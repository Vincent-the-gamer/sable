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
 * Video export pipeline: WebGL fluid + spectrum + subtitles → ffmpeg pipe
 */
export class ExportPipeline {
  static startExport(
    audioFilePath: string,
    outputPath: string,
    exportConfig: ExportConfig,
    exportSettings: ExportSettings,
    ffmpegPath: string,
    onProgress?: ProgressCallback,
    drumStem?: { samples: Float32Array; sampleRate: number },
  ): { cancel: () => void; done: Promise<string> } {
    let unlistenProgress: UnlistenFn | null = null
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

      listen<string>('export-error', (event) => {
        if (cancelled) return
        reject(new Error(event.payload))
      }).then((fn) => { unlistenError = fn })

      startExportFlow(
        audioFilePath, outputPath, exportConfig, exportSettings,
        ffmpegPath, onProgress, () => cancelled, drumStem,
      ).then(resolve).catch(reject)
    })

    const cancel = () => {
      cancelled = true
      invoke('cancel_video_export').catch(() => {})
      unlistenProgress?.()
      unlistenError?.()
    }

    done.finally(() => {
      unlistenProgress?.()
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
  drumStem?: { samples: Float32Array; sampleRate: number },
): Promise<string> {
  const width = (exportSettings.width + 1) & ~1
  const height = (exportSettings.height + 1) & ~1
  const fps = exportSettings.fps
  const frameDuration = 1.0 / fps
  const frameSize = width * height * 4

  onProgress?.({ currentFrame: 0, totalFrames: 0, percent: 0, stage: 'decoding' })

  console.log('[Export] Decoding audio...')
  const audioData = await invoke<AudioDecodeResult>('decode_audio_for_export', { path: audioFilePath })
  if (isCancelled?.()) throw new Error('Cancelled')

  const pcmBytes = _b64dec(audioData.samples_base64)
  const pcmF32 = new Float32Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength))
  const totalFrames = Math.ceil(audioData.duration_secs * fps)

  console.log(`[Export] ${audioData.duration_secs.toFixed(1)}s, ${totalFrames} frames, ${width}x${height}`)

  // Create renderer and warm up BEFORE starting ffmpeg.
  // This prevents ffmpeg -shortest from terminating early (before any video frames arrive)
  // while the audio input has already been fully read.
  console.log('[Export] Creating renderer...')
  const renderer = new OfflineCompositeRenderer(
    width, height,
    exportConfig.visualizerConfig,
    exportConfig.spectrumConfig,
    exportConfig.subtitleConfig,
    exportConfig.lyrics,
  )
  renderer.setAudioData(pcmF32, audioData.sample_rate)

  if (drumStem) {
    renderer.setDrumStem(drumStem.samples, drumStem.sampleRate)
    console.log('[Export] Drum stem enabled')
  }

  const warmupFrames = Math.min(totalFrames, Math.ceil(0.3 * fps))
  console.log(`[Export] Warming up ${warmupFrames} frames...`)
  const warmupT0 = performance.now()
  for (let i = 0; i < warmupFrames; i++) {
    if (isCancelled?.()) { renderer.destroy(); throw new Error('Cancelled') }
    renderer.renderFrame(i * frameDuration, frameDuration)
  }
  const warmupMs = (performance.now() - warmupT0).toFixed(1)
  renderer.reset()
  renderer.setAudioData(pcmF32, audioData.sample_rate)
  if (drumStem) renderer.setDrumStem(drumStem.samples, drumStem.sampleRate)
  console.log(`[Export] Warmup done: ${warmupFrames} frames in ${warmupMs}ms`)

  // Start ffmpeg AFTER warmup so both audio+video inputs begin simultaneously
  console.log('[Export] Starting ffmpeg pipe...')
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
  if (isCancelled?.()) { renderer.destroy(); throw new Error('Cancelled') }
  console.log('[Export] ffmpeg pipe started, rendering frames...')

  // Batch-render frames and push them into the shared Rust buffer.
  // Batch size = 2 to keep IPC payload small (~16MB at 1080p) while still
  // amortizing the round-trip overhead.
  const BATCH = 2
  const t0 = performance.now()
  let totalBytesSent = 0
  let lastYield = t0

  for (let i = 0; i < totalFrames; i += BATCH) {
    if (isCancelled?.()) { renderer.destroy(); throw new Error('Cancelled') }

    const batchT0 = performance.now()

    // Render a batch of frames
    const batchCount = Math.min(BATCH, totalFrames - i)
    const batch = new Uint8Array(batchCount * frameSize)
    for (let j = 0; j < batchCount; j++) {
      const renderT0 = performance.now()
      const pixels = renderer.renderFrame((i + j) * frameDuration, frameDuration)
      const renderMs = performance.now() - renderT0
      batch.set(pixels, j * frameSize)
      totalBytesSent += pixels.byteLength
      if (j === 0) console.log(`[Export:js] render frame ${i + j} ${renderMs.toFixed(1)}ms`)
    }

    const ipcT0 = performance.now()
    await invoke('push_frames', {
      data: batch.buffer.slice(batch.byteOffset, batch.byteOffset + batch.byteLength),
      frameCount: batchCount,
      totalFrames,
    })
    const ipcMs = performance.now() - ipcT0
    const batchMs = performance.now() - batchT0
    console.log(`[Export:js] batch ${i}+${batchCount} render ${batchMs.toFixed(1)}ms ipc ${ipcMs.toFixed(1)}ms`)

    const pct = Math.round(((i + batchCount) / totalFrames) * 100)
    onProgress?.({ currentFrame: i + batchCount, totalFrames, percent: pct, stage: 'rendering' })

    // Yield every 50ms to keep UI responsive
    const now = performance.now()
    if (now - lastYield > 50) {
      await new Promise((r) => setTimeout(r, 0))
      lastYield = now
    }
  }

  renderer.destroy()

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
  const avgMs = totalFrames > 0 ? ((performance.now() - t0) / totalFrames).toFixed(1) : '?'
  const mbSent = (totalBytesSent / 1024 / 1024).toFixed(1)
  console.log(`[Export] Render done ${elapsed}s, avg ${avgMs}ms/frame, ${mbSent}MB sent`)

  if (isCancelled?.()) throw new Error('Cancelled')

  onProgress?.({ currentFrame: totalFrames, totalFrames, percent: 100, stage: 'encoding' })
  console.log('[Export] Finishing ffmpeg encode...')
  await invoke('finish_piped_export')
  console.log('[Export] Done')

  return outputPath
}

function _b64dec(b64: string): Uint8Array {
  const s = atob(b64)
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}
