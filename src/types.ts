/** 粒子数据结构 */
export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  hue: number
  alpha: number
}

/** 频谱数据，由 AudioEngine 对外暴露 */
export interface SpectrumData {
  /** 频率数组 (0-255, 每个值的范围 0-255) */
  frequency: Uint8Array
  /** 时域波形数组 */
  waveform: Uint8Array
  /** 平均能量 (0-1) */
  averageEnergy: number
  /** 低频能量 (0-1)，用于节拍检测 */
  bassEnergy: number
}

/** 节拍检测结果 */
export interface BeatResult {
  /** 当前帧是否为节拍点 */
  isBeat: boolean
  /** 节拍强度 (0-1) */
  intensity: number
}

/** 可视化配置 */
export interface VisualizerConfig {
  /** 粒子最大数量 */
  particleCount: number
  /** 辉光强度系数 */
  glowIntensity: number
  /** 抖动强度系数 */
  shakeIntensity: number
  /** 色调范围 [minHue, maxHue] */
  hueRange: [number, number]
}

/** 导出设置 */
export interface ExportSettings {
  /** 视频宽度 */
  width: number
  /** 视频高度 */
  height: number
  /** 帧率 */
  fps: number
  /** 输出格式 */
  format: 'mp4' | 'webm'
  /** CRF 质量 (0-51, 越小质量越高) */
  crf: number
}
