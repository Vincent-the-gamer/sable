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

  const CHUNK = Math.max(1, Math.floor(40_000_000 / frameSize))
  const totalBufSize = CHUNK * frameSize
  let chunkBuf = new Uint8Array(totalBufSize)
  let cnt = 0
  const t0 = performance.now()
  let totalBytesSent = 0
  let lastYield = t0

  for (let i = 0; i < totalFrames; i++) {
    if (isCancelled?.()) { renderer.destroy(); throw new Error('Cancelled') }

    const pixels = renderer.renderFrame(i * frameDuration, frameDuration)
    chunkBuf.set(pixels, cnt * frameSize)
    cnt++

    if (cnt >= CHUNK || i === totalFrames - 1) {
      const chunkBytes = chunkBuf.subarray(0, cnt * frameSize)

      // 批量 RGBA → BGRA：在 contiguous buffer 上一次完成
      // VideoToolbox 原生支持 BGRA，消除软件色彩空间转换
      for (let p = 0; p < chunkBytes.length; p += 4) {
        const r = chunkBytes[p]
        chunkBytes[p] = chunkBytes[p + 2]
        chunkBytes[p + 2] = r
      }

      totalBytesSent += chunkBytes.byteLength

      // 使用 raw IPC 直接传输原始字节，完全绕过 base64 编码
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (invoke as any)('send_raw_chunk',
        chunkBytes.buffer.slice(
          chunkBytes.byteOffset,
          chunkBytes.byteOffset + chunkBytes.byteLength,
        ),
        {
          headers: {
            'X-Total-Frames': String(totalFrames),
          },
        },
      )
      cnt = 0

      const pct = Math.round(((i + 1) / totalFrames) * 100)
      onProgress?.({ currentFrame: i + 1, totalFrames, percent: pct, stage: 'rendering' })

      // 按时间 yield（每 80ms），减少 event loop 让出开销
      const now = performance.now()
      if (now - lastYield > 80) {
        await new Promise((r) => setTimeout(r, 0))
        lastYield = now
      }
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
