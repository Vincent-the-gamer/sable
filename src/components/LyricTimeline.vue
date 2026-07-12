<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import type { LyricLine } from "../types";

const props = defineProps<{
    lyrics: LyricLine[];
    duration: number;
    currentTime: number;
    isPlaying: boolean;
}>();

const emit = defineEmits<{
    (e: "update:lyrics", lyrics: LyricLine[]): void;
    (e: "seek", time: number): void;
}>();

// ═══ Timeline config ═══
const trackHeight = 32;
const rulerHeight = 24;

const containerRef = ref<HTMLDivElement | null>(null);
const dragging = ref<{
    index: number;
    type: "block" | "left" | "right";
    startX: number;
    originalStart: number;
    originalEnd: number;
} | null>(null);

const totalWidth = computed(() =>
    Math.max(props.duration * pxPerSec.value + 200, 800),
);

/** 缩放范围 */
const zoomOptions = [30, 45, 60, 90, 120, 180];
const currentZoom = ref(60);

function setZoom(z: number) {
    currentZoom.value = z;
}

const pxPerSec = computed(() => currentZoom.value);

/** 时间 → X 坐标 */
function timeToX(t: number) {
    return t * pxPerSec.value;
}

/** X 坐标 → 时间 */
function xToTime(x: number) {
    return Math.max(0, x / pxPerSec.value);
}

// ═══ Ruler marks ═══
const rulerMarks = computed(() => {
    const dur = props.duration || 60;
    const step = dur <= 30 ? 1 : dur <= 120 ? 5 : dur <= 600 ? 10 : 30;
    const marks: { label: string; x: number }[] = [];
    for (let t = 0; t <= dur; t += step) {
        marks.push({ label: formatTime(t), x: timeToX(t) });
    }
    return marks;
});

function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ═══ Block style ═══
function blockStyle(lyric: LyricLine) {
    const x = timeToX(lyric.startTime);
    const w = Math.max(timeToX(lyric.endTime) - x, 20);
    return {
        left: `${x}px`,
        width: `${w}px`,
        height: `${trackHeight}px`,
    };
}

/** 当前播放位置指示线 */
const playheadX = computed(() => timeToX(props.currentTime));

/** 当前播放的歌词行 index */
const activeLyricIndex = computed(() => {
    const t = props.currentTime;
    for (let i = props.lyrics.length - 1; i >= 0; i--) {
        if (props.lyrics[i].startTime <= t && props.lyrics[i].endTime > t)
            return i;
    }
    return -1;
});

// ═══ Drag logic ═══
let trackedLyrics: LyricLine[] = [];

function onPointerDown(
    e: PointerEvent,
    index: number,
    type: "block" | "left" | "right",
) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    trackedLyrics = props.lyrics.map((l) => ({ ...l }));

    dragging.value = {
        index,
        type,
        startX: e.clientX,
        originalStart: trackedLyrics[index].startTime,
        originalEnd: trackedLyrics[index].endTime,
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
}

function onPointerMove(e: PointerEvent) {
    if (!dragging.value) return;
    const d = dragging.value;
    const dx = e.clientX - d.startX;
    const dt = xToTime(dx) - xToTime(0);
    const lyrics = trackedLyrics;
    const idx = d.index;

    if (d.type === "block") {
        // 整体移动
        const newStart = Math.max(0, d.originalStart + dt);
        const newEnd = d.originalEnd + dt;
        lyrics[idx].startTime = newStart;
        lyrics[idx].endTime = newEnd;

        // 调整前一行的 endTime
        if (idx > 0 && lyrics[idx - 1].endTime > newStart) {
            lyrics[idx - 1].endTime = newStart;
        }
        // 调整后一行的 startTime
        if (idx < lyrics.length - 1 && lyrics[idx + 1].startTime < newEnd) {
            lyrics[idx + 1].startTime = newEnd;
        }
    } else if (d.type === "left") {
        const newStart = Math.max(0, d.originalStart + dt);
        lyrics[idx].startTime = Math.min(newStart, lyrics[idx].endTime - 0.1);
        if (idx > 0) {
            lyrics[idx - 1].endTime = lyrics[idx].startTime;
        }
    } else if (d.type === "right") {
        const newEnd = d.originalEnd + dt;
        lyrics[idx].endTime = Math.max(newEnd, lyrics[idx].startTime + 0.1);
        if (idx < lyrics.length - 1) {
            lyrics[idx + 1].startTime = lyrics[idx].endTime;
        }
    }
}

function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (dragging.value) {
        emit("update:lyrics", trackedLyrics);
        dragging.value = null;
    }
}

function onTrackClick(e: MouseEvent) {
    if (dragging.value) return;
    const rect = containerRef.value?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left + (containerRef.value?.scrollLeft ?? 0);
    emit("seek", xToTime(x));
}

/** 自动滚动到播放位置 */
function scrollToPlayhead() {
    if (!containerRef.value || !props.isPlaying) return;
    const px = playheadX.value;
    const container = containerRef.value;
    const viewWidth = container.clientWidth;
    const halfView = viewWidth / 2;
    if (
        px < container.scrollLeft + halfView * 0.3 ||
        px > container.scrollLeft + halfView * 1.7
    ) {
        container.scrollTo({
            left: Math.max(0, px - halfView),
            behavior: "smooth",
        });
    }
}

let scrollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
    scrollTimer = setInterval(scrollToPlayhead, 250);
});

onUnmounted(() => {
    if (scrollTimer) clearInterval(scrollTimer);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
});
</script>

<template>
    <div class="lyric-timeline-wrapper">
        <!-- 缩放控制 -->
        <div class="timeline-toolbar">
            <span class="toolbar-label">时间轴缩放</span>
            <div class="zoom-btns">
                <button
                    v-for="z in zoomOptions"
                    :key="z"
                    class="zoom-chip"
                    :class="{ active: currentZoom === z }"
                    @click="setZoom(z)"
                >
                    {{ z }}px/s
                </button>
            </div>
        </div>

        <!-- 时间轴主体 -->
        <div ref="containerRef" class="timeline-scroll" @click="onTrackClick">
            <div class="timeline-inner" :style="{ width: totalWidth + 'px' }">
                <!-- 刻度尺 -->
                <div
                    class="timeline-ruler"
                    :style="{ height: rulerHeight + 'px' }"
                >
                    <span
                        v-for="mark in rulerMarks"
                        :key="mark.label"
                        class="ruler-mark"
                        :style="{ left: mark.x + 'px' }"
                    >
                        {{ mark.label }}
                    </span>
                </div>

                <!-- 轨道区 -->
                <div
                    class="timeline-track"
                    :style="{ height: trackHeight + 8 + 'px' }"
                >
                    <!-- 播放头 -->
                    <div
                        v-if="duration > 0"
                        class="playhead"
                        :style="{
                            left: playheadX + 'px',
                            height: trackHeight + rulerHeight + 8 + 'px',
                        }"
                    />

                    <!-- 歌词块 -->
                    <div
                        v-for="(lyric, i) in lyrics"
                        :key="i"
                        class="lyric-block"
                        :class="{
                            active: i === activeLyricIndex,
                            dragging: dragging?.index === i,
                        }"
                        :style="blockStyle(lyric)"
                        @pointerdown.prevent="() => {}"
                    >
                        <!-- 左边缘拖拽 -->
                        <div
                            class="block-handle block-handle-left"
                            @pointerdown="
                                (e: PointerEvent) => onPointerDown(e, i, 'left')
                            "
                        />
                        <!-- 主体拖拽 -->
                        <div
                            class="block-body"
                            @pointerdown="
                                (e: PointerEvent) =>
                                    onPointerDown(e, i, 'block')
                            "
                        >
                            <span class="block-text">{{ lyric.text }}</span>
                        </div>
                        <!-- 右边缘拖拽 -->
                        <div
                            class="block-handle block-handle-right"
                            @pointerdown="
                                (e: PointerEvent) =>
                                    onPointerDown(e, i, 'right')
                            "
                        />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.lyric-timeline-wrapper {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
}

.timeline-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.toolbar-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.45);
    white-space: nowrap;
}

.zoom-btns {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}

.zoom-chip {
    padding: 2px 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.5);
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s;
}

.zoom-chip:hover {
    color: rgba(255, 255, 255, 0.7);
    border-color: rgba(255, 255, 255, 0.2);
}

.zoom-chip.active {
    border-color: #a855f7;
    background: rgba(168, 85, 247, 0.12);
    color: rgba(255, 255, 255, 0.9);
}

.timeline-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    cursor: pointer;
}

.timeline-scroll::-webkit-scrollbar {
    height: 6px;
}

.timeline-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
    border-radius: 3px;
}

.timeline-inner {
    position: relative;
    min-height: 64px;
}

.timeline-ruler {
    position: relative;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    pointer-events: none;
}

.ruler-mark {
    position: absolute;
    top: 4px;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.35);
    font-family: "SF Mono", monospace;
    transform: translateX(-50%);
}

.timeline-track {
    position: relative;
}

.playhead {
    position: absolute;
    top: 0;
    width: 2px;
    background: #ef4444;
    z-index: 10;
    pointer-events: none;
    box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
}

.lyric-block {
    position: absolute;
    top: 4px;
    display: flex;
    align-items: stretch;
    border-radius: 5px;
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.25);
    overflow: hidden;
    transition:
        background 0.15s,
        border-color 0.15s,
        box-shadow 0.15s;
    user-select: none;
}

.lyric-block:hover {
    background: rgba(168, 85, 247, 0.25);
    border-color: rgba(168, 85, 247, 0.45);
}

.lyric-block.active {
    background: rgba(168, 85, 247, 0.3);
    border-color: #a855f7;
    box-shadow: 0 0 8px rgba(168, 85, 247, 0.3);
}

.lyric-block.dragging {
    background: rgba(168, 85, 247, 0.4);
    border-color: #c084fc;
    z-index: 5;
}

.block-handle {
    width: 12px;
    min-width: 12px;
    cursor: col-resize;
    background: rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    transition: background 0.15s;
    border-radius: 2px;
}

.block-handle:hover {
    background: rgba(168, 85, 247, 0.4);
}

.block-handle-left {
    border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.block-handle-right {
    border-left: 1px solid rgba(255, 255, 255, 0.06);
}

.block-body {
    flex: 1;
    display: flex;
    align-items: center;
    padding: 0 4px;
    cursor: grab;
    min-width: 0;
    overflow: hidden;
}

.block-body:active {
    cursor: grabbing;
}

.block-text {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.8);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
}
</style>
