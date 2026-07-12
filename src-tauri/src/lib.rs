mod audio;
mod export;

use audio::decode_audio_file;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
struct AudioDecodeResult {
    sample_rate: u32,
    channels: u16,
    total_frames: u64,
    duration_secs: f64,
    samples_base64: String,
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(base64_encode(&bytes))
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}

#[tauri::command]
fn write_file_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("写入文件失败: {e}"))
}

#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: Vec<String> = db
        .faces()
        .filter_map(|info| info.families.first().map(|(n, _)| n.to_string()))
        .collect();
    names.sort();
    names.dedup();
    names.truncate(200);
    names
}

#[tauri::command]
fn decode_audio_for_export(
    app: tauri::AppHandle,
    path: String,
) -> Result<AudioDecodeResult, String> {
    let audio_data = decode_audio_file(&app, Path::new(&path))?;

    let bytes: &[u8] = bytemuck::cast_slice(&audio_data.samples);
    let samples_base64 = base64_encode(bytes);

    Ok(AudioDecodeResult {
        sample_rate: audio_data.info.sample_rate,
        channels: audio_data.info.channels,
        total_frames: audio_data.info.total_frames,
        duration_secs: audio_data.info.duration_secs,
        samples_base64,
    })
}

// ── 管道导出（无临时文件） ──

#[tauri::command]
fn start_piped_export(
    app: tauri::AppHandle,
    output_path: String,
    audio_path: String,
    width: u32,
    height: u32,
    fps: u32,
    encoder: String,
    format: String,
    crf: u8,
    speed_preset: String,
    ffmpeg_path: Option<String>,
) -> Result<(), String> {
    export::start_piped_export(
        &app,
        &output_path,
        &audio_path,
        width,
        height,
        fps,
        &encoder,
        &format,
        crf,
        &speed_preset,
        ffmpeg_path.as_deref(),
    )
}

#[tauri::command]
fn send_piped_chunk(
    app: tauri::AppHandle,
    data_base64: String,
    total_frames: u32,
) -> Result<(), String> {
    export::send_piped_chunk(&app, &data_base64, total_frames)
}

#[tauri::command]
fn send_piped_chunk_file(
    app: tauri::AppHandle,
    path: String,
    total_frames: u32,
) -> Result<(), String> {
    export::send_piped_chunk_file(&app, &path, total_frames)
}

#[tauri::command]
fn finish_piped_export(app: tauri::AppHandle) -> Result<(), String> {
    export::finish_piped_export(&app)
}

#[tauri::command]
fn cancel_video_export() -> Result<(), String> {
    export::cancel_export();
    export::abort_piped_export();
    Ok(())
}

// ── Base64 ──

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
            read_file_text,
            write_file_text,
            list_system_fonts,
            decode_audio_for_export,
            start_piped_export,
            send_piped_chunk,
            send_piped_chunk_file,
            finish_piped_export,
            cancel_video_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
