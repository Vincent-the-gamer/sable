<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import AudioControls from "./AudioControls.vue";
import VisualizerCanvas from "./VisualizerCanvas.vue";
import type { VisualizerConfig } from "../types";

const props = defineProps<{
    config: VisualizerConfig;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    hasAudio: boolean;
    engine: unknown;
}>();

const emit = defineEmits<{
    (e: "update:config", config: VisualizerConfig): void;
    (e: "play"): void;
    (e: "pause"): void;
    (e: "seek", time: number): void;
    (e: "canvasReady", canvas: HTMLCanvasElement): void;
}>();

// ═══ Direct local config (one-way from props, emit changes up) ═══
// Use computed getters that read from props directly, no local cache
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

// ═══ Color preset buttons ═══
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

// ═══ Canvas initialization ═══
const visCanvasRef = ref<InstanceType<typeof VisualizerCanvas> | null>(null);

onMounted(() => {
    nextTick(() => {
        const canvas = visCanvasRef.value?.canvas;
        if (canvas) emit("canvasReady", canvas);
    });
});
</script>

<template>
    <div class="effect-studio">
        <!-- Preview area -->
        <div class="preview-area">
            <VisualizerCanvas
                ref="visCanvasRef"
                :engine="engine as any"
                :config="config"
            />

            <!-- Player overlay -->
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
        </div>

        <!-- Controls panel -->
        <div class="controls-panel">
            <div class="panel-header">
                <h3>🎨 特效参数</h3>
                <button class="reset-btn" @click="resetConfig">重置默认</button>
            </div>

            <!-- 粒子数量 -->
            <div class="control-row">
                <label>
                    <span class="param-label">粒子数量</span>
                    <span class="param-value">{{ particleCount }}</span>
                </label>
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

            <!-- 辉光强度 -->
            <div class="control-row">
                <label>
                    <span class="param-label">辉光强度</span>
                    <span class="param-value">{{
                        glowIntensity.toFixed(1)
                    }}</span>
                </label>
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

            <!-- 抖动强度 -->
            <div class="control-row">
                <label>
                    <span class="param-label">抖动强度</span>
                    <span class="param-value">{{
                        shakeIntensity.toFixed(1)
                    }}</span>
                </label>
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

            <!-- 色调范围 -->
            <div class="control-row">
                <label>
                    <span class="param-label">色调起始</span>
                    <span class="param-value">{{ hueMin }}°</span>
                </label>
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
                <label>
                    <span class="param-label">色调结束</span>
                    <span class="param-value">{{ hueMax }}°</span>
                </label>
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

            <!-- 颜色预设 -->
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
                                background: `linear-gradient(90deg, hsl(${p.range[0]}, 100%, 50%), hsl(${p.range[1]}, 100%, 50%))`,
                            }"
                        />
                        {{ p.label }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.effect-studio {
    display: flex;
    width: 100%;
    height: 100%;
}

.preview-area {
    flex: 1;
    position: relative;
    min-width: 0;
}

.player-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 16px 24px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
    z-index: 10;
}

.controls-panel {
    width: 280px;
    flex-shrink: 0;
    padding: 20px;
    background: rgba(15, 15, 30, 0.9);
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
}

.panel-header h3 {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.75);
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
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
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
</style>
