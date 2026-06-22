import type { BeatResult, SpectrumData } from '../types'

/**
 * 节拍检测器：精准鼓点识别
 *
 * 鼓点的声学特征：
 * 1. 时域瞬态（attack）：RMS 能量在短时间内急剧上升
 * 2. 低频集中：底鼓 40-100Hz，军鼓 200-500Hz，在频域上能量集中在低频
 * 3. 宽带频谱通量（spectral flux）：鼓点会让几乎所有频段同时上升，
 *    而旋律/人声通常只在部分频段变化
 *
 * 算法：
 * 1. 时域波形 RMS onset detection（瞬态检测）
 * 2. 聚焦 sub-bass（bin 1-5 ≈ 43-258 Hz，覆盖底鼓+军鼓基频）
 * 3. 频谱通量（spectral flux）——帧间正差异之和，鼓点通量远高于旋律
 * 4. 三重确认 + 冷却机制，防止重复检测
 *
 * @param sensitivity 灵敏度倍率 (0.3-3.0)，值越大越容易检测到节拍
 */
export class BeatDetector {
  /** 能量历史窗口大小 */
  private readonly HISTORY_SIZE = 43

  /** 节拍检测基础阈值系数 */
  private readonly BASE_THRESHOLD = 1.3

  /** 基础冷却帧数（约 100ms @ 60fps → 6 帧） */
  private readonly BASE_COOLDOWN = 6

  /** 最小能量门槛（归一化 RMS） */
  private readonly MIN_ENERGY = 0.04

  /** 平滑包络的衰减系数 */
  private readonly ENVELOPE_DECAY = 0.92

  /** 频谱通量阈值：鼓点通量通常 > 0.15 */
  private readonly FLUX_THRESHOLD = 0.10

  /** sub-bass 鼓点阈值（归一化能量，bin 1-5 平均） */
  private readonly SUB_BASS_THRESHOLD = 0.05

  private energyHistory: number[] = []
  private cooldownCounter = 0
  private _lastIntensity = 0
  private _sensitivity = 1.0
  private smoothedEnergy = 0

  /** 上一帧的频谱数据，用于计算频谱通量 */
  private prevSpectrum: number[] | null = null

  /** 获取上一次检测到的节拍强度 */
  get lastIntensity(): number {
    return this._lastIntensity
  }

  /** 设置灵敏度 */
  set sensitivity(val: number) {
    this._sensitivity = Math.max(0.3, Math.min(3.0, val))
  }
  get sensitivity(): number {
    return this._sensitivity
  }

  /**
   * 对每一帧的频谱数据进行节拍检测
   */
  detect(spectrum: SpectrumData): BeatResult {
    // ── 1. 时域波形 RMS 能量（瞬态检测，最灵敏）──
    const waveEnergy = this.computeWaveRms(spectrum.waveform)

    // ── 2. 更新平滑包络 ──
    if (waveEnergy > this.smoothedEnergy) {
      // 能量上升时快速跟随（捕捉 attack）
      this.smoothedEnergy = this.smoothedEnergy * 0.5 + waveEnergy * 0.5
    } else {
      // 能量下降时缓慢衰减
      this.smoothedEnergy = this.smoothedEnergy * this.ENVELOPE_DECAY + waveEnergy * (1 - this.ENVELOPE_DECAY)
    }

    // ── 3. 聚焦 sub-bass：bin 1-5 (43-258 Hz)，精准捕获底鼓+军鼓基频 ──
    const subBassEnergy = this.computeSubBass(spectrum.frequency)

    // ── 4. 频谱通量：鼓点会引起宽带能量同时跃升 ──
    const spectralFlux = this.computeSpectralFlux(spectrum.frequency)

    // ── 5. 更新历史 ──
    this.energyHistory.push(waveEnergy)
    if (this.energyHistory.length > this.HISTORY_SIZE) {
      this.energyHistory.shift()
    }

    // 冷却倒数
    if (this.cooldownCounter > 0) {
      this.cooldownCounter--
    }

    // ── 6. 三重检测判定 ──
    // 阈值随灵敏度调整
    const s = this._sensitivity
    const onsetRatio = this.BASE_THRESHOLD / s
    const onsetThreshold = Math.max(0.01, this.smoothedEnergy * onsetRatio)
    const minEnergy = Math.max(0.02, this.MIN_ENERGY / s)

    // 1) 瞬态 onset 检测：当前 RMS 显著高于平滑包络
    const onsetDetected = waveEnergy > onsetThreshold && waveEnergy > minEnergy

    // 2) 鼓点低频确认：sub-bass 必须高于阈值（底鼓的声学特征）
    const subBassConfirmed = subBassEnergy > this.SUB_BASS_THRESHOLD / s

    // 3) 频谱通量确认：宽带能量跃升（军鼓/镲片的声学特征）
    const fluxConfirmed = spectralFlux > this.FLUX_THRESHOLD / s

    // 鼓点判定：onset + (底鼓低频 OR 宽带通量)，缺一不可
    const isBeat =
      this.cooldownCounter === 0 &&
      this.energyHistory.length >= 6 &&
      onsetDetected &&
      (subBassConfirmed || fluxConfirmed)

    if (isBeat) {
      // 冷却帧数随灵敏度调整
      this.cooldownCounter = Math.max(
        3,
        Math.round(this.BASE_COOLDOWN / s),
      )
      // 节拍强度：综合 onset 强度 + sub-bass 强度 + 频谱通量
      const onsetStrength = Math.min(1, (waveEnergy - onsetThreshold) / Math.max(0.01, 1 - onsetThreshold))
      const bassStrength = Math.min(1, subBassEnergy * 4) // sub-bass 0-0.25 映射到 0-1
      const fluxStrength = Math.min(1, spectralFlux * 2.5) // 通量映射
      this._lastIntensity = Math.min(1, Math.max(0.15,
        onsetStrength * 0.5 + bassStrength * 0.3 + fluxStrength * 0.2
      ))
      return { isBeat: true, intensity: this._lastIntensity }
    }

    // 衰减上一拍的强度
    this._lastIntensity *= 0.82
    return { isBeat: false, intensity: this._lastIntensity }
  }

  /** 从时域波形计算 RMS 能量 (0-1) */
  private computeWaveRms(waveform: Uint8Array): number {
    let sumSq = 0
    const len = waveform.length
    for (let i = 0; i < len; i++) {
      const sample = (waveform[i] - 128) / 128
      sumSq += sample * sample
    }
    return Math.sqrt(sumSq / len)
  }

  /**
   * 计算聚焦 sub-bass 能量：bin 1-5 (43-258 Hz @ 1024 FFT)
   *
   * FFT_SIZE=1024 → 512 频率 bin，bin 宽度 ≈ 43 Hz
   * Bin 1-5 = 43-258 Hz，精确覆盖：
   *   - 底鼓基频 40-100 Hz (bin 1-2)
   *   - 军鼓基频 200-500 Hz (bin 4-11)
   *   刻意排除 bin 0 (DC/极低频，容易误触发)
   */
  private computeSubBass(frequency: Uint8Array): number {
    // bin 1 到 bin 5（若数组太小则自适应）
    const endBin = Math.min(5, frequency.length - 1)
    const startBin = Math.min(1, endBin - 1)
    if (endBin <= startBin) return 0

    let sum = 0
    const count = endBin - startBin + 1
    for (let i = startBin; i <= endBin; i++) {
      sum += frequency[i]
    }
    return sum / (count * 255)
  }

  /**
   * 计算频谱通量（spectral flux）
   * = sum of max(0, currentBin - prevBin) / totalBins
   *
   * 鼓点的频谱通量远高于旋律变化，因为鼓点同时冲击几乎所有频段
   */
  private computeSpectralFlux(frequency: Uint8Array): number {
    if (!this.prevSpectrum || this.prevSpectrum.length !== frequency.length) {
      this.prevSpectrum = Array.from(frequency)
      return 0
    }

    let fluxSum = 0
    const len = frequency.length
    for (let i = 0; i < len; i++) {
      const diff = frequency[i] - this.prevSpectrum[i]
      if (diff > 0) fluxSum += diff
    }
    this.prevSpectrum = Array.from(frequency)

    return fluxSum / (len * 255)
  }

  /** 重置检测器状态 */
  reset(): void {
    this.energyHistory = []
    this.cooldownCounter = 0
    this._lastIntensity = 0
    this.smoothedEnergy = 0
    this.prevSpectrum = null
  }
}
