<script setup lang="ts">
/**
 * 调试面板：捕获所有 console 日志 + 显示应用运行状态
 */

import { ref, onMounted, onUnmounted, computed } from 'vue'
import type { SpectrumData, BeatResult } from '../types'

// ── 日志系统 ──

interface LogEntry {
  id: number
  type: 'log' | 'warn' | 'error' | 'debug'
  message: string
  timestamp: number
}

const logs = ref<LogEntry[]>([])
const maxLogs = 500
let nextId = 0

function addLog(type: LogEntry['type'], message: string) {
  logs.value.push({ id: nextId++, type, message, timestamp: Date.now() })
  if (logs.value.length > maxLogs) {
    logs.value.splice(0, logs.value.length - maxLogs)
  }
}

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a, null, 2)
        } catch {
          return String(a)
        }
      }
      return String(a)
    })
    .join(' ')
}

function installConsoleHook() {
  console.log = (...args: unknown[]) => {
    addLog('log', formatArgs(args))
    originalConsole.log(...args)
  }
  console.warn = (...args: unknown[]) => {
    addLog('warn', formatArgs(args))
    originalConsole.warn(...args)
  }
  console.error = (...args: unknown[]) => {
    addLog('error', formatArgs(args))
    originalConsole.error(...args)
  }
  console.debug = (...args: unknown[]) => {
    addLog('debug', formatArgs(args))
    originalConsole.debug(...args)
  }
}

function uninstallConsoleHook() {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.debug = originalConsole.debug
}

// ── 运行状态 ──

const props = defineProps<{
  isPlaying?: boolean
  hasAudio?: boolean
  currentTime?: number
  duration?: number
  loadedFilePath?: string
  isExporting?: boolean
  exportProgress?: {
    currentFrame: number
    totalFrames: number
    percent: number
    stage: string
  } | null
  latestSpectrum?: SpectrumData | null
  latestBeat?: BeatResult
  visualizerConfig?: {
    particleCount: number
    glowIntensity: number
    shakeIntensity: number
    hueRange: [number, number]
  }
  ffmpegPath?: string
}>()

const expandedLogs = ref<Set<number>>(new Set())

function toggleLogExpand(id: number) {
  if (expandedLogs.value.has(id)) {
    expandedLogs.value.delete(id)
  } else {
    expandedLogs.value.add(id)
  }
}

function clearLogs() {
  logs.value = []
}

function formatTime(ts: number) {
  const d = new Date(ts)
  return (
    d.getHours().toString().padStart(2, '0') +
    ':' +
    d.getMinutes().toString().padStart(2, '0') +
    ':' +
    d.getSeconds().toString().padStart(2, '0') +
    '.' +
    d.getMilliseconds().toString().padStart(3, '0')
  )
}

function typeClass(type: LogEntry['type']): string {
  return 'log-' + type
}

const logCounts = computed(() => {
  const c = { log: 0, warn: 0, error: 0, debug: 0 }
  for (const l of logs.value) c[l.type]++
  return c
})

// ── 生命周期 ──

onMounted(() => {
  installConsoleHook()
  addLog('debug', '🔧 调试面板已启动，开始捕获日志')
})

onUnmounted(() => {
  uninstallConsoleHook()
})
</script>

<template>
  <div class="debug-page">
    <!-- 状态面板 -->
    <section class="debug-section">
      <h3>📊 运行状态</h3>
      <div class="state-grid">
        <div class="state-row">
          <span class="key">播放状态</span>
          <span class="value" :class="{ active: props.isPlaying, inactive: !props.isPlaying }">
            {{ props.isPlaying ? '▶ 播放中' : '⏸ 已暂停' }}
          </span>
        </div>
        <div class="state-row">
          <span class="key">音频加载</span>
          <span class="value" :class="{ active: props.hasAudio, inactive: !props.hasAudio }">
            {{ props.hasAudio ? '✓ 已加载' : '✗ 未加载' }}
          </span>
        </div>
        <div class="state-row" v-if="props.hasAudio">
          <span class="key">当前时间</span>
          <span class="value">{{ (props.currentTime ?? 0).toFixed(2) }}s / {{ (props.duration ?? 0).toFixed(2) }}s</span>
        </div>
        <div class="state-row" v-if="props.loadedFilePath">
          <span class="key">文件路径</span>
          <span class="value mono">{{ props.loadedFilePath }}</span>
        </div>
        <div class="state-row">
          <span class="key">ffmpeg</span>
          <span class="value mono">{{ props.ffmpegPath || '(系统 PATH)' }}</span>
        </div>
        <div class="state-row">
          <span class="key">导出状态</span>
          <span class="value" :class="{ active: props.isExporting }">
            {{ props.isExporting ? '🔄 ' + (props.exportProgress?.stage ?? '...') : '—' }}
          </span>
        </div>
        <div class="state-row" v-if="props.isExporting && props.exportProgress">
          <span class="key">导出进度</span>
          <span class="value">
            {{ props.exportProgress.currentFrame }}/{{ props.exportProgress.totalFrames }}
            ({{ props.exportProgress.percent }}%)
          </span>
        </div>
        <div class="state-row" v-if="props.visualizerConfig">
          <span class="key">粒子数</span>
          <span class="value">{{ props.visualizerConfig.particleCount }}</span>
        </div>
        <div class="state-row" v-if="props.visualizerConfig">
          <span class="key">辉光/抖动</span>
          <span class="value">{{ props.visualizerConfig.glowIntensity }} / {{ props.visualizerConfig.shakeIntensity }}</span>
        </div>
        <div class="state-row" v-if="props.latestSpectrum">
          <span class="key">音频能量</span>
          <span class="value">
            avg={{ (props.latestSpectrum.averageEnergy * 100).toFixed(1) }}%,
            bass={{ (props.latestSpectrum.bassEnergy * 100).toFixed(1) }}%
          </span>
        </div>
        <div class="state-row" v-if="props.latestBeat">
          <span class="key">节拍</span>
          <span class="value" :class="{ active: props.latestBeat.isBeat }">
            {{ props.latestBeat.isBeat ? '💥 节拍! intensity=' + props.latestBeat.intensity.toFixed(2) : '—' }}
          </span>
        </div>
      </div>
    </section>

    <!-- 日志面板 -->
    <section class="debug-section debug-console">
      <div class="console-header">
        <h3>📋 Console 日志</h3>
        <div class="console-actions">
          <span class="log-stats">
            <span class="stat-log">{{ logCounts.log }}</span>
            <span class="stat-warn">{{ logCounts.warn }}</span>
            <span class="stat-error">{{ logCounts.error }}</span>
            <span class="stat-debug">{{ logCounts.debug }}</span>
          </span>
          <button class="btn-clear" @click="clearLogs">清空</button>
        </div>
      </div>
      <div class="console-log-list" ref="listRef">
        <div v-if="logs.length === 0" class="console-empty">暂无日志</div>
        <div
          v-for="entry in logs"
          :key="entry.id"
          class="console-entry"
          :class="typeClass(entry.type)"
          @click="toggleLogExpand(entry.id)"
        >
          <span class="entry-time">{{ formatTime(entry.timestamp) }}</span>
          <span class="entry-type">{{ entry.type.toUpperCase() }}</span>
          <span class="entry-msg" :class="{ expanded: expandedLogs.has(entry.id) }">{{ entry.message }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.debug-page {
  padding: 24px 32px;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.debug-section h3 {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ── 状态网格 ── */

.state-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 12px 16px;
}

.state-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 2px 0;
}

.key {
  color: rgba(255, 255, 255, 0.35);
}

.value {
  color: rgba(255, 255, 255, 0.75);
}

.value.active {
  color: rgba(150, 255, 150, 0.85);
}

.value.inactive {
  color: rgba(255, 150, 150, 0.5);
}

.mono {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12px;
  max-width: 320px;
  word-break: break-all;
  text-align: right;
}

/* ── Console ── */

.debug-console {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.console-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.console-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.log-stats {
  display: flex;
  gap: 8px;
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.stat-log {
  color: rgba(200, 200, 200, 0.6);
}
.stat-warn {
  color: rgba(255, 200, 100, 0.7);
}
.stat-error {
  color: rgba(255, 100, 100, 0.7);
}
.stat-debug {
  color: rgba(100, 150, 255, 0.6);
}

.btn-clear {
  padding: 4px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-clear:hover {
  background: rgba(255, 50, 50, 0.1);
  border-color: rgba(255, 50, 50, 0.3);
  color: rgba(255, 100, 100, 0.8);
}

.console-log-list {
  flex: 1;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px 0;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.5;
}

.console-empty {
  padding: 32px;
  text-align: center;
  color: rgba(255, 255, 255, 0.15);
}

.console-entry {
  display: flex;
  gap: 8px;
  padding: 3px 12px;
  cursor: pointer;
  transition: background 0.15s;
  border-left: 3px solid transparent;
}

.console-entry:hover {
  background: rgba(255, 255, 255, 0.03);
}

.console-entry.log-error {
  border-left-color: rgba(255, 70, 70, 0.5);
  background: rgba(255, 0, 0, 0.04);
}
.console-entry.log-warn {
  border-left-color: rgba(255, 180, 60, 0.5);
  background: rgba(255, 180, 0, 0.03);
}

.entry-time {
  color: rgba(255, 255, 255, 0.2);
  flex-shrink: 0;
  user-select: none;
}

.entry-type {
  flex-shrink: 0;
  width: 36px;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.8;
  user-select: none;
}

.log-log .entry-type {
  color: rgba(180, 180, 180, 0.7);
}
.log-warn .entry-type {
  color: rgba(255, 180, 60, 0.9);
}
.log-error .entry-type {
  color: rgba(255, 70, 70, 0.9);
}
.log-debug .entry-type {
  color: rgba(100, 150, 255, 0.8);
}

.entry-msg {
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.entry-msg.expanded {
  white-space: pre-wrap;
  word-break: break-all;
}

.log-error .entry-msg {
  color: rgba(255, 130, 130, 0.8);
}
.log-warn .entry-msg {
  color: rgba(255, 200, 100, 0.8);
}
.log-debug .entry-msg {
  color: rgba(130, 160, 255, 0.7);
}
</style>
