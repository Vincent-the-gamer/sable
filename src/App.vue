<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import AudioLoader from "./components/AudioLoader.vue";
import EffectStudio from "./components/EffectStudio.vue";
import ExportPanel from "./components/ExportPanel.vue";
import SettingsPage from "./components/SettingsPage.vue";
import DebugPage from "./components/DebugPage.vue";
import { AudioEngine } from "./engine/AudioEngine";
import { BeatDetector } from "./engine/BeatDetector";
import { VisualizerEngine } from "./engine/VisualizerEngine";
import { ExportPipeline } from "./engine/ExportPipeline";
import type {
    SpectrumData,
    BeatResult,
    VisualizerConfig,
    ExportSettings,
} from "./types";
import type { ExportProgress as ExportProgressData } from "./engine/ExportPipeline";

// ═══════════ Pages ═══════════
type Page = "home" | "studio" | "export" | "settings" | "debug";
const currentPage = ref<Page>("home");

// ═══════════ Audio Engine ═══════════
const audioEngine = new AudioEngine();
const beatDetector = new BeatDetector();
const visualizer = ref<VisualizerEngine | null>(null);

const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const hasAudio = ref(false);
const loadedFilePath = ref("");

const latestSpectrum = ref<SpectrumData | null>(null);
const latestBeat = ref<BeatResult>({ isBeat: false, intensity: 0 });

// ═══════════ Config ═══════════
const visualizerConfig = ref<VisualizerConfig>({
    particleCount: 250,
    glowIntensity: 1.0,
    shakeIntensity: 1.0,
    hueRange: [220, 300],
});

const exportSettings = ref<ExportSettings>({
    width: 1920,
    height: 1080,
    fps: 30,
    format: "mp4",
    crf: 23,
});

// ═══════════ Export State ═══════════
const isExporting = ref(false);
const exportProgress = ref<ExportProgressData | null>(null);
const exportVideoPath = ref("");
const exportDone = ref(false);
const previewVideoUrl = ref("");
const ffmpegPath = ref(localStorage.getItem("sable_ffmpeg_path") || "");

function syncFfmpegPath() {
    ffmpegPath.value = localStorage.getItem("sable_ffmpeg_path") || "";
}

let cancelCurrentExport: (() => void) | null = null;

// ═══════════ Time Tracker ═══════════
let timeTimer: ReturnType<typeof setInterval> | null = null;

function startTimeTracker() {
    stopTimeTracker();
    timeTimer = setInterval(() => {
        if (audioEngine.isPlaying) {
            currentTime.value = audioEngine.currentTime;
            latestSpectrum.value = audioEngine.getSpectrumData();
            if (latestSpectrum.value)
                latestBeat.value = beatDetector.detect(latestSpectrum.value);
        }
    }, 16);
}

function stopTimeTracker() {
    if (timeTimer) {
        clearInterval(timeTimer);
        timeTimer = null;
    }
}

// ═══════════ Audio Actions ═══════════
async function onFileLoaded(file: File, path: string) {
    await audioEngine.loadFile(file);
    hasAudio.value = true;
    duration.value = audioEngine.duration;
    currentTime.value = 0;
    loadedFilePath.value = path;
    beatDetector.reset();
    // Auto-navigate to studio
    currentPage.value = "studio";
}

function initVisualizer(canvas: HTMLCanvasElement) {
    visualizer.value?.stop();
    visualizer.value = new VisualizerEngine(canvas);
    visualizer.value.config = { ...visualizerConfig.value };
    visualizer.value.start(
        () => latestSpectrum.value,
        () => latestBeat.value,
    );
}

function play() {
    audioEngine.play();
    isPlaying.value = true;
    startTimeTracker();
}

function pause() {
    audioEngine.pause();
    isPlaying.value = false;
    stopTimeTracker();
}

function seek(time: number) {
    audioEngine.seek(time);
    currentTime.value = time;
}

function onKeyDown(e: KeyboardEvent) {
    if (e.code === "Space" && hasAudio.value && !isExporting.value) {
        e.preventDefault();
        isPlaying.value ? pause() : play();
    }
}

// ═══════════ Export Logic ═══════════
async function selectOutputPath() {
    const ext = exportSettings.value.format === "webm" ? "webm" : "mp4";
    const path = await save({
        filters: [
            {
                name: ext === "mp4" ? "MP4 Video" : "WebM Video",
                extensions: [ext],
            },
        ],
    });
    if (path) {
        exportVideoPath.value = path as string;
        exportDone.value = false;
        previewVideoUrl.value = "";
    }
}

function startExport() {
    if (!loadedFilePath.value || !exportVideoPath.value || isExporting.value)
        return;

    syncFfmpegPath();

    console.log("[App] 开始导出, ffmpeg:", ffmpegPath.value || "(系统PATH)");
    isExporting.value = true;
    exportDone.value = false;
    previewVideoUrl.value = "";
    exportProgress.value = {
        currentFrame: 0,
        totalFrames: 0,
        percent: 0,
        stage: "decoding",
    };

    const { cancel, done } = ExportPipeline.startExport(
        loadedFilePath.value,
        exportVideoPath.value,
        visualizerConfig.value,
        exportSettings.value,
        ffmpegPath.value,
        (p) => {
            exportProgress.value = { ...p };
        },
    );

    cancelCurrentExport = cancel;

    done.then((outputPath) => {
        isExporting.value = false;
        exportDone.value = true;
        previewVideoUrl.value = convertFileSrc(outputPath);
    })
        .catch((err) => {
            if (String(err).includes("取消")) {
                console.log("导出已取消");
            } else {
                console.error("导出失败:", err);
            }
            isExporting.value = false;
            exportProgress.value = null;
        })
        .finally(() => {
            cancelCurrentExport = null;
        });
}

function cancelExport() {
    cancelCurrentExport?.();
    isExporting.value = false;
    exportProgress.value = null;
}

function onUpdateConfig(cfg: VisualizerConfig) {
    // Only update the ref — VisualizerCanvas watch will sync to engine
    visualizerConfig.value = cfg;
}

// Stop visualizer when leaving studio page
watch(currentPage, (_, oldPage) => {
    if (oldPage === "studio") {
        visualizer.value?.stop();
    }
});

function onUpdateExportSettings(s: ExportSettings) {
    exportSettings.value = s;
    // Reset export path when settings change
    exportVideoPath.value = "";
    exportDone.value = false;
}

// ═══════════ Lifecycle ═══════════
onMounted(() => window.addEventListener("keydown", onKeyDown));
onUnmounted(() => {
    stopTimeTracker();
    visualizer.value?.stop();
    audioEngine.dispose();
    window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
    <div class="app-shell">
        <!-- Sidebar -->
        <aside class="sidebar">
            <div class="sidebar-brand">
                <span class="brand-icon">◆</span>
                <span class="brand-name">Sable</span>
            </div>
            <nav class="sidebar-nav">
                <button
                    class="nav-item"
                    :class="{ active: currentPage === 'home' }"
                    @click="currentPage = 'home'"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path d="M12 16V4m0 0L8 8m4-4l4 4" />
                        <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                    </svg>
                    导入
                </button>
                <button
                    class="nav-item"
                    :class="{ active: currentPage === 'studio' }"
                    :disabled="!hasAudio"
                    @click="currentPage = 'studio'"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 6v6l4 2" />
                    </svg>
                    特效
                </button>
                <button
                    class="nav-item"
                    :class="{ active: currentPage === 'export' }"
                    :disabled="!hasAudio"
                    @click="currentPage = 'export'"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    导出
                </button>
                <div class="nav-separator" />
                <button
                    class="nav-item"
                    :class="{ active: currentPage === 'settings' }"
                    @click="currentPage = 'settings'"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <circle cx="12" cy="12" r="3" />
                        <path
                            d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"
                        />
                    </svg>
                    设置
                </button>
                <button
                    class="nav-item"
                    :class="{ active: currentPage === 'debug' }"
                    @click="currentPage = 'debug'"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path d="M12 20h9" />
                        <path
                            d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
                        />
                    </svg>
                    调试
                </button>
            </nav>
            <div class="sidebar-footer">
                <span class="version">v0.2.0</span>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="main-content">
            <!-- Page: Home (Upload) -->
            <div v-if="currentPage === 'home'" class="page-center">
                <AudioLoader @file-loaded="onFileLoaded" />
                <p v-if="!hasAudio" class="hint-text">导入音频文件开始创作</p>
            </div>

            <!-- Page: Studio (Effect Config + Preview) -->
            <EffectStudio
                v-if="currentPage === 'studio'"
                :config="visualizerConfig"
                :is-playing="isPlaying"
                :current-time="currentTime"
                :duration="duration"
                :has-audio="hasAudio"
                :engine="visualizer"
                @update:config="onUpdateConfig"
                @play="play"
                @pause="pause"
                @seek="seek"
                @canvas-ready="initVisualizer"
            />

            <!-- Page: Export -->
            <div v-if="currentPage === 'export'" class="export-page">
                <div class="export-center">
                    <!-- Select output path -->
                    <div
                        v-if="!isExporting && !exportDone"
                        class="export-section"
                    >
                        <h2 class="export-title">导出视频</h2>
                        <p class="export-desc">选择保存位置后开始渲染</p>
                        <div class="export-actions">
                            <button
                                class="btn-secondary"
                                @click="selectOutputPath"
                            >
                                {{
                                    exportVideoPath
                                        ? "✓ " +
                                          exportVideoPath.split("/").pop()
                                        : "选择保存位置..."
                                }}
                            </button>
                            <button
                                class="btn-primary btn-large"
                                :disabled="!exportVideoPath"
                                @click="startExport"
                            >
                                🎬 开始导出
                            </button>
                        </div>
                    </div>

                    <!-- Exporting: progress -->
                    <div
                        v-if="isExporting && exportProgress"
                        class="export-section"
                    >
                        <h2 class="export-title">
                            {{
                                exportProgress.stage === "encoding"
                                    ? "编码中..."
                                    : exportProgress.stage === "decoding"
                                      ? "解码音频..."
                                      : "渲染中..."
                            }}
                        </h2>
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
                        <button class="btn-cancel" @click="cancelExport">
                            ✕ 取消导出
                        </button>
                    </div>

                    <!-- Export done: preview -->
                    <div
                        v-if="exportDone && previewVideoUrl"
                        class="export-section"
                    >
                        <h2 class="export-title">✅ 导出完成</h2>
                        <div class="preview-box">
                            <video
                                :src="previewVideoUrl"
                                controls
                                autoplay
                                loop
                                class="preview-video"
                            />
                        </div>
                        <p class="export-desc">
                            {{ exportVideoPath.split("/").pop() }}
                        </p>
                        <div class="export-actions">
                            <button
                                class="btn-secondary"
                                @click="
                                    exportDone = false;
                                    previewVideoUrl = '';
                                    exportVideoPath = '';
                                "
                            >
                                🎬 重新导出
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Export settings panel (right side) -->
                <ExportPanel
                    v-if="!isExporting"
                    :settings="exportSettings"
                    @update:settings="onUpdateExportSettings"
                />
            </div>

            <!-- Page: Settings -->
            <div v-if="currentPage === 'settings'" class="page-container">
                <SettingsPage />
            </div>

            <!-- Page: Debug -->
            <div v-if="currentPage === 'debug'" class="page-container">
                <DebugPage
                    :is-playing="isPlaying"
                    :has-audio="hasAudio"
                    :current-time="currentTime"
                    :duration="duration"
                    :loaded-file-path="loadedFilePath"
                    :is-exporting="isExporting"
                    :export-progress="exportProgress"
                    :latest-spectrum="latestSpectrum"
                    :latest-beat="latestBeat"
                    :visualizer-config="visualizerConfig"
                    :ffmpeg-path="ffmpegPath"
                />
            </div>
        </main>
    </div>
</template>

<style>
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

html,
body,
#app {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #0a0a14;
    color: #f0f0f0;
    font-family:
        "Inter",
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
}

.app-shell {
    display: flex;
    width: 100%;
    height: 100%;
}

/* ═══════ Sidebar ═══════ */

.sidebar {
    width: 200px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: rgba(15, 15, 30, 0.8);
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    padding: 20px 12px;
    z-index: 20;
}

.sidebar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    margin-bottom: 12px;
}

.brand-icon {
    font-size: 18px;
    color: #a855f7;
}

.brand-name {
    font-size: 16px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.85);
    letter-spacing: 0.03em;
}

.sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.45);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
}

.nav-item:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.75);
}

.nav-item.active {
    background: rgba(168, 85, 247, 0.12);
    color: rgba(255, 255, 255, 0.9);
}

.nav-item:disabled {
    opacity: 0.25;
    cursor: not-allowed;
}

.nav-separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.05);
    margin: 8px 8px;
}

.sidebar-footer {
    padding: 12px 8px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.version {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.2);
}

/* ═══════ Main Content ═══════ */

.main-content {
    flex: 1;
    display: flex;
    overflow: hidden;
    min-width: 0;
}

.page-container {
    width: 100%;
    height: 100%;
    overflow-y: auto;
}

.page-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 40px;
}

.hint-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.2);
    margin-top: 8px;
}

/* ═══════ Export Page ═══════ */

.export-page {
    display: flex;
    width: 100%;
    height: 100%;
}

.export-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
    min-width: 0;
}

.export-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    width: 100%;
    max-width: 460px;
}

.export-title {
    font-size: 22px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.85);
}

.export-desc {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.35);
}

.export-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
}

.progress-area {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
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
    background: linear-gradient(90deg, #6366f1, #a855f7);
    transition: width 0.3s ease;
}

.progress-pct {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.5);
    font-variant-numeric: tabular-nums;
    min-width: 42px;
    text-align: right;
}

.progress-detail {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.25);
}

.preview-box {
    width: 100%;
    max-width: 480px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #000;
}

.preview-video {
    width: 100%;
    display: block;
}

/* ═══════ Buttons ═══════ */

.btn-secondary {
    padding: 10px 20px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.75);
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    transition: all 0.2s;
}

.btn-secondary:hover {
    background: rgba(255, 255, 255, 0.08);
}

.btn-primary {
    padding: 10px 24px;
    border: none;
    border-radius: 9px;
    background: linear-gradient(135deg, #6366f1, #a855f7);
    color: white;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    transition: all 0.2s;
}

.btn-primary.btn-large {
    padding: 14px 36px;
    font-size: 16px;
}

.btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 18px rgba(99, 102, 241, 0.35);
}

.btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.btn-cancel {
    padding: 8px 20px;
    border: 1px solid rgba(255, 100, 100, 0.3);
    border-radius: 8px;
    background: rgba(255, 60, 60, 0.12);
    color: rgba(255, 160, 160, 0.85);
    cursor: pointer;
    font-size: 13px;
    transition: all 0.2s;
}

.btn-cancel:hover {
    background: rgba(255, 60, 60, 0.22);
    border-color: rgba(255, 100, 100, 0.5);
}
</style>
