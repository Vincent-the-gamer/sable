<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    hasAudio: boolean;
}>();

const emit = defineEmits<{
    (e: "play"): void;
    (e: "pause"): void;
    (e: "seek", time: number): void;
}>();

const progress = computed(() => {
    if (props.duration === 0) return 0;
    return (props.currentTime / props.duration) * 100;
});

const currentTimeStr = computed(() => formatTime(props.currentTime));
const durationStr = computed(() => formatTime(props.duration));

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function onProgressClick(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    emit("seek", ratio * props.duration);
}

function togglePlay() {
    if (props.isPlaying) {
        emit("pause");
    } else {
        emit("play");
    }
}
</script>

<template>
    <div class="audio-controls" :class="{ visible: hasAudio }">
        <button class="play-btn" @click="togglePlay">
            <svg
                v-if="!isPlaying"
                viewBox="0 0 24 24"
                width="28"
                height="28"
                fill="currentColor"
            >
                <path d="M8 5v14l11-7z" />
            </svg>
            <svg
                v-else
                viewBox="0 0 24 24"
                width="28"
                height="28"
                fill="currentColor"
            >
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
        </button>

        <span class="time">{{ currentTimeStr }}</span>

        <div class="progress-bar" @click="onProgressClick">
            <div class="progress-track">
                <div class="progress-fill" :style="{ width: progress + '%' }" />
            </div>
        </div>

        <span class="time">{{ durationStr }}</span>
    </div>
</template>

<style scoped>
.audio-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 500px;
    margin: 16px auto 0;
    padding: 12px 16px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.05);
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s ease;
    pointer-events: none;
}

.audio-controls.visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}

.play-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: rgba(150, 150, 255, 0.2);
    color: rgba(255, 255, 255, 0.9);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.2s;
}

.play-btn:hover {
    background: rgba(150, 150, 255, 0.4);
}

.time {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    font-variant-numeric: tabular-nums;
    min-width: 32px;
}

.progress-bar {
    flex: 1;
    height: 24px;
    display: flex;
    align-items: center;
    cursor: pointer;
}

.progress-track {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    border-radius: 2px;
    background: linear-gradient(
        90deg,
        rgba(150, 150, 255, 0.7),
        rgba(200, 150, 255, 0.7)
    );
    transition: width 0.1s linear;
}
</style>
