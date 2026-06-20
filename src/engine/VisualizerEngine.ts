import type { BeatResult, Particle, SpectrumData, VisualizerConfig } from '../types'

/**
 * 可视化渲染引擎：在 Canvas 上绘制粒子特效、辉光、节奏抖动
 */
export class VisualizerEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private particles: Particle[] = []
  private animFrameId = 0

  /** 画布逻辑尺寸 */
  private width = 0
  private height = 0

  /** 累计抖动偏移 */
  private shakeX = 0
  private shakeY = 0

  /** 配置 */
  config: VisualizerConfig = {
    particleCount: 200,
    glowIntensity: 1.0,
    shakeIntensity: 1.0,
    hue: 260,
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context not supported')
    this.ctx = ctx
    this.resize()
  }

  /** 调整画布尺寸以适应容器 */
  resize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.width = rect.width
    this.height = rect.height
    this.canvas.width = rect.width * dpr
    this.canvas.height = rect.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** 开始渲染循环 */
  start(
    getSpectrum: () => SpectrumData | null,
    getBeat: () => BeatResult,
  ): void {
    const loop = () => {
      const spectrum = getSpectrum()
      const beat = getBeat()

      // 更新粒子
      if (spectrum) {
        this.updateParticles(spectrum, beat)
      }

      // 更新抖动
      this.updateShake(beat)

      // 渲染
      this.render(spectrum, beat)

      this.animFrameId = requestAnimationFrame(loop)
    }
    loop()
  }

  /** 停止渲染循环 */
  stop(): void {
    cancelAnimationFrame(this.animFrameId)
    this.particles = []
    this.shakeX = 0
    this.shakeY = 0
  }

  // ==================== 粒子系统 ====================

  /** 生成新粒子 */
  private spawnParticle(spectrum: SpectrumData): Particle {
    const cx = this.width / 2
    const cy = this.height * 0.7
    const angle = Math.random() * Math.PI * 2
    const speed = 0.5 + (spectrum.averageEnergy * 4 + Math.random() * 2)
    const hue = this.config.hue + (Math.random() - 0.5) * 50

    return {
      x: cx + (Math.random() - 0.5) * 60,
      y: cy + (Math.random() - 0.5) * 40,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1,
      life: 1,
      maxLife: 0.6 + Math.random() * 0.8,
      size: 1 + spectrum.averageEnergy * 4 + Math.random() * 3,
      hue,
      alpha: 0.6 + Math.random() * 0.4,
    }
  }

  /** 批量生成粒子 */
  private updateParticles(spectrum: SpectrumData, beat: BeatResult): void {
    // 每帧生成的粒子数，随能量动态变化
    const spawnRate = 3 + spectrum.averageEnergy * 12
    const toSpawn = beat.isBeat ? spawnRate * 3 : spawnRate

    for (let i = 0; i < toSpawn; i++) {
      if (this.particles.length < this.config.particleCount) {
        this.particles.push(this.spawnParticle(spectrum))
      }
    }

    // 更新现有粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx
      p.y += p.vy

      // 阻力/重力
      p.vx *= 0.99
      p.vy *= 0.99
      p.vy += 0.02 // 轻微重力

      p.life -= 1 / (p.maxLife * 60) // 约在 maxLife 秒内消亡

      // 移除死亡粒子
      if (p.life <= 0) {
        // 将最后一个粒子移到当前位置（swap-remove 思想）
        this.particles[i] = this.particles[this.particles.length - 1]
        this.particles.pop()
      }
    }
  }

  // ==================== 抖动系统 ====================

  private updateShake(beat: BeatResult): void {
    if (beat.isBeat) {
      const maxShake = 12 * this.config.shakeIntensity
      this.shakeX = (Math.random() - 0.5) * maxShake * beat.intensity
      this.shakeY = (Math.random() - 0.5) * maxShake * beat.intensity
    } else {
      // 衰减抖动
      this.shakeX *= 0.85
      this.shakeY *= 0.85
    }
  }

  // ==================== 渲染 ====================

  private render(spectrum: SpectrumData | null, beat: BeatResult): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height

    // 清屏（带半透明残留，产生拖尾效果）
    ctx.fillStyle = 'rgba(10, 10, 20, 0.25)'
    ctx.fillRect(0, 0, w, h)

    ctx.save()

    // 应用抖动变换
    ctx.translate(this.shakeX, this.shakeY)

    if (spectrum) {
      // 绘制辉光
      this.renderGlow(spectrum, beat)
    }

    // 绘制粒子
    this.renderParticles()

    ctx.restore()
  }

  /** 辉光效果 */
  private renderGlow(spectrum: SpectrumData, beat: BeatResult): void {
    const ctx = this.ctx
    const cx = this.width / 2
    const cy = this.height * 0.7
    const energy = spectrum.averageEnergy
    const beatBoost = beat.isBeat ? 1 + beat.intensity * 0.5 : 1

    const glowRadius =
      (80 + energy * 160) * this.config.glowIntensity * beatBoost

    // 外层辉光
    const outerGradient = ctx.createRadialGradient(cx, cy, glowRadius * 0.3, cx, cy, glowRadius)
    outerGradient.addColorStop(0, `hsla(${this.config.hue}, 100%, 60%, ${0.4 * energy * beatBoost})`)
    outerGradient.addColorStop(0.5, `hsla(${this.config.hue + 40}, 100%, 50%, ${0.15 * energy * beatBoost})`)
    outerGradient.addColorStop(1, 'transparent')

    ctx.fillStyle = outerGradient
    ctx.fillRect(cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2)

    // 核心亮点（在节拍时更亮）
    if (beat.isBeat || energy > 0.3) {
      const coreGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius * 0.4)
      coreGradient.addColorStop(0, `rgba(255, 255, 255, ${0.3 + beat.intensity * 0.5})`)
      coreGradient.addColorStop(1, 'transparent')
      ctx.fillStyle = coreGradient
      ctx.fillRect(cx - glowRadius * 0.4, cy - glowRadius * 0.4, glowRadius * 0.8, glowRadius * 0.8)
    }
  }

  /** 粒子渲染 */
  private renderParticles(): void {
    const ctx = this.ctx

    for (const p of this.particles) {
      const alpha = p.alpha * p.life
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)

      // 粒子辉光
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3)
      gradient.addColorStop(0, `hsla(${p.hue}, 100%, 70%, ${alpha})`)
      gradient.addColorStop(0.3, `hsla(${p.hue}, 100%, 60%, ${alpha * 0.6})`)
      gradient.addColorStop(1, 'transparent')

      ctx.fillStyle = gradient
      ctx.fill()
    }

    // 混合模式让粒子叠加产生更亮的效果
    ctx.globalCompositeOperation = 'lighter'

    for (const p of this.particles) {
      if (p.size > 2) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${p.hue}, 100%, 85%, ${p.alpha * p.life * 0.5})`
        ctx.fill()
      }
    }

    ctx.globalCompositeOperation = 'source-over'
  }
}
