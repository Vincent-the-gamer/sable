import type { Particle, VisualizerConfig } from '../types'
import { FftAnalyzer } from './FftAnalyzer'

/**
 * 离线帧渲染器：在 OffscreenCanvas 上逐帧渲染特效
 * 用于视频导出，不依赖 DOM 或 requestAnimationFrame
 */
export class OfflineRenderer {
  private canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private fft: FftAnalyzer
  private particles: Particle[] = []
  private shakeX = 0
  private shakeY = 0

  readonly width: number
  readonly height: number
  config: VisualizerConfig

  /** PCM 采样数据（f32, -1..1） */
  private samples: Float32Array | null = null
  private sampleRate = 0

  constructor(width: number, height: number, config: VisualizerConfig) {
    this.width = width
    this.height = height
    this.config = { ...config }

    this.canvas = new OffscreenCanvas(width, height)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('OffscreenCanvas 2D 不支持')
    this.ctx = ctx

    this.fft = new FftAnalyzer(256)
  }

  /** 设置音频源数据 */
  setAudioData(samples: Float32Array, sampleRate: number): void {
    this.samples = samples
    this.sampleRate = sampleRate
  }

  /** 重置粒子状态（开始新视频时调用） */
  reset(): void {
    this.particles = []
    this.shakeX = 0
    this.shakeY = 0
  }

  /**
   * 渲染一帧
   * @param timeSeconds - 当前帧对应的时间（秒）
   * @returns RGBA 像素数据
   */
  renderFrame(timeSeconds: number): Uint8ClampedArray {
    const ctx = this.ctx
    const w = this.width
    const h = this.height

    // 根据时间戳计算频谱数据
    const spectrum = this.computeSpectrum(timeSeconds)

    // 节拍检测
    const beat = this.detectBeat(spectrum)

    // 更新粒子
    this.updateParticles(spectrum, beat)

    // 更新抖动
    this.updateShake(beat)

    // ---- 渲染到 OffscreenCanvas ----
    // 清屏（带拖尾）
    ctx.fillStyle = 'rgba(10, 10, 20, 0.25)'
    ctx.fillRect(0, 0, w, h)

    ctx.save()
    ctx.translate(this.shakeX, this.shakeY)

    // 辉光
    this.renderGlow(spectrum, beat)

    // 粒子
    this.renderParticles()

    ctx.restore()

    return ctx.getImageData(0, 0, w, h).data
  }

  // ========== 频谱计算 ==========

  private computeSpectrum(timeSeconds: number) {
    if (!this.samples || this.sampleRate === 0) {
      return {
        frequency: new Uint8Array(128),
        waveform: new Uint8Array(128),
        averageEnergy: 0,
        bassEnergy: 0,
      }
    }

    const sampleIndex = Math.floor(timeSeconds * this.sampleRate)

    // FFT 频谱
    const fftMag = this.fft.analyzeWindow(this.samples, Math.max(0, sampleIndex - 128))
    const freqData = new Uint8Array(128)
    for (let i = 0; i < 128; i++) {
      freqData[i] = Math.min(255, fftMag[i] * 255 * 3)
    }

    // 时域波形
    const waveData = new Uint8Array(128)
    for (let i = 0; i < 128; i++) {
      const idx = Math.max(0, sampleIndex - 64 + i)
      if (idx < this.samples.length) {
        waveData[i] = Math.min(255, ((this.samples[idx] + 1) / 2) * 255)
      }
    }

    // 平均能量
    let sum = 0
    for (let i = 0; i < freqData.length; i++) sum += freqData[i]
    const averageEnergy = sum / (freqData.length * 255)

    // 低频能量
    const bassBins = Math.floor(freqData.length / 4)
    let bassSum = 0
    for (let i = 0; i < bassBins; i++) bassSum += freqData[i]
    const bassEnergy = bassSum / (bassBins * 255)

    return { frequency: freqData, waveform: waveData, averageEnergy, bassEnergy }
  }

  // ========== 节拍检测（简化版） ==========
  private energyHistory: number[] = []
  private cooldownCounter = 0
  private lastIntensity = 0

  private detectBeat(spectrum: ReturnType<OfflineRenderer['computeSpectrum']>) {
    const bassEnergy = spectrum.bassEnergy
    this.energyHistory.push(bassEnergy)
    if (this.energyHistory.length > 60) this.energyHistory.shift()
    if (this.cooldownCounter > 0) this.cooldownCounter--

    const avg = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length
    const isBeat =
      this.cooldownCounter === 0 &&
      this.energyHistory.length >= 10 &&
      bassEnergy > avg * 1.4 &&
      bassEnergy > 0.15

    if (isBeat) {
      this.cooldownCounter = 12
      this.lastIntensity = Math.min(1, (bassEnergy - avg * 1.4) / (1 - avg * 1.4))
      return { isBeat: true, intensity: this.lastIntensity }
    }

    this.lastIntensity *= 0.9
    return { isBeat: false, intensity: this.lastIntensity }
  }

  // ========== 粒子系统 ==========

  private spawnParticle(energy: number): Particle {
    const cx = this.width / 2
    const cy = this.height * 0.7
    const angle = Math.random() * Math.PI * 2
    const speed = 0.5 + energy * 4 + Math.random() * 2
    const [minHue, maxHue] = this.config.hueRange

    return {
      x: cx + (Math.random() - 0.5) * 60,
      y: cy + (Math.random() - 0.5) * 40,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1,
      life: 1,
      maxLife: 0.6 + Math.random() * 0.8,
      size: 1 + energy * 4 + Math.random() * 3,
      hue: minHue + Math.random() * (maxHue - minHue),
      alpha: 0.6 + Math.random() * 0.4,
    }
  }

  private updateParticles(
    spectrum: ReturnType<OfflineRenderer['computeSpectrum']>,
    beat: { isBeat: boolean; intensity: number },
  ): void {
    const spawnRate = 3 + spectrum.averageEnergy * 12
    const toSpawn = beat.isBeat ? spawnRate * 3 : spawnRate

    for (let i = 0; i < toSpawn; i++) {
      if (this.particles.length < this.config.particleCount) {
        this.particles.push(this.spawnParticle(spectrum.averageEnergy))
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx
      p.y += p.vy
      p.vx *= 0.99
      p.vy *= 0.99
      p.vy += 0.02
      p.life -= 1 / (p.maxLife * 60)

      if (p.life <= 0) {
        this.particles[i] = this.particles[this.particles.length - 1]
        this.particles.pop()
      }
    }
  }

  private updateShake(beat: { isBeat: boolean; intensity: number }): void {
    if (beat.isBeat) {
      const maxShake = 12 * this.config.shakeIntensity
      this.shakeX = (Math.random() - 0.5) * maxShake * beat.intensity
      this.shakeY = (Math.random() - 0.5) * maxShake * beat.intensity
    } else {
      this.shakeX *= 0.85
      this.shakeY *= 0.85
    }
  }

  // ========== 渲染函数 ==========

  private renderGlow(
    spectrum: ReturnType<OfflineRenderer['computeSpectrum']>,
    beat: { isBeat: boolean; intensity: number },
  ): void {
    const ctx = this.ctx
    const cx = this.width / 2
    const cy = this.height * 0.7
    const energy = spectrum.averageEnergy
    const beatBoost = beat.isBeat ? 1 + beat.intensity * 0.5 : 1
    const glowRadius = (80 + energy * 160) * this.config.glowIntensity * beatBoost

    const outerGradient = ctx.createRadialGradient(cx, cy, glowRadius * 0.3, cx, cy, glowRadius)
    outerGradient.addColorStop(0, `hsla(${this.config.hueRange[0]}, 100%, 60%, ${0.4 * energy * beatBoost})`)
    outerGradient.addColorStop(0.5, `hsla(${this.config.hueRange[0] + 40}, 100%, 50%, ${0.15 * energy * beatBoost})`)
    outerGradient.addColorStop(1, 'transparent')
    ctx.fillStyle = outerGradient
    ctx.fillRect(cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2)

    if (beat.isBeat || energy > 0.3) {
      const coreGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius * 0.4)
      coreGradient.addColorStop(0, `rgba(255, 255, 255, ${0.3 + beat.intensity * 0.5})`)
      coreGradient.addColorStop(1, 'transparent')
      ctx.fillStyle = coreGradient
      ctx.fillRect(cx - glowRadius * 0.4, cy - glowRadius * 0.4, glowRadius * 0.8, glowRadius * 0.8)
    }
  }

  private renderParticles(): void {
    const ctx = this.ctx

    for (const p of this.particles) {
      const alpha = p.alpha * p.life
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3)
      gradient.addColorStop(0, `hsla(${p.hue}, 100%, 70%, ${alpha})`)
      gradient.addColorStop(0.3, `hsla(${p.hue}, 100%, 60%, ${alpha * 0.6})`)
      gradient.addColorStop(1, 'transparent')
      ctx.fillStyle = gradient
      ctx.fill()
    }

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
