/**
 * 简易 FFT 频谱分析器，用于从 PCM 采样数据中提取频谱信息。
 * 实现 radix-2 Cooley-Tukey FFT 算法。
 */
export class FftAnalyzer {
  private readonly fftSize: number
  private readonly halfSize: number
  private readonly sinTable: Float64Array
  private readonly cosTable: Float64Array

  // 预分配工作缓冲区，避免每帧 GC
  private readonly real: Float64Array
  private readonly imag: Float64Array
  private readonly magnitudes: Float32Array

  constructor(fftSize: number = 256) {
    this.fftSize = fftSize
    this.halfSize = fftSize / 2

    // 预计算旋转因子
    this.sinTable = new Float64Array(this.halfSize)
    this.cosTable = new Float64Array(this.halfSize)
    for (let i = 0; i < this.halfSize; i++) {
      const angle = (-2 * Math.PI * i) / fftSize
      this.sinTable[i] = Math.sin(angle)
      this.cosTable[i] = Math.cos(angle)
    }

    // 预分配 FFT 工作缓冲区
    this.real = new Float64Array(this.fftSize)
    this.imag = new Float64Array(this.fftSize)
    this.magnitudes = new Float32Array(this.halfSize)
  }

  /**
   * 对 PCM 采样窗口执行 FFT，返回频域幅度谱（归一化到 0-1）
   * @param samples - PCM 采样（f32, -1..1）
   * @param offset - 起始偏移
   * @param windowSize - 窗口大小（必须 = fftSize）
   */
  analyzeWindow(
    samples: Float32Array,
    offset: number,
    windowSize: number = this.fftSize,
  ): Float32Array {
    const real = this.real
    const imag = this.imag

    // 清零
    real.fill(0)
    imag.fill(0)

    // 复制数据 + 应用 Hann 窗
    for (let i = 0; i < windowSize && offset + i < samples.length; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)))
      real[i] = samples[offset + i] * hann
    }

    // 位反转重排
    this.bitReverse(real, imag)

    // FFT 蝶形运算
    for (let step = 2; step <= this.fftSize; step *= 2) {
      const halfStep = step / 2
      const tableStep = this.fftSize / step

      for (let group = 0; group < this.fftSize; group += step) {
        for (let pair = 0; pair < halfStep; pair++) {
          const i = group + pair
          const j = i + halfStep
          const twiddle = pair * tableStep

          const tr = this.cosTable[twiddle] * real[j] - this.sinTable[twiddle] * imag[j]
          const ti = this.sinTable[twiddle] * real[j] + this.cosTable[twiddle] * imag[j]

          real[j] = real[i] - tr
          imag[j] = imag[i] - ti
          real[i] += tr
          imag[i] += ti
        }
      }
    }

    // 计算幅度并归一化（复用 magnitudes 缓冲区）
    const magnitudes = this.magnitudes
    for (let i = 0; i < this.halfSize; i++) {
      magnitudes[i] = Math.sqrt(real[i] ** 2 + imag[i] ** 2) / this.fftSize
    }

    return magnitudes
  }

  private bitReverse(real: Float64Array, imag: Float64Array): void {
    for (let i = 0; i < this.fftSize; i++) {
      const j = this.reverseBits(i)
      if (j > i) {
        ;[real[i], real[j]] = [real[j], real[i]]
        ;[imag[i], imag[j]] = [imag[j], imag[i]]
      }
    }
  }

  private reverseBits(x: number): number {
    let result = 0
    let bits = Math.log2(this.fftSize)
    for (let i = 0; i < bits; i++) {
      result = (result << 1) | (x & 1)
      x >>= 1
    }
    return result
  }
}
