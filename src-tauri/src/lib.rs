mod audio;
mod export;
mod renderer;

use audio::decode_audio_file;
use serde::Serialize;

/// 返回给前端的音频元信息 + PCM 数据
#[derive(Debug, Serialize)]
struct AudioDecodeResult {
    info: audio::DecodedAudio,
    samples_base64: String,
}

/// 读取文件的原始字节（base64 返回）
#[tauri::command]
fn read_file_bytes(path: String) -> Result<String, String> {
    eprintln!("[sable:lib] read_file_bytes: {path}");
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    eprintln!("[sable:lib] read_file_bytes: 读取 {} 字节", bytes.len());
    Ok(base64_encode(&bytes))
}

/// 解码音频文件（旧接口，保留兼容）
#[tauri::command]
fn decode_audio(path: String) -> Result<AudioDecodeResult, String> {
    eprintln!("[sable:lib] decode_audio: {path}");
    let audio_data = decode_audio_file(std::path::Path::new(&path))?;
    eprintln!(
        "[sable:lib] decode_audio: 采样率={}, 声道={}, 帧数={}, 时长={:.2}s",
        audio_data.info.sample_rate,
        audio_data.info.channels,
        audio_data.info.total_frames,
        audio_data.info.duration_secs
    );

    let bytes: &[u8] = bytemuck::cast_slice(&audio_data.samples);
    let samples_base64 = base64_encode(bytes);

    Ok(AudioDecodeResult {
        info: audio_data.info,
        samples_base64,
    })
}

// ── 新的视频导出接口（后台线程，非阻塞） ──

/// 启动后台视频导出，通过 Tauri 事件汇报进度
///
/// 事件：
/// - `export-progress`: ExportProgressEvent
/// - `export-done`: 输出文件路径 (String)
/// - `export-error`: 错误消息 (String)
#[tauri::command]
async fn start_video_export_v2(
    app: tauri::AppHandle,
    config: export::ExportConfig,
) -> Result<(), String> {
    eprintln!("[sable:lib] start_video_export_v2: audio={}, output={}, {}x{}@{}fps, particles={}, ffmpeg={:?}",
        config.audio_path, config.output_path, config.width, config.height,
        config.fps, config.particle_count, config.ffmpeg_path);
    // 立即返回，所有工作在后台线程完成
    export::start_background_export(app, config)
}

/// 取消正在进行的导出
#[tauri::command]
fn cancel_video_export() -> Result<(), String> {
    eprintln!("[sable:lib] cancel_video_export: 收到取消请求");
    export::cancel_export();
    Ok(())
}

// ── 旧接口（保留兼容，但不再使用） ──

#[tauri::command]
fn start_video_export(
    _width: u32,
    _height: u32,
    _fps: u32,
    _output_path: String,
    _audio_path: String,
) -> Result<(), String> {
    Err("请使用新的 start_video_export_v2 接口".into())
}

#[tauri::command]
fn send_video_frame(_rgba_bytes: Vec<u8>) -> Result<(), String> {
    Err("请使用新的 start_video_export_v2 接口".into())
}

#[tauri::command]
fn finish_video_export() -> Result<(), String> {
    Err("请使用新的 start_video_export_v2 接口".into())
}

/// 简单的 base64 编码
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((n >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(CHARS[(n & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            decode_audio,
            start_video_export,
            send_video_frame,
            finish_video_export,
            start_video_export_v2,
            cancel_video_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
