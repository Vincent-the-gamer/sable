<script setup lang="ts">
import {
    ref,
    computed,
    reactive,
    onMounted,
    onUnmounted,
    nextTick,
    watch,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import AudioControls from "./AudioControls.vue";
import VisualizerCanvas from "./VisualizerCanvas.vue";
import LyricTimeline from "./LyricTimeline.vue";
import type {
    VisualizerConfig,
    ExportSettings,
    SubtitleConfig,
    LyricLine,
    BeatResult,
    SpectrumConfig,
    SpeedPreset,
    VideoEncoder,
} from "../types";
import {
    ENTRANCE_EFFECT_OPTIONS,
    EXIT_EFFECT_OPTIONS,
    SPECTRUM_STYLE_OPTIONS,
    DEFAULT_SPECTRUM_CONFIG,
    SPEED_PRESET_OPTIONS,
    ENCODER_OPTIONS,
} from "../types";
import type { EntranceEffect, ExitEffect } from "../types";
import type { ExportProgress } from "../engine/ExportPipeline";

const props = defineProps<{
    config: VisualizerConfig;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    hasAudio: boolean;
    engine: unknown;
    exportSettings: ExportSettings;
    isExporting: boolean;
    exportProgress: ExportProgress | null;
    exportDone: boolean;
    exportVideoPath: string;
    previewVideoUrl: string;
    lyrics: LyricLine[];
    currentLyric: string;
    hasLyrics: boolean;
    subtitleConfig: SubtitleConfig;
    latestBeat: BeatResult;
    /** 平滑鼓点频段能量 (0-1)，连续信号，用于边缘闪烁 */
    drumEnergy: number;
    spectrumConfig: SpectrumConfig;
    /** 是否已加载鼓点分轨 */
    hasDrumStem: boolean;
    /** 鼓点分轨文件名 */
    drumStemFileName: string;
}>();

const emit = defineEmits<{
    (e: "update:config", config: VisualizerConfig): void;
    (e: "update:exportSettings", settings: ExportSettings): void;
    (e: "update:subtitleConfig", config: SubtitleConfig): void;
    (e: "update:spectrumConfig", config: SpectrumConfig): void;
    (e: "update:lyrics", lyrics: LyricLine[]): void;
    (e: "lrcImport"): void;
    (e: "play"): void;
    (e: "pause"): void;
    (e: "seek", time: number): void;
    (e: "canvasReady", canvas: HTMLCanvasElement): void;
    (e: "spectrumCanvasReady", canvas: HTMLCanvasElement): void;
    (e: "selectOutputPath"): void;
    (e: "startExport"): void;
    (e: "cancelExport"): void;
    (e: "resetExport"): void;
}>();

// ═══ Tab switching ═══
const activeTab = ref<"effects" | "subtitle" | "export">("effects");

// ═══ Effect controls ═══
const particleCount = computed({
    get: () => props.config.particleCount,
    set: (v) => emitConfig({ particleCount: v }),
});
const glowIntensity = computed({
    get: () => props.config.glowIntensity,
    set: (v) => emitConfig({ glowIntensity: v }),
});
const shakeIntensity = computed({
    get: () => props.config.shakeIntensity,
    set: (v) => emitConfig({ shakeIntensity: v }),
});
const hueValue = computed({
    get: () => props.config.hue,
    set: (v) => emitConfig({ hue: v }),
});
const hueSpread = computed({
    get: () => props.config.hueSpread ?? 60,
    set: (v) => emitConfig({ hueSpread: v }),
});
const fluidIntensity = computed({
    get: () => props.config.fluidIntensity ?? 1.0,
    set: (v) => emitConfig({ fluidIntensity: v }),
});
const fluidActivity = computed({
    get: () => props.config.fluidActivity ?? 1.0,
    set: (v) => emitConfig({ fluidActivity: v }),
});
const hueRotate = computed({
    get: () => props.config.hueRotate ?? false,
    set: (v) => emitConfig({ hueRotate: v }),
});
const hueRotateSpeed = computed({
    get: () => props.config.hueRotateSpeed ?? 1.0,
    set: (v) => emitConfig({ hueRotateSpeed: v }),
});

// ═══ Beat Edge controls ═══
const beatEdgeEnabled = computed({
    get: () => props.config.beatEdgeEnabled ?? true,
    set: (v) => emitConfig({ beatEdgeEnabled: v }),
});
const beatEdgeSensitivity = computed({
    get: () => props.config.beatEdgeSensitivity ?? 1.0,
    set: (v) => emitConfig({ beatEdgeSensitivity: v }),
});
const beatEdgeWidth = computed({
    get: () => props.config.beatEdgeWidth ?? 0.12,
    set: (v) => emitConfig({ beatEdgeWidth: v }),
});

function emitConfig(partial: Partial<VisualizerConfig>) {
    emit("update:config", { ...props.config, ...partial });
}

const colorPresets: { label: string; hue: number }[] = [
    { label: "蓝紫", hue: 260 },
    { label: "青绿", hue: 180 },
    { label: "暖橙", hue: 35 },
    { label: "粉红", hue: 330 },
    { label: "金色", hue: 50 },
    { label: "霓虹", hue: 290 },
];

function applyPreset(preset: (typeof colorPresets)[0]) {
    emitConfig({ hue: preset.hue });
}

function resetConfig() {
    emitConfig({
        particleCount: 250,
        glowIntensity: 1.0,
        shakeIntensity: 1.0,
        hue: 260,
        hueSpread: 60,
        fluidIntensity: 1.0,
        fluidActivity: 1.0,
        hueRotate: false,
        hueRotateSpeed: 1.0,
        beatEdgeEnabled: true,
        beatEdgeSensitivity: 1.0,
        beatEdgeWidth: 0.12,
    });
}

// ═══ Spectrum controls ═══
const spectrumEnabled = computed({
    get: () => props.spectrumConfig.enabled,
    set: (v) => emitSpectrumConfig({ enabled: v }),
});
const spectrumStyle = computed({
    get: () => props.spectrumConfig.style,
    set: (v) => emitSpectrumConfig({ style: v }),
});
const spectrumOpacity = computed({
    get: () => props.spectrumConfig.opacity,
    set: (v) => emitSpectrumConfig({ opacity: v }),
});
const spectrumColorMode = computed({
    get: () => props.spectrumConfig.colorMode,
    set: (v) => emitSpectrumConfig({ colorMode: v }),
});
const spectrumCustomColor = computed({
    get: () => props.spectrumConfig.customColor,
    set: (v) => emitSpectrumConfig({ customColor: v }),
});
const spectrumBarCount = computed({
    get: () => props.spectrumConfig.barCount,
    set: (v) => emitSpectrumConfig({ barCount: v }),
});
const spectrumSensitivity = computed({
    get: () => props.spectrumConfig.sensitivity,
    set: (v) => emitSpectrumConfig({ sensitivity: v }),
});

function emitSpectrumConfig(partial: Partial<SpectrumConfig>) {
    emit("update:spectrumConfig", { ...props.spectrumConfig, ...partial });
}

function resetSpectrumConfig() {
    emit("update:spectrumConfig", { ...DEFAULT_SPECTRUM_CONFIG });
}

const spectrumCanvasRef = ref<HTMLCanvasElement | null>(null);

// ═══ Export controls ═══
const localExport = ref<ExportSettings>({ ...props.exportSettings });

watch(
    () => props.exportSettings,
    (s) => {
        localExport.value = { ...s };
    },
    { deep: true },
);

function emitExportChange() {
    emit("update:exportSettings", { ...localExport.value });
}

const resolutionPresets: { label: string; width: number; height: number }[] = [
    { label: "480p", width: 640, height: 480 },
    { label: "720p", width: 1280, height: 720 },
    { label: "1080p", width: 1920, height: 1080 },
    { label: "1440p", width: 2560, height: 1440 },
    { label: "4K", width: 3840, height: 2160 },
    { label: "方形", width: 1080, height: 1080 },
    { label: "竖屏", width: 1080, height: 1920 },
];

function applyResolution(p: (typeof resolutionPresets)[0]) {
    localExport.value.width = p.width;
    localExport.value.height = p.height;
    emitExportChange();
}

const fpsOptions = [24, 30, 60];
function setFps(fps: number) {
    localExport.value.fps = fps;
    emitExportChange();
}

function setSpeedPreset(preset: SpeedPreset) {
    localExport.value.speedPreset = preset;
    emitExportChange();
}

function setEncoder(encoder: VideoEncoder) {
    localExport.value.encoder = encoder;
    if (encoder === "software_vp9") {
        localExport.value.format = "webm";
        if (localExport.value.crf < 15) localExport.value.crf = 30;
    } else if (encoder === "software_x265") {
        localExport.value.format = "mp4";
        // x265 默认 CRF=28 等价于 x264 CRF=23
        if (localExport.value.crf > 40) localExport.value.crf = 28;
    } else {
        localExport.value.format = "mp4";
        if (localExport.value.crf > 40) localExport.value.crf = 23;
    }
    emitExportChange();
}

const isHardwareEncoder = computed(() =>
    localExport.value.encoder.startsWith("videotoolbox"),
);

const qualityLabel = computed(() => {
    if (isHardwareEncoder.value) {
        const q = localExport.value.speedPreset;
        if (q === "quality") return "极佳";
        if (q === "balanced") return "高";
        if (q === "fast") return "标准";
        if (q === "superfast") return "快速";
        return "极速";
    }
    const c = localExport.value.crf;
    // x265 CRF 28 ≈ x264 CRF 23
    if (localExport.value.encoder === "software_x265") {
        if (c <= 22) return "极佳";
        if (c <= 28) return "高";
        if (c <= 34) return "标准";
        if (c <= 42) return "低";
        return "最低";
    }
    if (c <= 18) return "极佳";
    if (c <= 23) return "高";
    if (c <= 28) return "标准";
    if (c <= 35) return "低";
    return "最低";
});

function onCrfInput(e: Event) {
    localExport.value.crf = Number((e.target as HTMLInputElement).value);
    emitExportChange();
}
function onWidthInput(e: Event) {
    localExport.value.width = Number((e.target as HTMLInputElement).value);
    emitExportChange();
}
function onHeightInput(e: Event) {
    localExport.value.height = Number((e.target as HTMLInputElement).value);
    emitExportChange();
}

// ═══ Subtitle controls & animation ═══
const hasManualOuterColor = ref(false);

const lyricOuterColor = computed(() => {
    if (hasManualOuterColor.value) return props.subtitleConfig.outerColor;
    return `hsl(${props.config.hue}, 100%, 60%)`;
});

function emitSubtitleConfig(partial: Partial<SubtitleConfig>) {
    if ("outerColor" in partial) hasManualOuterColor.value = true;
    emit("update:subtitleConfig", { ...props.subtitleConfig, ...partial });
}

// Subtitle animation state
const animState = reactive({
    posX: 50,
    posY: 50,
    targetX: 50,
    targetY: 50,
    shakeX: 0,
    shakeY: 0,
    scale: 1,
    entranceProgress: 0,
    exitProgress: 0,
    isExiting: false,
    entrancePhase: 0,
    swayX: 0,
    swayY: 0,
    beatGlowEnergy: 0,
});

let prevLyric = "";
const displayedLyric = ref("");
let animFrameId: number | null = null;

// System font listing
const systemFonts = ref<string[]>([]);
const fontSearch = ref("");

async function loadSystemFonts() {
    try {
        systemFonts.value = await invoke<string[]>("list_system_fonts");
    } catch {
        systemFonts.value = [
            "PingFang SC",
            "Heiti SC",
            "STHeiti",
            "Songti SC",
            "STSong",
            "KaiTi",
            "STKaiti",
            "Microsoft YaHei",
            "SimHei",
            "SimSun",
            "Arial",
            "Helvetica",
            "Times New Roman",
            "Georgia",
            "Courier New",
            "Menlo",
            "Monaco",
            "SF Mono",
            "Noto Sans SC",
            "Noto Serif SC",
        ];
    }
}

const filteredFonts = computed(() => {
    if (!fontSearch.value) return systemFonts.value;
    const q = fontSearch.value.toLowerCase();
    return systemFonts.value.filter((f) => f.toLowerCase().includes(q));
});

// Multi-select effect toggles
function toggleEntranceEffect(effect: EntranceEffect) {
    const current = [...props.subtitleConfig.entranceEffect];
    const idx = current.indexOf(effect);
    if (idx >= 0) {
        if (current.length > 1) current.splice(idx, 1);
    } else {
        current.push(effect);
    }
    emitSubtitleConfig({ entranceEffect: current } as Partial<SubtitleConfig>);
}

function toggleExitEffect(effect: ExitEffect) {
    const current = [...props.subtitleConfig.exitEffect];
    const idx = current.indexOf(effect);
    if (idx >= 0) {
        if (current.length > 1) current.splice(idx, 1);
    } else {
        current.push(effect);
    }
    emitSubtitleConfig({ exitEffect: current } as Partial<SubtitleConfig>);
}

function hasEffect(effects: string[], name: string): boolean {
    return effects.includes(name);
}

function randomizePosition() {
    const r = props.subtitleConfig.positionRandomness;
    const margin = 15;
    animState.targetX =
        margin + Math.random() * (100 - margin * 2) * r + (1 - r) * 50;
    animState.targetY =
        margin + Math.random() * (100 - margin * 2) * r + (1 - r) * 50;
}

function tickAnimation() {
    // 节拍边框辉光：需要鼓点分轨 + 启用 + 播放中
    if (
        props.hasDrumStem &&
        props.config.beatEdgeEnabled !== false &&
        props.isPlaying
    ) {
        if (props.latestBeat?.isBeat && props.latestBeat.intensity > 0.05) {
            // 鼓点瞬间：拉到检测强度，瞬间闪亮
            animState.beatGlowEnergy = Math.max(
                0.65,
                props.latestBeat.intensity * 1.3,
            );
        }
        // 衰减：0.82 倍率 ≈ 10 帧 (160ms) 后降到峰值 ~14%
        animState.beatGlowEnergy *= 0.85;
        if (animState.beatGlowEnergy < 0.003) animState.beatGlowEnergy = 0;
    } else {
        animState.beatGlowEnergy = 0;
    }

    const ds = props.subtitleConfig.driftSpeed * 0.05;
    animState.posX += (animState.targetX - animState.posX) * ds;
    animState.posY += (animState.targetY - animState.posY) * ds;
    animState.shakeX *= 0.85;
    animState.shakeY *= 0.85;
    animState.scale += (1 - animState.scale) * 0.2;

    // Entrance animation progress
    if (animState.entranceProgress < 1) {
        animState.entranceProgress = Math.min(
            1,
            animState.entranceProgress + 0.04,
        );
    }

    // Exit animation
    if (animState.isExiting) {
        animState.exitProgress = Math.min(1, animState.exitProgress + 0.06);
        if (animState.exitProgress >= 1) {
            animState.entranceProgress = 0;
            animState.exitProgress = 0;
            animState.isExiting = false;
        }
    }

    // Continuous sway (oscillating)
    const t = performance.now() / 1000;
    animState.swayX =
        Math.sin(t * 1.7 + animState.entrancePhase * 10) *
        props.subtitleConfig.swayAmount;
    animState.swayY =
        Math.cos(t * 2.1 + animState.entrancePhase * 7) *
        props.subtitleConfig.swayAmount *
        0.7;

    animFrameId = requestAnimationFrame(tickAnimation);

    // 同步 beat edge canvas 尺寸并绘制边缘辉光
    syncBeatEdgeCanvas();
    renderBeatEdgeGlow();
}

// Watch for lyric changes to randomize position
watch(
    () => props.currentLyric,
    (val) => {
        if (val && val !== prevLyric) {
            if (prevLyric) {
                animState.isExiting = true;
                animState.exitProgress = 0;
                setTimeout(() => {
                    prevLyric = val;
                    displayedLyric.value = val;
                    animState.isExiting = false;
                    animState.entranceProgress = 0;
                    randomizePosition();
                    animState.entrancePhase = Math.random();
                }, 120);
            } else {
                prevLyric = val;
                displayedLyric.value = val;
                randomizePosition();
                animState.entranceProgress = 0;
                animState.entrancePhase = Math.random();
            }
        } else if (!val && prevLyric) {
            // 歌词变为空（空行或间隙）→ 执行出场动画后隐藏
            animState.isExiting = true;
            animState.exitProgress = 0;
            setTimeout(() => {
                prevLyric = "";
                displayedLyric.value = "";
                animState.isExiting = false;
                animState.entranceProgress = 0;
            }, 120);
        }
    },
);

// Watch for beats (only for beat edge glow, NOT lyrics — lyrics stay calm)
// Removed: lyrics no longer shake/scale with beats

// Computed styles for the lyric overlay
const lyricOverlayStyle = computed(() => {
    const cfg = props.subtitleConfig;
    const ep = animState.entranceProgress;
    const xp = animState.exitProgress;

    // Calculate entrance transform
    let entranceTransform = "";
    if (ep < 1) {
        const ease = 1 - Math.pow(1 - ep, 3); // ease-out cubic
        const offset = (1 - ease) * 60;
        if (hasEffect(cfg.entranceEffect, "slideUp"))
            entranceTransform = ` translateY(${offset}px)`;
        else if (hasEffect(cfg.entranceEffect, "slideDown"))
            entranceTransform = ` translateY(${-offset}px)`;
        else if (hasEffect(cfg.entranceEffect, "slideLeft"))
            entranceTransform = ` translateX(${offset}px)`;
        else if (hasEffect(cfg.entranceEffect, "slideRight"))
            entranceTransform = ` translateX(${-offset}px)`;
        else if (hasEffect(cfg.entranceEffect, "scale"))
            entranceTransform = ` scale(${0.3 + ease * 0.7})`;
    }

    let exitTransform = "";
    if (xp > 0) {
        const ease = xp;
        const offset = ease * 40;
        if (hasEffect(cfg.exitEffect, "slideUp"))
            exitTransform = ` translateY(${-offset}px)`;
        else if (hasEffect(cfg.exitEffect, "slideDown"))
            exitTransform = ` translateY(${offset}px)`;
        else if (hasEffect(cfg.exitEffect, "slideLeft"))
            exitTransform = ` translateX(${-offset}px)`;
        else if (hasEffect(cfg.exitEffect, "slideRight"))
            exitTransform = ` translateX(${offset}px)`;
        else if (hasEffect(cfg.exitEffect, "scale"))
            exitTransform = ` scale(${1 - ease * 0.5})`;
    }

    let opacity = 1;
    if (
        ep < 1 &&
        (hasEffect(cfg.entranceEffect, "fade") ||
            hasEffect(cfg.entranceEffect, "blur"))
    )
        opacity = ep;
    if (
        xp > 0 &&
        (hasEffect(cfg.exitEffect, "fade") || hasEffect(cfg.exitEffect, "blur"))
    )
        opacity = 1 - xp;

    let filter = "none";
    if (ep < 1 && hasEffect(cfg.entranceEffect, "blur"))
        filter = `blur(${(1 - ep) * 8}px)`;
    if (xp > 0 && hasEffect(cfg.exitEffect, "blur"))
        filter = `blur(${xp * 8}px)`;

    return {
        position: "absolute" as const,
        left: `${animState.posX}%`,
        top: `${animState.posY}%`,
        transform: `translate(-50%, -50%) translate(${animState.shakeX + animState.swayX}px, ${animState.shakeY + animState.swayY}px) scale(${animState.scale})${entranceTransform}${exitTransform}`,
        zIndex: 15,
        textAlign: "center" as const,
        pointerEvents: "none" as const,
        maxWidth: `${cfg.maxWidth}%`,
        opacity,
        filter,
    };
});

const lyricTextStyle = computed(() => ({
    fontSize: `${props.subtitleConfig.fontSize}px`,
    fontWeight: props.subtitleConfig.fontWeight,
    fontFamily:
        props.subtitleConfig.fontFamily === "inherit"
            ? undefined
            : props.subtitleConfig.fontFamily,
    letterSpacing: `${props.subtitleConfig.letterSpacing}em`,
    color: props.subtitleConfig.innerColor,
    textShadow: [
        `0 0 ${props.subtitleConfig.glowSize}px ${lyricOuterColor.value}`,
        `0 0 ${props.subtitleConfig.glowSize * 1.5}px ${withAlpha(lyricOuterColor.value, props.subtitleConfig.glowIntensity * 0.6)}`,
        `0 2px 4px rgba(0,0,0,0.6)`,
    ].join(", "),
    wordBreak: "break-word" as const,
    overflowWrap: "break-word" as const,
    whiteSpace: "normal" as const,
}));

function withAlpha(color: string, alpha: number): string {
    if (color.startsWith("hsl")) {
        return color.replace(")", ` / ${alpha})`);
    }
    return color;
}

// Start animation loop
function startAnimLoop() {
    if (animFrameId) return;
    animFrameId = requestAnimationFrame(tickAnimation);
}

function stopAnimLoop() {
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
}

// ═══ Canvas init ═══
const visCanvasRef = ref<InstanceType<typeof VisualizerCanvas> | null>(null);
const beatEdgeCanvasRef = ref<HTMLCanvasElement | null>(null);
let beatEdgeCtx: CanvasRenderingContext2D | null = null;

/** 在 beat edge canvas 上绘制边缘鼓点辉光（内框，导出可见） */
function renderBeatEdgeGlow() {
    if (!beatEdgeCtx) return;
    const ctx = beatEdgeCtx;
    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;

    // 先清空
    ctx.clearRect(0, 0, w, h);

    const energy = animState.beatGlowEnergy;
    if (energy < 0.005) return;

    const hue = props.config.hue;
    // easeOutExpo 映射
    const eased = energy < 0.08 ? energy * 0.2 : 1 - Math.pow(1 - energy, 3);
    const alpha = Math.min(1, eased * 1.3);

    // 辉光带宽度（从边缘向内延伸的像素数，相对于画布尺寸）
    const maxGlowWidth = Math.min(w, h) * (props.config.beatEdgeWidth ?? 0.12);
    const glowWidth = maxGlowWidth * eased;

    ctx.save();

    // 四个方向的渐变带
    const edges = [
        // 上边
        { x: 0, y: 0, w: w, h: glowWidth },
        // 下边
        { x: 0, y: h - glowWidth, w: w, h: glowWidth },
        // 左边
        { x: 0, y: 0, w: glowWidth, h: h },
        // 右边
        { x: w - glowWidth, y: 0, w: glowWidth, h: h },
    ];

    for (const edge of edges) {
        const isVertical = edge.w < edge.h;
        const grad = isVertical
            ? ctx.createLinearGradient(
                  edge.x === 0 ? 0 : w,
                  0,
                  edge.x === 0 ? glowWidth : w - glowWidth,
                  0,
              )
            : ctx.createLinearGradient(
                  0,
                  edge.y === 0 ? 0 : h,
                  0,
                  edge.y === 0 ? glowWidth : h - glowWidth,
              );

        // 多层颜色叠加
        grad.addColorStop(0, `hsla(${hue}, 100%, 80%, ${alpha})`);
        grad.addColorStop(0.15, `hsla(${hue}, 100%, 65%, ${alpha * 0.85})`);
        grad.addColorStop(0.4, `hsla(${hue}, 90%, 50%, ${alpha * 0.5})`);
        grad.addColorStop(0.7, `hsla(${hue}, 80%, 40%, ${alpha * 0.15})`);
        grad.addColorStop(1, "transparent");

        ctx.fillStyle = grad;
        ctx.fillRect(edge.x, edge.y, edge.w, edge.h);
    }

    ctx.restore();
}

/** 初始化/更新 beat edge canvas 尺寸 */
function syncBeatEdgeCanvas() {
    const canvas = beatEdgeCanvasRef.value;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width * dpr);
    const h = Math.floor(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        beatEdgeCtx = canvas.getContext("2d");
    }
}

onMounted(() => {
    loadSystemFonts();
    startAnimLoop();
    nextTick(() => {
        setupResizeObserver();
        syncBeatEdgeCanvas();
        const canvas = visCanvasRef.value?.canvas;
        if (canvas) emit("canvasReady", canvas);
        if (spectrumCanvasRef.value) {
            emit("spectrumCanvasReady", spectrumCanvasRef.value);
        }
    });
});

onUnmounted(() => {
    stopAnimLoop();
    resizeObserver?.disconnect();
});

// ═══ Preview sizing: compute px dimensions from container + export ratio ═══
const previewContainer = ref<HTMLElement | null>(null);
const previewWidth = ref(640);
const previewHeight = ref(360);

const previewAspect = computed(
    () => props.exportSettings.width / props.exportSettings.height,
);

// 节拍边框辉光样式 — 鼓点触发时视频边缘一圈强烈发光闪烁
const beatBorderStyle = computed(() => {
    const energy = animState.beatGlowEnergy;
    if (energy < 0.005)
        return { borderColor: "rgba(255,255,255,0.06)", borderWidth: "1px" };
    const hue = props.config.hue;
    // easeOutCubic：平滑映射，低能量也有可见辉光
    const eased = 1 - Math.pow(1 - Math.min(1, energy), 3);
    // 主扩散半径
    const spread = 4 + eased * 140;
    // 核心亮度 alpha — 提升到 1.6 倍让闪光更刺眼
    const alpha = Math.min(1, eased * 1.6);
    // 紧凑内圈发光
    const innerSpread = 2 + eased * 32;
    return {
        boxShadow: [
            // 第一层：紧贴边缘的亮白核心闪光
            `0 0 ${innerSpread}px ${innerSpread * 0.2}px hsla(${hue}, 100%, 80%, ${alpha})`,
            // 第二层：中等扩散的彩色辉光
            `0 0 ${spread}px ${spread * 0.15}px hsla(${hue}, 100%, 60%, ${alpha * 0.85})`,
            // 第三层：大范围柔光
            `0 0 ${spread * 1.8}px ${spread * 0.05}px hsla(${hue}, 100%, 50%, ${alpha * 0.5})`,
            // 第四层：超大范围极淡晕染
            `0 0 ${spread * 3}px ${spread * 0.02}px hsla(${hue}, 80%, 55%, ${alpha * 0.25})`,
            // 内阴影：视频内部边缘也泛光
            `inset 0 0 ${spread * 0.6}px ${spread * 0.1}px hsla(${hue}, 90%, 60%, ${alpha * 0.55})`,
        ].join(", "),
        borderColor: `hsla(${hue}, 100%, 70%, ${Math.min(1, alpha * 1.2)})`,
        borderWidth: `${1 + eased * 4}px`,
    };
});

function computePreviewSize() {
    if (!previewContainer.value) return;
    const parent = previewContainer.value.parentElement; // .preview-column
    if (!parent) return;
    const grandParent = parent.parentElement; // .studio-layout
    if (!grandParent) return;
    const pw = grandParent.clientWidth - 280; // reserve space for sidebar
    const ph = grandParent.clientHeight - 116; // reserve space for timeline (~100px) + padding (16px)
    if (pw <= 0 || ph <= 0) return;
    const ratio = previewAspect.value;
    let w: number, h: number;
    if (pw / ph > ratio) {
        h = ph;
        w = h * ratio;
    } else {
        w = pw;
        h = w / ratio;
    }
    w = Math.max(Math.floor(w), 320);
    h = Math.max(Math.floor(h), 180);
    if (w !== previewWidth.value || h !== previewHeight.value) {
        previewWidth.value = w;
        previewHeight.value = h;
        nextTick(() => {
            (props.engine as any)?.resize?.();
        });
    }
}

let resizeObserver: ResizeObserver | null = null;

function setupResizeObserver() {
    const parent = previewContainer.value?.parentElement;
    if (!parent) return;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
        computePreviewSize();
    });
    resizeObserver.observe(parent);
    computePreviewSize();
}

watch([previewContainer], () => {
    nextTick(() => setupResizeObserver());
});
</script>

<template>
    <div class="studio-layout">
        <div class="preview-column">
            <div
                ref="previewContainer"
                class="preview-stage"
                :style="{
                    width: previewWidth + 'px',
                    height: previewHeight + 'px',
                    ...beatBorderStyle,
                }"
            >
                <VisualizerCanvas
                    ref="visCanvasRef"
                    :engine="engine as any"
                    :config="config"
                />
                <!-- 边缘鼓点辉光叠加层（Canvas 渲染，导出可见） -->
                <canvas ref="beatEdgeCanvasRef" class="beat-edge-canvas" />
                <!-- 频谱可视化叠加层 -->
                <canvas ref="spectrumCanvasRef" class="spectrum-canvas" />
                <!-- 歌词字幕叠加层 -->
                <div
                    v-if="hasLyrics && displayedLyric"
                    class="lyric-overlay"
                    :style="lyricOverlayStyle"
                >
                    <span
                        class="lyric-text"
                        :key="displayedLyric"
                        :style="lyricTextStyle"
                        >{{ displayedLyric }}</span
                    >
                </div>
                <div v-if="hasAudio" class="player-overlay">
                    <AudioControls
                        :is-playing="isPlaying"
                        :current-time="currentTime"
                        :duration="duration"
                        :has-audio="hasAudio"
                        @play="emit('play')"
                        @pause="emit('pause')"
                        @seek="(t) => emit('seek', t)"
                    />
                </div>
                <div class="ratio-badge">
                    {{ exportSettings.width }}×{{ exportSettings.height }}
                </div>
            </div>

            <LyricTimeline
                v-if="hasLyrics"
                class="timeline-below"
                :lyrics="lyrics"
                :duration="duration"
                :current-time="currentTime"
                :is-playing="isPlaying"
                @update:lyrics="(l) => emit('update:lyrics', l)"
                @seek="(t) => emit('seek', t)"
            />
        </div>

        <div class="sidebar-panel">
            <div class="panel-tabs">
                <button
                    class="tab-btn"
                    :class="{ active: activeTab === 'effects' }"
                    @click="activeTab = 'effects'"
                >
                    🎨 特效
                </button>
                <button
                    class="tab-btn"
                    :class="{ active: activeTab === 'subtitle' }"
                    @click="activeTab = 'subtitle'"
                >
                    🎤 字幕
                </button>
                <button
                    class="tab-btn"
                    :class="{ active: activeTab === 'export' }"
                    @click="activeTab = 'export'"
                >
                    📦 导出
                </button>
            </div>

            <div v-show="activeTab === 'effects'" class="tab-content">
                <div class="panel-header">
                    <h3>特效参数</h3>
                    <button class="reset-btn" @click="resetConfig">重置</button>
                </div>

                <div class="control-row">
                    <label
                        ><span class="param-label">粒子数量</span
                        ><span class="param-value">{{
                            particleCount
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="50"
                        max="500"
                        step="10"
                        :value="particleCount"
                        @input="
                            particleCount = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">辉光强度</span
                        ><span class="param-value">{{
                            glowIntensity.toFixed(1)
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        :value="glowIntensity"
                        @input="
                            glowIntensity = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">抖动强度</span
                        ><span class="param-value">{{
                            shakeIntensity.toFixed(1)
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        :value="shakeIntensity"
                        @input="
                            shakeIntensity = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">色相中心</span
                        ><span
                            class="param-value"
                            :style="{
                                color: `hsl(${hueValue}, 100%, 60%)`,
                            }"
                            >{{ hueValue }}°</span
                        ></label
                    >
                    <div class="hue-track">
                        <input
                            type="range"
                            min="0"
                            max="360"
                            step="5"
                            :value="hueValue"
                            :style="{
                                background: `linear-gradient(90deg, red, yellow, lime, cyan, blue, magenta, red)`,
                            }"
                            @input="
                                hueValue = Number(
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                        />
                    </div>
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">色相范围</span
                        ><span class="param-value"
                            >±{{ Math.round(hueSpread / 2) }}°</span
                        ></label
                    >
                    <input
                        type="range"
                        min="10"
                        max="360"
                        step="5"
                        :value="hueSpread"
                        @input="
                            hueSpread = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">流体亮度</span
                        ><span class="param-value">{{
                            fluidIntensity.toFixed(1)
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="0.1"
                        max="2.0"
                        step="0.1"
                        :value="fluidIntensity"
                        @input="
                            fluidIntensity = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">流体活跃度</span
                        ><span class="param-value">{{
                            fluidActivity.toFixed(1)
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="0.1"
                        max="2.0"
                        step="0.1"
                        :value="fluidActivity"
                        @input="
                            fluidActivity = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label><span class="param-label">动态色相</span></label>
                    <div class="chip-row">
                        <button
                            class="chip"
                            :class="{ active: hueRotate }"
                            @click="hueRotate = !hueRotate"
                        >
                            {{ hueRotate ? "🌈 旋转中" : "⏸ 静止" }}
                        </button>
                    </div>
                </div>
                <div v-if="hueRotate" class="control-row">
                    <label
                        ><span class="param-label">旋转速度</span
                        ><span class="param-value">{{
                            hueRotateSpeed.toFixed(1)
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        :value="hueRotateSpeed"
                        @input="
                            hueRotateSpeed = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <!-- ═══ 边缘鼓点闪烁 ═══ -->
                <!-- 边缘鼓点闪烁 -->
                <div class="section-sep" />
                <div class="control-row">
                    <label
                        ><span class="param-label">边缘鼓点闪烁 🥁</span></label
                    >
                    <div class="chip-row">
                        <button
                            class="chip"
                            :class="{ active: beatEdgeEnabled }"
                            @click="beatEdgeEnabled = !beatEdgeEnabled"
                        >
                            {{ beatEdgeEnabled ? "✨ 已启用" : "⏸ 已关闭" }}
                        </button>
                    </div>
                </div>
                <div v-if="beatEdgeEnabled" class="control-row">
                    <label
                        ><span class="param-label">闪烁灵敏度</span
                        ><span class="param-value">{{
                            beatEdgeSensitivity.toFixed(1)
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="0.5"
                        max="2.0"
                        step="0.1"
                        :value="beatEdgeSensitivity"
                        @input="
                            beatEdgeSensitivity = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div v-if="beatEdgeEnabled" class="control-row">
                    <label
                        ><span class="param-label">辉光宽度</span
                        ><span class="param-value">{{
                            (beatEdgeWidth * 100).toFixed(0) + "%"
                        }}</span></label
                    >
                    <input
                        type="range"
                        min="2"
                        max="40"
                        step="1"
                        :value="Math.round(beatEdgeWidth * 100)"
                        @input="
                            beatEdgeWidth =
                                Number(
                                    ($event.target as HTMLInputElement).value,
                                ) / 100
                        "
                    />
                </div>
                <div class="preset-section">
                    <span class="param-label">配色预设</span>
                    <div class="preset-grid">
                        <button
                            v-for="p in colorPresets"
                            :key="p.label"
                            class="preset-btn"
                            :class="{
                                active: config.hue === p.hue,
                            }"
                            @click="applyPreset(p)"
                        >
                            <span
                                class="preset-swatch"
                                :style="{
                                    background: `hsl(${p.hue}, 100%, 50%)`,
                                }"
                            />{{ p.label }}
                        </button>
                    </div>
                </div>
                <div class="preset-section">
                    <span class="param-label">频谱可视化</span>
                    <div class="chip-row">
                        <button
                            class="chip"
                            :class="{ active: spectrumEnabled }"
                            @click="spectrumEnabled = !spectrumEnabled"
                        >
                            {{ spectrumEnabled ? "✅ 已启用" : "⏸ 关闭" }}
                        </button>
                    </div>
                </div>
                <template v-if="spectrumEnabled">
                    <div class="control-row">
                        <label><span class="param-label">样式</span></label>
                        <div class="preset-row">
                            <button
                                v-for="s in SPECTRUM_STYLE_OPTIONS"
                                :key="s.value"
                                class="chip"
                                :class="{ active: spectrumStyle === s.value }"
                                @click="spectrumStyle = s.value"
                            >
                                {{ s.label }}
                            </button>
                        </div>
                    </div>
                    <div class="control-row">
                        <label
                            ><span class="param-label">不透明度</span
                            ><span class="param-value"
                                >{{ Math.round(spectrumOpacity * 100) }}%</span
                            ></label
                        >
                        <input
                            type="range"
                            min="10"
                            max="100"
                            step="5"
                            :value="spectrumOpacity * 100"
                            @input="
                                spectrumOpacity =
                                    Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ) / 100
                            "
                        />
                    </div>
                    <div class="control-row">
                        <label
                            ><span class="param-label">柱数/点数</span
                            ><span class="param-value">{{
                                spectrumBarCount
                            }}</span></label
                        >
                        <input
                            type="range"
                            min="16"
                            max="128"
                            step="8"
                            :value="spectrumBarCount"
                            @input="
                                spectrumBarCount = Number(
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                        />
                    </div>
                    <div class="control-row">
                        <label
                            ><span class="param-label">灵敏度</span
                            ><span class="param-value"
                                >{{
                                    Math.round(spectrumSensitivity * 100)
                                }}%</span
                            ></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            :value="spectrumSensitivity * 100"
                            @input="
                                spectrumSensitivity =
                                    Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ) / 100
                            "
                        />
                    </div>
                    <div class="control-row">
                        <label><span class="param-label">颜色模式</span></label>
                        <div class="chip-row">
                            <button
                                class="chip"
                                :class="{
                                    active: spectrumColorMode === 'auto',
                                }"
                                @click="spectrumColorMode = 'auto'"
                            >
                                频段渐变
                            </button>
                            <button
                                class="chip"
                                :class="{
                                    active: spectrumColorMode === 'hue',
                                }"
                                @click="spectrumColorMode = 'hue'"
                            >
                                跟随色相
                            </button>
                            <button
                                class="chip"
                                :class="{
                                    active: spectrumColorMode === 'custom',
                                }"
                                @click="spectrumColorMode = 'custom'"
                            >
                                自定义
                            </button>
                        </div>
                    </div>
                    <div
                        v-if="spectrumColorMode === 'custom'"
                        class="control-row"
                    >
                        <label
                            ><span class="param-label">自定义颜色</span
                            ><span
                                class="param-swatch-small"
                                :style="{
                                    background: spectrumCustomColor,
                                }"
                            />
                        </label>
                        <div class="color-input-row">
                            <input
                                type="color"
                                class="color-picker"
                                :value="spectrumCustomColor"
                                @input="
                                    spectrumCustomColor = (
                                        $event.target as HTMLInputElement
                                    ).value
                                "
                            />
                            <input
                                type="text"
                                class="color-text-input"
                                :value="spectrumCustomColor"
                                @input="
                                    spectrumCustomColor = (
                                        $event.target as HTMLInputElement
                                    ).value
                                "
                            />
                        </div>
                    </div>
                    <button
                        class="reset-btn"
                        style="margin-top: 8px"
                        @click="resetSpectrumConfig"
                    >
                        重置频谱
                    </button>
                </template>
            </div>

            <!-- Subtitle Tab -->
            <div v-show="activeTab === 'subtitle'" class="tab-content">
                <button class="lrc-import-btn" @click="emit('lrcImport')">
                    📝 导入 LRC 歌词
                </button>

                <div v-if="hasLyrics" class="subtitle-controls">
                    <div class="control-row">
                        <label
                            ><span class="param-label">字体大小</span
                            ><span class="param-value"
                                >{{ subtitleConfig.fontSize }}px</span
                            ></label
                        >
                        <input
                            type="range"
                            min="16"
                            max="64"
                            step="1"
                            :value="subtitleConfig.fontSize"
                            @input="
                                emitSubtitleConfig({
                                    fontSize: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">字重</span
                            ><span class="param-value">{{
                                subtitleConfig.fontWeight
                            }}</span></label
                        >
                        <div class="chip-row">
                            <button
                                v-for="w in [300, 400, 500, 700, 900]"
                                :key="w"
                                class="chip"
                                :class="{
                                    active: subtitleConfig.fontWeight === w,
                                }"
                                @click="emitSubtitleConfig({ fontWeight: w })"
                            >
                                {{ w }}
                            </button>
                        </div>
                    </div>

                    <div class="control-row">
                        <label><span class="param-label">字体</span></label>
                        <div class="font-select-wrapper">
                            <input
                                type="text"
                                v-model="fontSearch"
                                placeholder="搜索字体..."
                                class="font-search-input"
                            />
                            <select
                                size="6"
                                class="font-select-list"
                                :value="subtitleConfig.fontFamily"
                                @change="
                                    emitSubtitleConfig({
                                        fontFamily: (
                                            $event.target as HTMLSelectElement
                                        ).value,
                                    })
                                "
                            >
                                <option
                                    value="inherit"
                                    :style="{ fontFamily: 'inherit' }"
                                >
                                    系统默认
                                </option>
                                <option
                                    v-for="f in filteredFonts"
                                    :key="f"
                                    :value="f"
                                    :style="{ fontFamily: f }"
                                >
                                    {{ f }}
                                </option>
                            </select>
                        </div>
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">字间距</span
                            ><span class="param-value"
                                >{{
                                    subtitleConfig.letterSpacing.toFixed(2)
                                }}em</span
                            ></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="0.3"
                            step="0.01"
                            :value="subtitleConfig.letterSpacing"
                            @input="
                                emitSubtitleConfig({
                                    letterSpacing: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">最大宽度</span
                            ><span class="param-value"
                                >{{ subtitleConfig.maxWidth }}%</span
                            ></label
                        >
                        <input
                            type="range"
                            min="30"
                            max="100"
                            step="5"
                            :value="subtitleConfig.maxWidth"
                            @input="
                                emitSubtitleConfig({
                                    maxWidth: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">外发光大小</span
                            ><span class="param-value"
                                >{{ subtitleConfig.glowSize }}px</span
                            ></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="60"
                            step="1"
                            :value="subtitleConfig.glowSize"
                            @input="
                                emitSubtitleConfig({
                                    glowSize: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">发光强度</span
                            ><span class="param-value">{{
                                subtitleConfig.glowIntensity.toFixed(1)
                            }}</span></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            :value="subtitleConfig.glowIntensity"
                            @input="
                                emitSubtitleConfig({
                                    glowIntensity: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">抖动幅度</span
                            ><span class="param-value"
                                >{{ subtitleConfig.shakeAmount }}px</span
                            ></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="40"
                            step="1"
                            :value="subtitleConfig.shakeAmount"
                            @input="
                                emitSubtitleConfig({
                                    shakeAmount: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">位置随机度</span
                            ><span class="param-value">{{
                                subtitleConfig.positionRandomness.toFixed(2)
                            }}</span></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            :value="subtitleConfig.positionRandomness"
                            @input="
                                emitSubtitleConfig({
                                    positionRandomness: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">摇曳幅度</span
                            ><span class="param-value"
                                >{{ subtitleConfig.swayAmount }}px</span
                            ></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="20"
                            step="0.5"
                            :value="subtitleConfig.swayAmount"
                            @input="
                                emitSubtitleConfig({
                                    swayAmount: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">漂移速度</span
                            ><span class="param-value">{{
                                subtitleConfig.driftSpeed.toFixed(1)
                            }}</span></label
                        >
                        <input
                            type="range"
                            min="0"
                            max="3"
                            step="0.1"
                            :value="subtitleConfig.driftSpeed"
                            @input="
                                emitSubtitleConfig({
                                    driftSpeed: Number(
                                        ($event.target as HTMLInputElement)
                                            .value,
                                    ),
                                })
                            "
                        />
                    </div>

                    <div class="control-row">
                        <label><span class="param-label">入场效果</span></label>
                        <div class="chip-row">
                            <button
                                v-for="e in ENTRANCE_EFFECT_OPTIONS"
                                :key="e.value"
                                class="chip"
                                :class="{
                                    active: subtitleConfig.entranceEffect.includes(
                                        e.value,
                                    ),
                                }"
                                @click="toggleEntranceEffect(e.value)"
                            >
                                {{ e.label }}
                            </button>
                        </div>
                    </div>

                    <div class="control-row">
                        <label><span class="param-label">出场效果</span></label>
                        <div class="chip-row">
                            <button
                                v-for="e in EXIT_EFFECT_OPTIONS"
                                :key="e.value"
                                class="chip"
                                :class="{
                                    active: subtitleConfig.exitEffect.includes(
                                        e.value,
                                    ),
                                }"
                                @click="toggleExitEffect(e.value)"
                            >
                                {{ e.label }}
                            </button>
                        </div>
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">文字颜色</span
                            ><span
                                class="param-swatch-small"
                                :style="{
                                    background: subtitleConfig.innerColor,
                                }"
                            ></span
                        ></label>
                        <div class="color-input-row">
                            <input
                                type="text"
                                :value="subtitleConfig.innerColor"
                                class="color-text-input"
                                @change="
                                    emitSubtitleConfig({
                                        innerColor: (
                                            $event.target as HTMLInputElement
                                        ).value,
                                    })
                                "
                            />
                            <input
                                type="color"
                                :value="subtitleConfig.innerColor"
                                class="color-picker"
                                @input="
                                    emitSubtitleConfig({
                                        innerColor: (
                                            $event.target as HTMLInputElement
                                        ).value,
                                    })
                                "
                            />
                        </div>
                        <div class="preset-row">
                            <button
                                v-for="c in [
                                    '#ffffff',
                                    '#a855f7',
                                    '#6366f1',
                                    '#ec4899',
                                    '#14b8a6',
                                    '#f59e0b',
                                ]"
                                :key="c"
                                class="color-chip"
                                :class="{
                                    active: subtitleConfig.innerColor === c,
                                }"
                                :style="{ background: c }"
                                @click="emitSubtitleConfig({ innerColor: c })"
                            />
                        </div>
                    </div>

                    <div class="control-row">
                        <label
                            ><span class="param-label">发光颜色</span
                            ><span class="param-value"
                                ><button
                                    class="auto-hue-btn"
                                    :class="{
                                        active: !hasManualOuterColor,
                                    }"
                                    @click="
                                        hasManualOuterColor = false;
                                        emitSubtitleConfig({
                                            outerColor: lyricOuterColor,
                                        });
                                    "
                                >
                                    跟随色相
                                </button></span
                            ></label
                        >
                        <div v-if="hasManualOuterColor" class="color-input-row">
                            <input
                                type="text"
                                :value="subtitleConfig.outerColor"
                                class="color-text-input"
                                @change="
                                    emitSubtitleConfig({
                                        outerColor: (
                                            $event.target as HTMLInputElement
                                        ).value,
                                    })
                                "
                            />
                            <input
                                type="color"
                                :value="subtitleConfig.outerColor"
                                class="color-picker"
                                @input="
                                    emitSubtitleConfig({
                                        outerColor: (
                                            $event.target as HTMLInputElement
                                        ).value,
                                    })
                                "
                            />
                        </div>
                        <div v-if="hasManualOuterColor" class="preset-row">
                            <button
                                v-for="c in [
                                    '#a855f7',
                                    '#6366f1',
                                    '#ec4899',
                                    '#14b8a6',
                                    '#f59e0b',
                                    '#ef4444',
                                ]"
                                :key="c"
                                class="color-chip"
                                :class="{
                                    active: subtitleConfig.outerColor === c,
                                }"
                                :style="{ background: c }"
                                @click="emitSubtitleConfig({ outerColor: c })"
                            />
                        </div>
                    </div>
                </div>

                <p v-if="!hasLyrics" class="hint-text">尚未导入歌词文件</p>
            </div>

            <div v-show="activeTab === 'export'" class="tab-content">
                <div class="section">
                    <span class="section-label">分辨率</span>
                    <div class="preset-row">
                        <button
                            v-for="p in resolutionPresets"
                            :key="p.label"
                            class="chip"
                            :class="{
                                active:
                                    localExport.width === p.width &&
                                    localExport.height === p.height,
                            }"
                            @click="applyResolution(p)"
                        >
                            {{ p.label }}
                        </button>
                    </div>
                    <div class="dim-row">
                        <div class="dim-input">
                            <input
                                type="number"
                                :value="localExport.width"
                                min="320"
                                max="7680"
                                step="2"
                                @input="onWidthInput"
                            /><span class="dim-suffix">W</span>
                        </div>
                        <span class="dim-sep">×</span>
                        <div class="dim-input">
                            <input
                                type="number"
                                :value="localExport.height"
                                min="240"
                                max="4320"
                                step="2"
                                @input="onHeightInput"
                            /><span class="dim-suffix">H</span>
                        </div>
                    </div>
                </div>
                <div class="section">
                    <span class="section-label">帧率</span>
                    <div class="preset-row">
                        <button
                            v-for="fps in fpsOptions"
                            :key="fps"
                            class="chip"
                            :class="{ active: localExport.fps === fps }"
                            @click="setFps(fps)"
                        >
                            {{ fps }} fps
                        </button>
                    </div>
                </div>
                <div class="section">
                    <span class="section-label">编码器</span>
                    <div class="encoder-list">
                        <button
                            v-for="enc in ENCODER_OPTIONS"
                            :key="enc.value"
                            class="encoder-btn"
                            :class="{
                                active: localExport.encoder === enc.value,
                            }"
                            @click="setEncoder(enc.value)"
                        >
                            <span class="encoder-name">{{ enc.label }}</span
                            ><span class="encoder-desc">{{ enc.desc }}</span>
                        </button>
                    </div>
                </div>
                <div class="section">
                    <span class="section-label">编码速度</span>
                    <div class="speed-preset-list">
                        <button
                            v-for="opt in SPEED_PRESET_OPTIONS"
                            :key="opt.value"
                            class="speed-btn"
                            :class="{
                                active: localExport.speedPreset === opt.value,
                            }"
                            @click="setSpeedPreset(opt.value)"
                        >
                            <span class="speed-name">{{ opt.label }}</span>
                            <span class="speed-desc">{{ opt.desc }}</span>
                        </button>
                    </div>
                </div>
                <div v-if="!isHardwareEncoder" class="section">
                    <div class="quality-header">
                        <span class="section-label">画质 (CRF)</span
                        ><span
                            class="quality-badge"
                            :class="'q-' + qualityLabel"
                            >{{ qualityLabel }}</span
                        >
                    </div>
                    <input
                        type="range"
                        :min="localExport.format === 'webm' ? 15 : 0"
                        :max="51"
                        :step="1"
                        :value="localExport.crf"
                        @input="onCrfInput"
                    />
                    <div class="crf-labels">
                        <span>高画质</span
                        ><span>CRF: {{ localExport.crf }}</span
                        ><span>小体积</span>
                    </div>
                </div>

                <div class="export-actions-section">
                    <template v-if="!isExporting && !exportDone">
                        <button
                            class="btn-secondary btn-full"
                            @click="emit('selectOutputPath')"
                        >
                            {{
                                exportVideoPath
                                    ? "✓ " + exportVideoPath.split("/").pop()
                                    : "选择保存位置..."
                            }}
                        </button>
                        <button
                            class="btn-primary btn-full"
                            :disabled="!exportVideoPath"
                            @click="emit('startExport')"
                        >
                            🎬 开始导出
                        </button>
                    </template>
                    <template v-if="isExporting && exportProgress">
                        <div class="export-progress">
                            <div class="progress-stage">
                                {{
                                    exportProgress.stage === "encoding"
                                        ? "编码中..."
                                        : exportProgress.stage === "decoding"
                                          ? "解码音频..."
                                          : "渲染中..."
                                }}
                            </div>
                            <div class="progress-area">
                                <div class="progress-track">
                                    <div
                                        class="progress-fill"
                                        :style="{
                                            width: exportProgress.percent + '%',
                                        }"
                                    />
                                </div>
                                <span class="progress-pct"
                                    >{{ exportProgress.percent }}%</span
                                >
                            </div>
                            <p class="progress-detail">
                                帧 {{ exportProgress.currentFrame }} /
                                {{ exportProgress.totalFrames }}
                            </p>
                        </div>
                        <button
                            class="btn-cancel btn-full"
                            @click="emit('cancelExport')"
                        >
                            ✕ 取消导出
                        </button>
                    </template>
                    <template v-if="exportDone && previewVideoUrl">
                        <div class="export-done">
                            <span class="done-icon">✅</span
                            ><span>导出完成</span>
                        </div>
                        <button
                            class="btn-secondary btn-full"
                            @click="emit('resetExport')"
                        >
                            🎬 重新导出
                        </button>
                    </template>
                </div>

                <div class="summary">
                    <div class="summary-row">
                        <span>视频</span
                        ><span
                            >{{ localExport.width }}×{{ localExport.height }} @
                            {{ localExport.fps }}fps</span
                        >
                    </div>
                    <div class="summary-row">
                        <span>编码</span
                        ><span
                            >{{
                                ENCODER_OPTIONS.find(
                                    (e) => e.value === localExport.encoder,
                                )?.label || localExport.encoder
                            }}
                            · {{ qualityLabel }}</span
                        >
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.studio-layout {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: stretch;
    justify-content: center;
    background: #000;
    gap: 0;
}
.preview-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    overflow: hidden;
    padding: 12px 0;
}
.preview-stage {
    position: relative;
    overflow: hidden;
    background: #0a0a14;
    flex-shrink: 0;
    border: 1px solid rgba(255, 255, 255, 0.06);
    transition:
        box-shadow 0.12s ease-out,
        border-color 0.12s ease-out,
        border-width 0.12s ease-out;
}
.timeline-below {
    width: 100%;
    flex-shrink: 0;
}
.spectrum-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 5;
    pointer-events: none;
}
.beat-edge-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 4;
    pointer-events: none;
}
.player-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 16px 24px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
    z-index: 10;
}
.ratio-badge {
    position: absolute;
    top: 12px;
    right: 16px;
    padding: 3px 10px;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.35);
    font-size: 11px;
    font-family: "SF Mono", monospace;
    pointer-events: none;
    z-index: 10;
}

.sidebar-panel {
    width: 280px;
    flex-shrink: 0;
    height: 100%;
    background: rgba(15, 15, 30, 0.95);
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.panel-tabs {
    display: flex;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
}
.tab-btn {
    flex: 1;
    padding: 12px 0;
    border: none;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    border-bottom: 2px solid transparent;
}
.tab-btn:hover {
    color: rgba(255, 255, 255, 0.6);
}
.tab-btn.active {
    color: rgba(255, 255, 255, 0.9);
    border-bottom-color: #a855f7;
    background: rgba(168, 85, 247, 0.05);
}
.tab-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.panel-header h3 {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.85);
    margin: 0;
}
.reset-btn {
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, 0.4);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
}
.reset-btn:hover {
    color: rgba(255, 255, 255, 0.7);
    border-color: rgba(255, 255, 255, 0.25);
}

.control-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.control-row label {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.param-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
.param-value {
    font-size: 12px;
    color: rgba(200, 200, 255, 0.8);
    font-variant-numeric: tabular-nums;
    font-family: "SF Mono", monospace;
}

input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.1);
    outline: none;
    cursor: pointer;
}
input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #a855f7;
    border: 2px solid rgba(255, 255, 255, 0.3);
    cursor: pointer;
    transition: transform 0.1s;
}
input[type="range"]::-webkit-slider-thumb:hover {
    transform: scale(1.15);
}

.hue-track input[type="range"] {
    height: 8px;
    border-radius: 4px;
    background: linear-gradient(
        90deg,
        red,
        yellow,
        lime,
        cyan,
        blue,
        magenta,
        red
    ) !important;
}

.preset-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.section-sep {
    height: 1px;
    background: rgba(255, 255, 255, 0.06);
    margin: 16px 0;
}
.preset-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
}
.preset-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.5);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
}
.preset-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.15);
}
.preset-btn.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
    color: rgba(255, 255, 255, 0.85);
}
.preset-swatch {
    width: 32px;
    height: 10px;
    border-radius: 3px;
}

.section {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.section-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.5);
}
.preset-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.chip {
    padding: 5px 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
}
.chip:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.18);
}
.chip.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.12);
    color: rgba(255, 255, 255, 0.9);
}
.dim-row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.dim-input {
    flex: 1;
    position: relative;
}
.dim-input input {
    width: 100%;
    padding: 7px 32px 7px 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    font-family: "SF Mono", monospace;
    outline: none;
    transition: border-color 0.15s;
}
.dim-input input:focus {
    border-color: rgba(168, 85, 247, 0.4);
}
.dim-suffix {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: rgba(255, 255, 255, 0.25);
}
.dim-sep {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.2);
}

.format-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.format-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
}
.format-btn:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.14);
}
.format-btn.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.08);
}
.format-name {
    font-size: 13px;
    font-weight: 500;
}
.format-desc {
    font-size: 11px;
    opacity: 0.5;
}

.lyric-mode-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    flex: 1;
}
.lyric-mode-btn:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.14);
}
.lyric-mode-btn.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.08);
}
.lyric-mode-label {
    font-size: 13px;
    font-weight: 500;
}
.lyric-mode-desc {
    font-size: 11px;
    opacity: 0.5;
}

.encoder-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.encoder-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
}
.encoder-btn:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.14);
}
.encoder-btn.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.08);
}
.encoder-name {
    font-size: 13px;
    font-weight: 500;
}
.encoder-desc {
    font-size: 11px;
    opacity: 0.5;
}

.speed-preset-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.speed-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
}

.speed-btn:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.14);
}

.speed-btn.active {
    border-color: #22c55e;
    background: rgba(34, 197, 94, 0.08);
}

.speed-name {
    font-size: 13px;
    font-weight: 500;
}

.speed-desc {
    font-size: 11px;
    opacity: 0.5;
}

.quality-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.quality-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
}
.q-极佳 {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
}
.q-高 {
    color: #a3e635;
    background: rgba(163, 230, 53, 0.1);
}
.q-标准 {
    color: #facc15;
    background: rgba(250, 204, 21, 0.1);
}
.q-低 {
    color: #f97316;
    background: rgba(249, 115, 22, 0.1);
}
.q-最低 {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
}
.crf-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.2);
}

.export-actions-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.btn-primary {
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    background: #a855f7;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
}
.btn-primary:hover:not(:disabled) {
    background: #9333ea;
}
.btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
.btn-secondary {
    padding: 10px 16px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
}
.btn-secondary:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.25);
}
.btn-full {
    width: 100%;
    text-align: center;
}
.btn-cancel {
    padding: 8px 16px;
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    background: rgba(239, 68, 68, 0.06);
    color: rgba(239, 68, 68, 0.7);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
}
.btn-cancel:hover {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.5);
}

.export-progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
}
.progress-stage {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    text-align: center;
}
.progress-area {
    display: flex;
    align-items: center;
    gap: 10px;
}
.progress-track {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
}
.progress-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, #a855f7, #6366f1);
    transition: width 0.3s ease;
}
.progress-pct {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    font-family: "SF Mono", monospace;
    min-width: 36px;
    text-align: right;
}
.progress-detail {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.25);
    text-align: center;
    margin: 0;
}

.export-done {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    border-radius: 8px;
    background: rgba(74, 222, 128, 0.08);
    border: 1px solid rgba(74, 222, 128, 0.15);
    color: #4ade80;
    font-size: 13px;
    font-weight: 500;
    justify-content: center;
}
.done-icon {
    font-size: 16px;
}

.summary {
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.summary-row {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
}
.summary-row span:first-child {
    color: rgba(255, 255, 255, 0.35);
}
.summary-row span:last-child {
    color: rgba(255, 255, 255, 0.65);
    font-family: "SF Mono", monospace;
}

/* ── Subtitle tab ── */
.lrc-import-btn {
    padding: 10px 24px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.55);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
}
.lrc-import-btn:hover {
    border-color: rgba(168, 85, 247, 0.4);
    background: rgba(168, 85, 247, 0.08);
    color: rgba(255, 255, 255, 0.8);
}

.subtitle-controls {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.font-select-wrapper {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
}

.font-search-input {
    padding: 6px 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.8);
    font-size: 12px;
    outline: none;
}

.font-search-input:focus {
    border-color: rgba(168, 85, 247, 0.4);
}

.font-select-list {
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.3);
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    padding: 4px;
    outline: none;
    overflow-y: auto;
}

.font-select-list option {
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
}

.font-select-list option:checked {
    background: rgba(168, 85, 247, 0.3);
    color: #fff;
}

.color-input-row {
    display: flex;
    gap: 8px;
    align-items: center;
}

.color-text-input {
    flex: 1;
    padding: 7px 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.8);
    font-size: 12px;
    font-family: "SF Mono", monospace;
    outline: none;
    transition: border-color 0.15s;
}
.color-text-input:focus {
    border-color: rgba(168, 85, 247, 0.4);
}

.color-picker {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
}
.color-picker::-webkit-color-swatch-wrapper {
    padding: 2px;
}
.color-picker::-webkit-color-swatch {
    border: none;
    border-radius: 4px;
}

.color-chip {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 50%;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
}
.color-chip:hover {
    transform: scale(1.15);
}
.color-chip.active {
    border-color: #fff;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
}

.auto-hue-btn {
    padding: 3px 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.45);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
}
.auto-hue-btn:hover {
    border-color: rgba(168, 85, 247, 0.3);
    color: rgba(255, 255, 255, 0.7);
}
.auto-hue-btn.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.12);
    color: #a855f7;
}

.param-swatch-small {
    display: inline-block;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    vertical-align: middle;
    margin-left: 4px;
}

.hint-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.25);
    text-align: center;
    padding: 20px 0;
}

/* ── Dynamic lyric overlay ── */
.lyric-overlay {
    pointer-events: none;
    white-space: nowrap;
}
.lyric-text {
    display: inline-block;
    animation: lyricFadeIn var(--fade-dur, 0.35s) ease-out;
}

@keyframes lyricFadeIn {
    from {
        opacity: 0;
        filter: blur(4px);
    }
    to {
        opacity: 1;
        filter: blur(0);
    }
}

.drum-stem-hint {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
}

.drum-stem-note {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    margin: 0;
}

.drum-stem-note-sub {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
    margin: 0;
}
</style>
