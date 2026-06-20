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

onMounted(() => {
    if (canvasRef.value && props.engine) {
        props.engine.resize();
    }
});

onUnmounted(() => {
    props.engine?.stop();
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

// Expose canvas element directly (not the Ref)
defineExpose({
    get canvas() {
        return canvasRef.value;
    },
});
</script>

<template>
    <canvas ref="canvasRef" class="visualizer-canvas" />
</template>

<style scoped>
.visualizer-canvas {
    display: block;
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
}
</style>
