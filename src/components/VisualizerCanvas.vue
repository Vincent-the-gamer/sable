<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import type { VisualizerConfig } from "../types";

interface VisualizerEngineLike {
    config: VisualizerConfig;
    resize(): void;
    start(getSpectrum: () => unknown, getBeat: () => unknown): void;
    stop(): void;
}

const props = defineProps<{
    engine: VisualizerEngineLike | null;
    config: VisualizerConfig;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
    if (canvasRef.value) {
        resizeObserver = new ResizeObserver(() => {
            props.engine?.resize();
        });
        resizeObserver.observe(canvasRef.value);
    }
});

onUnmounted(() => {
    resizeObserver?.disconnect();
});

watch(
    () => props.config,
    (cfg) => {
        if (props.engine) {
            props.engine.config = cfg;
        }
    },
    { deep: true },
);

// Expose canvas so parent can directly initialize visualizer
defineExpose({ canvas: canvasRef });
</script>

<template>
    <div class="visualizer-container">
        <canvas ref="canvasRef" class="visualizer-canvas" />
    </div>
</template>

<style scoped>
.visualizer-container {
    position: absolute;
    inset: 0;
    overflow: hidden;
}

.visualizer-canvas {
    display: block;
    width: 100%;
    height: 100%;
}
</style>
