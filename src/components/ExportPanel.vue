<script setup lang="ts">
import { ref, computed } from "vue";
import type { ExportSettings } from "../types";
import { ENCODER_OPTIONS } from "../types";

const props = defineProps<{
    settings: ExportSettings;
}>();

const emit = defineEmits<{
    (e: "update:settings", settings: ExportSettings): void;
}>();

const local = ref<ExportSettings>({ ...props.settings });

function emitChange() {
    emit("update:settings", { ...local.value });
}

// ═══ Resolution presets ═══
interface ResolutionPreset {
    label: string;
    width: number;
    height: number;
}

const resolutionPresets: ResolutionPreset[] = [
    { label: "480p", width: 640, height: 480 },
    { label: "720p", width: 1280, height: 720 },
    { label: "1080p", width: 1920, height: 1080 },
    { label: "2K", width: 2560, height: 1440 },
    { label: "4K", width: 3840, height: 2160 },
    { label: "方形", width: 1080, height: 1080 },
    { label: "竖屏", width: 1080, height: 1920 },
];

function applyResolution(preset: ResolutionPreset) {
    local.value.width = preset.width;
    local.value.height = preset.height;
    emitChange();
}

const isCustomResolution = computed(() => {
    return !resolutionPresets.some(
        (p) => p.width === local.value.width && p.height === local.value.height,
    );
});

// ═══ FPS ═══
const fpsOptions = [24, 30, 60];

function setFps(fps: number) {
    local.value.fps = fps;
    emitChange();
}

// ═══ Encoder ═══
const groupedEncoders = computed(() => {
    const groups: { label: string; options: typeof ENCODER_OPTIONS }[] = [
        {
            label: "macOS",
            options: ENCODER_OPTIONS.filter((o) => o.platform === "macOS"),
        },
        {
            label: "NVIDIA",
            options: ENCODER_OPTIONS.filter(
                (o) =>
                    o.platform === "Windows/Linux" &&
                    o.label.startsWith("NVENC"),
            ),
        },
        {
            label: "AMD",
            options: ENCODER_OPTIONS.filter(
                (o) =>
                    o.platform === "Windows/Linux" && o.label.startsWith("AMF"),
            ),
        },
        {
            label: "Intel",
            options: ENCODER_OPTIONS.filter(
                (o) =>
                    o.platform === "Windows/Linux" &&
                    o.label.startsWith("QuickSync"),
            ),
        },
        {
            label: "Linux VAAPI",
            options: ENCODER_OPTIONS.filter((o) => o.platform === "Linux"),
        },
        {
            label: "CPU",
            options: ENCODER_OPTIONS.filter((o) => o.platform === "通用"),
        },
    ];
    return groups.filter((g) => g.options.length > 0);
});

function setEncoder(encoder: string) {
    local.value.encoder = encoder as ExportSettings["encoder"];
    emitChange();
}

// ═══ Format ═══
const formatOptions = [
    { value: "mp4" as const, label: "MP4 (H.264)", desc: "兼容性最好" },
    { value: "webm" as const, label: "WebM (VP9)", desc: "体积更小" },
];

function setFormat(format: "mp4" | "webm") {
    local.value.format = format;
    // 自动调整 CRF
    if (format === "webm" && local.value.crf < 20) {
        local.value.crf = 30;
    } else if (format === "mp4" && local.value.crf > 40) {
        local.value.crf = 23;
    }
    emitChange();
}

const qualityLabel = computed(() => {
    const crf = local.value.crf;
    if (crf <= 18) return "极佳";
    if (crf <= 23) return "高";
    if (crf <= 28) return "标准";
    if (crf <= 35) return "低";
    return "最低";
});

function onCrfInput(e: Event) {
    local.value.crf = Number((e.target as HTMLInputElement).value);
    emitChange();
}

// ═══ Width/Height input ═══
function onWidthInput(e: Event) {
    let w = Number((e.target as HTMLInputElement).value);
    if (w % 2 !== 0) w = Math.ceil(w / 2) * 2;
    local.value.width = w;
    emitChange();
}

function onHeightInput(e: Event) {
    let h = Number((e.target as HTMLInputElement).value);
    if (h % 2 !== 0) h = Math.ceil(h / 2) * 2;
    local.value.height = h;
    emitChange();
}

function resetDefaults() {
    local.value = {
        width: 1920,
        height: 1080,
        fps: 30,
        encoder: "videotoolbox_h264",
        format: "mp4",
        crf: 23,
        speedPreset: "quality",
    };
    emitChange();
}
</script>

<template>
    <div class="export-panel">
        <div class="panel-header">
            <h3>Export Settings</h3>
            <button class="reset-btn" @click="resetDefaults">Default</button>
        </div>

        <!-- Resolution -->
        <div class="section">
            <span class="section-label">Resolution</span>
            <div class="preset-row">
                <button
                    v-for="preset in resolutionPresets"
                    :key="preset.label"
                    class="chip"
                    :class="{
                        active:
                            local.width === preset.width &&
                            local.height === preset.height,
                    }"
                    @click="applyResolution(preset)"
                >
                    {{ preset.label }}
                </button>
                <button class="chip" :class="{ active: isCustomResolution }">
                    Custom
                </button>
            </div>
            <div class="dim-row">
                <div class="dim-input">
                    <input
                        type="number"
                        :value="local.width"
                        min="320"
                        max="7680"
                        step="2"
                        @input="onWidthInput"
                    />
                    <span class="dim-suffix">W</span>
                </div>
                <span class="dim-sep">x</span>
                <div class="dim-input">
                    <input
                        type="number"
                        :value="local.height"
                        min="240"
                        max="4320"
                        step="2"
                        @input="onHeightInput"
                    />
                    <span class="dim-suffix">H</span>
                </div>
            </div>
        </div>

        <!-- FPS -->
        <div class="section">
            <span class="section-label">FPS</span>
            <div class="preset-row">
                <button
                    v-for="fps in fpsOptions"
                    :key="fps"
                    class="chip"
                    :class="{ active: local.fps === fps }"
                    @click="setFps(fps)"
                >
                    {{ fps }} fps
                </button>
            </div>
        </div>

        <!-- Encoder -->
        <div class="section">
            <span class="section-label">Encoder</span>
            <template v-for="group in groupedEncoders" :key="group.label">
                <span class="subsection-label">{{ group.label }}</span>
                <div class="encoder-list">
                    <button
                        v-for="enc in group.options"
                        :key="enc.value"
                        class="encoder-btn"
                        :class="{ active: local.encoder === enc.value }"
                        @click="setEncoder(enc.value)"
                    >
                        <span class="encoder-name">{{ enc.label }}</span>
                        <span class="encoder-desc">{{ enc.desc }}</span>
                    </button>
                </div>
            </template>
        </div>

        <!-- Format -->
        <div class="section">
            <span class="section-label">Format</span>
            <div class="format-list">
                <button
                    v-for="fmt in formatOptions"
                    :key="fmt.value"
                    class="format-btn"
                    :class="{ active: local.format === fmt.value }"
                    @click="setFormat(fmt.value)"
                >
                    <span class="format-name">{{ fmt.label }}</span>
                    <span class="format-desc">{{ fmt.desc }}</span>
                </button>
            </div>
        </div>

        <!-- Quality -->
        <div class="section">
            <div class="quality-header">
                <span class="section-label">Quality</span>
                <span class="quality-badge" :class="'q-' + qualityLabel">{{
                    qualityLabel
                }}</span>
            </div>
            <input
                type="range"
                :min="local.format === 'webm' ? 15 : 0"
                :max="51"
                :step="1"
                :value="local.crf"
                @input="onCrfInput"
            />
            <div class="crf-labels">
                <span>High</span>
                <span>CRF: {{ local.crf }}</span>
                <span>Small</span>
            </div>
        </div>

        <!-- Summary -->
        <div class="summary">
            <div class="summary-row">
                <span>Video</span>
                <span
                    >{{ local.width }}x{{ local.height }} @
                    {{ local.fps }}fps</span
                >
            </div>
            <div class="summary-row">
                <span>Format</span>
                <span
                    >{{ local.format.toUpperCase() }} / {{ qualityLabel }}</span
                >
            </div>
        </div>
    </div>
</template>

<style scoped>
.export-panel {
    width: 280px;
    flex-shrink: 0;
    padding: 20px;
    background: rgba(15, 15, 30, 0.9);
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
}

.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.panel-header h3 {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.85);
    margin: 0;
}

.reset-btn {
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
}

.reset-btn:hover {
    color: rgba(255, 255, 255, 0.7);
    border-color: rgba(255, 255, 255, 0.25);
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

.subsection-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 2px;
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

.encoder-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.encoder-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 8px 10px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
}

.encoder-btn:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.12);
}

.encoder-btn.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
    color: rgba(255, 255, 255, 0.85);
}

.encoder-name {
    font-size: 12px;
    font-weight: 500;
}

.encoder-desc {
    font-size: 10px;
    opacity: 0.45;
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

.quality-badge.q-极佳 {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
}
.quality-badge.q-高 {
    color: #a3e635;
    background: rgba(163, 230, 53, 0.1);
}
.quality-badge.q-标准 {
    color: #facc15;
    background: rgba(250, 204, 21, 0.1);
}
.quality-badge.q-低 {
    color: #f97316;
    background: rgba(249, 115, 22, 0.1);
}
.quality-badge.q-最低 {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
}

.crf-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
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

.summary {
    margin-top: auto;
    padding-top: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.summary-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
}

.summary-row span:first-child {
    color: rgba(255, 255, 255, 0.5);
}

.summary-row span:last-child {
    color: rgba(255, 255, 255, 0.7);
    font-family: "SF Mono", monospace;
}
</style>
