use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::frame_buffer::{drain_to_ffmpeg, SharedFrameBuffer};

// ═══════════ Cancel ═══════════

static CANCEL_FLAG: Mutex<bool> = Mutex::new(false);

pub fn cancel_export() {
    if let Ok(mut flag) = CANCEL_FLAG.lock() {
        *flag = true;
    }
}

fn is_cancelled() -> bool {
    CANCEL_FLAG.lock().map(|f| *f).unwrap_or(false)
}

// ═══════════ Shared Frame Buffer Export State ═══════════

struct SharedExport {
    frame_buffer: SharedFrameBuffer,
    child: Child,
    output_path: String,
    drain_handle: Option<std::thread::JoinHandle<()>>,
}

static SHARED_EXPORT: Mutex<Option<SharedExport>> = Mutex::new(None);

// ═══════════ FFmpeg Command Builder ═══════════

fn build_ffmpeg_command(
    ffmpeg: &str,
    output_path: &str,
    audio_path: &str,
    width: u32,
    height: u32,
    fps: u32,
    encoder: &str,
    crf: u8,
    speed_preset: &str,
) -> Command {
    // NV12 要求宽高均为偶数
    let width = ((width + 1) >> 1) << 1;
    let height = ((height + 1) >> 1) << 1;

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-fflags",
        "+genpts",
        "-threads",
        "0",
        "-f",
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

    // 色度缩放：fast_bilinear 比 lanczos 快 20x
    cmd.args(["-sws_flags", "fast_bilinear"]);

    // ═══ Encoder-specific arguments ═══
    let bpp_quality = 0.45;
    let bpp_balanced = 0.30;
    let bpp_fast = 0.18;
    let bpp_superfast = 0.12;
    let bpp_ultrafast = 0.08;

    match encoder {
        // ─── macOS: VideoToolbox ───
        "videotoolbox_h264" => {
            let bpp = match speed_preset {
                "quality" => bpp_quality,
                "balanced" => bpp_balanced,
                "fast" => bpp_fast,
                "superfast" => bpp_superfast,
                _ => bpp_ultrafast,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(500_000);
            let bitrate_str = bitrate.to_string();
            let mut args = vec![
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                &bitrate_str,
                "-allow_sw",
                "1",
            ];
            if speed_preset == "superfast" || speed_preset == "ultrafast" {
                args.extend_from_slice(&["-realtime", "1"]);
            }
            args.extend_from_slice(&["-c:a", "aac", "-b:a", "192k", "-shortest"]);
            cmd.args(&args);
        }
        "videotoolbox_hevc" => {
            let bpp = match speed_preset {
                "quality" => 0.31,
                "balanced" => 0.21,
                "fast" => 0.13,
                "superfast" => 0.08,
                _ => 0.055,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(300_000);
            let bitrate_str = bitrate.to_string();
            let mut args = vec![
                "-c:v",
                "hevc_videotoolbox",
                "-b:v",
                &bitrate_str,
                "-allow_sw",
                "1",
                "-tag:v",
                "hvc1",
            ];
            if speed_preset == "superfast" || speed_preset == "ultrafast" {
                args.extend_from_slice(&["-realtime", "1"]);
            }
            args.extend_from_slice(&["-c:a", "aac", "-b:a", "192k", "-shortest"]);
            cmd.args(&args);
        }

        // ─── NVIDIA: NVENC ───
        // Direct system memory input — no hwupload_cuda filter needed.
        // NVENC handles GPU upload internally, which is faster than a separate filter.
        "nvenc_h264" => {
            let bpp = match speed_preset {
                "quality" => bpp_quality,
                "balanced" => bpp_balanced,
                "fast" => bpp_fast,
                "superfast" => bpp_superfast,
                _ => bpp_ultrafast,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(500_000);
            let preset = match speed_preset {
                "quality" => "slow",
                "balanced" => "medium",
                "fast" => "fast",
                "superfast" => "faster",
                _ => "max",
            };
            cmd.args([
                "-c:v",
                "h264_nvenc",
                "-preset",
                preset,
                "-b:v",
                &bitrate.to_string(),
                "-tune",
                "ll",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }
        "nvenc_hevc" => {
            let bpp = match speed_preset {
                "quality" => 0.31,
                "balanced" => 0.21,
                "fast" => 0.13,
                "superfast" => 0.08,
                _ => 0.055,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(300_000);
            let preset = match speed_preset {
                "quality" => "slow",
                "balanced" => "medium",
                "fast" => "fast",
                "superfast" => "faster",
                _ => "max",
            };
            cmd.args([
                "-c:v",
                "hevc_nvenc",
                "-preset",
                preset,
                "-b:v",
                &bitrate.to_string(),
                "-tune",
                "ll",
                "-tag:v",
                "hvc1",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }

        // ─── AMD: AMF ───
        "amf_h264" => {
            let bpp = match speed_preset {
                "quality" => bpp_quality,
                "balanced" => bpp_balanced,
                "fast" => bpp_fast,
                "superfast" => bpp_superfast,
                _ => bpp_ultrafast,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(500_000);
            let quality = match speed_preset {
                "quality" => "quality",
                "balanced" => "balanced",
                _ => "speed",
            };
            cmd.args([
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                "h264_amf",
                "-quality",
                quality,
                "-b:v",
                &bitrate.to_string(),
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }
        "amf_hevc" => {
            let bpp = match speed_preset {
                "quality" => 0.31,
                "balanced" => 0.21,
                "fast" => 0.13,
                "superfast" => 0.08,
                _ => 0.055,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(300_000);
            let quality = match speed_preset {
                "quality" => "quality",
                "balanced" => "balanced",
                _ => "speed",
            };
            cmd.args([
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                "hevc_amf",
                "-quality",
                quality,
                "-b:v",
                &bitrate.to_string(),
                "-tag:v",
                "hvc1",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }

        // ─── Intel: QuickSync ───
        "qsv_h264" => {
            let bpp = match speed_preset {
                "quality" => bpp_quality,
                "balanced" => bpp_balanced,
                "fast" => bpp_fast,
                "superfast" => bpp_superfast,
                _ => bpp_ultrafast,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(500_000);
            cmd.args([
                "-vf",
                "format=nv12,hwupload=extra_hw_frames=64",
                "-c:v",
                "h264_qsv",
                "-b:v",
                &bitrate.to_string(),
                "-pix_fmt:v",
                "nv12",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }
        "qsv_hevc" => {
            let bpp = match speed_preset {
                "quality" => 0.31,
                "balanced" => 0.21,
                "fast" => 0.13,
                "superfast" => 0.08,
                _ => 0.055,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(300_000);
            cmd.args([
                "-vf",
                "format=nv12,hwupload=extra_hw_frames=64",
                "-c:v",
                "hevc_qsv",
                "-b:v",
                &bitrate.to_string(),
                "-tag:v",
                "hvc1",
                "-pix_fmt:v",
                "nv12",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }

        // ─── Linux: VAAPI ───
        "vaapi_h264" => {
            let bpp = match speed_preset {
                "quality" => bpp_quality,
                "balanced" => bpp_balanced,
                "fast" => bpp_fast,
                "superfast" => bpp_superfast,
                _ => bpp_ultrafast,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(500_000);
            cmd.args([
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                "h264_vaapi",
                "-b:v",
                &bitrate.to_string(),
                "-pix_fmt:v",
                "vaapi",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }
        "vaapi_hevc" => {
            let bpp = match speed_preset {
                "quality" => 0.31,
                "balanced" => 0.21,
                "fast" => 0.13,
                "superfast" => 0.08,
                _ => 0.055,
            };
            let bitrate = ((width as f64 * height as f64 * fps as f64 * bpp) as u64).max(300_000);
            cmd.args([
                "-vf",
                "format=nv12,hwupload",
                "-c:v",
                "hevc_vaapi",
                "-b:v",
                &bitrate.to_string(),
                "-tag:v",
                "hvc1",
                "-pix_fmt:v",
                "vaapi",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
        }

        // ─── Software encoders ───
        "software_vp9" => {
            let (cpu_used, deadline) = match speed_preset {
                "quality" => ("0", "good"),
                "balanced" => ("2", "good"),
                "fast" => ("3", "realtime"),
                "superfast" => ("4", "realtime"),
                _ => ("5", "realtime"),
            };
            cmd.args([
                "-c:v",
                "libvpx-vp9",
                "-crf",
                &crf.to_string(),
                "-b:v",
                "0",
                "-cpu-used",
                cpu_used,
                "-deadline",
                deadline,
                "-row-mt",
                "1",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "libopus",
                "-b:a",
                "128k",
                "-shortest",
            ]);
        }
        "software_x265" => {
            let preset = match speed_preset {
                "quality" => "slow",
                "balanced" => "medium",
                "fast" => "veryfast",
                "superfast" => "superfast",
                _ => "ultrafast",
            };
            cmd.args([
                "-c:v",
                "libx265",
                "-preset",
                preset,
                "-crf",
                &crf.to_string(),
                "-pix_fmt",
                "yuv420p",
                "-tag:v",
                "hvc1",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
            if preset == "ultrafast" {
                cmd.args([
                    "-x265-params",
                    "no-sao=1:no-deblock=1:ref=1:bframes=0:me=dia:subme=0",
                ]);
            }
        }
        _ => {
            // software_x264 (default)
            let preset = match speed_preset {
                "quality" => "slow",
                "balanced" => "medium",
                "fast" => "veryfast",
                "superfast" => "superfast",
                _ => "ultrafast",
            };
            cmd.args([
                "-c:v",
                "libx264",
                "-preset",
                preset,
                "-tune",
                "animation",
                "-crf",
                &crf.to_string(),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
            ]);
            if preset == "ultrafast" {
                cmd.args([
                    "-x264-params",
                    "no-deblock=1:no-cabac=1:ref=1:bframes=0:scenecut=0:no-weightb=1",
                ]);
            }
        }
    }

    cmd.args(["-max_muxing_queue_size", "9999"]);
    cmd.arg(output_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    cmd
}

// ═══════════ Public API ═══════════

/// Start ffmpeg with shared frame buffer.
/// JS renders frames into the buffer via `push_frame`,
/// a Rust background thread drains them into FFmpeg stdin.
/// Frame data stays in Rust heap — zero IPC serialization of frame bytes.
pub fn start_piped_export(
    app: &AppHandle,
    output_path: &str,
    audio_path: &str,
    width: u32,
    height: u32,
    fps: u32,
    encoder: &str,
    _format: &str,
    crf: u8,
    speed_preset: &str,
    ffmpeg_path: Option<&str>,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");

    let mut cmd = build_ffmpeg_command(
        ffmpeg,
        output_path,
        audio_path,
        width,
        height,
        fps,
        encoder,
        crf,
        speed_preset,
    );

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;

    // Read stderr in background to prevent pipe deadlock
    let stderr = child.stderr.take();
    std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            let mut reader = std::io::BufReader::new(stderr);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(s) = std::str::from_utf8(&buf[..n]) {
                            eprintln!("[ffmpeg] {}", s.trim());
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    });

    let stdin = child.stdin.take().ok_or("Cannot get ffmpeg stdin")?;

    // Create shared frame buffer. total_frames starts at 0 so the drain
    // thread won't early-exit on sent >= total. JS sets the real count via push_frame.
    let frame_buffer = SharedFrameBuffer::new(width, height, 0);

    // Spawn background drain thread
    let app_clone = app.clone();
    let fb_clone = frame_buffer.clone_for_drain();
    let drain_handle = std::thread::spawn(move || {
        let result = drain_to_ffmpeg(&fb_clone, stdin, &app_clone);
        match result {
            Ok(sent) => eprintln!("[export] Drained {sent} frames"),
            Err(e) => eprintln!("[export] Drain error: {e}"),
        }
    });

    let mut guard = SHARED_EXPORT.lock().unwrap();
    *guard = Some(SharedExport {
        frame_buffer,
        child,
        output_path: output_path.to_string(),
        drain_handle: Some(drain_handle),
    });

    let _ = app.emit(
        "export-progress",
        serde_json::json!({
            "current_frame": 0u32,
            "total_frames": 0u32,
            "percent": 0u32,
            "stage": "rendering"
        }),
    );

    Ok(())
}

/// Push a batch of rendered frames into the shared buffer.
/// `data` contains `frame_count` contiguous RGBA frames.
/// Frame data is copied into Rust heap — no IPC serialization after this point.
pub fn push_frames(data: Vec<u8>, frame_count: u32, total_frames: u32) -> Result<u32, String> {
    let t0 = std::time::Instant::now();

    // Extract the buffer Arc while holding the global lock, then release it
    // before the expensive frame-copy loop so drain can run concurrently.
    let fb = {
        let guard = SHARED_EXPORT.lock().unwrap();
        let export = guard.as_ref().ok_or("Pipe not started")?;

        if is_cancelled() {
            return Err("Cancelled".into());
        }

        // Update total frames on first push so the drain thread knows when to stop
        export.frame_buffer.set_total_frames(total_frames);

        export.frame_buffer.clone_for_push()
    };

    // Split the contiguous data into individual frame slices
    let frame_size = data.len() / frame_count as usize;
    let frame_refs: Vec<&[u8]> = data.chunks(frame_size).take(frame_count as usize).collect();

    let (first, last) = fb.push_frames(&frame_refs)?;
    let elapsed = t0.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "[export:push] batch {}+{} copy {:.1}ms",
        first, frame_count, elapsed
    );
    Ok(last - first)
}

/// Signal that JS has finished rendering all frames.
/// The background drain thread will finish once the buffer is empty.
pub fn finish_piped_export(app: &AppHandle) -> Result<(), String> {
    let mut guard = SHARED_EXPORT.lock().unwrap();
    let mut export = guard.take().ok_or("Pipe not started")?;

    // Signal done to the drain thread
    export.frame_buffer.mark_done();

    // Wait for drain thread to finish
    if let Some(handle) = export.drain_handle.take() {
        let _ = handle.join();
    }

    let _ = app.emit(
        "export-progress",
        serde_json::json!({
            "current_frame": 0u32,
            "total_frames": 0u32,
            "percent": 100u32,
            "stage": "encoding"
        }),
    );

    // Wait for FFmpeg to finish
    let status = export
        .child
        .wait()
        .map_err(|e| format!("ffmpeg failed: {e}"))?;

    if status.success() {
        let path = export.output_path.clone();
        let _ = app.emit("export-done", path);
        Ok(())
    } else {
        let code = status.code().unwrap_or(-1);
        Err(format!("ffmpeg exit code: {code}"))
    }
}

/// Force kill piped export
pub fn abort_piped_export() {
    if let Ok(mut guard) = SHARED_EXPORT.lock() {
        if let Some(mut export) = guard.take() {
            export.frame_buffer.cancel();
            if let Some(handle) = export.drain_handle.take() {
                let _ = handle.join();
            }
            let _ = export.child.kill();
            let _ = export.child.wait();
            let _ = std::fs::remove_file(&export.output_path);
        }
    }
}
