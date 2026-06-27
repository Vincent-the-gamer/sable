import type { SpectrumData, BeatResult, VisualizerConfig } from '../types'
import { WebGLFluidEngine } from './WebGLFluidEngine'
import { FftAnalyzer } from './FftAnalyzer'

/**
 * 离线流体渲染器：使用 WebGLFluidEngine 在 OffscreenCanvas 上逐帧渲染
 *
 * 特性：
 * - 复用 WebGLFluidEngine 的完整 Navier-Stokes 流体模拟
 * - 独立 FFT/节拍检测，从 PCM 采样数据驱动
 * - 输出与预览完全一致的流体效果
 */
export class OfflineFluidRenderer {
  private engine: WebGLFluidEngine
  private fft: FftAnalyzer
  private canvas: OffscreenCanvas

  readonly width: number
  readonly height: number

  /** PCM 采样数据（f32, -1..1） */
  private samples: Float32Array | null = null
  private sampleRate = 0

  // 节拍检测状态
  private energyHistory: number[] = []
  private cooldownCounter = 0
  private lastBeatIntensity = 0

  // 能量平滑
  private smoothedEnergy = 0

  constructor(width: number, height: number, config: VisualizerConfig) {
    this.width = width
    this.height = height

    this.canvas = new OffscreenCanvas(width, height)
    this.fft = new FftAnalyzer(1024)

    this.engine = new WebGLFluidEngine(this.canvas, config)
    this.engine.setDimensions(width, height)
  }

  /** 设置音频源数据 */
  setAudioData(samples: Float32Array, sampleRate: number): void {
    this.samples = samples
    this.sampleRate = sampleRate
  }

  /** 重置状态（开始新导出时调用） */
  reset(): void {
    this.engine.resetState()
    this.energyHistory = []
    this.cooldownCounter = 0
    this.lastBeatIntensity = 0
    this.smoothedEnergy = 0
    this.prevFluxSpectrum = null
  }

  /** 更新配置 */
  updateConfig(config: VisualizerConfig): void {
    this.engine.config = config
  }

  /**
   * 渲染一帧
   * @param timeSeconds - 当前帧对应的时间（秒）
   * @param dt - 帧间隔（秒），用于流体模拟步进
   * @returns RGBA 像素数据
   */
  renderFrame(timeSeconds: number, dt: number): Uint8Array {
    // 根据时间戳计算频谱数据
    const spectrum = this.computeSpectrum(timeSeconds)
    // 节拍检测
    const beat = this.detectBeat(spectrum)
    // 平滑能量（用于流体引擎内部状态）
    if (spectrum) {
      this.smoothedEnergy += (spectrum.averageEnergy - this.smoothedEnergy) * 0.15
    } else {
      this.smoothedEnergy *= 0.9
    }

    // 驱动流体引擎渲染一帧
    this.engine.offlineStep(dt, spectrum, beat)

    // 捕获像素
    return this.engine.captureFrame()
  }

  // ========== 频谱计算 ==========

  private computeSpectrum(timeSeconds: number): SpectrumData | null {
    if (!this.samples || this.sampleRate === 0) {
      return null
    }

    const sampleIndex = Math.floor(timeSeconds * this.sampleRate)

    // FFT 频谱 — 与预览 AudioEngine 对齐：FFT 1024 → 512 bins
    const FFT_SIZE = 1024
    const HALF_SIZE = FFT_SIZE / 2
    const fftMag = this.fft.analyzeWindow(
      this.samples,
      Math.max(0, sampleIndex - HALF_SIZE),
      FFT_SIZE,
    )

    // dB 范围与 AudioEngine AnalyserNode 对齐: minDecibels=-80, maxDecibels=-10
    const MIN_DB = -80
    const MAX_DB = -10
    const dbRange = MAX_DB - MIN_DB

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

    // 时域波形
    const waveData = new Uint8Array(HALF_SIZE)
    for (let i = 0; i < HALF_SIZE; i++) {
      const idx = Math.max(0, sampleIndex - HALF_SIZE / 2 + i)
      if (idx < this.samples.length) {
        waveData[i] = Math.min(255, Math.floor(((this.samples[idx] + 1) / 2) * 255))
      }
    }

    // 平均能量
    let sum = 0
    for (let i = 0; i < freqData.length; i++) sum += freqData[i]
    const averageEnergy = sum / (freqData.length * 255)

    // 低频能量
    const bassBins = Math.min(24, freqData.length)
    let bassSum = 0
    for (let i = 0; i < bassBins; i++) bassSum += freqData[i]
    const bassEnergy = bassSum / (bassBins * 255)

    return { frequency: freqData, waveform: waveData, averageEnergy, bassEnergy, drumEnergy: bassEnergy, melodicEnergy: averageEnergy }
  }

  // ========== 节拍检测 ==========
  private prevFluxSpectrum: number[] | null = null

  private detectBeat(spectrum: SpectrumData | null): BeatResult {
    if (!spectrum) {
      this.prevFluxSpectrum = null
      this.lastBeatIntensity *= 0.9
      return { isBeat: false, intensity: this.lastBeatIntensity }
    }

    // sub-bass 能量 (bin 0-1 ≈ 0-344 Hz @ 256 FFT，覆盖底鼓+军鼓基频)
    const subBassBins = Math.min(2, spectrum.frequency.length)
    let subBassSum = 0
    for (let i = 0; i < subBassBins; i++) subBassSum += spectrum.frequency[i]
    const subBassEnergy = subBassSum / (subBassBins * 255)

    // 频谱通量：鼓点的宽带跃升特征
    let spectralFlux = 0
    if (this.prevFluxSpectrum && this.prevFluxSpectrum.length === spectrum.frequency.length) {
      let fluxSum = 0
      for (let i = 0; i < spectrum.frequency.length; i++) {
        const diff = spectrum.frequency[i] - this.prevFluxSpectrum[i]
        if (diff > 0) fluxSum += diff
      }
      spectralFlux = fluxSum / (spectrum.frequency.length * 255)
    }
    this.prevFluxSpectrum = Array.from(spectrum.frequency)

    // 综合能量（sub-bass 权重更高，因为它直接代表鼓点）
    const combinedEnergy = subBassEnergy * 0.6 + spectrum.averageEnergy * 0.4

    this.energyHistory.push(combinedEnergy)
    if (this.energyHistory.length > 60) this.energyHistory.shift()
    if (this.cooldownCounter > 0) this.cooldownCounter--

    const avg = this.energyHistory.length > 0
      ? this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length
      : 0

    // 鼓点判定：综合能量 spike + (sub-bass 强 OR 频谱通量高)
    const isBeat =
      this.cooldownCounter === 0 &&
      this.energyHistory.length >= 10 &&
      combinedEnergy > avg * 1.35 &&
      combinedEnergy > 0.12 &&
      (subBassEnergy > 0.08 || spectralFlux > 0.06)

    if (isBeat) {
      this.cooldownCounter = 10
      const energyStrength = Math.min(1, (combinedEnergy - avg * 1.35) / (1 - avg * 1.35))
      const fluxStrength = Math.min(1, spectralFlux * 5)
      this.lastBeatIntensity = Math.min(1, Math.max(0.15,
        energyStrength * 0.6 + fluxStrength * 0.4
      ))
      return { isBeat: true, intensity: this.lastBeatIntensity }
    }

    this.lastBeatIntensity *= 0.88
    return { isBeat: false, intensity: this.lastBeatIntensity }
  }
}
