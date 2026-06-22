use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

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

// ═══════════ Piped Export State ═══════════

struct PipedExport {
    child: Child,
    stdin: ChildStdin,
    output_path: String,
}

static PIPED_EXPORT: Mutex<Option<PipedExport>> = Mutex::new(None);

/// Start ffmpeg piped encoding (frames sent via send_piped_chunk)
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

    // NV12 要求宽高均为偶数；上对齐以避免 VideoToolbox/swscale 硬编失败
    let width = ((width + 1) >> 1) << 1;
    let height = ((height + 1) >> 1) << 1;

    let mut cmd = Command::new(ffmpeg);
    // 基础参数：覆盖输出，自动线程，恒定帧率，加速管道识别
    cmd.args([
        "-y",
        "-fflags",
        "+genpts",
        "-threads",
        "0", // 自动检测 CPU 线程数
        "-vsync",
        "cfr", // 恒定帧率
        "-f",
        "rawvideo",
        "-probesize",
        "32", // 最小分析大小，加速 rawvideo 管道输入
        "-analyzeduration",
        "0", // 跳过流分析
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

    match encoder {
        "videotoolbox_h264" => {
            let quality = match speed_preset {
                "quality" => 30,
                "balanced" => 55,
                "fast" => 75,
                "superfast" => 85,
                _ => 90,
            };
            // VideoToolbox 需要 nv12 输入；用 -vf format=nv12 做显式格式转换
            // 避免 -pix_fmt（无流标识符）被错误应用到音频流导致 -22 (Invalid argument)
            cmd.args([
                "-vf",
                "format=nv12",
                "-c:v",
                "h264_videotoolbox",
                "-q:v",
                &quality.to_string(),
                "-allow_sw",
                "1",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart",
            ]);
        }
        "videotoolbox_hevc" => {
            let quality = match speed_preset {
                "quality" => 30,
                "balanced" => 55,
                "fast" => 75,
                "superfast" => 85,
                _ => 90,
            };
            cmd.args([
                "-vf",
                "format=nv12",
                "-c:v",
                "hevc_videotoolbox",
                "-q:v",
                &quality.to_string(),
                "-allow_sw",
                "1",
                "-tag:v",
                "hvc1",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart",
            ]);
        }
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
                "-movflags",
                "+faststart",
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
                "-movflags",
                "+faststart",
            ]);
            if preset == "ultrafast" {
                cmd.args([
                    "-x264-params",
                    "no-deblock=1:no-cabac=1:ref=1:bframes=0:scenecut=0:no-weightb=1",
                ]);
            }
        }
    }

    // 防止编码队列过大导致的卡顿
    cmd.args(["-max_muxing_queue_size", "9999"]);
    cmd.arg(output_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;

    // 立即启动后台线程读取 stderr，防止管道阻塞 + 提供调试信息
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

    let mut guard = PIPED_EXPORT.lock().unwrap();
    *guard = Some(PipedExport {
        child,
        stdin,
        output_path: output_path.to_string(),
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

/// Send a chunk of frames to ffmpeg (base64 encoded RGBA data)
pub fn send_piped_chunk(
    app: &AppHandle,
    base64_data: &str,
    total_frames: u32,
) -> Result<(), String> {
    let mut guard = PIPED_EXPORT.lock().unwrap();
    let export = guard.as_mut().ok_or("Pipe not started")?;

    if is_cancelled() {
        return Err("Cancelled".into());
    }

    let bytes = base64_decode(base64_data)?;
    export
        .stdin
        .write_all(&bytes)
        .map_err(|e| format!("Pipe write failed: {e}"))?;

    let _ = app.emit(
        "export-progress",
        serde_json::json!({
            "current_frame": 0u32,
            "total_frames": total_frames,
            "percent": 0u32,
            "stage": "rendering"
        }),
    );

    Ok(())
}

/// Close stdin and wait for ffmpeg to finish
/// Reads stderr in background to prevent pipe deadlock
pub fn finish_piped_export(app: &AppHandle) -> Result<(), String> {
    let mut guard = PIPED_EXPORT.lock().unwrap();
    let mut export = guard.take().ok_or("Pipe not started")?;

    drop(export.stdin);

    let _ = app.emit(
        "export-progress",
        serde_json::json!({
            "current_frame": 0u32,
            "total_frames": 0u32,
            "percent": 100u32,
            "stage": "encoding"
        }),
    );

    // 后台线程读取 stderr，防止管道阻塞 + 提供调试信息
    let stderr = export.child.stderr.take();
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
    if let Ok(mut guard) = PIPED_EXPORT.lock() {
        if let Some(mut export) = guard.take() {
            let _ = export.child.kill();
            drop(export.stdin);
            let _ = export.child.wait();
            let _ = std::fs::remove_file(&export.output_path);
        }
    }
}

// ═══════════ Base64 ═══════════

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = input.trim_end_matches('=');
    let mut output = Vec::with_capacity(input.len() * 3 / 4);

    let mut table = [0xffu8; 128];
    for (i, &c) in CHARS.iter().enumerate() {
        table[c as usize] = i as u8;
    }

    let mut buffer = 0u32;
    let mut bits = 0u32;

    for byte in input.bytes() {
        if byte > 127 {
            return Err(format!("Invalid base64 char: {}", byte as char));
        }
        let value = table[byte as usize];
        if value == 0xff {
            return Err(format!("Invalid base64: {}", byte as char));
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(output)
}
