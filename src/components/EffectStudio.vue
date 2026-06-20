<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import AudioControls from "./AudioControls.vue";
import VisualizerCanvas from "./VisualizerCanvas.vue";
import type { VisualizerConfig, ExportSettings } from "../types";
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
}>();

const emit = defineEmits<{
    (e: "update:config", config: VisualizerConfig): void;
    (e: "update:exportSettings", settings: ExportSettings): void;
    (e: "play"): void;
    (e: "pause"): void;
    (e: "seek", time: number): void;
    (e: "canvasReady", canvas: HTMLCanvasElement): void;
    (e: "selectOutputPath"): void;
    (e: "startExport"): void;
    (e: "cancelExport"): void;
    (e: "resetExport"): void;
}>();

// ═══ Tab switching ═══
const activeTab = ref<"effects" | "export">("effects");

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
const hueMin = computed({
    get: () => props.config.hueRange[0],
    set: (v) => emitConfig({ hueRange: [v, props.config.hueRange[1]] }),
});
const hueMax = computed({
    get: () => props.config.hueRange[1],
    set: (v) => emitConfig({ hueRange: [props.config.hueRange[0], v] }),
});

function emitConfig(partial: Partial<VisualizerConfig>) {
    emit("update:config", { ...props.config, ...partial });
}

const colorPresets: { label: string; range: [number, number] }[] = [
    { label: "蓝紫", range: [220, 300] },
    { label: "青绿", range: [140, 220] },
    { label: "暖橙", range: [10, 60] },
    { label: "粉红", range: [300, 360] },
    { label: "金色", range: [35, 70] },
    { label: "霓虹", range: [180, 360] },
];

function applyPreset(preset: (typeof colorPresets)[0]) {
    emitConfig({ hueRange: [...preset.range] });
}

function resetConfig() {
    emitConfig({
        particleCount: 250,
        glowIntensity: 1.0,
        shakeIntensity: 1.0,
        hueRange: [220, 300],
    });
}

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

const formatOptions = [
    { value: "mp4" as const, label: "MP4 (H.264)", desc: "兼容性最好" },
    { value: "webm" as const, label: "WebM (VP9)", desc: "体积更小" },
];

function setFormat(format: "mp4" | "webm") {
    localExport.value.format = format;
    if (format === "webm" && localExport.value.crf < 20)
        localExport.value.crf = 30;
    else if (format === "mp4" && localExport.value.crf > 40)
        localExport.value.crf = 23;
    emitExportChange();
}

const qualityLabel = computed(() => {
    const c = localExport.value.crf;
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

// ═══ Canvas init ═══
const visCanvasRef = ref<InstanceType<typeof VisualizerCanvas> | null>(null);

onMounted(() => {
    nextTick(() => {
        setupResizeObserver();
        const canvas = visCanvasRef.value?.canvas;
        if (canvas) emit("canvasReady", canvas);
    });
});

onUnmounted(() => {
    resizeObserver?.disconnect();
});

// ═══ Preview sizing: compute px dimensions from container + export ratio ═══
const previewContainer = ref<HTMLElement | null>(null);
const previewWidth = ref(640);
const previewHeight = ref(360);

const previewAspect = computed(
    () => props.exportSettings.width / props.exportSettings.height,
);

function computePreviewSize() {
    if (!previewContainer.value) return;
    const parent = previewContainer.value.parentElement;
    if (!parent) return;
    const pw = parent.clientWidth - 280;
    const ph = parent.clientHeight;
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
        <div
            ref="previewContainer"
            class="preview-stage"
            :style="{
                width: previewWidth + 'px',
                height: previewHeight + 'px',
            }"
        >
            <VisualizerCanvas
                ref="visCanvasRef"
                :engine="engine as any"
                :config="config"
            />
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
                        ><span class="param-label">色调起始</span
                        ><span class="param-value">{{ hueMin }}°</span></label
                    >
                    <input
                        type="range"
                        min="0"
                        max="350"
                        step="5"
                        :value="hueMin"
                        @input="
                            hueMin = Number(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </div>
                <div class="control-row">
                    <label
                        ><span class="param-label">色调结束</span
                        ><span class="param-value">{{ hueMax }}°</span></label
                    >
                    <input
                        type="range"
                        min="10"
                        max="360"
                        step="5"
                        :value="hueMax"
                        @input="
                            hueMax = Number(
                                ($event.target as HTMLInputElement).value,
                            )
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
                                active:
                                    config.hueRange[0] === p.range[0] &&
                                    config.hueRange[1] === p.range[1],
                            }"
                            @click="applyPreset(p)"
                        >
                            <span
                                class="preset-swatch"
                                :style="{
                                    background: `linear-gradient(90deg, hsl(${p.range[0]},100%,50%), hsl(${p.range[1]},100%,50%))`,
                                }"
                            />{{ p.label }}
                        </button>
                    </div>
                </div>
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
                    <span class="section-label">输出格式</span>
                    <div class="format-list">
                        <button
                            v-for="fmt in formatOptions"
                            :key="fmt.value"
                            class="format-btn"
                            :class="{
                                active: localExport.format === fmt.value,
                            }"
                            @click="setFormat(fmt.value)"
                        >
                            <span class="format-name">{{ fmt.label }}</span
                            ><span class="format-desc">{{ fmt.desc }}</span>
                        </button>
                    </div>
                </div>
                <div class="section">
                    <div class="quality-header">
                        <span class="section-label">画质</span
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
                        <span>格式</span
                        ><span
                            >{{ localExport.format.toUpperCase() }} /
                            {{ qualityLabel }}画质</span
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
    align-items: center;
    justify-content: center;
    background: #000;
}
.preview-stage {
    position: relative;
    overflow: hidden;
    background: #0a0a14;
    flex-shrink: 0;
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
    color: rgba(255, 255, 255, 0.35);
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
    color: rgba(255, 255, 255, 0.7);
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

.preset-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
    color: rgba(255, 255, 255, 0.35);
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
</style>
