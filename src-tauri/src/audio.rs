use serde::Serialize;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// 解码后的 PCM 音频数据，发送给前端
#[derive(Debug, Clone, Serialize)]
pub struct DecodedAudio {
    /// 采样率 (Hz)
    pub sample_rate: u32,
    /// 声道数
    pub channels: u16,
    /// 总采样帧数（每帧 = channels 个采样点）
    pub total_frames: u64,
    /// 时长（秒）
    pub duration_secs: f64,
}

/// 音频解码结果，包含元数据和原始 f32 采样（通过 Tauri command 分别传输）
pub struct AudioData {
    pub info: DecodedAudio,
    /// 混合为单声道的 f32 采样，值范围 [-1, 1]
    pub samples: Vec<f32>,
}

/// 使用 symphonia 解码音频文件
pub fn decode_audio_file(path: &Path) -> Result<AudioData, String> {
    eprintln!("[sable:audio] 开始解码: {}", path.display());
    // 打开文件
    let src = std::fs::File::open(path).map_err(|e| {
        eprintln!("[sable:audio] 无法打开文件: {e}");
        format!("无法打开文件: {e}")
    })?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());

    // 探测格式
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
        .map_err(|e| {
            eprintln!("[sable:audio] 不支持的音频格式: {e}");
            format!("不支持的音频格式: {e}")
        })?;

    let mut format = probed.format;

    // 选择第一个音轨
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| {
            eprintln!("[sable:audio] 没有找到有效的音轨");
            "没有找到有效的音轨".to_string()
        })?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let sample_rate = codec_params.sample_rate.unwrap_or(44100);
    let channels = codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
    let total_frames = codec_params.n_frames.unwrap_or(0);

    eprintln!("[sable:audio] 音轨信息: sample_rate={sample_rate}, channels={channels}, total_frames={total_frames}");

    // 创建解码器
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| {
            eprintln!("[sable:audio] 无法创建解码器: {e}");
            format!("无法创建解码器: {e}")
        })?;

    // 解码所有数据
    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => {
                eprintln!("[sable:audio] 解码错误: {e}");
                return Err(format!("解码错误: {e}"));
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder.decode(&packet).map_err(|e| {
            eprintln!("[sable:audio] 解码帧失败: {e}");
            format!("解码帧失败: {e}")
        })?;

        // 转换到 f32 采样缓冲区
        let spec = *decoded.spec();
        let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        let frame_samples = sample_buf.samples();

        // 混合为单声道
        let num_channels = spec.channels.count();
        if num_channels == 1 {
            samples.extend_from_slice(frame_samples);
        } else {
            for chunk in frame_samples.chunks(num_channels) {
                let mono: f32 = chunk.iter().sum::<f32>() / num_channels as f32;
                samples.push(mono);
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
