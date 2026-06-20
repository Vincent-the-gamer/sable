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

/** 歌词行 */
export interface LyricLine {
  /** 起始时间（秒） */
  startTime: number
  /** 该行文本 */
  text: string
  /** 逐字时间（可选，用于卡拉OK效果） */
  wordTimestamps?: { time: number; word: string }[]
}

/** 字幕特效配置 */
export interface SubtitleConfig {
  /** 字体大小 (px) */
  fontSize: number
  /** 字重 */
  fontWeight: number
  /** 字体族 */
  fontFamily: string
  /** 字间距 (em) */
  letterSpacing: number
  /** 最大宽度 (% 相对于预览区) */
  maxWidth: number
  /** 外发光大小 (px) */
  glowSize: number
  /** 外发光强度 (0-1) */
  glowIntensity: number
  /** 抖动幅度 (px) */
  shakeAmount: number
  /** 位置随机度 (0-1) */
  positionRandomness: number
  /** 持续摇曳幅度 (px) */
  swayAmount: number
  /** 漂移速度 */
  driftSpeed: number
  /** 节拍缩放系数 */
  beatScale: number
  /** 内层文字颜色 (CSS) */
  innerColor: string
  /** 外层发光颜色 (CSS) */
  outerColor: string
  /** 淡入淡出时长 (s) */
  fadeDuration: number
  /** 入场效果（可多选组合） */
  entranceEffect: EntranceEffect[]
  /** 出场效果（可多选组合） */
  exitEffect: ExitEffect[]
}

/** 入场效果类型 */
export type EntranceEffect =
  | 'fade'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'scale'
  | 'blur'
  | 'none'

/** 出场效果类型 */
export type ExitEffect =
  | 'fade'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'scale'
  | 'blur'
  | 'none'

/** 可用字体列表 */
export const FONT_OPTIONS = [
  { label: '系统默认', value: 'inherit' },
  { label: '思源黑体', value: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: '思源宋体', value: '"Noto Serif SC", "SimSun", "STSong", serif' },
  { label: '圆体', value: '"PingFang SC", "Microsoft YaHei", "HarmonyOS Sans", sans-serif' },
  { label: '等宽', value: '"SF Mono", "Fira Code", "Consolas", monospace' },
  { label: '手写体', value: '"ZCOOL KuaiLe", "Ma Shan Zheng", "KaiTi", cursive' },
  { label: '黑体', value: '"PingFang SC", "Heiti SC", "SimHei", sans-serif' },
  { label: '楷体', value: '"KaiTi", "STKaiti", "楷体", serif' },
]

export const ENTRANCE_EFFECT_OPTIONS: { label: string; value: EntranceEffect }[] = [
  { label: '淡入', value: 'fade' },
  { label: '上滑', value: 'slideUp' },
  { label: '下滑', value: 'slideDown' },
  { label: '左滑', value: 'slideLeft' },
  { label: '右滑', value: 'slideRight' },
  { label: '缩放', value: 'scale' },
  { label: '模糊', value: 'blur' },
  { label: '无', value: 'none' },
]

export const EXIT_EFFECT_OPTIONS: { label: string; value: ExitEffect }[] = [
  { label: '淡出', value: 'fade' },
  { label: '上滑', value: 'slideUp' },
  { label: '下滑', value: 'slideDown' },
  { label: '左滑', value: 'slideLeft' },
  { label: '右滑', value: 'slideRight' },
  { label: '缩小', value: 'scale' },
  { label: '模糊', value: 'blur' },
  { label: '无', value: 'none' },
]

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  fontSize: 28,
  fontWeight: 700,
  fontFamily: 'inherit',
  letterSpacing: 0.05,
  maxWidth: 80,
  glowSize: 30,
  glowIntensity: 0.8,
  shakeAmount: 12,
  positionRandomness: 0.6,
  swayAmount: 4,
  driftSpeed: 0.8,
  beatScale: 1.3,
  innerColor: '#ffffff',
  outerColor: '#a855f7',
  fadeDuration: 0.35,
  entranceEffect: ['fade'],
  exitEffect: ['fade'],
}

/** 可视化配置 */
export interface VisualizerConfig {
  /** 粒子最大数量 */
  particleCount: number
  /** 辉光强度系数 */
  glowIntensity: number
  /** 抖动/涡度强度系数 */
  shakeIntensity: number
  /** 色相 (0-360)，引擎在此值 ±25° 范围内随机生成颜色 */
  hue: number
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
