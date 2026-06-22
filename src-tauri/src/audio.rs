use serde::Serialize;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter};

/// 解码后的 PCM 音频数据，发送给前端
#[derive(Debug, Clone, Serialize)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    pub total_frames: u64,
    pub duration_secs: f64,
}

pub struct AudioData {
    pub info: DecodedAudio,
    pub samples: Vec<f32>,
}

/// 使用 symphonia 解码音频文件，通过 Tauri 事件汇报进度
pub fn decode_audio_file(app: &AppHandle, path: &Path) -> Result<AudioData, String> {
    eprintln!("[sable:audio] 开始解码: {}", path.display());

    let src = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {e}"))?;

    let file_size = src.metadata().map(|m| m.len()).unwrap_or(0);
    let mss = MediaSourceStream::new(Box::new(src), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("不支持的音频格式: {e}"))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("没有找到有效的音轨")?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let sample_rate = codec_params.sample_rate.unwrap_or(44100);
    let channels = codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
    let total_frames = codec_params.n_frames.unwrap_or(0);

    eprintln!("[sable:audio] 音轨: {sample_rate}Hz, {channels}ch, {total_frames} frames");

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("无法创建解码器: {e}"))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut last_progress_pct = 0u32;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(format!("解码错误: {e}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder
            .decode(&packet)
            .map_err(|e| format!("解码帧失败: {e}"))?;

        let spec = *decoded.spec();
        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        let frame_samples = sample_buf.samples();
        let num_channels = spec.channels.count();
        if num_channels == 1 {
            samples.extend_from_slice(frame_samples);
        } else {
            for chunk in frame_samples.chunks(num_channels) {
                let mono: f32 = chunk.iter().sum::<f32>() / num_channels as f32;
                samples.push(mono);
            }
        }

        // 报告解码进度（基于文件位置估算百分比）
        if total_frames > 0 {
            let pct = (samples.len() as f64 / total_frames as f64 * 100.0).min(99.0) as u32;
            if pct > last_progress_pct {
                last_progress_pct = pct;
                let _ = app.emit(
                    "export-progress",
                    serde_json::json!({
                        "current_frame": 0u32,
                        "total_frames": 0u32,
                        "percent": pct,
                        "stage": "decoding"
                    }),
                );
            }
        } else if file_size > 0 && samples.len() % 44100 == 0 {
            // 回退：基于采样数粗略估算
            let pct =
                (samples.len() as f64 / (sample_rate as f64 * 300.0) * 100.0).min(99.0) as u32;
            if pct > last_progress_pct {
                last_progress_pct = pct;
                let _ = app.emit(
                    "export-progress",
                    serde_json::json!({
                        "current_frame": 0u32,
                        "total_frames": 0u32,
                        "percent": pct,
                        "stage": "decoding"
                    }),
                );
            }
        }
    }

    let duration_secs = if total_frames > 0 {
        total_frames as f64 / sample_rate as f64
    } else {
        samples.len() as f64 / sample_rate as f64
    };

    let info = DecodedAudio {
        sample_rate,
        channels,
        total_frames: total_frames.max(samples.len() as u64),
        duration_secs,
    };

    eprintln!(
        "[sable:audio] 解码完成: {} 采样, {:.2}s",
        samples.len(),
        duration_secs
    );
    Ok(AudioData { info, samples })
}
