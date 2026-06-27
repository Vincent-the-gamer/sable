import type { SpectrumData } from '../types'

/**
 * 音频引擎：负责加载音频文件、播放控制、频谱分析
 * 基于 Web Audio API
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private buffer: AudioBuffer | null = null

  private freqData: Uint8Array = new Uint8Array()
  private waveData: Uint8Array = new Uint8Array()

  private startedAt = 0
  private pausedAt = 0
  private _isPlaying = false
  private _duration = 0

  /** 防止 onended 竞态：每次 play() 递增，onended 只处理当前 sourceId */
  private sourceId = 0

  /** 频谱 FFT 尺寸 (必须是 2 的幂)
   *  1024 → 512 频率 bin，bin 宽度约 43 Hz，可分辨鼓点频段 */
  private readonly FFT_SIZE = 1024

  get isPlaying(): boolean {
    return this._isPlaying
  }

  get duration(): number {
    return this._duration
  }

  get currentTime(): number {
    if (!this.ctx || !this.buffer) return 0
    if (this._isPlaying) {
      // startedAt = ctxTimeAtPlayStart - pausedAt
      // so currentTime = ctxTime - startedAt = elapsed + pausedAt ✓
      return this.ctx.currentTime - this.startedAt
    }
    return this.pausedAt
  }

  /** 初始化 AudioContext（需在用户交互后调用） */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
    }
    return this.ctx
  }

  /** 从 File 对象加载音频 */
  async loadFile(file: File): Promise<void> {
    this.stop()

    const ctx = this.ensureContext()
    const arrayBuffer = await file.arrayBuffer()
    this.buffer = await ctx.decodeAudioData(arrayBuffer)
    this._duration = this.buffer.duration

    // 创建分析器节点
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = this.FFT_SIZE
    this.analyser.minDecibels = -80
    this.analyser.maxDecibels = -10
    this.analyser.smoothingTimeConstant = 0

    // 创建增益节点
    this.gainNode = ctx.createGain()
    this.gainNode.gain.value = 0.8

    // 分配数据缓冲区
    const bufferLength = this.analyser.frequencyBinCount
    this.freqData = new Uint8Array(bufferLength)
    this.waveData = new Uint8Array(bufferLength)

    this.pausedAt = 0
  }

  /** 播放 */
  play(): void {
    if (!this.buffer || !this.ctx || !this.analyser || !this.gainNode) return

    // 如果已经播完，从头开始
    if (this.pausedAt >= this._duration) {
      this.pausedAt = 0
    }

    this.stopSource()

    const sid = ++this.sourceId
    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer

    source.connect(this.analyser)
    this.analyser.connect(this.gainNode)
    this.gainNode.connect(this.ctx.destination)

    source.start(0, this.pausedAt)
    this.startedAt = this.ctx.currentTime - this.pausedAt
    this._isPlaying = true
    this.source = source

    source.onended = () => {
      // 只处理当前 source，忽略旧 source 的 onended
      if (this.sourceId !== sid) return
      this._isPlaying = false
      // 自然播完时记录进度到末尾
      if (this.pausedAt < this._duration) {
        this.pausedAt = this._duration
      }
    }
  }

  /** 暂停 */
  pause(): void {
    if (!this._isPlaying || !this.ctx) return
    this.pausedAt = this.ctx.currentTime - this.startedAt
    this.stopSource()
    this._isPlaying = false
  }

  /** 停止并重置 */
  stop(): void {
    this.stopSource()
    this._isPlaying = false
    this.pausedAt = 0
  }

  /** 跳转到指定时间（秒） */
  seek(time: number): void {
    const wasPlaying = this._isPlaying
    // 先记录目标位置
    this.pausedAt = Math.max(0, Math.min(time, this._duration))
    // 停止当前 source（递增 sourceId，使旧 onended 失效）
    this.sourceId++
    this.stopSource()
    this._isPlaying = false
    if (wasPlaying) {
      this.play()
    }
  }

  /** 获取当前频谱数据 */
  getSpectrumData(): SpectrumData {
    if (!this.analyser) {
      return {
        frequency: new Uint8Array(),
        waveform: new Uint8Array(),
        averageEnergy: 0,
        bassEnergy: 0,
        drumEnergy: 0,
        melodicEnergy: 0,
      }
    }

    this.analyser.getByteFrequencyData(this.freqData)
    this.analyser.getByteTimeDomainData(this.waveData)

    // 计算平均能量 (0-1)
    let sum = 0
    for (let i = 0; i < this.freqData.length; i++) {
      sum += this.freqData[i]
    }
    const averageEnergy = sum / (this.freqData.length * 255)

    // 计算低频能量（前 24 bin ≈ 0-1032 Hz，覆盖 kick/snare 频段）
    // FFT_SIZE=1024 → 512 bin，bin 宽度 22050/512 ≈ 43 Hz
    // bin 0-23 覆盖 0-1032 Hz，精准捕获底鼓(40-100Hz)和军鼓(200-500Hz)
    const bassBins = Math.min(24, this.freqData.length)
    let bassSum = 0
    for (let i = 0; i < bassBins; i++) {
      bassSum += this.freqData[i]
    }
    const bassEnergy = bassSum / (bassBins * 255)

    // ── 鼓点频段：bin 1-10 (43-430 Hz)，排除 bin 0 (DC/极低频噪声) ──
    // 覆盖 kick (40-100 Hz, bin 1-2)、snare (200-500 Hz, bin 4-11)、toms (100-300 Hz, bin 2-7)
    const drumStart = 1
    const drumEnd = Math.min(10, this.freqData.length - 1)
    let drumSum = 0
    const drumCount = drumEnd - drumStart + 1
    for (let i = drumStart; i <= drumEnd; i++) {
      drumSum += this.freqData[i]
    }
    const drumEnergy = drumSum / (drumCount * 255)

    // ── 旋律频段：bin 11+ (430 Hz+)，覆盖人声/乐器/和声 ──
    const melStart = Math.min(11, this.freqData.length - 1)
    const melEnd = this.freqData.length - 1
    if (melEnd > melStart) {
      let melSum = 0
      const melCount = melEnd - melStart + 1
      for (let i = melStart; i <= melEnd; i++) {
        melSum += this.freqData[i]
      }
      const melodicEnergy = melSum / (melCount * 255)

      return {
        frequency: new Uint8Array(this.freqData),
        waveform: new Uint8Array(this.waveData),
        averageEnergy,
        bassEnergy,
        drumEnergy,
        melodicEnergy,
      }
    }

    return {
      frequency: new Uint8Array(this.freqData),
      waveform: new Uint8Array(this.waveData),
      averageEnergy,
      bassEnergy,
      drumEnergy,
      melodicEnergy: 0,
    }
  }

  /** 销毁引擎，释放资源 */
  dispose(): void {
    this.stop()
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
    }
    this.buffer = null
    this.analyser = null
    this.gainNode = null
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.stop()
      } catch {
        // source may already be stopped
      }
      this.source.disconnect()
      this.source = null
    }
  }
}
