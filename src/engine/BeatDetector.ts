import type { BeatResult, SpectrumData } from '../types'

/**
 * 节拍检测器：drumEnergy 导数峰值检测
 *
 * 原理：
 * drumEnergy (bin 1-10, 43-430 Hz) 来自 AudioEngine 频域分离。
 * kick/snare → drumEnergy 瞬间从 0.02 跳到 0.30（大正差分）
 * bass 音符 → drumEnergy 从 0.05 渐变到 0.10（小正差分）
 *
 * 取 drumEnergy 的一阶导数（帧间正差分），峰值即为鼓点。
 */
export class BeatDetector {
  /** 导数历史窗口 */
  private readonly DERIV_HISTORY = 40

  /** 导数阈值系数 */
  private readonly PEAK_RATIO = 2.5

  private readonly BASE_COOLDOWN = 7

  private derivHistory: number[] = []
  private cooldownCounter = 0
  private _lastIntensity = 0
  private _sensitivity = 1.0

  private prevDrumEnergy = 0
  private smoothedDrumEnergy = 0

  get lastIntensity(): number { return this._lastIntensity }
  get drumLevel(): number { return this.smoothedDrumEnergy }

  set sensitivity(val: number) {
    this._sensitivity = Math.max(0.3, Math.min(3.0, val))
  }
  get sensitivity(): number { return this._sensitivity }

  detect(spectrum: SpectrumData): BeatResult {
    const rawDrum = spectrum.drumEnergy ?? 0
    const s = this._sensitivity

    // ═══ 1. drumEnergy 一阶导数（正差分）═══
    const deriv = Math.max(0, rawDrum - this.prevDrumEnergy)
    this.prevDrumEnergy = rawDrum

    // ═══ 2. 导数历史 ═══
    this.derivHistory.push(deriv)
    if (this.derivHistory.length > this.DERIV_HISTORY) this.derivHistory.shift()
    if (this.cooldownCounter > 0) this.cooldownCounter--

    // ═══ 3. drumEnergy 平滑（用于输出）═══
    if (rawDrum > this.smoothedDrumEnergy) {
      this.smoothedDrumEnergy = this.smoothedDrumEnergy * 0.35 + rawDrum * 0.65
    } else {
      this.smoothedDrumEnergy = this.smoothedDrumEnergy * 0.88 + rawDrum * 0.12
    }

    // ═══ 4. 自适应阈值 = 中位数 × 系数 ═══
    if (this.derivHistory.length < 8) {
      this._lastIntensity *= 0.75
      return { isBeat: false, intensity: this._lastIntensity }
    }

    const sorted = [...this.derivHistory].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]

    const ratio = this.PEAK_RATIO / Math.sqrt(s)
    const threshold = Math.max(0.008, median * ratio)

    // ═══ 5. 判定 ═══
    const isBeat =
      this.cooldownCounter === 0 &&
      deriv > threshold &&
      deriv > 0.015 &&
      rawDrum > 0.04  // drumEnergy 本身也要够高，过滤微弱噪声

    if (isBeat) {
      this.cooldownCounter = Math.max(3, Math.round(this.BASE_COOLDOWN / s))

      // 强度映射：导数值越大 → 强度越高，用 tanh 做 soft clip
      const excess = (deriv - threshold) / Math.max(0.01, 0.3 - threshold)
      this._lastIntensity = Math.min(1, Math.max(0.2, 0.3 + excess * 0.7))
      return { isBeat: true, intensity: this._lastIntensity }
    }

    this._lastIntensity *= 0.78
    return { isBeat: false, intensity: this._lastIntensity }
  }

  reset(): void {
    this.derivHistory = []
    this.cooldownCounter = 0
    this._lastIntensity = 0
    this.prevDrumEnergy = 0
    this.smoothedDrumEnergy = 0
  }
}
