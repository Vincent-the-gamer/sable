import type { BeatResult, SpectrumData, VisualizerConfig } from '../types'

/**
 * 全屏 Canvas 2D 粒子引擎
 *
 * 特点：
 * - 全屏粒子系统（500+ 粒子，按音频频谱分布）
 * - 8 个频段映射到屏幕不同位置（低频→底部中心，高频→上方两侧）
 * - 粒子带有径向渐变辉光 + additive blending
 * - 节拍检测触发爆发效果
 * - 拖尾效果（半透明清屏）
 * - 频谱波形底部展示
 */

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  hue: number
  saturation: number
  lightness: number
  alpha: number
}

interface Emitter {
  x: number
  y: number
  angle: number
  frequencyBand: number
}

export class ParticleEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private particles: Particle[] = []
  private emitters: Emitter[] = []
  private animFrameId = 0
  private running = false
  private time = 0

  private width = 0
  private height = 0

  config: VisualizerConfig

  private beatEnergy = 0

  constructor(canvas: HTMLCanvasElement, config: VisualizerConfig) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not supported')
    this.ctx = ctx
    this.config = { ...config }
    this.resize()
    this.initEmitters()
  }

  private initEmitters() {
    this.emitters = []
    // 8 个频段发射器，分布在全屏不同位置
    const bands = 8
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1)
      // 低频靠近底部中心，高频靠近顶部两侧
      const angle = (t - 0.5) * Math.PI * 1.1
      const radius = 0.12 + t * 0.38
      this.emitters.push({
        x: 0.5 + Math.cos(angle) * radius,
        y: 0.65 - t * 0.55,
        angle,
        frequencyBand: i,
      })
    }
    // 中心能量源
    this.emitters.push({
      x: 0.5,
      y: 0.5,
      angle: -Math.PI / 2,
      frequencyBand: -1, // 特殊标记：平均能量
    })
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.floor(rect.width * dpr)
    const h = Math.floor(rect.height * dpr)
    if (w <= 0 || h <= 0) return
    this.width = w
    this.height = h
    this.canvas.width = w
    this.canvas.height = h
  }

  start(
    getSpectrum: () => SpectrumData | null,
    getBeat: () => BeatResult,
  ): void {
    if (this.running) return
    this.running = true

    // 确保 canvas 有尺寸
    if (this.width === 0) this.resize()

    let lastTime = performance.now()

    const loop = () => {
      if (!this.running) return
      const now = performance.now()
      const dt = Math.min((now - lastTime) / 1000, 1 / 30)
      lastTime = now
      this.time += dt

      const spectrum = getSpectrum()
      const beat = getBeat()

      if (spectrum) {
        this.update(spectrum, beat, dt)
      } else {
        // 空闲时也更新（粒子衰减）
        this.updateIdle(dt)
      }

      this.render(spectrum)

      this.animFrameId = requestAnimationFrame(loop)
    }
    loop()
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.animFrameId)
    this.particles = []
  }

  // ═══════════ 更新粒子 ═══════════

  private update(spectrum: SpectrumData, beat: BeatResult, dt: number) {
    const freq = spectrum.frequency
    const energy = spectrum.averageEnergy

    // 更新节拍能量（带衰减）
    if (beat.isBeat) {
      this.beatEnergy = beat.intensity
    }
    this.beatEnergy *= 0.92

    // 每个频段发射粒子
    const bandSize = Math.floor(freq.length / 8)
    for (const emitter of this.emitters) {
      let bandEnergy: number

      if (emitter.frequencyBand === -1) {
        bandEnergy = energy
      } else {
        const start = emitter.frequencyBand * bandSize
        const end = start + bandSize
        let sum = 0
        for (let i = start; i < end && i < freq.length; i++) sum += freq[i]
        bandEnergy = sum / (bandSize * 255)
      }

      if (bandEnergy < 0.05) continue

      // 根据能量发射粒子
      const spawnRate = 1 + bandEnergy * 8
      const toSpawn = beat.isBeat ? spawnRate * 4 : spawnRate

      for (let i = 0; i < toSpawn; i++) {
        if (this.particles.length >= this.config.particleCount) break
        this.spawnParticle(emitter, bandEnergy, beat)
      }
    }

    // 节拍爆发（全屏环形粒子）
    if (beat.isBeat) {
      const burstCount = 30 + Math.floor(beat.intensity * 40)
      for (let i = 0; i < burstCount; i++) {
        if (this.particles.length >= this.config.particleCount) break
        this.spawnBurstParticle(beat)
      }
    }

    // 更新所有粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx * dt * 60
      p.y += p.vy * dt * 60

      // 阻力
      p.vx *= 0.985
      p.vy *= 0.985

      // 轻微重力
      p.vy += 0.03 * dt * 60

      // 衰减
      p.life -= dt / p.maxLife

      // 移除死亡粒子
      if (p.life <= 0) {
        this.particles[i] = this.particles[this.particles.length - 1]
        this.particles.pop()
      }
    }
  }

  private updateIdle(dt: number) {
    this.beatEnergy *= 0.9

    // 更新现有粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx * dt * 60
      p.y += p.vy * dt * 60
      p.vx *= 0.98
      p.vy *= 0.98
      p.vy += 0.02 * dt * 60
      p.life -= dt / p.maxLife
      if (p.life <= 0) {
        this.particles[i] = this.particles[this.particles.length - 1]
        this.particles.pop()
      }
    }
  }

  private spawnParticle(emitter: Emitter, energy: number, _beat: BeatResult) {
    const [minHue, maxHue] = this.config.hueRange
    const hueRange = maxHue - minHue

    // 频段决定色调
    const bandT = emitter.frequencyBand === -1 ? 0.5 : emitter.frequencyBand / 7
    const hue = minHue + bandT * hueRange

    // 速度方向：从发射点向外扩散
    const angle = emitter.angle + (Math.random() - 0.5) * Math.PI * 0.8
    const speed = 1.5 + energy * 8 + Math.random() * 3

    const cx = emitter.x * this.width
    const cy = emitter.y * this.height

    this.particles.push({
      x: cx + (Math.random() - 0.5) * 40,
      y: cy + (Math.random() - 0.5) * 30,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      maxLife: 0.5 + Math.random() * 1.5 + energy * 1,
      size: 1.5 + energy * 6 + Math.random() * 3,
      hue: hue + (Math.random() - 0.5) * 30,
      saturation: 0.6 + Math.random() * 0.4,
      lightness: 0.4 + energy * 0.4 + Math.random() * 0.2,
      alpha: 0.5 + energy * 0.5,
    })
  }

  private spawnBurstParticle(beat: BeatResult) {
    const [minHue, maxHue] = this.config.hueRange
    const hue = minHue + Math.random() * (maxHue - minHue)
    const angle = Math.random() * Math.PI * 2
    const dist = 0.05 + Math.random() * 0.25
    const speed = 5 + beat.intensity * 25

    this.particles.push({
      x: this.width * (0.5 + Math.cos(angle) * dist),
      y: this.height * (0.5 + Math.sin(angle) * dist),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      maxLife: 0.3 + Math.random() * 0.7,
      size: 2 + beat.intensity * 8 + Math.random() * 5,
      hue,
      saturation: 0.8,
      lightness: 0.5 + beat.intensity * 0.4,
      alpha: 0.7 + beat.intensity * 0.3,
    })
  }

  // ═══════════ 渲染 ═══════════

  private render(spectrum: SpectrumData | null) {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    if (w <= 0 || h <= 0) return

    // 半透明清屏 → 拖尾效果
    ctx.fillStyle = 'rgba(8, 8, 18, 0.28)'
    ctx.fillRect(0, 0, w, h)

    const energy = spectrum?.averageEnergy ?? 0.1
    const [minHue, maxHue] = this.config.hueRange

    // ═══ 背景辉光 ═══
    const glowRadius = (120 + energy * 200 + this.beatEnergy * 150) * this.config.glowIntensity
    const cx = w * 0.5
    const cy = h * 0.45

    const glowGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius)
    glowGrad.addColorStop(0, `hsla(${minHue}, 80%, 50%, ${0.15 + energy * 0.25})`)
    glowGrad.addColorStop(0.4, `hsla(${(minHue + maxHue) / 2}, 70%, 40%, ${energy * 0.15})`)
    glowGrad.addColorStop(1, 'transparent')
    ctx.fillStyle = glowGrad
    ctx.fillRect(cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2)

    // ═══ 发射点辉光 ═══
    for (const emitter of this.emitters) {
      const ex = emitter.x * w
      const ey = emitter.y * h
      const eGlow = ctx.createRadialGradient(ex, ey, 0, ex, ey, 25 + energy * 30)
      eGlow.addColorStop(0, `hsla(${minHue}, 60%, 60%, ${0.1 + energy * 0.15})`)
      eGlow.addColorStop(1, 'transparent')
      ctx.fillStyle = eGlow
      ctx.fillRect(ex - 30, ey - 30, 60, 60)
    }

    // ═══ 粒子 ═══
    this.renderParticles()

    // ═══ 节拍闪光 ═══
    if (this.beatEnergy > 0.05) {
      const flashAlpha = this.beatEnergy * 0.12
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`
      ctx.fillRect(0, 0, w, h)
    }
  }

  private renderParticles() {
    const ctx = this.ctx

    // 第一遍：粒子的外层辉光
    for (const p of this.particles) {
      const alpha = p.alpha * p.life
      if (alpha < 0.02) continue
      const r = p.size * 3

      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
      grad.addColorStop(0, `hsla(${p.hue}, ${p.saturation * 100}%, ${p.lightness * 100}%, ${alpha * 0.6})`)
      grad.addColorStop(0.4, `hsla(${p.hue}, ${p.saturation * 100}%, ${p.lightness * 80}%, ${alpha * 0.3})`)
      grad.addColorStop(1, 'transparent')

      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // 第二遍：additive blending 让亮点叠加
    ctx.globalCompositeOperation = 'lighter'

    for (const p of this.particles) {
      const alpha = p.alpha * p.life
      if (alpha < 0.05) continue

      // 明亮核心
      const coreR = p.size * 0.6
      ctx.fillStyle = `hsla(${p.hue}, ${p.saturation * 100}%, ${p.lightness * 100 + 20}%, ${alpha * 0.7})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, coreR, 0, Math.PI * 2)
      ctx.fill()

      // 高光中心
      if (p.size > 2) {
        ctx.fillStyle = `hsla(${p.hue}, ${p.saturation * 50}%, 95%, ${alpha * 0.5})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, coreR * 0.35, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.globalCompositeOperation = 'source-over'
  }
}
