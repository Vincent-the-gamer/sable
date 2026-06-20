import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { VisualizerConfig, ExportSettings } from '../types'

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

/**
 * 视频导出管线：调用 Rust 后台线程完成全部渲染+编码。
 *
 * Rust 后台线程负责：音频解码 → 逐帧渲染 → ffmpeg 编码
 * 通过 Tauri 事件汇报进度，主线程完全不阻塞
 * 支持取消
 */
export class ExportPipeline {
  /**
   * 启动视频导出（非阻塞，通过事件回调汇报进度）
   */
  static startExport(
    audioFilePath: string,
    outputPath: string,
    effectConfig: VisualizerConfig,
    exportSettings: ExportSettings,
    ffmpegPath: string,
    onProgress?: ProgressCallback,
  ): { cancel: () => void; done: Promise<string> } {
    let unlistenProgress: UnlistenFn | null = null
    let unlistenDone: UnlistenFn | null = null
    let unlistenError: UnlistenFn | null = null
    let cancelled = false

    const done = new Promise<string>((resolve, reject) => {
      console.log('[Export] 注册事件监听...')

      // 监听进度
      listen<ProgressPayload>('export-progress', (event) => {
        if (cancelled) return
        const p = event.payload
        onProgress?.({
          currentFrame: p.current_frame,
          totalFrames: p.total_frames,
          percent: p.percent,
          stage: p.stage as ExportProgress['stage'],
        })
      }).then((fn) => {
        unlistenProgress = fn
        console.log('[Export] progress 监听已注册')
      })

      // 监听完成
      listen<string>('export-done', (event) => {
        if (cancelled) return
        console.log('[Export] 收到 export-done:', event.payload)
        resolve(event.payload)
      }).then((fn) => {
        unlistenDone = fn
        console.log('[Export] done 监听已注册')
      })

      // 监听错误
      listen<string>('export-error', (event) => {
        if (cancelled) return
        console.error('[Export] 收到 export-error:', event.payload)
        reject(new Error(event.payload))
      }).then((fn) => {
        unlistenError = fn
        console.log('[Export] error 监听已注册')
      })

      // 调用 Rust 后端
      console.log('[Export] 调用 invoke start_video_export_v2...')
      invoke('start_video_export_v2', {
        config: {
          audio_path: audioFilePath,
          output_path: outputPath,
          width: exportSettings.width,
          height: exportSettings.height,
          fps: exportSettings.fps,
          particle_count: effectConfig.particleCount,
          glow_intensity: effectConfig.glowIntensity,
          shake_intensity: effectConfig.shakeIntensity,
          hue_min: effectConfig.hueRange[0],
          hue_max: effectConfig.hueRange[1],
          ffmpeg_path: ffmpegPath || null,
          format: exportSettings.format,
          crf: exportSettings.crf,
        },
      }).then(() => {
        console.log('[Export] invoke 返回成功，等待后台线程完成...')
      }).catch((err) => {
        console.error('[Export] invoke 失败:', err)
        reject(err)
      })
    })

    const cancel = () => {
      console.log('[Export] 取消导出')
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
