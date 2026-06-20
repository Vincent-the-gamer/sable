<script setup lang="ts">
import { ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const emit = defineEmits<{
    (e: "fileLoaded", file: File, path: string): void;
}>();

const isDragging = ref(false);
const selectedFileName = ref("");
const selectedFilePath = ref("");
const isLoading = ref(false);

async function openFileDialog() {
    const path = await open({
        filters: [
            {
                name: "Audio",
                extensions: ["mp3", "wav", "flac", "ogg", "aac", "m4a", "wma"],
            },
        ],
    });
    if (path) await loadPath(path as string);
}

async function loadPath(path: string) {
    isLoading.value = true;
    try {
        const base64 = await invoke<string>("read_file_bytes", { path });
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const name = path.split("/").pop() || path.split("\\").pop() || "audio";
        const file = new File([bytes], name);
        selectedFileName.value = name;
        selectedFilePath.value = path;
        emit("fileLoaded", file, path);
    } catch (err) {
        console.error("加载音频失败:", err);
    } finally {
        isLoading.value = false;
    }
}

function onDrop(event: DragEvent) {
    event.preventDefault();
    isDragging.value = false;
    const file = event.dataTransfer?.files[0];
    if (file) {
        selectedFileName.value = file.name;
        emit("fileLoaded", file, "");
    }
}
function onDragOver(event: DragEvent) {
    event.preventDefault();
    isDragging.value = true;
}
function onDragLeave() {
    isDragging.value = false;
}
</script>

<template>
    <div
        class="audio-loader"
        :class="{ 'drag-over': isDragging, 'has-file': !!selectedFileName }"
        @click="openFileDialog"
        @drop="onDrop"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
    >
        <div v-if="!selectedFileName && !isLoading" class="loader-empty">
            <svg
                class="upload-icon"
                viewBox="0 0 24 24"
                width="48"
                height="48"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
            >
                <path d="M12 16V4m0 0L8 8m4-4l4 4" />
                <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
            <p>点击选择音频文件，或拖放到此处</p>
            <span class="hint">MP3 / WAV / FLAC / OGG 等</span>
        </div>

        <div v-if="selectedFileName && !isLoading" class="loader-selected">
            <svg
                class="music-icon"
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
            </svg>
            <span class="file-name">{{ selectedFileName }}</span>
            <span class="change-hint">点击更换</span>
        </div>

        <div v-if="isLoading" class="loader-loading">
            <span>加载中...</span>
        </div>
    </div>
</template>

<style scoped>
.audio-loader {
    width: 100%;
    max-width: 500px;
    margin: 40px auto;
    padding: 40px 24px;
    border: 2px dashed rgba(255, 255, 255, 0.18);
    border-radius: 16px;
    cursor: pointer;
    transition: all 0.3s ease;
    background: rgba(255, 255, 255, 0.03);
}
.audio-loader:hover,
.audio-loader.drag-over {
    border-color: rgba(150, 150, 255, 0.5);
    background: rgba(150, 150, 255, 0.06);
}
.audio-loader.has-file {
    border-style: solid;
    border-color: rgba(150, 150, 255, 0.25);
    padding: 20px 24px;
}
.loader-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    color: rgba(255, 255, 255, 0.5);
}
.upload-icon {
    opacity: 0.4;
    margin-bottom: 4px;
}
.loader-empty p {
    margin: 0;
    font-size: 15px;
}
.hint {
    font-size: 12px;
    opacity: 0.4;
}
.loader-selected {
    display: flex;
    align-items: center;
    gap: 12px;
}
.music-icon {
    opacity: 0.6;
    flex-shrink: 0;
}
.file-name {
    flex: 1;
    font-size: 15px;
    color: rgba(255, 255, 255, 0.85);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.change-hint {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.3);
    flex-shrink: 0;
}
.loader-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.4);
    font-size: 14px;
}
</style>
