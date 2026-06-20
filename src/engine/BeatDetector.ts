import type { BeatResult, SpectrumData } from '../types'

/**
 * 节拍检测器：基于低频能量历史进行实时节拍检测
 *
 * 算法思路：
 * 1. 维护一个低频能量的滑动窗口
 * 2. 当当前低频能量超过窗口平均值的一定倍数（阈值），判定为节拍
 * 3. 加入冷却时间防止同一节拍被重复检测
 */
export class BeatDetector {
  /** 能量历史窗口大小 */
  private readonly HISTORY_SIZE = 60

  /** 节拍检测阈值系数，当前能量需超过历史均值的倍数 */
  private readonly THRESHOLD_MULTIPLIER = 1.4

  /** 冷却帧数，两次节拍之间的最小间隔 */
  private readonly COOLDOWN_FRAMES = 12

  private energyHistory: number[] = []
  private cooldownCounter = 0
  private _lastIntensity = 0

  /** 获取上一次检测到的节拍强度 */
  get lastIntensity(): number {
    return this._lastIntensity
  }

  /**
   * 对每一帧的频谱数据进行节拍检测
   * @param spectrum 频谱数据
   * @returns 节拍检测结果
   */
  detect(spectrum: SpectrumData): BeatResult {
    const bassEnergy = spectrum.bassEnergy

    // 更新能量历史
    this.energyHistory.push(bassEnergy)
    if (this.energyHistory.length > this.HISTORY_SIZE) {
      this.energyHistory.shift()
    }

    // 冷却倒数
    if (this.cooldownCounter > 0) {
      this.cooldownCounter--
    }

    // 计算历史平均能量
    const avgEnergy =
      this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length

    // 检测节拍：当前能量超过阈值 且 不在冷却期 且 历史数据足够
    const threshold = avgEnergy * this.THRESHOLD_MULTIPLIER
    const isBeat =
      this.cooldownCounter === 0 &&
      this.energyHistory.length >= 10 &&
      bassEnergy > threshold &&
      bassEnergy > 0.15 // 最小能量门槛，过滤静音段

    if (isBeat) {
      this.cooldownCounter = this.COOLDOWN_FRAMES
      // 节拍强度 = 当前能量相对于阈值的比例，映射到 0-1
      this._lastIntensity = Math.min(
        1,
        (bassEnergy - threshold) / (1 - threshold),
      )
      return { isBeat: true, intensity: this._lastIntensity }
    }

    // 衰减上一拍的强度，实现平滑过渡
    this._lastIntensity *= 0.9
    return { isBeat: false, intensity: this._lastIntensity }
  }

  /** 重置检测器状态 */
  reset(): void {
    this.energyHistory = []
    this.cooldownCounter = 0
    this._lastIntensity = 0
  }
}
