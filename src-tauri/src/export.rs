use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::renderer::{FrameRenderer, RendererConfig};

// ══════════════════ 进度事件 ══════════════════

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgressEvent {
    pub current_frame: u32,
    pub total_frames: u32,
    pub percent: u32,
    pub stage: String,
}

// ══════════════════ 全局取消标志 ══════════════════

static CANCEL_FLAG: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn set_cancel_flag(flag: Arc<AtomicBool>) {
    *CANCEL_FLAG.lock().unwrap() = Some(flag);
}

fn clear_cancel_flag() {
    *CANCEL_FLAG.lock().unwrap() = None;
}

// ══════════════════ 导出配置 ══════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportConfig {
    pub audio_path: String,
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub particle_count: u32,
    pub glow_intensity: f32,
    pub shake_intensity: f32,
    pub hue_min: f32,
    pub hue_max: f32,
    /// 自定义 ffmpeg 路径，None 则使用 PATH 中的 "ffmpeg"
    pub ffmpeg_path: Option<String>,
    /// 输出格式: "mp4" | "webm"
    #[serde(default = "default_format")]
    pub format: String,
    /// CRF 质量 (0-51, 越小质量越高, mp4 默认 23, webm 默认 30)
    #[serde(default = "default_crf")]
    pub crf: u8,
}

fn default_format() -> String {
    "mp4".to_string()
}
fn default_crf() -> u8 {
    23
}

// ══════════════════ 入口：立即返回，后台执行 ══════════════════

pub fn start_background_export(app: AppHandle, config: ExportConfig) -> Result<(), String> {
    eprintln!("[sable:export] 启动后台导出线程");
    let cancel_flag = Arc::new(AtomicBool::new(false));
    set_cancel_flag(cancel_flag.clone());

    std::thread::spawn(move || {
        eprintln!("[sable:export] 后台线程开始执行");
        let result = run_export(&app, &config, &cancel_flag);

        match result {
            Ok(()) => {
                eprintln!("[sable:export] 导出成功，发送 export-done 事件");
                let _ = app.emit("export-done", config.output_path.clone());
            }
            Err(e) => {
                eprintln!("[sable:export] 导出失败: {e}");
                let _ = app.emit("export-error", e);
            }
        }

        clear_cancel_flag();
        eprintln!("[sable:export] 后台线程结束");
    });

    Ok(())
}

pub fn cancel_export() {
    eprintln!("[sable:export] 设置取消标志");
    if let Some(flag) = CANCEL_FLAG.lock().unwrap().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

// ══════════════════ 后台导出主逻辑 ══════════════════

fn run_export(app: &AppHandle, config: &ExportConfig, cancel: &AtomicBool) -> Result<(), String> {
    // 确定 ffmpeg 路径
    let ffmpeg_path = config.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    eprintln!("[sable:export] 使用 ffmpeg: {ffmpeg_path}");

    // ── 阶段 1: 解码音频 ──
    eprintln!("[sable:export] 阶段1: 解码音频");
    emit_progress(app, 0, 0, 0, "decoding");

    let audio_path = std::path::Path::new(&config.audio_path);
    let audio_data =
        crate::audio::decode_audio_file(audio_path).map_err(|e| format!("音频解码失败: {e}"))?;

    eprintln!(
        "[sable:export] 音频解码完成: {} 采样, {:.2}s",
        audio_data.samples.len(),
        audio_data.info.duration_secs
    );

    if cancel.load(Ordering::SeqCst) {
        eprintln!("[sable:export] 解码后被取消");
        return Ok(());
    }

    let total_frames = (audio_data.info.duration_secs * config.fps as f64).ceil() as u32;
    eprintln!(
        "[sable:export] 总帧数: {total_frames} ({}x{} @ {}fps)",
        config.width, config.height, config.fps
    );

    // ── 阶段 2: 初始化渲染器 ──
    eprintln!("[sable:export] 阶段2: 初始化渲染器");
    emit_progress(app, 0, total_frames, 0, "rendering");

    let renderer_config = RendererConfig {
        particle_count: config.particle_count,
        glow_intensity: config.glow_intensity,
        shake_intensity: config.shake_intensity,
        hue_range: (config.hue_min, config.hue_max),
    };

    let mut renderer = FrameRenderer::new(config.width, config.height, renderer_config);
    renderer.set_audio_data(&audio_data.samples, audio_data.info.sample_rate);
    renderer.reset();

    if cancel.load(Ordering::SeqCst) {
        return Ok(());
    }

    // ── 阶段 3: 启动 ffmpeg，逐帧渲染 + 编码 ──
    eprintln!(
        "[sable:export] 阶段3: 启动 ffmpeg 管道 (format={}, crf={})",
        config.format, config.crf
    );
    let mut exporter = VideoExporter::start(
        config.width,
        config.height,
        config.fps,
        &config.output_path,
        &config.audio_path,
        ffmpeg_path,
        &config.format,
        config.crf,
    )?;
    eprintln!("[sable:export] ffmpeg 已启动，开始逐帧渲染...");

    let frame_duration = 1.0 / config.fps as f64;

    for i in 0..total_frames {
        if cancel.load(Ordering::SeqCst) {
            drop(exporter);
            let _ = std::fs::remove_file(&config.output_path);
            return Ok(());
        }

        let time_seconds = i as f64 * frame_duration;
        let rgba = renderer.render_frame(time_seconds);
        exporter.send_frame(&rgba)?;

        if i % 10 == 0 || i == total_frames - 1 {
            let pct = ((i + 1) as f64 / total_frames as f64 * 100.0) as u32;
            if i % 50 == 0 || i == total_frames - 1 {
                eprintln!("[sable:export] 帧 {i}/{total_frames} ({pct}%)");
            }
            emit_progress(app, i + 1, total_frames, pct, "rendering");
        }
    }

    eprintln!("[sable:export] 所有帧渲染完成");

    // ── 阶段 4: 完成编码 ──
    eprintln!("[sable:export] 阶段4: ffmpeg 编码完成");
    emit_progress(app, total_frames, total_frames, 100, "encoding");
    exporter.finish()?;
    emit_progress(app, total_frames, total_frames, 100, "done");

    Ok(())
}

fn emit_progress(app: &AppHandle, current: u32, total: u32, percent: u32, stage: &str) {
    let _ = app.emit(
        "export-progress",
        ExportProgressEvent {
            current_frame: current,
            total_frames: total,
            percent,
            stage: stage.to_string(),
        },
    );
}

// ══════════════════ 视频导出器（ffmpeg 管道） ══════════════════

pub struct VideoExporter {
    process: Child,
    stdin: ChildStdin,
    width: u32,
    height: u32,
}

impl VideoExporter {
    pub fn start(
        width: u32,
        height: u32,
        fps: u32,
        output_path: &str,
        audio_path: &str,
        ffmpeg_path: &str,
        format: &str,
        crf: u8,
    ) -> Result<Self, String> {
        eprintln!("[sable:export] 启动 ffmpeg: {ffmpeg_path}");
        let mut cmd = Command::new(ffmpeg_path);

        // 公共参数：原始视频输入管道
        cmd.args([
            "-y",
            "-f",
            "rawvideo",
            "-vcodec",
            "rawvideo",
            "-s",
            &format!("{width}x{height}"),
            "-pix_fmt",
            "rgba",
            "-r",
            &fps.to_string(),
            "-i",
            "pipe:0",
            "-i",
            audio_path,
        ]);

        // 根据格式选择不同的编码器参数
        match format {
            "webm" => {
                cmd.args([
                    "-c:v",
                    "libvpx-vp9",
                    "-crf",
                    &crf.to_string(),
                    "-b:v",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "libopus",
                    "-b:a",
                    "128k",
                    "-shortest",
                ]);
            }
            _ => {
                // 默认 mp4 (H.264)
                cmd.args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    &crf.to_string(),
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-shortest",
                    "-movflags",
                    "+faststart",
                ]);
            }
        }

        cmd.arg(output_path);

        cmd.stdin(Stdio::piped());
        cmd.stderr(Stdio::null());
        cmd.stdout(Stdio::null());

        let mut process = cmd.spawn().map_err(|e| {
            eprintln!("[sable:export] ffmpeg 启动失败 (路径: {ffmpeg_path}): {e}");
            format!("启动 ffmpeg 失败 (路径: {ffmpeg_path}): {e}")
        })?;
        eprintln!("[sable:export] ffmpeg 进程已启动, pid={}", process.id());
        let stdin = process.stdin.take().ok_or("无法获取 ffmpeg 标准输入")?;

        Ok(Self {
            process,
            stdin,
            width,
            height,
        })
    }

    pub fn send_frame(&mut self, rgba_bytes: &[u8]) -> Result<(), String> {
        let expected_len = (self.width * self.height * 4) as usize;
        if rgba_bytes.len() != expected_len {
            return Err(format!(
                "帧数据大小不匹配: 期望 {expected_len} 字节, 实际 {} 字节",
                rgba_bytes.len()
            ));
        }

        self.stdin
            .write_all(rgba_bytes)
            .map_err(|e| format!("写入帧数据失败: {e}"))?;

        Ok(())
    }

    pub fn finish(mut self) -> Result<(), String> {
        drop(self.stdin);

        let output = self
            .process
            .wait()
            .map_err(|e| format!("等待 ffmpeg 完成失败: {e}"))?;

        if output.success() {
            Ok(())
        } else {
            Err(format!("ffmpeg 退出码: {}", output.code().unwrap_or(-1)))
        }
    }
}
