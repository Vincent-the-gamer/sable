import type { SpectrumData, BeatResult, VisualizerConfig } from '../types'

/**
 * WebGL 流体模拟引擎 — 基于 Navier-Stokes 方程
 * 精确参考 PavelDoGreat/WebGL-Fluid-Simulation 实现
 *
 * 关键特性：
 * - float/half-float 纹理 (高精度速度场 + 染料累积)
 * - 涡度增强 (vorticity confinement)
 * - Bloom 辉光后处理
 * - 边界条件处理
 * - 音频频谱驱动的染料/速度注入
 */

// ────────────────────────── 常量配置 ──────────────────────────
// 内部模拟分辨率现在根据输出尺寸动态缩放，以保证小分辨率输出时也有高帧率
const SIM_RESOLUTION_BASE = 192   // 基准值，对应 1080p 输出高度
const DYE_RESOLUTION_BASE = 1536  // 基准值，对应 1080p 输出高度
const SIM_RESOLUTION_MIN = 64
const DYE_RESOLUTION_MIN = 480

// ────────────────────────── 着色器 ──────────────────────────

const baseVertexShader = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`

const clearShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main() {
    gl_FragColor = value * texture2D(uTexture, vUv);
  }
`

const splatShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  void main() {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`

const advectionShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  void main() {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 result = texture2D(uSource, coord);
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
  }
`

const divergenceShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`

const curlShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`

const vorticityShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main() {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`

const pressureShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float C = texture2D(uPressure, vUv).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`

const gradientSubtractShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`

const bloomPrefilterShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec3 curve;
  uniform float threshold;
  void main() {
    vec3 c = texture2D(uTexture, vUv).rgb;
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - curve.x, 0.0, curve.y);
    rq = curve.z * rq * rq;
    c *= max(rq, br - threshold) / max(br, 0.0001);
    gl_FragColor = vec4(c, 0.0);
  }
`

const bloomBlurShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  void main() {
    vec4 sum = vec4(0.0);
    sum += texture2D(uTexture, vL);
    sum += texture2D(uTexture, vR);
    sum += texture2D(uTexture, vT);
    sum += texture2D(uTexture, vB);
    sum *= 0.25;
    gl_FragColor = sum;
  }
`

const bloomFinalShader = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  uniform float intensity;
  void main() {
    vec4 sum = vec4(0.0);
    sum += texture2D(uTexture, vL);
    sum += texture2D(uTexture, vR);
    sum += texture2D(uTexture, vT);
    sum += texture2D(uTexture, vB);
    sum *= 0.25;
    gl_FragColor = sum * intensity;
  }
`

const displayShader = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  uniform sampler2D uBloom;
  uniform vec2 texelSize;

  vec3 linearToGamma(vec3 color) {
    color = max(color, vec3(0.0));
    return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0.0));
  }

  void main() {
    vec3 c = texture2D(uTexture, vUv).rgb;

    // Shading: normal-based lighting for 3D fluid look
    vec3 lc = texture2D(uTexture, vL).rgb;
    vec3 rc = texture2D(uTexture, vR).rgb;
    vec3 tc = texture2D(uTexture, vT).rgb;
    vec3 bc = texture2D(uTexture, vB).rgb;
    float dx = length(rc) - length(lc);
    float dy = length(tc) - length(bc);
    vec3 n = normalize(vec3(dx, dy, length(texelSize)));
    vec3 l = vec3(0.0, 0.0, 1.0);
    float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
    c *= diffuse;

    // Bloom composite
    vec3 bloom = texture2D(uBloom, vUv).rgb;
    bloom = linearToGamma(bloom);
    c += bloom;

    float a = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c, a);
  }
`

// ────────────────────────── 接口 ──────────────────────────

interface SplatPoint {
  x: number
  y: number
  dx: number
  dy: number
  color: [number, number, number]
}

interface FBO {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  attach(id: number): number
}

interface DoubleFBO {
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  read: FBO
  write: FBO
  swap(): void
}

// ────────────────────────── 引擎类 ──────────────────────────

export class WebGLFluidEngine {
  // WebGL
  canvas: HTMLCanvasElement | OffscreenCanvas
  private gl: WebGLRenderingContext
  /** 导出/离线模式：不从 DOM 读取尺寸，直接使用 canvas 像素尺寸 */
  private isOffline = false
  private ext = {
    formatRGBA: null as { internalFormat: number; format: number } | null,
    formatRG: null as { internalFormat: number; format: number } | null,
    formatR: null as { internalFormat: number; format: number } | null,
    halfFloatTexType: 0,
    supportLinearFiltering: true,
  }
  private isWebGL2 = false

  // Programs
  private clearProgram!: WebGLProgram
  private splatProgram!: WebGLProgram
  private advectionProgram!: WebGLProgram
  private divergenceProgram!: WebGLProgram
  private curlProgram!: WebGLProgram
  private vorticityProgram!: WebGLProgram
  private pressureProgram!: WebGLProgram
  private gradientSubtractProgram!: WebGLProgram
  private bloomPrefilterProgram!: WebGLProgram
  private bloomBlurProgram!: WebGLProgram
  private bloomFinalProgram!: WebGLProgram
  private displayProgram!: WebGLProgram

  // FBOs
  private dye!: DoubleFBO
  private velocity!: DoubleFBO
  private divergenceFBO!: FBO
  private curlFBO!: FBO
  private pressure!: DoubleFBO
  private bloom!: FBO
  private bloomFramebuffers: FBO[] = []
  // 独立显示 FBO，避免依赖 canvas 默认 framebuffer（hidden canvas 在 WKWebView 中可能无后备存储）
  private displayFBO!: FBO

  // Display
  private displayWidth = 0
  private displayHeight = 0


  // State
  private pendingSplats: SplatPoint[] = []
  private animFrameId = 0
  private running = false
  private time = 0
  private colorUpdateTimer = 0
  private rotatingHue = 260  // 当前旋转色相，初始 = config.hue

  // Config
  config: VisualizerConfig
  private fluidConfig = {
    DENSITY_DISSIPATION: 1.5,       // 降低消散，染料更持久
    VELOCITY_DISSIPATION: 0.2,      // 降低速度消散
    PRESSURE: 0.9,                   // 提高压力保持
    PRESSURE_ITERATIONS: 20,
    CURL: 30,                        // 提高基础涡度
    SPLAT_RADIUS: 0.20,              // 更大的 splat 半径
    SPLAT_FORCE: 3500,               // 更大力道
    BLOOM_INTENSITY: 0.75,           // 更强辉光
    BLOOM_THRESHOLD: 0.5,            // 更低阈值 = 更多区域发光
    BLOOM_SOFT_KNEE: 0.75,           // 更柔和过渡
  }

  // 缓存的音频能量，供 step() 动态调参
  private currentAudioEnergy = 0

  // Audio-driven
  private bandPositions: { x: number; y: number; color: [number, number, number] }[] = []

  // Quad buffer
  private quadBuffer: WebGLBuffer | null = null

  /** 导出模式下的模拟质量倍率 (默认 1.0，导出建议 2.0) */
  private simQualityMultiplier = 1.0

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, config: VisualizerConfig, preserveDrawing = false, simQualityMultiplier = 1.0) {
    this.canvas = canvas
    this.config = { ...config }
    this.simQualityMultiplier = Math.max(1.0, simQualityMultiplier)
    this.isOffline = preserveDrawing
    this.applyConfig()

    // 尝试 WebGL2，回退到 WebGL1
    const ctxOpts: WebGLContextAttributes = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: preserveDrawing,
    }

    let gl: WebGLRenderingContext | null = null
    if ('getContext' in canvas) {
      gl = (canvas as HTMLCanvasElement).getContext('webgl2', ctxOpts) as WebGLRenderingContext | null
    } else {
      gl = (canvas as OffscreenCanvas).getContext('webgl2', ctxOpts) as unknown as WebGLRenderingContext | null
    }

    this.isWebGL2 = !!gl

    if (!gl) {
      if ('getContext' in canvas) {
        gl = (canvas as HTMLCanvasElement).getContext('webgl', ctxOpts)
      } else {
        gl = (canvas as OffscreenCanvas).getContext('webgl', ctxOpts) as unknown as WebGLRenderingContext | null
      }
      if (!gl) throw new Error('WebGL not supported')
    }
    this.gl = gl

    this.initExtensions()
    this.initPrograms()
    this.createQuad()
    // 必须在 initFramebuffers 前设置好 displayWidth/Height
    // OffscreenCanvas: canvas 已预先 sizing，直接从 canvas 读取
    // HTMLCanvas: getBoundingClientRect 此时应已就绪（@canvas-ready 后调用）
    this.resize()
    this.initFramebuffers()

    // 初始化 8 个频段位置
    for (let i = 0; i < 8; i++) {
      this.bandPositions.push({
        x: Math.random(),
        y: Math.random(),
        color: this.generateColor(),
      })
    }

    // 静默启动 — 无初始 splat
    console.log('[WebGLFluid] 初始化完成, WebGL' + (this.isWebGL2 ? '2' : '1'),
      'canvas:', this.displayWidth, 'x', this.displayHeight)
  }

  // ═══════════ 扩展检测 ═══════════

  private initExtensions() {
    const gl = this.gl

    if (this.isWebGL2) {
      ;(gl as WebGL2RenderingContext).getExtension('EXT_color_buffer_float')
      this.ext.supportLinearFiltering = !!(gl as WebGL2RenderingContext)
        .getExtension('OES_texture_float_linear')
      this.ext.halfFloatTexType = (gl as WebGL2RenderingContext).HALF_FLOAT

      this.ext.formatRGBA = this.getSupportedFormat(
        gl, (gl as WebGL2RenderingContext).RGBA16F, gl.RGBA, this.ext.halfFloatTexType,
      )
      this.ext.formatRG = this.getSupportedFormat(
        gl, (gl as WebGL2RenderingContext).RG16F,
        (gl as WebGL2RenderingContext).RG, this.ext.halfFloatTexType,
      )
      this.ext.formatR = this.getSupportedFormat(
        gl, (gl as WebGL2RenderingContext).R16F,
        (gl as WebGL2RenderingContext).RED, this.ext.halfFloatTexType,
      )
    } else {
      const halfFloatExt = gl.getExtension('OES_texture_half_float')!
      this.ext.halfFloatTexType = halfFloatExt.HALF_FLOAT_OES
      this.ext.supportLinearFiltering = !!gl.getExtension('OES_texture_half_float_linear')

      // WebGL1: 只能用 RGBA
      this.ext.formatRGBA = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, this.ext.halfFloatTexType)
      this.ext.formatRG = this.ext.formatRGBA
      this.ext.formatR = this.ext.formatRGBA
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0)

    if (!this.ext.formatRGBA) {
      console.warn('[WebGLFluid] 半浮点纹理不支持，效果可能不佳')
      // 回退到 UNSIGNED_BYTE
      this.ext.formatRGBA = { internalFormat: gl.RGBA, format: gl.RGBA }
      this.ext.formatRG = { internalFormat: gl.RGBA, format: gl.RGBA }
      this.ext.formatR = { internalFormat: gl.RGBA, format: gl.RGBA }
      this.ext.halfFloatTexType = gl.UNSIGNED_BYTE
    }
  }

  private getSupportedFormat(
    gl: WebGLRenderingContext,
    internalFormat: number, format: number, type: number,
  ): { internalFormat: number; format: number } | null {
    if (this.supportRenderTextureFormat(gl, internalFormat, format, type)) {
      return { internalFormat, format }
    }
    // 回退链: R16F -> RG16F -> RGBA16F
    if (this.isWebGL2 && internalFormat === (gl as WebGL2RenderingContext).R16F) {
      return this.getSupportedFormat(gl, (gl as WebGL2RenderingContext).RG16F,
        (gl as WebGL2RenderingContext).RG, type)
    }
    if (this.isWebGL2 && internalFormat === (gl as WebGL2RenderingContext).RG16F) {
      return this.getSupportedFormat(gl, (gl as WebGL2RenderingContext).RGBA16F,
        gl.RGBA, type)
    }
    return null
  }

  private supportRenderTextureFormat(
    gl: WebGLRenderingContext,
    internalFormat: number, format: number, type: number,
  ): boolean {
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null)

    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.deleteTexture(texture)
    gl.deleteFramebuffer(fbo)
    return status === gl.FRAMEBUFFER_COMPLETE
  }

  // ═══════════ 着色器编译 ═══════════

  private compile(vs: string, fs: string): WebGLProgram {
    const gl = this.gl
    const vsShader = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(vsShader, vs)
    gl.compileShader(vsShader)
    if (!gl.getShaderParameter(vsShader, gl.COMPILE_STATUS)) {
      console.error('VS error:', gl.getShaderInfoLog(vsShader))
    }

    const fsShader = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(fsShader, fs)
    gl.compileShader(fsShader)
    if (!gl.getShaderParameter(fsShader, gl.COMPILE_STATUS)) {
      console.error('FS error:', gl.getShaderInfoLog(fsShader))
    }

    const program = gl.createProgram()!
    gl.attachShader(program, vsShader)
    gl.attachShader(program, fsShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Link error: ' + gl.getProgramInfoLog(program))
    }
    return program
  }

  private initPrograms() {
    this.clearProgram = this.compile(baseVertexShader, clearShader)
    this.splatProgram = this.compile(baseVertexShader, splatShader)
    this.advectionProgram = this.compile(baseVertexShader, advectionShader)
    this.divergenceProgram = this.compile(baseVertexShader, divergenceShader)
    this.curlProgram = this.compile(baseVertexShader, curlShader)
    this.vorticityProgram = this.compile(baseVertexShader, vorticityShader)
    this.pressureProgram = this.compile(baseVertexShader, pressureShader)
    this.gradientSubtractProgram = this.compile(baseVertexShader, gradientSubtractShader)
    this.bloomPrefilterProgram = this.compile(baseVertexShader, bloomPrefilterShader)
    this.bloomBlurProgram = this.compile(baseVertexShader, bloomBlurShader)
    this.bloomFinalProgram = this.compile(baseVertexShader, bloomFinalShader)
    this.displayProgram = this.compile(baseVertexShader, displayShader)
  }

  // ═══════════ FBO 管理 ═══════════

  private createFBO(w: number, h: number, internalFormat: number, format: number,
    type: number, filter: number): FBO {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)

    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.viewport(0, 0, w, h)
    gl.clear(gl.COLOR_BUFFER_BIT)

    return {
      texture, fbo,
      width: w, height: h,
      texelSizeX: 1.0 / w, texelSizeY: 1.0 / h,
      attach(id: number) {
        gl.activeTexture(gl.TEXTURE0 + id)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        return id
      },
    }
  }

  private createDoubleFBO(w: number, h: number, internalFormat: number,
    format: number, type: number, filter: number): DoubleFBO {
    let fbo1 = this.createFBO(w, h, internalFormat, format, type, filter)
    let fbo2 = this.createFBO(w, h, internalFormat, format, type, filter)
    return {
      width: w, height: h,
      texelSizeX: fbo1.texelSizeX,
      texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1 },
      set read(v) { fbo1 = v },
      get write() { return fbo2 },
      set write(v) { fbo2 = v },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t },
    }
  }

  private initFramebuffers() {
    const gl = this.gl
    gl.disable(gl.BLEND)

    const texType = this.ext.halfFloatTexType
    const rgba = this.ext.formatRGBA!
    const rg = this.ext.formatRG!
    const r = this.ext.formatR!
    const filtering = this.ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST

    // 动态分辨率：根据输出高度缩放模拟精度，小输出 = 快渲染
    // 导出模式通过 simQualityMultiplier 提高内部模拟精度，消除模糊
    const scale = (this.displayHeight / 1080) * this.simQualityMultiplier
    const simResRaw = Math.max(SIM_RESOLUTION_MIN, Math.round(SIM_RESOLUTION_BASE * scale))
    const dyeResRaw = Math.max(DYE_RESOLUTION_MIN, Math.round(DYE_RESOLUTION_BASE * scale))
    const simRes = this.getResolution(simResRaw)
    const dyeRes = this.getResolution(dyeResRaw)

    this.velocity = this.createDoubleFBO(simRes.width, simRes.height,
      rg.internalFormat, rg.format, texType, filtering)
    this.dye = this.createDoubleFBO(dyeRes.width, dyeRes.height,
      rgba.internalFormat, rgba.format, texType, filtering)
    this.divergenceFBO = this.createFBO(simRes.width, simRes.height,
      r.internalFormat, r.format, texType, gl.NEAREST)
    this.curlFBO = this.createFBO(simRes.width, simRes.height,
      r.internalFormat, r.format, texType, gl.NEAREST)
    this.pressure = this.createDoubleFBO(simRes.width, simRes.height,
      r.internalFormat, r.format, texType, gl.NEAREST)

    this.initBloomFramebuffers()

    // 显示 FBO：独立于 canvas 默认 framebuffer，使用 RGBA8 确保 readPixels 可靠
    // 避免 hidden canvas 在 WKWebView 中默认 framebuffer 无后备存储导致黑屏
    if (this.displayFBO) {
      gl.deleteFramebuffer(this.displayFBO.fbo)
      gl.deleteTexture(this.displayFBO.texture)
    }
    this.displayFBO = this.createFBO(this.displayWidth, this.displayHeight,
      gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST)
    // 验证 displayFBO 完整性
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.displayFBO.fbo)
    const fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (fboStatus !== gl.FRAMEBUFFER_COMPLETE) {
      console.error(`[WebGLFluid] displayFBO 不完整! status=${fboStatus}, expected=${gl.FRAMEBUFFER_COMPLETE}`)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    console.log(`[WebGLFluid] FBO 初始化: sim=${simRes.width}x${simRes.height} dye=${dyeRes.width}x${dyeRes.height} output=${this.displayWidth}x${this.displayHeight}`)
  }

  private initBloomFramebuffers() {
    const gl = this.gl
    const texType = this.ext.halfFloatTexType
    const rgba = this.ext.formatRGBA!
    const filtering = this.ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST

    const bloomBase = Math.max(128, Math.round(256 * (this.displayHeight / 1080) * this.simQualityMultiplier))
    const res = this.getResolution(bloomBase)
    this.bloom = this.createFBO(res.width, res.height,
      rgba.internalFormat, rgba.format, texType, filtering)

    this.bloomFramebuffers = []
    for (let i = 0; i < 8; i++) { // BLOOM_ITERATIONS
      const width = res.width >> (i + 1)
      const height = res.height >> (i + 1)
      if (width < 2 || height < 2) break
      this.bloomFramebuffers.push(
        this.createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering),
      )
    }
  }

  private getResolution(resolution: number): { width: number; height: number } {
    const aspectRatio = this.displayWidth > 0
      ? Math.max(this.displayWidth / this.displayHeight, this.displayHeight / this.displayWidth)
      : 1.0

    const min = Math.round(resolution)
    const max = Math.round(resolution * aspectRatio)

    if (this.displayWidth > this.displayHeight)
      return { width: max, height: min }
    return { width: min, height: max }
  }

  // ═══════════ 渲染工具 ═══════════

  private createQuad() {
    const gl = this.gl
    const vertices = new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1])
    this.quadBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  }

  private blit(target: FBO | null, clear = false) {
    const gl = this.gl
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    } else {
      gl.viewport(0, 0, target.width, target.height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    }
    if (clear) {
      gl.clearColor(0.0, 0.0, 0.0, 1.0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer!)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)
  }

  private setUniform1f(program: WebGLProgram, name: string, v: number) {
    this.gl.uniform1f(this.gl.getUniformLocation(program, name), v)
  }

  private setUniform2f(program: WebGLProgram, name: string, x: number, y: number) {
    this.gl.uniform2f(this.gl.getUniformLocation(program, name), x, y)
  }

  private setUniform3f(program: WebGLProgram, name: string, x: number, y: number, z: number) {
    this.gl.uniform3f(this.gl.getUniformLocation(program, name), x, y, z)
  }

  private setTexture(program: WebGLProgram, name: string, fbo: FBO, unit: number) {
    const gl = this.gl
    const loc = gl.getUniformLocation(program, name)
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, fbo.texture)
    gl.uniform1i(loc, unit)
  }

  // ═══════════ 模拟核心 ═══════════

  // audioEnergy: 0~1 整体音频能量，用于动态调制涡度和速度消散
  private step(dt: number, audioEnergy = 0) {
    const gl = this.gl
    gl.disable(gl.BLEND)

    // 动态参数：音频越强 → 涡旋越强、速度消散越慢、压力迭代越多 (扩大动态范围)
    const dynCurl = this.fluidConfig.CURL * (0.4 + audioEnergy * 2.0)
    const dynVelDissipation = this.fluidConfig.VELOCITY_DISSIPATION * (2.0 - audioEnergy * 1.6)
    const dynPressureIters = Math.round(this.fluidConfig.PRESSURE_ITERATIONS * (0.6 + audioEnergy * 0.9))

    // 1. Curl
    gl.useProgram(this.curlProgram)
    this.setUniform2f(this.curlProgram, 'texelSize', this.velocity.texelSizeX, this.velocity.texelSizeY)
    this.setTexture(this.curlProgram, 'uVelocity', this.velocity.read, 0)
    this.blit(this.curlFBO)

    // 2. Vorticity confinement
    gl.useProgram(this.vorticityProgram)
    this.setUniform2f(this.vorticityProgram, 'texelSize', this.velocity.texelSizeX, this.velocity.texelSizeY)
    this.setTexture(this.vorticityProgram, 'uVelocity', this.velocity.read, 0)
    this.setTexture(this.vorticityProgram, 'uCurl', this.curlFBO, 1)
    this.setUniform1f(this.vorticityProgram, 'curl', dynCurl)
    this.setUniform1f(this.vorticityProgram, 'dt', dt)
    this.blit(this.velocity.write)
    this.velocity.swap()

    // 3. Divergence
    gl.useProgram(this.divergenceProgram)
    this.setUniform2f(this.divergenceProgram, 'texelSize', this.velocity.texelSizeX, this.velocity.texelSizeY)
    this.setTexture(this.divergenceProgram, 'uVelocity', this.velocity.read, 0)
    this.blit(this.divergenceFBO)

    // 4. Clear pressure
    gl.useProgram(this.clearProgram)
    this.setTexture(this.clearProgram, 'uTexture', this.pressure.read, 0)
    this.setUniform1f(this.clearProgram, 'value', this.fluidConfig.PRESSURE)
    this.blit(this.pressure.write)
    this.pressure.swap()

    // 5. Pressure solve (Jacobi iterations)
    gl.useProgram(this.pressureProgram)
    this.setUniform2f(this.pressureProgram, 'texelSize', this.velocity.texelSizeX, this.velocity.texelSizeY)
    this.setTexture(this.pressureProgram, 'uDivergence', this.divergenceFBO, 0)
    for (let i = 0; i < dynPressureIters; i++) {
      this.setTexture(this.pressureProgram, 'uPressure', this.pressure.read, 1)
      this.blit(this.pressure.write)
      this.pressure.swap()
    }

    // 6. Gradient subtract
    gl.useProgram(this.gradientSubtractProgram)
    this.setUniform2f(this.gradientSubtractProgram, 'texelSize', this.velocity.texelSizeX, this.velocity.texelSizeY)
    this.setTexture(this.gradientSubtractProgram, 'uPressure', this.pressure.read, 0)
    this.setTexture(this.gradientSubtractProgram, 'uVelocity', this.velocity.read, 1)
    this.blit(this.velocity.write)
    this.velocity.swap()

    // 7. Advect velocity
    gl.useProgram(this.advectionProgram)
    this.setUniform2f(this.advectionProgram, 'texelSize', this.velocity.texelSizeX, this.velocity.texelSizeY)
    this.setTexture(this.advectionProgram, 'uVelocity', this.velocity.read, 0)
    this.setTexture(this.advectionProgram, 'uSource', this.velocity.read, 0)
    this.setUniform1f(this.advectionProgram, 'dt', dt)
    this.setUniform1f(this.advectionProgram, 'dissipation', dynVelDissipation)
    this.blit(this.velocity.write)
    this.velocity.swap()

    // 8. Advect dye
    gl.useProgram(this.advectionProgram)
    this.setUniform2f(this.advectionProgram, 'texelSize', this.dye.texelSizeX, this.dye.texelSizeY)
    this.setTexture(this.advectionProgram, 'uVelocity', this.velocity.read, 0)
    this.setTexture(this.advectionProgram, 'uSource', this.dye.read, 1)
    this.setUniform1f(this.advectionProgram, 'dt', dt)
    this.setUniform1f(this.advectionProgram, 'dissipation', this.fluidConfig.DENSITY_DISSIPATION)
    this.blit(this.dye.write)
    this.dye.swap()
  }

  // ═══════════ 染料注入 ═══════════

  private splat(x: number, y: number, dx: number, dy: number, color: [number, number, number]) {
    const gl = this.gl

    // Splat velocity
    gl.useProgram(this.splatProgram)
    this.setTexture(this.splatProgram, 'uTarget', this.velocity.read, 0)
    this.setUniform1f(this.splatProgram, 'aspectRatio', this.canvas.width / this.canvas.height)
    this.setUniform2f(this.splatProgram, 'point', x, y)
    this.setUniform3f(this.splatProgram, 'color', dx, dy, 0.0)
    this.setUniform1f(this.splatProgram, 'radius', this.correctRadius(
      this.fluidConfig.SPLAT_RADIUS / 100.0))
    this.blit(this.velocity.write)
    this.velocity.swap()

    // Splat dye
    gl.useProgram(this.splatProgram)
    this.setTexture(this.splatProgram, 'uTarget', this.dye.read, 0)
    this.setUniform1f(this.splatProgram, 'aspectRatio', this.canvas.width / this.canvas.height)
    this.setUniform2f(this.splatProgram, 'point', x, y)
    this.setUniform3f(this.splatProgram, 'color', color[0], color[1], color[2])
    this.setUniform1f(this.splatProgram, 'radius', this.correctRadius(
      this.fluidConfig.SPLAT_RADIUS / 100.0))
    this.blit(this.dye.write)
    this.dye.swap()
  }

  private correctRadius(radius: number): number {
    const aspectRatio = this.canvas.width / this.canvas.height
    if (aspectRatio > 1) radius *= aspectRatio
    return radius
  }

  // ═══════════ Bloom ═══════════

  private applyBloom(source: DoubleFBO, destination: FBO) {
    if (this.bloomFramebuffers.length < 2) return

    const gl = this.gl
    gl.disable(gl.BLEND)

    let last = destination

    // Prefilter
    gl.useProgram(this.bloomPrefilterProgram)
    const knee = this.fluidConfig.BLOOM_THRESHOLD * this.fluidConfig.BLOOM_SOFT_KNEE + 0.0001
    const curve0 = this.fluidConfig.BLOOM_THRESHOLD - knee
    const curve1 = knee * 2.0
    const curve2 = 0.25 / knee
    this.setUniform3f(this.bloomPrefilterProgram, 'curve', curve0, curve1, curve2)
    this.setUniform1f(this.bloomPrefilterProgram, 'threshold', this.fluidConfig.BLOOM_THRESHOLD)
    this.setTexture(this.bloomPrefilterProgram, 'uTexture', source.read, 0)
    this.blit(last)

    // Downsample blur
    gl.useProgram(this.bloomBlurProgram)
    for (let i = 0; i < this.bloomFramebuffers.length; i++) {
      const dest = this.bloomFramebuffers[i]
      if (!dest) break
      this.setUniform2f(this.bloomBlurProgram, 'texelSize', last.texelSizeX, last.texelSizeY)
      this.setTexture(this.bloomBlurProgram, 'uTexture', last, 0)
      this.blit(dest)
      last = dest
    }

    // Upsample composite
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.enable(gl.BLEND)

    for (let i = this.bloomFramebuffers.length - 2; i >= 0; i--) {
      const baseTex = this.bloomFramebuffers[i]
      if (!baseTex) continue
      this.setUniform2f(this.bloomBlurProgram, 'texelSize', last.texelSizeX, last.texelSizeY)
      this.setTexture(this.bloomBlurProgram, 'uTexture', last, 0)
      gl.viewport(0, 0, baseTex.width, baseTex.height)
      this.blit(baseTex)
      last = baseTex
    }

    // Final
    gl.disable(gl.BLEND)
    gl.useProgram(this.bloomFinalProgram)
    this.setUniform2f(this.bloomFinalProgram, 'texelSize', last.texelSizeX, last.texelSizeY)
    this.setTexture(this.bloomFinalProgram, 'uTexture', last, 0)
    this.setUniform1f(this.bloomFinalProgram, 'intensity', this.fluidConfig.BLOOM_INTENSITY)
    this.blit(destination)
  }

  // ═══════════ 渲染显示 ═══════════

  private renderDisplay(targetFbo: WebGLFramebuffer | null = null) {
    const gl = this.gl

    // 1. Bloom
    this.applyBloom(this.dye, this.bloom)

    // 2. Clear and render to target
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo)
    gl.viewport(0, 0, this.displayWidth, this.displayHeight)
    gl.clearColor(0.0, 0.0, 0.0, 1.0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // 3. 用 alpha blending 叠上流体
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.BLEND)

    gl.useProgram(this.displayProgram)
    this.setUniform2f(this.displayProgram, 'texelSize', 1.0 / this.displayWidth, 1.0 / this.displayHeight)
    this.setTexture(this.displayProgram, 'uTexture', this.dye.read, 0)
    this.setTexture(this.displayProgram, 'uBloom', this.bloom, 1)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer!)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4)
  }

  // ═══════════ 公共接口 ═══════════

  resize(): void {
    if ('getBoundingClientRect' in this.canvas) {
      // 导出/离线模式：直接使用 canvas 像素尺寸，不要 DPR 缩放
      if (this.isOffline) {
        const w = this.canvas.width
        const h = this.canvas.height
        if (w === 0 || h === 0) return
        this.displayWidth = w
        this.displayHeight = h
      } else {
        // 预览模式：DPR 缩放以保证 Retina 清晰度
        const dpr = window.devicePixelRatio || 1
        const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect()
        let w = Math.floor(rect.width * dpr)
        let h = Math.floor(rect.height * dpr)
        // 如果 canvas 不在 DOM 中，getBoundingClientRect 返回 0×0
        // 回退到 canvas.width / canvas.height（离线渲染场景）
        if (w === 0 || h === 0) {
          w = this.canvas.width
          h = this.canvas.height
          if (w === 0 || h === 0) return
        }
        this.displayWidth = w
        this.displayHeight = h
        this.canvas.width = w
        this.canvas.height = h
      }
    }
    // OffscreenCanvas: already sized, just sync display dimensions
    else {
      this.displayWidth = this.canvas.width
      this.displayHeight = this.canvas.height
    }
  }

  /** 直接设置画布尺寸（用于离线渲染），并重建 FBO */
  setDimensions(width: number, height: number): void {
    const needsRebuild = this.displayWidth !== width || this.displayHeight !== height
    this.canvas.width = width
    this.canvas.height = height
    this.displayWidth = width
    this.displayHeight = height

    // 仅当尺寸变化时重置捕获缓冲区
    const size = width * height * 4
    if (!this._captureBuf || this._captureBuf.length !== size) {
      this._captureBuf = new Uint8Array(size)
    }

    // 重建 FBO 以匹配新尺寸
    if (needsRebuild) {
      this.initFramebuffers()
    }
  }

  // 使用 drawImage 从 WebGL canvas 复制到 2D canvas，避免 readPixels 兼容性问题
  private _captureBuf: Uint8Array | null = null

  /** Capture RGBA pixels from displayFBO via readPixels (standard WebGL approach) */
  captureFrame(): Uint8Array {
    const gl = this.gl
    const w = this.displayWidth
    const h = this.displayHeight
    const size = w * h * 4

    if (!this._captureBuf || this._captureBuf.length !== size) {
      this._captureBuf = new Uint8Array(size)
    }

    // Ensure all GL commands complete
    gl.finish()

    // Read from displayFBO (RGBA8, always has GPU backing unlike default FB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.displayFBO.fbo)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._captureBuf)

    return this._captureBuf
  }

  resetState(): void {
    this.time = 0
    this.currentAudioEnergy = 0
    this.colorUpdateTimer = 0
    this.rotatingHue = this.config.hue
    this.pendingSplats = []
    this.bandPositions = []
    for (let i = 0; i < 8; i++) {
      this.bandPositions.push({
        x: Math.random(),
        y: Math.random(),
        color: this.generateColor(),
      })
    }
  }

  /**
   * 离线渲染一帧：注入音频 splats → 模拟步进 → 渲染显示
   * 调用后可用 captureFrame() 获取像素
   */
  offlineStep(dt: number, spectrum: SpectrumData | null, beat: BeatResult): void {
    // 累计模拟时间（与 start() 循环保持一致的驱动逻辑）
    this.time += dt

    // 动态色相旋转
    if (this.config.hueRotate) {
      const speed = this.config.hueRotateSpeed ?? 1.0
      this.rotatingHue = ((this.rotatingHue + dt * speed * 30) % 360 + 360) % 360
    } else {
      this.rotatingHue = this.config.hue
    }

    this.updateColors(dt)

    // 音频驱动的染料注入
    if (spectrum) {
      // dt-aware 平滑：保持 ~100ms 时间常数
      const tau = 0.10
      const s = 1 - Math.exp(-dt / tau)
      this.currentAudioEnergy += (spectrum.averageEnergy - this.currentAudioEnergy) * s
      this.generateAudioSplats(spectrum, beat, dt)
    } else {
      this.currentAudioEnergy *= 0.9
    }

    // 应用排队的 splats
    for (const s of this.pendingSplats) {
      this.splat(s.x, s.y, s.dx, s.dy, s.color)
    }
    this.pendingSplats = []

    // 模拟步进
    this.step(dt, this.currentAudioEnergy)

    // 渲染到 displayFBO（captureFrame 从 displayFBO 读取）
    if (this.displayWidth > 0 && this.displayHeight > 0) {
      this.renderDisplay(this.displayFBO.fbo)
    }
  }

  start(
    getSpectrum: () => SpectrumData | null,
    getBeat: () => BeatResult,
  ): void {
    if (this.running) return
    this.running = true

    if (this.displayWidth === 0 || this.displayHeight === 0) {
      this.resize()
    }

    let lastTime = performance.now()

    const loop = () => {
      if (!this.running) return

      const now = performance.now()
      const rawDt = now - lastTime
      lastTime = now
      const dt = Math.min(rawDt / 1000, 0.016666) // cap at ~60fps
      this.time += dt

      const spectrum = getSpectrum()
      const beat = getBeat()

      // 计算整体音频能量（给 step 做动态物理调制）
      if (spectrum) {
        // dt-aware 平滑：保持 ~100ms 时间常数，帧率无关
        const tau = 0.10
        const s = 1 - Math.exp(-dt / tau)
        this.currentAudioEnergy += (spectrum.averageEnergy - this.currentAudioEnergy) * s
      } else {
        // 无音频时逐渐归零
        this.currentAudioEnergy *= 0.9
      }

      // 动态色相旋转
      if (this.config.hueRotate) {
        const speed = this.config.hueRotateSpeed ?? 1.0
        this.rotatingHue = ((this.rotatingHue + dt * speed * 30) % 360 + 360) % 360
      } else {
        this.rotatingHue = this.config.hue
      }

      // 颜色变换
      this.updateColors(dt)

      // 音频驱动的染料注入
      if (spectrum) {
        this.generateAudioSplats(spectrum, beat, dt)
      }

      // 应用排队的 splats（如空格键随机注入）
      for (const s of this.pendingSplats) {
        this.splat(s.x, s.y, s.dx, s.dy, s.color)
      }
      this.pendingSplats = []

      // 模拟步进 — 传入音频能量以同步流体动力学
      this.step(dt, this.currentAudioEnergy)

      if (this.displayWidth > 0 && this.displayHeight > 0) {
        this.renderDisplay(null)
      } else {
        this.resize()
      }

      this.animFrameId = requestAnimationFrame(loop)
    }

    loop()
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.animFrameId)
  }

  /** 释放 WebGL 上下文和相关 GPU 资源 */
  destroy(): void {
    this.stop()
    const gl = this.gl
    // 删除所有 shader programs
    const programs = [
      this.clearProgram, this.splatProgram, this.advectionProgram,
      this.divergenceProgram, this.curlProgram, this.vorticityProgram,
      this.pressureProgram, this.gradientSubtractProgram,
      this.bloomPrefilterProgram, this.bloomBlurProgram, this.bloomFinalProgram,
      this.displayProgram,
    ]
    for (const p of programs) {
      if (p) gl.deleteProgram(p)
    }
    // 使用 WEBGL_lose_context 扩展释放上下文
    const loseExt = gl.getExtension('WEBGL_lose_context')
    if (loseExt) {
      loseExt.loseContext()
    }
  }

  // ═══════════ 配置更新 ═══════════

  /** 从外部 UI 面板同步配置变更 */
  updateConfig(cfg: VisualizerConfig): void {
    this.config = { ...cfg }
    this.applyConfig()
  }

  /** 将 VisualizerConfig 映射到流体物理参数 */
  private applyConfig(): void {
    const c = this.config
    // glowIntensity 0~2 → bloom 0.4~1.4
    this.fluidConfig.BLOOM_INTENSITY = 0.4 + c.glowIntensity * 0.5
    // shakeIntensity 0~2 → curl 15~60, velocity dissipation 0.35~0.05
    this.fluidConfig.CURL = 15 + c.shakeIntensity * 22.5
    this.fluidConfig.VELOCITY_DISSIPATION = 0.35 - c.shakeIntensity * 0.15
    // shakeIntensity also affects force
    this.fluidConfig.SPLAT_FORCE = 2500 + c.shakeIntensity * 2000
  }

  // 手动触发随机 splat（空格键等）
  triggerRandomSplat(amount?: number) {
    const count = amount ?? Math.floor(Math.random() * 20) + 5
    for (let i = 0; i < count; i++) {
      const color = this.generateColor()
      color[0] *= 10.0; color[1] *= 10.0; color[2] *= 10.0
      this.pendingSplats.push({
        x: Math.random(),
        y: Math.random(),
        dx: 1000 * (Math.random() - 0.5),
        dy: 1000 * (Math.random() - 0.5),
        color,
      })
    }
  }

  // ═══════════ 颜色生成 ═══════════

  private updateColors(dt: number) {
    this.colorUpdateTimer += dt * 10
    if (this.colorUpdateTimer >= 1) {
      this.colorUpdateTimer = (this.colorUpdateTimer - 1) % 1
      for (const bp of this.bandPositions) {
        bp.color = this.generateColor()
      }
    }
  }

  private generateColor(): [number, number, number] {
    // 在 rotatingHue ± (hueSpread/2) 范围内随机生成
    const baseHue = this.rotatingHue
    const spread = this.config.hueSpread ?? 50
    const h = ((baseHue + (Math.random() - 0.5) * spread) / 360 + 1) % 1
    const c = this.hsvToRgb(h, 1.0, 1.0)
    return [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15]
  }

  private hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    let r = 0, g = 0, b = 0
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break
      case 1: r = q; g = v; b = p; break
      case 2: r = p; g = v; b = t; break
      case 3: r = p; g = q; b = v; break
      case 4: r = t; g = p; b = v; break
      case 5: r = v; g = p; b = q; break
    }
    return [r, g, b]
  }

  // ═══════════ 音频驱动染料注入 ═══════════

  private generateAudioSplats(spectrum: SpectrumData, beat: BeatResult, dt: number) {
    const freq = spectrum.frequency
    const bandCount = 8
    const intensityMul = this.config.fluidIntensity ?? 1.0
    const activityMul = this.config.fluidActivity ?? 1.0
    // 活跃度越低 → 阈值越高，避免低能量时也满屏

    // ── 全频段能量驱动流体（鼓点已独立为边缘闪烁，流体不再需要避开低频）──
    const fluidEnergy = spectrum.averageEnergy

    // ═══ 全局能量层 ═══
    if (fluidEnergy > 0.03) {
      const globalSpread = Math.ceil(fluidEnergy * 5 * activityMul)
      for (let i = 0; i < globalSpread; i++) {
        const gColor = this.generateColor()
        const gBright = (0.03 + fluidEnergy * 0.6) * intensityMul
        gColor[0] *= gBright
        gColor[1] *= gBright
        gColor[2] *= gBright
        this.pendingSplats.push({
          x: 0.1 + Math.random() * 0.8,
          y: 0.1 + Math.random() * 0.8,
          dx: (Math.random() - 0.5) * this.fluidConfig.SPLAT_FORCE * fluidEnergy * 0.4,
          dy: (Math.random() - 0.5) * this.fluidConfig.SPLAT_FORCE * fluidEnergy * 0.4,
          color: gColor,
        })
      }
    }

    for (let b = 0; b < bandCount; b++) {
      const binStart = Math.floor((freq.length / bandCount) * b)
      const binEnd = Math.floor((freq.length / bandCount) * (b + 1))
      let bandSum = 0
      for (let i = binStart; i < binEnd; i++) bandSum += freq[i]
      const bandEnergy = bandSum / ((binEnd - binStart) * 255)

      if (bandEnergy < 0.008) continue

      // 全频段参与流体（鼓点已独立处理）

      const bp = this.bandPositions[b]
      const color = bp.color

      const wanderSpeed = dt * (0.6 + bandEnergy * 4.0)
      bp.x += (Math.random() - 0.5) * wanderSpeed
      bp.y += (Math.random() - 0.5) * wanderSpeed

      if (Math.random() < bandEnergy * 0.4) {
        bp.x += (Math.random() - 0.5) * 0.4
        bp.y += (Math.random() - 0.5) * 0.4
      }

      bp.x = Math.max(0.03, Math.min(0.97, bp.x))
      bp.y = Math.max(0.03, Math.min(0.97, bp.y))

      const count = Math.ceil(bandEnergy * 5.0 * activityMul)
      for (let j = 0; j < count; j++) {
        const sx = bp.x + (Math.random() - 0.5) * (0.25 + bandEnergy * 0.4)
        const sy = bp.y + (Math.random() - 0.5) * (0.25 + bandEnergy * 0.4)

        const r = Math.random()
        let dx: number, dy: number
        if (r < 0.4) {
          const phase = this.time * 2.5 + b * 0.7
          const angle = phase + (Math.random() - 0.5) * 2.0
          const fm = this.fluidConfig.SPLAT_FORCE * bandEnergy * 1.5
          dx = Math.cos(angle) * fm
          dy = Math.sin(angle) * fm
        } else if (r < 0.7) {
          const angle = Math.random() * Math.PI * 2
          const fm = this.fluidConfig.SPLAT_FORCE * bandEnergy * 1.2
          dx = Math.cos(angle) * fm
          dy = Math.sin(angle) * fm
        } else {
          const fm = this.fluidConfig.SPLAT_FORCE * bandEnergy * 1.8
          dx = (Math.random() - 0.5) * fm * 2
          dy = (Math.random() - 0.5) * fm * 2
        }

        const brightness = (0.25 + bandEnergy * 2.5) * intensityMul
        const boostedColor: [number, number, number] = [
          color[0] * brightness,
          color[1] * brightness,
          color[2] * brightness,
        ]

        this.pendingSplats.push({
          x: Math.max(0.01, Math.min(0.99, sx)),
          y: Math.max(0.01, Math.min(0.99, sy)),
          dx, dy,
          color: boostedColor,
        })
      }
    }

    // 全局随机散布
    if (fluidEnergy > 0.04) {
      const scatterCount = Math.ceil(fluidEnergy * 10 * activityMul)
      for (let i = 0; i < scatterCount; i++) {
        const color = this.generateColor()
        const brightness = (0.10 + fluidEnergy * 1.2) * intensityMul
        color[0] *= brightness
        color[1] *= brightness
        color[2] *= brightness
        const angle = Math.random() * Math.PI * 2
        const fm = this.fluidConfig.SPLAT_FORCE * fluidEnergy * 1.0
        this.pendingSplats.push({
          x: Math.random(),
          y: Math.random(),
          dx: Math.cos(angle) * fm + (Math.random() - 0.5) * fm,
          dy: Math.sin(angle) * fm + (Math.random() - 0.5) * fm,
          color,
        })
      }
    }

    // ═══ 鼓点流体共鸣：鼓点发生时注入少量额外 splat ═══
    if (beat.isBeat && beat.intensity > 0.3 && spectrum.drumEnergy > 0.12) {
      const drumTraceCount = Math.ceil(beat.intensity * 4 * activityMul)
      for (let i = 0; i < drumTraceCount; i++) {
        const color = this.generateColor()
        const brightness = beat.intensity * 0.3 * intensityMul
        color[0] *= brightness
        color[1] *= brightness
        color[2] *= brightness
        this.pendingSplats.push({
          x: 0.2 + Math.random() * 0.6,
          y: 0.2 + Math.random() * 0.6,
          dx: (Math.random() - 0.5) * this.fluidConfig.SPLAT_FORCE * beat.intensity * 0.3,
          dy: (Math.random() - 0.5) * this.fluidConfig.SPLAT_FORCE * beat.intensity * 0.3,
          color,
        })
      }
    }
  }
}
