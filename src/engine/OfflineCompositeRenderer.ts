import type { SpectrumData, BeatResult, VisualizerConfig, SpectrumConfig, SubtitleConfig, LyricLine } from '../types'
import { WebGLFluidEngine } from './WebGLFluidEngine'
import { FftAnalyzer } from './FftAnalyzer'
import { BeatDetector } from './BeatDetector'

/**
 * 离线复合渲染器：将所有预览中的特效合成为一帧输出
 *
 * 层级（从底到顶）：
 * 1. WebGL 流体背景
 * 2. 2D 粒子 + 辉光
 * 3. 频谱可视化（柱状/环形/波形/镜像/星点）
 * 4. 字幕/歌词（含所有特效：glow, shake, 入场/出场动画, beat缩放等）
 *
 * 用于视频导出，确保输出与预览完全一致
 */
export class OfflineCompositeRenderer {
  private fluidEngine: WebGLFluidEngine
  private fluidCanvas: HTMLCanvasElement
  // 使用 HTMLCanvasElement 而非 OffscreenCanvas 以确保 WKWebView 兼容
  private compositeCanvas: HTMLCanvasElement
  private ctx2d: CanvasRenderingContext2D
  private fft: FftAnalyzer
  private beatDetector: BeatDetector

  readonly width: number
  readonly height: number

  // 音频数据
  private samples: Float32Array | null = null
  private sampleRate = 0

  // 频谱渲染缓存
  private spectrumConfig: SpectrumConfig
  private rotatingHue = 260

  // 字幕状态
  private subtitleConfig: SubtitleConfig
  private lyrics: LyricLine[] = []
  private animState = {
    posX: 0, posY: 0, targetX: 0, targetY: 0,
    shakeX: 0, shakeY: 0, scale: 1, beatScaleTarget: 1,
    entranceProgress: 0, exitProgress: 0, isExiting: false,
    swayX: 0, swayY: 0, beatGlowEnergy: 0,
    subtitleGlowEnergy: 0, // 字幕独立辉光能量，避免与边缘辉光互相干扰
  }

  constructor(
    width: number, height: number,
    visualizerConfig: VisualizerConfig,
    spectrumConfig: SpectrumConfig,
    subtitleConfig: SubtitleConfig,
    lyrics: LyricLine[],
  ) {
    this.width = width
    this.height = height

    this.fluidCanvas = document.createElement('canvas')
    this.fluidCanvas.width = width
    this.fluidCanvas.height = height
    this.fluidCanvas.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:${height}px;opacity:0;pointer-events:none`
    document.body.appendChild(this.fluidCanvas)

    this.fft = new FftAnalyzer(1024)
    this.beatDetector = new BeatDetector()

    this.fluidEngine = new WebGLFluidEngine(this.fluidCanvas, visualizerConfig, true)
    this.fluidEngine.setDimensions(width, height)

    // 2D 合成画布（在流体之上绘制频谱和字幕），使用 DOM canvas 确保兼容
    this.compositeCanvas = document.createElement('canvas')
    this.compositeCanvas.width = width
    this.compositeCanvas.height = height
    const ctx = this.compositeCanvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not supported')
    this.ctx2d = ctx

    this.spectrumConfig = { ...spectrumConfig }
    this.subtitleConfig = { ...subtitleConfig }
    this.lyrics = lyrics

    console.log('[OfflineComposite] beatEdgeEnabled =', this.fluidEngine.config.beatEdgeEnabled, 'config =', JSON.stringify(visualizerConfig))
  }

  setAudioData(samples: Float32Array, sampleRate: number): void {
    this.samples = samples
    this.sampleRate = sampleRate
  }

  reset(): void {
    this.fluidEngine.resetState()
    this.beatDetector.reset()
    this.rotatingHue = this.spectrumConfig.hue
    this.animState = {
      posX: 0, posY: 0, targetX: 0, targetY: 0,
      shakeX: 0, shakeY: 0, scale: 1, beatScaleTarget: 1,
      entranceProgress: 0, exitProgress: 0, isExiting: false,
      swayX: 0, swayY: 0, beatGlowEnergy: 0,
      subtitleGlowEnergy: 0,
    }
  }

  /** 释放所有资源（WebGL 上下文、Canvas 等） */
  destroy(): void {
    this.fluidEngine.destroy()
    if (this.fluidCanvas.parentNode) {
      this.fluidCanvas.parentNode.removeChild(this.fluidCanvas)
    }
  }

  /** 预注入初始 splat 使流体快速可见（用于导出预热后） */
  primeFluid(): void {
    for (let i = 0; i < 3; i++) {
      // 用中等能量注入几波 splat，加速染料积累
      this.fluidEngine.triggerRandomSplat(8 + i * 4)
      this.fluidEngine.offlineStep(0.033, null, { isBeat: false, intensity: 0 })
    }
  }

  /**
   * 渲染一帧完整画面
   * @returns RGBA 像素数据 (Uint8ClampedArray)
   */
  renderFrame(timeSeconds: number, dt: number): Uint8ClampedArray {
    const spectrum = this.computeSpectrum(timeSeconds)
    const beat = spectrum ? this.beatDetector.detect(spectrum) : { isBeat: false, intensity: 0 }



    // 色相旋转
    if (this.spectrumConfig.hueRotate && this.spectrumConfig.enabled) {
      const speed = this.spectrumConfig.hueRotateSpeed ?? 1.0
      this.rotatingHue = ((this.rotatingHue + dt * speed * 30) % 360 + 360) % 360
    } else {
      this.rotatingHue = this.spectrumConfig.hue
    }

    // 同步色相给流体引擎
    if (this.spectrumConfig.enabled && this.spectrumConfig.colorMode === 'hue') {
      this.fluidEngine.config = {
        ...this.fluidEngine.config,
        hue: Math.round(this.rotatingHue),
      }
    }

    // 第1层：流体
    this.fluidEngine.offlineStep(dt, spectrum, beat)
    const fluidPixels = this.fluidEngine.captureFrame()

    // Debug
    if (timeSeconds < 0.2) {
      let nz = 0
      for (let i = 0; i < 100; i++) { if (fluidPixels[i] !== 0) nz++ }
      console.log(`[Composite] t=${timeSeconds.toFixed(3)} nz=${nz} e=${spectrum?.averageEnergy?.toFixed(4) ?? 'null'}`)
    }

    // 第2层：在 2D canvas 上绘制流体
    const ctx = this.ctx2d
    const w = this.width
    const h = this.height
    const imageData = ctx.createImageData(w, h)
    imageData.data.set(fluidPixels)
    ctx.putImageData(imageData, 0, 0)

    // 第3层：频谱可视化
    if (this.spectrumConfig.enabled && spectrum) {
      this.renderSpectrum(spectrum, timeSeconds)
    }

    // 第4层：字幕
    if (this.lyrics.length > 0) {
      this.renderSubtitle(timeSeconds, beat)
    }

    // 边缘鼓点辉光（匹配预览效果）
    const beatEdgeOn = this.fluidEngine.config.beatEdgeEnabled
    if (beatEdgeOn) {
      // Update beat glow energy with smoothing
      if (beat.isBeat && beat.intensity > 0.05) {
        // 与预览一致：鼓点瞬间拉到较高能量，确保边缘辉光明显可见
        this.animState.beatGlowEnergy = Math.max(0.65, beat.intensity * 1.3)
        if (timeSeconds < 2) console.log('[BeatEdge] BEAT', timeSeconds.toFixed(3), 'intensity', beat.intensity.toFixed(3), '-> glowEnergy', this.animState.beatGlowEnergy.toFixed(3))
      }
      this.animState.beatGlowEnergy *= 0.85
      if (this.animState.beatGlowEnergy < 0.003) this.animState.beatGlowEnergy = 0
      this.renderBeatEdgeGlow()
    } else {
      if (timeSeconds < 0.1) console.log('[BeatEdge] beatEdgeEnabled is FALSE in fluidEngine.config')
    }

    const result = ctx.getImageData(0, 0, w, h).data

    if (!(this as any)._pxChk && this.animState.beatGlowEnergy > 0.5) {
      (this as any)._pxChk = true
      const topPixel = ctx.getImageData(w / 2, 10, 1, 1).data
      const edgePixel = ctx.getImageData(5, h / 2, 1, 1).data
      console.log('[BeatEdge] Pixel check: top-center=', Array.from(topPixel), 'left-mid=', Array.from(edgePixel))
    }

    return result
  }

  // ========== 频谱计算 ==========

  private computeSpectrum(timeSeconds: number): SpectrumData | null {
    if (!this.samples || this.sampleRate === 0) return null

    const sampleIndex = Math.floor(timeSeconds * this.sampleRate)
    // 与预览 AudioEngine 的 AnalyserNode 对齐：
    // - FFT 1024 → 512 bins (AnalyserNode.fftSize = 1024)
    // - dB 范围 [-80, -10] (match analyser.minDecibels/maxDecibels)
    // - smoothingTimeConstant = 0 (无帧间平滑)
    // - 单窗口 FFT，不做多窗口 max-pooling（避免能量膨胀）
    const FFT_SIZE = 1024
    const HALF_SIZE = FFT_SIZE / 2 // 512 bins, matches AudioEngine
    const MIN_DB = -80
    const MAX_DB = -10
    const dbRange = MAX_DB - MIN_DB

    const offset = Math.max(0, sampleIndex - HALF_SIZE)
    const fftMag = this.fft.analyzeWindow(this.samples, offset, FFT_SIZE)

    const freqData = new Uint8Array(HALF_SIZE)
    for (let i = 0; i < HALF_SIZE; i++) {
      const mag = fftMag[i]
      let db: number
      if (mag <= 1e-10) {
        db = -120
      } else {
        db = 20 * Math.log10(mag)
      }
      const linear = Math.max(0, Math.min(255, Math.round(((db - MIN_DB) / dbRange) * 255)))
      freqData[i] = linear
    }

    // 时域波形（512 点，与 AudioEngine 对齐）
    const waveData = new Uint8Array(HALF_SIZE)
    for (let i = 0; i < HALF_SIZE; i++) {
      const idx = Math.max(0, sampleIndex - HALF_SIZE / 2 + i)
      if (idx < this.samples.length) {
        waveData[i] = Math.min(255, Math.floor(((this.samples[idx] + 1) / 2) * 255))
      }
    }

    // 平均能量 (0-1)，与 AudioEngine.getSpectrumData 计算方式一致
    let sum = 0
    for (let i = 0; i < freqData.length; i++) sum += freqData[i]
    const averageEnergy = sum / (freqData.length * 255)

    // 低频能量 (bassEnergy)：前 24 bin ≈ 0-1032 Hz @ 44100 Hz，与 AudioEngine 完全对齐
    // AnalyserNode: fftSize=1024 → 512 bin，bin 宽度 22050/512 ≈ 43 Hz
    // bin 0-23 ≈ 0-1032 Hz，覆盖底鼓+军鼓频段
    const bassBins = Math.min(24, freqData.length)
    let bassSum = 0
    for (let i = 0; i < bassBins; i++) bassSum += freqData[i]
    const bassEnergy = bassSum / (bassBins * 255)

    // drumEnergy: bin 1-10 ≈ 43-430 Hz (kick: 40-100Hz, snare: 200-500Hz, toms: 100-300Hz)
    const drumStart = 1
    const drumEnd = Math.min(10, freqData.length - 1)
    let drumSum = 0
    const drumCount = drumEnd - drumStart + 1
    for (let i = drumStart; i <= drumEnd; i++) drumSum += freqData[i]
    const drumEnergy = drumSum / (drumCount * 255)

    // melodicEnergy: bin 11+ (430 Hz+)，人声/乐器/和声
    const melodicStart = Math.min(11, freqData.length - 1)
    const melodicEnd = freqData.length - 1
    let melodicEnergy = 0
    if (melodicEnd > melodicStart) {
      let melodicSum = 0
      const melodicCount = melodicEnd - melodicStart + 1
      for (let i = melodicStart; i <= melodicEnd; i++) melodicSum += freqData[i]
      melodicEnergy = melodicSum / (melodicCount * 255)
    }

    // 每秒打印一次能量统计，方便对比预览
    if (!(this as any)._lastEnergyLog || timeSeconds - (this as any)._lastEnergyLog > 1) {
      (this as any)._lastEnergyLog = timeSeconds
      console.log('[Spectrum] t=' + timeSeconds.toFixed(1) + 's avgE=' + averageEnergy.toFixed(3) + ' bassE=' + bassEnergy.toFixed(3) + ' drumE=' + drumEnergy.toFixed(3) + ' melE=' + melodicEnergy.toFixed(3))
    }

    return { frequency: freqData, waveform: waveData, averageEnergy, bassEnergy, drumEnergy, melodicEnergy }
  }

  // ========== 节拍检测（使用 BeatDetector，与预览完全一致）==========

  // ========== 频谱渲染 ==========

  private renderSpectrum(spectrum: SpectrumData, timeSeconds: number): void {
    const ctx = this.ctx2d
    const w = this.width
    const h = this.height
    const freq = spectrum.frequency
    const cfg = this.spectrumConfig

    switch (cfg.style) {
      case 'bars': this.renderBars(ctx, w, h, freq, cfg); break
      case 'circular': this.renderCircular(ctx, w, h, freq, cfg); break
      case 'wave': this.renderWave(ctx, w, h, freq, cfg); break
      case 'mirror': this.renderMirror(ctx, w, h, freq, cfg); break
      case 'dots': this.renderDots(ctx, w, h, freq, cfg, timeSeconds); break
      default: this.renderBars(ctx, w, h, freq, cfg)
    }
  }

  private applySensitivity(value: number): number {
    if (value <= 0) return 0
    const gamma = 3.0 - this.spectrumConfig.sensitivity * 2.7
    return Math.pow(value, gamma)
  }

  private getSpectrumColor(i: number, total: number): string {
    const cfg = this.spectrumConfig
    switch (cfg.colorMode) {
      case 'hue':
        return `hsla(${this.rotatingHue}, 80%, 60%, ${cfg.opacity})`
      case 'custom':
        return cfg.customColor
      case 'auto':
      default: {
        const t = i / (total - 1)
        const hue = 240 - t * 280
        return `hsla(${((hue % 360) + 360) % 360}, ${70 + t * 30}%, ${50 + t * 20}%, ${cfg.opacity})`
      }
    }
  }

  private renderBars(
    ctx: CanvasRenderingContext2D,
    w: number, h: number, freq: Uint8Array, cfg: SpectrumConfig,
  ): void {
    const totalBars = Math.min(cfg.barCount, 128)
    const barWidth = w / totalBars
    const binSize = Math.floor(freq.length / totalBars)

    for (let i = 0; i < totalBars; i++) {
      let sum = 0
      const start = i * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255
      const boosted = this.applySensitivity(value)
      if (boosted < 0.01) continue

      const barH = Math.max(2, boosted * h * 0.85)
      const x = i * barWidth + barWidth * 0.15
      const y = h - barH
      const color = this.getSpectrumColor(i, totalBars)

      const gradient = ctx.createLinearGradient(x, y, x, h)
      gradient.addColorStop(0, color.replace(/[\d.]+\)$/, '1)'))
      gradient.addColorStop(0.6, color)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gradient
      this.roundRect(ctx, x, y, barWidth * 0.7, barH, Math.max(1, barWidth * 0.3))
      ctx.fill()

      if (boosted > 0.3) {
        ctx.fillStyle = color.replace(/[\d.]+\)$/, '1)')
        ctx.beginPath()
        ctx.arc(x + barWidth * 0.35, y + 2, barWidth * 0.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  private renderCircular(
    ctx: CanvasRenderingContext2D,
    w: number, h: number, freq: Uint8Array, cfg: SpectrumConfig,
  ): void {
    const cx = w / 2
    const cy = h / 2
    const maxRadius = Math.min(w, h) * 0.38
    const innerRadius = maxRadius * 0.2
    const count = cfg.barCount
    const binSize = Math.floor(freq.length / count)

    for (let i = 0; i < count; i++) {
      let sum = 0
      const start = i * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255
      const boosted = this.applySensitivity(value)
      if (boosted < 0.01) continue

      const angle = (i / count) * Math.PI * 2 - Math.PI / 2
      const barH = boosted * (maxRadius - innerRadius)
      const r1 = innerRadius
      const r2 = innerRadius + barH
      const color = this.getSpectrumColor(i, count)
      const x1 = cx + Math.cos(angle) * r1
      const y1 = cy + Math.sin(angle) * r1
      const x2 = cx + Math.cos(angle) * r2
      const y2 = cy + Math.sin(angle) * r2

      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, (maxRadius - innerRadius) / count * 1.2)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()

      if (boosted > 0.35) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)'
        ctx.beginPath()
        ctx.arc(x2, y2, ctx.lineWidth * 0.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  private renderWave(
    ctx: CanvasRenderingContext2D,
    w: number, h: number, freq: Uint8Array, cfg: SpectrumConfig,
  ): void {
    const count = cfg.barCount
    const binSize = Math.floor(freq.length / count)
    const points: { x: number; y: number }[] = []

    for (let i = 0; i <= count; i++) {
      const idx = Math.min(i, count - 1)
      let sum = 0
      const start = idx * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255
      const boosted = this.applySensitivity(value)
      points.push({ x: (i / count) * w, y: h * 0.5 - boosted * h * 0.4 })
    }

    const hue = this.rotatingHue
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (const p of points) ctx.lineTo(p.x, p.y)
    ctx.lineTo(w, h)
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, `hsla(${hue}, 80%, 60%, ${cfg.opacity * 0.5})`)
    grad.addColorStop(0.5, `hsla(${hue}, 60%, 40%, ${cfg.opacity * 0.3})`)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
    ctx.strokeStyle = `hsla(${hue}, 90%, 70%, ${cfg.opacity})`
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${cfg.opacity * 0.4})`
    ctx.lineWidth = 6
    ctx.stroke()
  }

  private renderMirror(
    ctx: CanvasRenderingContext2D,
    w: number, h: number, freq: Uint8Array, cfg: SpectrumConfig,
  ): void {
    const totalBars = cfg.barCount
    const barWidth = w / totalBars
    const binSize = Math.floor(freq.length / totalBars)
    const centerY = h / 2

    for (let i = 0; i < totalBars; i++) {
      let sum = 0
      const start = i * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255
      const boosted = this.applySensitivity(value)
      if (boosted < 0.01) continue

      const barH = Math.max(2, boosted * h * 0.42)
      const x = i * barWidth + barWidth * 0.15
      const color = this.getSpectrumColor(i, totalBars)
      const radius = Math.max(1, barWidth * 0.3)

      const upGrad = ctx.createLinearGradient(x, centerY - barH, x, centerY)
      upGrad.addColorStop(0, color.replace(/[\d.]+\)$/, '0.9)'))
      upGrad.addColorStop(1, color)
      ctx.fillStyle = upGrad
      this.roundRect(ctx, x, centerY - barH, barWidth * 0.7, barH, radius)
      ctx.fill()

      const downGrad = ctx.createLinearGradient(x, centerY, x, centerY + barH)
      downGrad.addColorStop(0, color)
      downGrad.addColorStop(1, color.replace(/[\d.]+\)$/, '0.3)'))
      ctx.fillStyle = downGrad
      this.roundRect(ctx, x, centerY, barWidth * 0.7, barH, radius)
      ctx.fill()
    }
  }

  private renderDots(
    ctx: CanvasRenderingContext2D,
    w: number, h: number, freq: Uint8Array, cfg: SpectrumConfig,
    timeSeconds: number,
  ): void {
    const count = cfg.barCount
    const binSize = Math.floor(freq.length / count)
    const maxRadius = Math.min(w, h) * 0.4
    const cx = w / 2
    const cy = h / 2
    // 使用音频时间戳，确保离线渲染可复现
    const t = timeSeconds

    for (let i = 0; i < count; i++) {
      let sum = 0
      const start = i * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255
      const boosted = this.applySensitivity(value)
      if (boosted < 0.02) continue

      const angle = (i / count) * Math.PI * 6 + t * 0.1
      const dist = 0.08 + (i / count) * 0.35
      const x = cx + Math.cos(angle) * maxRadius * dist + (boosted - 0.5) * 20
      const y = cy + Math.sin(angle) * maxRadius * dist * 0.7 + (boosted - 0.5) * 20
      const color = this.getSpectrumColor(i, count)
      const size = 2 + boosted * 8

      const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 2)
      glow.addColorStop(0, color.replace(/[\d.]+\)$/, '0.9)'))
      glow.addColorStop(0.4, color.replace(/[\d.]+\)$/, '0.4)'))
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(x, y, size * 2, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.beginPath()
      ctx.arc(x, y, size * 0.35, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ========== 字幕渲染 ==========

  private renderSubtitle(timeSeconds: number, beat: BeatResult): void {
    const cfg = this.subtitleConfig
    const ctx = this.ctx2d
    const w = this.width
    const h = this.height

    // 查找当前时间对应的歌词行
    let currentLyric: LyricLine | null = null
    let nextLyric: LyricLine | null = null
    for (let i = 0; i < this.lyrics.length; i++) {
      const line = this.lyrics[i]
      if (timeSeconds >= line.startTime) {
        currentLyric = line
        nextLyric = i + 1 < this.lyrics.length ? this.lyrics[i + 1] : null
      } else {
        break
      }
    }
    if (!currentLyric) return

    const endTime = nextLyric ? nextLyric.startTime : (currentLyric.startTime + 5)
    const fadeDuration = cfg.fadeDuration || 0.35

    // 计算入场/出场进度
    const entranceProgress = Math.min(1, (timeSeconds - currentLyric.startTime) / fadeDuration)
    const timeUntilEnd = endTime - timeSeconds
    const exitProgress = timeUntilEnd < fadeDuration ? 1 - Math.max(0, timeUntilEnd / fadeDuration) : 0
    const isExiting = exitProgress > 0

    // 更新动画状态（模拟前端动画系统）
    const as = this.animState
    if (entranceProgress < 1 || isExiting) {
      as.entranceProgress = entranceProgress
      as.exitProgress = exitProgress
      as.isExiting = isExiting
    } else {
      as.entranceProgress = 1
      as.exitProgress = 0
      as.isExiting = false
    }

    // 随机位置（仅在入场时）
    if (entranceProgress <= 0.01) {
      const margin = 0.1
      as.targetX = (margin + Math.random() * (1 - 2 * margin) * cfg.positionRandomness) * w
      as.targetY = h * 0.65 + (Math.random() - 0.5) * h * 0.15 * cfg.positionRandomness
      as.scale = 1
      as.beatScaleTarget = 1
    }

    // 节拍缩放
    if (beat.isBeat) {
      as.beatScaleTarget = cfg.beatScale
      as.subtitleGlowEnergy = beat.intensity
    }
    as.beatScaleTarget += (1 - as.beatScaleTarget) * 0.15
    as.scale += (as.beatScaleTarget - as.scale) * 0.2
    as.subtitleGlowEnergy *= 0.85

    // 抖动
    if (beat.isBeat) {
      as.shakeX = (Math.random() - 0.5) * cfg.shakeAmount * 2 * beat.intensity
      as.shakeY = (Math.random() - 0.5) * cfg.shakeAmount * 2 * beat.intensity
    } else {
      as.shakeX *= 0.85
      as.shakeY *= 0.85
    }

    // 摇曳（使用音频时间戳，确保离线渲染可复现且严格跟随音频）
    const t = timeSeconds * cfg.driftSpeed
    as.swayX = Math.sin(t * 1.3 + 0.5) * cfg.swayAmount
    as.swayY = Math.cos(t * 0.9 + 1.2) * cfg.swayAmount * 0.6

    // 位置平滑
    as.posX += (as.targetX - as.posX) * 0.3
    as.posY += (as.targetY - as.posY) * 0.3

    // 入场/出场滑动偏移（在 Canvas 上直接应用，而非 CSS transform）
    let slideOffsetX = 0
    let slideOffsetY = 0
    const ep = as.entranceProgress
    const xp = as.exitProgress
    const hasEntrance = (effect: string) => cfg.entranceEffect.includes(effect as any)
    const hasExit = (effect: string) => cfg.exitEffect.includes(effect as any)

    if (ep < 1 && !as.isExiting) {
      const ease = ep < 0.5 ? 2 * ep * ep : 1 - Math.pow(-2 * ep + 2, 2) / 2
      const offset = (1 - ease) * 80
      if (hasEntrance('slideUp')) slideOffsetY = offset
      if (hasEntrance('slideDown')) slideOffsetY = -offset
      if (hasEntrance('slideLeft')) slideOffsetX = offset
      if (hasEntrance('slideRight')) slideOffsetX = -offset
    }

    if (xp > 0) {
      const ease = xp < 0.5 ? 2 * xp * xp : 1 - Math.pow(-2 * xp + 2, 2) / 2
      const offset = ease * 80
      if (hasExit('slideUp')) slideOffsetY = -offset
      if (hasExit('slideDown')) slideOffsetY = offset
      if (hasExit('slideLeft')) slideOffsetX = -offset
      if (hasExit('slideRight')) slideOffsetX = offset
    }

    // 计算透明度
    let opacity = 1
    if (hasEntrance('fade') && ep < 1 && !as.isExiting) opacity = ep
    if (hasExit('fade') && xp > 0) opacity = 1 - xp

    // 模糊效果
    let blurPx = 0
    if (hasEntrance('blur') && ep < 1 && !as.isExiting) blurPx = (1 - ep) * 10
    if (hasExit('blur') && xp > 0) blurPx = xp * 10
    if (blurPx > 0) {
      ctx.filter = `blur(${blurPx}px)`
    }

    // 绘制
    ctx.save()

    const drawX = as.posX + as.shakeX + as.swayX + slideOffsetX
    const drawY = as.posY + as.shakeY + as.swayY + slideOffsetY

    ctx.translate(drawX, drawY)

    // 不缩放 ctx，而是直接调整字体大小，避免 Canvas 放大导致文字模糊
    const entranceScale = (0.3 + ep * 0.7)
    const effectiveScale = as.scale * entranceScale
    const effectiveFontSize = Math.round(cfg.fontSize * effectiveScale)
    const maxWidth = (cfg.maxWidth / 100) * w
    ctx.font = `${cfg.fontWeight} ${effectiveFontSize}px ${cfg.fontFamily === 'inherit' ? 'sans-serif' : cfg.fontFamily}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // 多层辉光模拟 CSS text-shadow 效果（三层叠加，从大到小）
    if (cfg.glowSize > 0 && cfg.glowIntensity > 0) {
      const glowAlpha = cfg.glowIntensity * opacity
      const beatGlow = as.subtitleGlowEnergy * 0.3
      const totalAlpha = glowAlpha + beatGlow
      const baseGlow = cfg.glowSize * (1 + as.subtitleGlowEnergy * 0.5)
      // 跟随流体色相动态调整 outerColor（与预览默认行为一致）
      const dynamicOuterColor = `hsl(${this.fluidEngine.config.hue}, 100%, 60%)`

      // 最外层：大模糊 + 低透明度，模拟 CSS 最外层辉光
      ctx.shadowColor = withAlpha(dynamicOuterColor, totalAlpha * 0.3)
      ctx.shadowBlur = baseGlow * 1.5
      ctx.fillStyle = withAlpha(dynamicOuterColor, totalAlpha * 0.15)
      ctx.fillText(currentLyric.text, 0, 0, maxWidth)

      // 中层：中等模糊
      ctx.shadowColor = withAlpha(dynamicOuterColor, totalAlpha * 0.5)
      ctx.shadowBlur = baseGlow * 0.7
      ctx.fillStyle = withAlpha(dynamicOuterColor, totalAlpha * 0.25)
      ctx.fillText(currentLyric.text, 0, 0, maxWidth)

      // 内层：紧凑辉光，接近文字本体
      ctx.shadowColor = withAlpha(dynamicOuterColor, totalAlpha)
      ctx.shadowBlur = baseGlow * 0.3
    }

    // 主文字层
    ctx.fillStyle = withAlpha(cfg.innerColor, opacity)
    ctx.fillText(currentLyric.text, 0, 0, maxWidth)

    ctx.restore()
    ctx.filter = 'none'
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  }

  // ========== 边缘鼓点辉光 ==========

  private renderBeatEdgeGlow(): void {
    const ctx = this.ctx2d
    const w = this.width
    const h = this.height
    const energy = this.animState.beatGlowEnergy
    if (energy < 0.005) return

    if (!(this as any)._bgd) { (this as any)._bgd = true; console.log('[BeatEdge] renderBeatEdgeGlow called, energy=' + energy.toFixed(4) + ' w=' + w + ' h=' + h) }

    const hue = this.fluidEngine.config.hue
    const eased = energy < 0.08 ? energy * 0.2 : 1 - Math.pow(1 - energy, 3)
    const alpha = Math.min(1, eased * 1.3)
    const maxGlowWidth = Math.min(w, h) * (this.fluidEngine.config.beatEdgeWidth ?? 0.12)
    const glowWidth = maxGlowWidth * eased

    ctx.save()
    const edges = [
      { x: 0, y: 0, ew: w, eh: glowWidth },
      { x: 0, y: h - glowWidth, ew: w, eh: glowWidth },
      { x: 0, y: 0, ew: glowWidth, eh: h },
      { x: w - glowWidth, y: 0, ew: glowWidth, eh: h },
    ]
    for (const edge of edges) {
      const isVert = edge.ew < edge.eh
      const grad = isVert
        ? ctx.createLinearGradient(edge.x === 0 ? 0 : w, 0, edge.x === 0 ? glowWidth : w - glowWidth, 0)
        : ctx.createLinearGradient(0, edge.y === 0 ? 0 : h, 0, edge.y === 0 ? glowWidth : h - glowWidth)
      grad.addColorStop(0, `hsla(${hue}, 100%, 80%, ${alpha})`)
      grad.addColorStop(0.15, `hsla(${hue}, 100%, 65%, ${alpha * 0.85})`)
      grad.addColorStop(0.4, `hsla(${hue}, 90%, 50%, ${alpha * 0.5})`)
      grad.addColorStop(0.7, `hsla(${hue}, 80%, 40%, ${alpha * 0.15})`)
      grad.addColorStop(1, 'transparent')
      ctx.fillStyle = grad
      ctx.fillRect(edge.x, edge.y, edge.ew, edge.eh)
    }
    ctx.restore()
  }

  // ========== 辅助 ==========

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
  ): void {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }
}

/** 将 CSS 颜色字符串转换为带自定义 alpha 的 rgba */
function withAlpha(color: string, alpha: number): string {
  // 简单解析 hex 或 rgba
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${alpha})`
  }
  // 尝试匹配 rgba(r,g,b,a)
  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/)
  if (rgbaMatch) {
    return `rgba(${rgbaMatch[1]},${rgbaMatch[2]},${rgbaMatch[3]},${alpha})`
  }
  return `rgba(255,255,255,${alpha})`
}
