<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import AudioLoader from "./components/AudioLoader.vue";
import EffectStudio from "./components/EffectStudio.vue";
import SettingsPage from "./components/SettingsPage.vue";
import DebugPage from "./components/DebugPage.vue";
import { AudioEngine } from "./engine/AudioEngine";
import { BeatDetector } from "./engine/BeatDetector";
import { WebGLFluidEngine } from "./engine/WebGLFluidEngine";
import { ExportPipeline } from "./engine/ExportPipeline";
import type {
    SpectrumData,
    BeatResult,
    VisualizerConfig,
    ExportSettings,
} from "./types";
import type { ExportProgress as ExportProgressData } from "./engine/ExportPipeline";

// ═══════════ Pages ═══════════
type Page = "home" | "studio" | "settings" | "debug";
const currentPage = ref<Page>("home");

// ═══════════ Audio Engine ═══════════
const audioEngine = new AudioEngine();
const beatDetector = new BeatDetector();
const visualizer = ref<WebGLFluidEngine | null>(null);

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
        } else {
            // Audio ended naturally (onended)
            isPlaying.value = false;
            latestSpectrum.value = null;
            stopTimeTracker();
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
    visualizer.value = new WebGLFluidEngine(canvas, {
        ...visualizerConfig.value,
    });
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
    latestSpectrum.value = null;
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

function resetExport() {
    exportDone.value = false;
    previewVideoUrl.value = "";
    exportVideoPath.value = "";
}

function onUpdateConfig(cfg: VisualizerConfig) {
    visualizerConfig.value = cfg;
    visualizer.value?.updateConfig(cfg);
}

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
                    工作室
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
                <span class="version">v0.3.0</span>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="main-content">
            <!-- Page: Home (Upload) -->
            <div v-if="currentPage === 'home'" class="page-center">
                <AudioLoader @file-loaded="onFileLoaded" />
                <p v-if="!hasAudio" class="hint-text">导入音频文件开始创作</p>
            </div>

            <!-- Page: Studio (Unified Preview + Export) -->
            <EffectStudio
                v-if="currentPage === 'studio'"
                :config="visualizerConfig"
                :is-playing="isPlaying"
                :current-time="currentTime"
                :duration="duration"
                :has-audio="hasAudio"
                :engine="visualizer"
                :export-settings="exportSettings"
                :is-exporting="isExporting"
                :export-progress="exportProgress"
                :export-done="exportDone"
                :export-video-path="exportVideoPath"
                :preview-video-url="previewVideoUrl"
                @update:config="onUpdateConfig"
                @update:export-settings="onUpdateExportSettings"
                @play="play"
                @pause="pause"
                @seek="seek"
                @canvas-ready="initVisualizer"
                @select-output-path="selectOutputPath"
                @start-export="startExport"
                @cancel-export="cancelExport"
                @reset-export="resetExport"
            />

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
    color: rgba(255, 255, 255, 0.8);
    font-family:
        -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none;
}

.app-shell {
    display: flex;
    width: 100%;
    height: 100%;
}

/* Sidebar */
.sidebar {
    width: 64px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: rgba(10, 10, 20, 0.95);
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    padding: 16px 0;
    z-index: 20;
}

.sidebar-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    margin-bottom: 20px;
}

.brand-icon {
    font-size: 20px;
    color: #a855f7;
}

.brand-name {
    font-size: 10px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.4);
    letter-spacing: 0.1em;
}

.sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
}

.nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 0;
    width: 56px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: rgba(255, 255, 255, 0.35);
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s;
}

.nav-item:hover:not(:disabled) {
    color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.04);
}

.nav-item.active {
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
}

.nav-item:disabled {
    opacity: 0.2;
    cursor: not-allowed;
}

.nav-separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.06);
    margin: 4px 8px;
}

.sidebar-footer {
    margin-top: auto;
}

.version {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.15);
    font-family: "SF Mono", monospace;
}

/* Main Content */
.main-content {
    flex: 1;
    min-width: 0;
    position: relative;
    overflow: hidden;
}

.page-container {
    width: 100%;
    height: 100%;
    overflow-y: auto;
}

.page-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    gap: 24px;
}

.hint-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.2);
}
</style>
