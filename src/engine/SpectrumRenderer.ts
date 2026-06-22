import type { SpectrumData, SpectrumConfig } from '../types'

/**
 * 音频频谱可视化渲染器
 *
 * 支持多种样式：
 * - bars: 经典柱状频谱
 * - circular: 环形径向频谱
 * - wave: 波形曲线
 * - mirror: 镜像对称柱状
 * - dots: 星点散落
 */
export class SpectrumRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private animFrameId = 0
  private running = false
  private rotatingHue = 260
  private lastTime = 0

  config: SpectrumConfig

  constructor(canvas: HTMLCanvasElement, config: SpectrumConfig) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context not supported')
    this.ctx = ctx
    this.config = { ...config }
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

  start(getSpectrum: () => SpectrumData | null): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()

    const loop = () => {
      if (!this.running) return

      // 动态色相旋转
      const now = performance.now()
      const dt = Math.min((now - this.lastTime) / 1000, 0.1)
      this.lastTime = now
      if (this.config.hueRotate) {
        const speed = this.config.hueRotateSpeed ?? 1.0
        this.rotatingHue = ((this.rotatingHue + dt * speed * 30) % 360 + 360) % 360
      } else {
        this.rotatingHue = this.config.hue
      }

      if (this.config.enabled) {
        const spectrum = getSpectrum()
        if (spectrum) {
          this.render(spectrum)
        } else {
          this.clear()
        }
      } else {
        this.clear()
      }

      this.animFrameId = requestAnimationFrame(loop)
    }
    loop()
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.animFrameId)
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height)
  }

  // ═══════════ 渲染调度 ═══════════

  private render(spectrum: SpectrumData): void {
    // 完全透明清屏，让底层流体透出
    this.ctx.clearRect(0, 0, this.width, this.height)
    switch (this.config.style) {
      case 'bars':
        this.renderBars(spectrum)
        break
      case 'circular':
        this.renderCircular(spectrum)
        break
      case 'wave':
        this.renderWave(spectrum)
        break
      case 'mirror':
        this.renderMirror(spectrum)
        break
      case 'dots':
        this.renderDots(spectrum)
        break
      default:
        this.renderBars(spectrum)
    }
  }

  // ═══════════ 颜色获取 ═══════════

  /**
   * 根据频段索引获取颜色
   * @param i 频段索引 (0 ~ barCount-1)
   * @param hue 基础色相
   */
  private getColor(i: number, total: number, hue: number): string {
    switch (this.config.colorMode) {
      case 'hue':
        return `hsla(${hue}, 80%, 60%, ${this.config.opacity})`
      case 'custom':
        return this.config.customColor
      case 'auto':
      default: {
        // 低频冷色 → 高频暖色渐变
        const t = i / (total - 1)
        const h = 240 - t * 280 // 蓝紫 (240) → 品红/红 (0/360)
        const s = 70 + t * 30
        const l = 50 + t * 20
        return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${this.config.opacity})`
      }
    }
  }

  // ═══════════ 柱状频谱 ═══════════

  private renderBars(spectrum: SpectrumData): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    const freq = spectrum.frequency
    const count = this.config.sensitivity < 0.5
      ? this.config.barCount
      : Math.floor(this.config.barCount * (1 + (this.config.sensitivity - 0.5)))

    // 不再填充背景：频谱叠加在流体之上，透明区域让流体透出

    const totalBars = Math.min(count, 128)
    const barWidth = w / totalBars
    const binSize = Math.floor(freq.length / totalBars)

    for (let i = 0; i < totalBars; i++) {
      let sum = 0
      const start = i * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255

      // 灵敏度调节：低灵敏度压缩低值，高灵敏度放大低值
      const boosted = this.applySensitivity(value)
      if (boosted < 0.01) continue

      const barH = Math.max(2, boosted * h * 0.85)
      const x = i * barWidth + barWidth * 0.15
      const y = h - barH

      const hue = this.rotatingHue
      const color = this.getColor(i, totalBars, hue)

      // 辉光效果
      const glowGrad = ctx.createLinearGradient(x, y, x, h)
      glowGrad.addColorStop(0, color.replace(/[\d.]+\)$/, '1)'))
      glowGrad.addColorStop(0.6, color)
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glowGrad

      const radius = Math.max(1, barWidth * 0.3)
      this.roundRect(ctx, x, y, barWidth * 0.7, barH, radius)
      ctx.fill()

      // 顶部亮点
      if (boosted > 0.3) {
        ctx.fillStyle = color.replace(/[\d.]+\)$/, '1)')
        ctx.beginPath()
        ctx.arc(x + barWidth * 0.35, y + 2, barWidth * 0.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // ═══════════ 环形频谱 ═══════════

  private renderCircular(spectrum: SpectrumData): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    const freq = spectrum.frequency

    const cx = w / 2
    const cy = h / 2
    const maxRadius = Math.min(w, h) * 0.38
    const innerRadius = maxRadius * 0.2
    const count = this.config.barCount
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

      const x1 = cx + Math.cos(angle) * r1
      const y1 = cy + Math.sin(angle) * r1
      const x2 = cx + Math.cos(angle) * r2
      const y2 = cy + Math.sin(angle) * r2

      const color = this.getColor(i, count, this.rotatingHue)

      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, (maxRadius - innerRadius) / count * 1.2)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()

      // 外端亮点
      if (boosted > 0.35) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
        ctx.beginPath()
        ctx.arc(x2, y2, ctx.lineWidth * 0.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // 中心辉光 (随能量)
    const energy = spectrum.averageEnergy
    const centerGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerRadius * 1.5)
    centerGlow.addColorStop(0, `rgba(255, 255, 255, ${0.05 + energy * 0.15})`)
    centerGlow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = centerGlow
    ctx.beginPath()
    ctx.arc(cx, cy, innerRadius * 1.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // ═══════════ 波形曲线 ═══════════

  private renderWave(spectrum: SpectrumData): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    const freq = spectrum.frequency

    const count = this.config.barCount
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

      const x = (i / count) * w
      const y = h * 0.5 - boosted * h * 0.4
      points.push({ x, y })
    }

    const hue = this.rotatingHue

    // 绘制填充波形
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (const p of points) {
      ctx.lineTo(p.x, p.y)
    }
    ctx.lineTo(w, h)
    ctx.closePath()

    const fillGrad = ctx.createLinearGradient(0, 0, 0, h)
    fillGrad.addColorStop(0, `hsla(${hue}, 80%, 60%, ${this.config.opacity * 0.5})`)
    fillGrad.addColorStop(0.5, `hsla(${hue}, 60%, 40%, ${this.config.opacity * 0.3})`)
    fillGrad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = fillGrad
    ctx.fill()

    // 绘制顶部轮廓线
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y)
    }
    ctx.strokeStyle = `hsla(${hue}, 90%, 70%, ${this.config.opacity})`
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()

    // 发光轮廓
    ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${this.config.opacity * 0.4})`
    ctx.lineWidth = 6
    ctx.stroke()
  }

  // ═══════════ 镜像柱状 ═══════════

  private renderMirror(spectrum: SpectrumData): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    const freq = spectrum.frequency

    const totalBars = this.config.barCount
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

      const color = this.getColor(i, totalBars, this.rotatingHue)

      // 上半部分
      const upGrad = ctx.createLinearGradient(x, centerY - barH, x, centerY)
      upGrad.addColorStop(0, color.replace(/[\d.]+\)$/, '0.9)'))
      upGrad.addColorStop(1, color)
      ctx.fillStyle = upGrad
      const radius = Math.max(1, barWidth * 0.3)
      this.roundRect(ctx, x, centerY - barH, barWidth * 0.7, barH, radius)
      ctx.fill()

      // 下半部分 (镜像)
      const downGrad = ctx.createLinearGradient(x, centerY, x, centerY + barH)
      downGrad.addColorStop(0, color)
      downGrad.addColorStop(1, color.replace(/[\d.]+\)$/, '0.3)'))
      ctx.fillStyle = downGrad
      this.roundRect(ctx, x, centerY, barWidth * 0.7, barH, radius)
      ctx.fill()
    }

    // 中线辉光
    const lineGlow = ctx.createLinearGradient(0, centerY - 2, 0, centerY + 2)
    lineGlow.addColorStop(0, 'rgba(255,255,255,0)')
    lineGlow.addColorStop(0.5, `rgba(255,255,255,${0.1 + spectrum.averageEnergy * 0.3})`)
    lineGlow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = lineGlow
    ctx.fillRect(0, centerY - 3, w, 6)
  }

  // ═══════════ 星点 ═══════════

  private renderDots(spectrum: SpectrumData): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    const freq = spectrum.frequency

    const count = this.config.barCount
    const binSize = Math.floor(freq.length / count)
    const maxRadius = Math.min(w, h) * 0.4
    const cx = w / 2
    const cy = h / 2

    for (let i = 0; i < count; i++) {
      let sum = 0
      const start = i * binSize
      const end = Math.min(start + binSize, freq.length)
      for (let j = start; j < end; j++) sum += freq[j]
      const value = sum / (end - start) / 255
      const boosted = this.applySensitivity(value)
      if (boosted < 0.02) continue

      // 螺旋散布
      const angle = (i / count) * Math.PI * 6 + performance.now() * 0.0001
      const dist = 0.08 + (i / count) * 0.35
      const x = cx + Math.cos(angle) * maxRadius * dist + (boosted - 0.5) * 20
      const y = cy + Math.sin(angle) * maxRadius * dist * 0.7 + (boosted - 0.5) * 20

      const color = this.getColor(i, count, this.rotatingHue)
      const size = 2 + boosted * 8

      // 辉光
      const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 2)
      glow.addColorStop(0, color.replace(/[\d.]+\)$/, '0.9)'))
      glow.addColorStop(0.4, color.replace(/[\d.]+\)$/, '0.4)'))
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(x, y, size * 2, 0, Math.PI * 2)
      ctx.fill()

      // 核心
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.beginPath()
      ctx.arc(x, y, size * 0.35, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ═══════════ 工具 ═══════════

  private applySensitivity(value: number): number {
    if (value <= 0) return 0
    // sensitivity 0→1 映射到 gamma 3→0.3
    // 低 sensitivity = 高 gamma = 只显示高能量
    // 高 sensitivity = 低 gamma = 连低能量也显示
    const gamma = 3.0 - this.config.sensitivity * 2.7
    return Math.pow(value, gamma)
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    w: number, h: number,
    r: number,
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
