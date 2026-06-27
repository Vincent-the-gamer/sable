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
  /** 鼓点频段能量 (0-1)：bin 1-10 (43-430 Hz)，覆盖 kick/snare/toms */
  drumEnergy: number
  /** 旋律频段能量 (0-1)：bin 11+ (430 Hz+)，覆盖人声/乐器/和声 */
  melodicEnergy: number
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

/** 频谱可视化样式 */
export type SpectrumStyle = 'bars' | 'circular' | 'wave' | 'mirror' | 'dots'

export const SPECTRUM_STYLE_OPTIONS: { label: string; value: SpectrumStyle }[] = [
  { label: '柱状', value: 'bars' },
  { label: '环形', value: 'circular' },
  { label: '波形', value: 'wave' },
  { label: '镜像', value: 'mirror' },
  { label: '星点', value: 'dots' },
]

/** 频谱可视化配置 */
export interface SpectrumConfig {
  /** 是否启用 */
  enabled: boolean
  /** 样式 */
  style: SpectrumStyle
  /** 不透明度 (0-1) */
  opacity: number
  /** 颜色模式: 'hue' 跟随流体色相, 'auto' 频段渐变, 'custom' 自定义 */
  colorMode: 'hue' | 'auto' | 'custom'
  /** 自定义颜色 (CSS) */
  customColor: string
  /** 柱数/点数 */
  barCount: number
  /** 灵敏度 (0-1)，值越大低能量响应越强 */
  sensitivity: number
  /** 跟随的色相 (由流体配置同步) */
  hue: number
  /** 色相是否自动旋转 */
  hueRotate: boolean
  /** 旋转速度 */
  hueRotateSpeed: number
}

export const DEFAULT_SPECTRUM_CONFIG: SpectrumConfig = {
  enabled: false,
  style: 'bars',
  opacity: 0.85,
  colorMode: 'hue',
  customColor: '#a855f7',
  barCount: 64,
  sensitivity: 0.5,
  hue: 260,
  hueRotate: false,
  hueRotateSpeed: 1.0,
}

/** 可视化配置 */
export interface VisualizerConfig {
  /** 粒子最大数量 */
  particleCount: number
  /** 辉光强度系数 */
  glowIntensity: number
  /** 抖动/涡度强度系数 */
  shakeIntensity: number
  /** 色相中心 (0-360)，颜色在此值附近随机生成 */
  hue: number
  /** 色相扩散范围 (0-180)，实际色相在 [hue-spread/2, hue+spread/2] 内 */
  hueSpread: number
  /** 流体亮度/力道倍率 (0.1-2.0)，控制注入染料的鲜艳度 */
  fluidIntensity: number
  /** 流体活跃度倍率 (0.1-2.0)，控制注入点的密度 */
  fluidActivity: number
  /** 色相是否自动旋转渐变 */
  hueRotate: boolean
  /** 色相旋转速度 (0.1-5.0)，值越大越快 */
  hueRotateSpeed: number
  /** 边缘鼓点闪烁：是否启用 */
  beatEdgeEnabled: boolean
  	/** 边缘鼓点闪烁：灵敏度 (0.5-2.0)，值越大越容易触发 */
  	beatEdgeSensitivity: number
  	/** 边缘鼓点闪烁：辉光宽度 (0.02-0.40)，相对于画布短边的比例 */
  	beatEdgeWidth: number
  }

/** 编码器选项 */
export type VideoEncoder = 'videotoolbox_h264' | 'videotoolbox_hevc' | 'software_x264' | 'software_x265' | 'software_vp9'

export const ENCODER_OPTIONS: { value: VideoEncoder; label: string; desc: string }[] = [
  { value: 'videotoolbox_h264', label: 'VideoToolbox H.264', desc: '硬件加速 • 极速 • 兼容好' },
  { value: 'videotoolbox_hevc', label: 'VideoToolbox HEVC', desc: '硬件加速 • 体积更小' },
  { value: 'software_x264',  label: 'x264 (H.264)',      desc: '软编 • 兼容性最佳' },
  { value: 'software_x265',  label: 'x265 (HEVC)',       desc: '软编 • 压缩率最高' },
  { value: 'software_vp9',   label: 'VP9 (WebM)',        desc: '开放格式' },
]

/** 编码速度预设 */
export type SpeedPreset = 'ultrafast' | 'superfast' | 'fast' | 'balanced' | 'quality'

export const SPEED_PRESET_OPTIONS: { label: string; value: SpeedPreset; desc: string }[] = [
  { label: '⚡ 极速', value: 'ultrafast', desc: '速度最快，文件较大' },
  { label: '🏃 超快', value: 'superfast', desc: '速度快，质量尚可' },
  { label: '🚀 快速', value: 'fast', desc: '速度与质量兼顾' },
  { label: '⚖️ 均衡', value: 'balanced', desc: '推荐日常使用' },
  { label: '💎 高品质', value: 'quality', desc: '体积最小，速度较慢' },
]

/** 导出设置 */
export interface ExportSettings {
  /** 视频宽度 */
  width: number
  /** 视频高度 */
  height: number
  /** 帧率 */
  fps: number
  /** 编码器 */
  encoder: VideoEncoder
  /** 输出格式 */
  format: 'mp4' | 'webm'
  /** CRF 质量 (0-51, 越小质量越高, 仅软件编码器) */
  crf: number
  /** 编码速度预设 (硬件编码器控制码率，软件编码器控制 preset/CRF) */
  speedPreset: SpeedPreset
}
