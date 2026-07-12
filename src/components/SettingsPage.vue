<script setup lang="ts">
import { ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

const appName = "Sable";
const version = "0.1.0";
const githubUrl = "https://github.com/Vincent-the-gamer/sable";

const ffmpegPath = ref(localStorage.getItem("sable_ffmpeg_path") || "");

function saveFfmpegPath() {
    localStorage.setItem("sable_ffmpeg_path", ffmpegPath.value);
}

async function browseFfmpeg() {
    const selected = await open({
        title: "选择 ffmpeg 可执行文件",
        multiple: false,
    });
    if (selected && typeof selected === "string") {
        ffmpegPath.value = selected;
        saveFfmpegPath();
    }
}

function openGithub() {
    openUrl(githubUrl);
}

// 暴露给父组件
defineExpose({ ffmpegPath });
</script>

<template>
    <div class="settings-page">
        <h2>设置</h2>

        <div class="setting-section">
            <h3>ffmpeg 路径</h3>
            <p class="desc">用于视频编码，留空则使用系统 PATH 中的 ffmpeg</p>
            <div class="ffmpeg-row">
                <input
                    v-model="ffmpegPath"
                    class="ffmpeg-input"
                    placeholder="例如 /opt/homebrew/bin/ffmpeg（留空则自动查找）"
                    @change="saveFfmpegPath"
                />
                <button class="browse-btn" @click="browseFfmpeg">浏览</button>
            </div>
            <p v-if="ffmpegPath" class="ffmpeg-hint">当前：{{ ffmpegPath }}</p>
        </div>

        <div class="setting-section">
            <h3>关于</h3>

            <div class="info-grid">
                <div class="info-row">
                    <span class="label">应用名称</span>
                    <span class="value">{{ appName }}</span>
                </div>
                <div class="info-row">
                    <span class="label">版本</span>
                    <span class="value">v{{ version }}</span>
                </div>
                <div class="info-row">
                    <span class="label">描述</span>
                    <span class="value">音频可视化特效视频生成器</span>
                </div>
            </div>
        </div>

        <div class="setting-section">
            <h3>链接</h3>
            <button class="link-btn" @click="openGithub">
                <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="currentColor"
                >
                    <path
                        d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
                    />
                </svg>
                GitHub
                <svg
                    class="external-icon"
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path d="M7 17L17 7M7 7h10v10" />
                </svg>
            </button>
        </div>
    </div>
</template>

<style scoped>
.settings-page {
    padding: 40px;
    max-width: 560px;
}

.settings-page h2 {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 32px;
    color: rgba(255, 255, 255, 0.9);
}

.setting-section {
    margin-bottom: 32px;
}

.setting-section h3 {
    font-size: 13px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.55);
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.desc {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 10px;
}

.ffmpeg-row {
    display: flex;
    gap: 8px;
}

.ffmpeg-input {
    flex: 1;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.85);
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s;
}
.ffmpeg-input:focus {
    border-color: rgba(168, 85, 247, 0.4);
}
.ffmpeg-input::placeholder {
    color: rgba(255, 255, 255, 0.2);
}

.browse-btn {
    padding: 10px 18px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
}
.browse-btn:hover {
    background: rgba(255, 255, 255, 0.08);
}

.ffmpeg-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 6px;
    font-family: monospace;
    word-break: break-all;
}

.info-grid {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.label {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.65);
}

.value {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.85);
}

.link-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.8);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
}

.link-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.25);
}

.external-icon {
    opacity: 0.4;
}
</style>
