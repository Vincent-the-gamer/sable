import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { VisualizerConfig, ExportSettings, SpectrumConfig, SubtitleConfig, LyricLine } from '../types'
import { OfflineCompositeRenderer } from './OfflineCompositeRenderer'

export interface ExportProgress {
  currentFrame: number
  totalFrames: number
  percent: number
  stage: 'decoding' | 'rendering' | 'encoding' | 'done'
}

export type ProgressCallback = (progress: ExportProgress) => void

interface ProgressPayload {
  current_frame: number
  total_frames: number
  percent: number
  stage: string
}

interface AudioDecodeResult {
  sample_rate: number
  channels: number
  total_frames: number
  duration_secs: number
  samples_base64: string
}

export interface ExportConfig {
  visualizerConfig: VisualizerConfig
  spectrumConfig: SpectrumConfig
  subtitleConfig: SubtitleConfig
  lyrics: LyricLine[]
}

/**
 * 视频导出管线：WebGL 流体 + 频谱 + 字幕 → base64 管道 → ffmpeg 直接编码
 * 无临时文件，帧数据流式送入 ffmpeg stdin
 */
export class ExportPipeline {
  static startExport(
    audioFilePath: string,
    outputPath: string,
    exportConfig: ExportConfig,
    exportSettings: ExportSettings,
    ffmpegPath: string,
    onProgress?: ProgressCallback,
  ): { cancel: () => void; done: Promise<string> } {
    let unlistenProgress: UnlistenFn | null = null
    let unlistenDone: UnlistenFn | null = null
    let unlistenError: UnlistenFn | null = null
    let cancelled = false

    const done = new Promise<string>((resolve, reject) => {
      listen<ProgressPayload>('export-progress', (event) => {
        if (cancelled) return
        const p = event.payload
        onProgress?.({
          currentFrame: p.current_frame,
          totalFrames: p.total_frames,
          percent: p.percent,
          stage: p.stage as ExportProgress['stage'],
        })
      }).then((fn) => { unlistenProgress = fn })

      listen<string>('export-done', (event) => {
        if (cancelled) return
        resolve(event.payload)
      }).then((fn) => { unlistenDone = fn })

      listen<string>('export-error', (event) => {
        if (cancelled) return
        reject(new Error(event.payload))
      }).then((fn) => { unlistenError = fn })

      startExportFlow(
        audioFilePath, outputPath, exportConfig, exportSettings,
        ffmpegPath, onProgress, () => cancelled,
      ).catch(reject)
    })

    const cancel = () => {
      cancelled = true
      invoke('cancel_video_export').catch(() => {})
      unlistenProgress?.()
      unlistenDone?.()
      unlistenError?.()
    }

    done.finally(() => {
      unlistenProgress?.()
      unlistenDone?.()
      unlistenError?.()
    })

    return { cancel, done }
  }
}

async function startExportFlow(
  audioFilePath: string,
  outputPath: string,
  exportConfig: ExportConfig,
  exportSettings: ExportSettings,
  ffmpegPath: string,
  onProgress?: ProgressCallback,
  isCancelled?: () => boolean,
): Promise<void> {
  // 对齐到偶数：NV12 格式要求宽高为偶数，否则 VideoToolbox 硬编失败
  const width = (exportSettings.width + 1) & ~1
  const height = (exportSettings.height + 1) & ~1
  const fps = exportSettings.fps
  const frameDuration = 1.0 / fps
  const frameSize = width * height * 4

  // ═══ 阶段 1: 解码 ═══
  onProgress?.({ currentFrame: 0, totalFrames: 0, percent: 0, stage: 'decoding' })

  const audioData = await invoke<AudioDecodeResult>('decode_audio_for_export', { path: audioFilePath })
  if (isCancelled?.()) return

  const pcmBytes = _b64dec(audioData.samples_base64)
  const pcmF32 = new Float32Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength))
  const totalFrames = Math.ceil(audioData.duration_secs * fps)

  console.log(`[Export] ${audioData.duration_secs.toFixed(1)}s, ${totalFrames} 帧, ${width}x${height}`)

  // ═══ 阶段 2: 启动 ffmpeg 管道 ═══
  await invoke('start_piped_export', {
    outputPath,
    audioPath: audioFilePath,
    width, height, fps,
    encoder: exportSettings.encoder,
    format: exportSettings.format,
    crf: exportSettings.crf,
    speedPreset: exportSettings.speedPreset ?? 'ultrafast',
    ffmpegPath: ffmpegPath || null,
  })
  if (isCancelled?.()) return

  // ═══ 阶段 3: 渲染 + 管道写入 ═══
  const renderer = new OfflineCompositeRenderer(
    width, height,
    exportConfig.visualizerConfig,
    exportConfig.spectrumConfig,
    exportConfig.subtitleConfig,
    exportConfig.lyrics,
  )
  renderer.setAudioData(pcmF32, audioData.sample_rate)

  // 预热：预跑 ~0.3s 的帧以积累染料，避免开头空白
  const warmupFrames = Math.min(totalFrames, Math.ceil(0.3 * fps))
  for (let i = 0; i < warmupFrames; i++) {
    if (isCancelled?.()) { renderer.destroy(); return }
    renderer.renderFrame(i * frameDuration, frameDuration)
  }
  // 重置状态，从 t=0 开始正式渲染
  renderer.reset()
  renderer.setAudioData(pcmF32, audioData.sample_rate)
  // 不再额外 primeFluid：预热阶段已积累染料，避免开头高亮突兀
  console.log(`[Export] 预热完成: ${warmupFrames} 帧`)

  // 批量发送：CHUNK 大小调整以减少 IPC 开销同时保持 UI 响应
  // 480p: ~1.2MB/frame, CHUNK=12 → ~14MB/chunk
  // 1080p: ~8MB/frame, CHUNK=4 → ~32MB/chunk
  const CHUNK = Math.max(1, Math.floor(20_000_000 / frameSize))
  const totalBufSize = CHUNK * frameSize
  let chunkBuf = new Uint8Array(totalBufSize)
  let cnt = 0
  const t0 = performance.now()

  for (let i = 0; i < totalFrames; i++) {
    if (isCancelled?.()) { renderer.destroy(); return }

    const pixels = renderer.renderFrame(i * frameDuration, frameDuration)
    chunkBuf.set(pixels, cnt * frameSize)
    cnt++

    if (cnt >= CHUNK || i === totalFrames - 1) {
      await invoke('send_piped_chunk', {
        dataBase64: _b64enc(chunkBuf.subarray(0, cnt * frameSize)),
        totalFrames,
      })
      cnt = 0

      const pct = Math.round(((i + 1) / totalFrames) * 100)
      onProgress?.({ currentFrame: i + 1, totalFrames, percent: pct, stage: 'rendering' })
    }
  }

  // 渲染完成，释放 GPU 资源
  renderer.destroy()

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
  const avgMs = totalFrames > 0 ? ((performance.now() - t0) / totalFrames).toFixed(1) : '?'
  console.log(`[Export] 渲染完成 ${elapsed}s, 平均 ${avgMs}ms/帧`)

  if (isCancelled?.()) return

  // ═══ 阶段 4: 关闭管道 ═══
  onProgress?.({ currentFrame: totalFrames, totalFrames, percent: 100, stage: 'encoding' })
  await invoke('finish_piped_export')
  console.log('[Export] 完成')
}

function _b64dec(b64: string): Uint8Array {
  const s = atob(b64)
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}

function _b64enc(bytes: Uint8Array): string {
  const K = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += K) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + K)))
  }
  return btoa(parts.join(''))
}
