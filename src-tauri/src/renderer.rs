use rand::Rng;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f32::consts::PI;
use tiny_skia::*;

// ── 可视化配置 ──

#[derive(Debug, Clone)]
pub struct RendererConfig {
    pub particle_count: u32,
    pub glow_intensity: f32,
    pub shake_intensity: f32,
    pub hue_range: (f32, f32),
}

// ── 粒子 ──

struct Particle {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    life: f32,
    max_life: f32,
    size: f32,
    hue: f32,
    alpha: f32,
}

// ── 频谱结果 ──

struct Spectrum {
    #[allow(dead_code)]
    freq: Vec<u8>, // 0..255
    avg_energy: f32,  // 0..1
    bass_energy: f32, // 0..1
}

struct BeatResult {
    is_beat: bool,
    intensity: f32,
}

// ── 帧渲染器 ──

pub struct FrameRenderer {
    width: u32,
    height: u32,
    config: RendererConfig,

    // 音频数据
    samples: Vec<f32>,
    sample_rate: u32,

    // 粒子
    particles: Vec<Particle>,

    // 抖动
    shake_x: f32,
    shake_y: f32,

    // 节拍检测
    energy_history: Vec<f32>,
    cooldown: u32,
    last_intensity: f32,

    // FFT 相关
    fft_size: usize,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    fft_input: Vec<Complex<f32>>,
    fft_scratch: Vec<Complex<f32>>,
    hann_window: Vec<f32>,

    // 画布
    pixmap: Pixmap,
}

impl FrameRenderer {
    pub fn new(width: u32, height: u32, config: RendererConfig) -> Self {
        let fft_size = 256;
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);

        // 预计算 Hann 窗
        let hann_window: Vec<f32> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / (fft_size - 1) as f32).cos()))
            .collect();

        let pixmap = Pixmap::new(width, height).expect("无法创建 Pixmap");

        Self {
            width,
            height,
            config,
            samples: Vec::new(),
            sample_rate: 44100,
            particles: Vec::new(),
            shake_x: 0.0,
            shake_y: 0.0,
            energy_history: Vec::new(),
            cooldown: 0,
            last_intensity: 0.0,
            fft_size,
            fft,
            fft_input: vec![Complex::new(0.0, 0.0); fft_size],
            fft_scratch: vec![Complex::new(0.0, 0.0); fft_size],
            hann_window,
            pixmap,
        }
    }

    pub fn set_audio_data(&mut self, samples: &[f32], sample_rate: u32) {
        self.samples = samples.to_vec();
        self.sample_rate = sample_rate;
    }

    pub fn reset(&mut self) {
        self.particles.clear();
        self.shake_x = 0.0;
        self.shake_y = 0.0;
        self.energy_history.clear();
        self.cooldown = 0;
        self.last_intensity = 0.0;
    }

    /// 渲染一帧，返回 RGBA 像素数据
    pub fn render_frame(&mut self, time_seconds: f64) -> Vec<u8> {
        let spectrum = self.compute_spectrum(time_seconds);
        let beat = self.detect_beat(&spectrum);
        self.update_particles(&spectrum, &beat);
        self.update_shake(&beat);
        self.draw(&spectrum, &beat);

        // 返回 RGBA bytes（tiny-skia pixmap 是预乘 alpha 的 RGBA）
        // ffmpeg 需要非预乘 RGBA，但差别通常可忽略
        self.pixmap.data().to_vec()
    }

    // ══════════════════ 频谱计算 ══════════════════

    fn compute_spectrum(&mut self, time_seconds: f64) -> Spectrum {
        if self.samples.is_empty() {
            return Spectrum {
                freq: vec![0; 128],
                avg_energy: 0.0,
                bass_energy: 0.0,
            };
        }

        let sample_idx = (time_seconds * self.sample_rate as f64) as usize;
        let window_start = sample_idx.saturating_sub(self.fft_size / 2);

        // 填充 FFT 输入 + Hann 窗
        for i in 0..self.fft_size {
            let sample = if window_start + i < self.samples.len() {
                self.samples[window_start + i]
            } else {
                0.0
            };
            self.fft_input[i] = Complex::new(sample * self.hann_window[i], 0.0);
        }

        // FFT（in-place 变换，直接处理 fft_input，无需 clone）
        self.fft
            .process_with_scratch(&mut self.fft_input, &mut self.fft_scratch);

        // 频率幅度 → 0..255
        let half = self.fft_size / 2;
        let mut freq = vec![0u8; half];
        for i in 0..half {
            let mag = (self.fft_input[i].norm_sqr().sqrt() / self.fft_size as f32 * 3.0).min(1.0);
            freq[i] = (mag * 255.0) as u8;
        }

        let avg_energy = freq.iter().map(|&v| v as f32).sum::<f32>() / (half * 255) as f32;

        let bass_bins = half / 4;
        let bass_energy =
            freq[..bass_bins].iter().map(|&v| v as f32).sum::<f32>() / (bass_bins * 255) as f32;

        Spectrum {
            freq,
            avg_energy,
            bass_energy,
        }
    }

    // ══════════════════ 节拍检测 ══════════════════

    fn detect_beat(&mut self, spectrum: &Spectrum) -> BeatResult {
        self.energy_history.push(spectrum.bass_energy);
        if self.energy_history.len() > 60 {
            self.energy_history.remove(0);
        }
        if self.cooldown > 0 {
            self.cooldown -= 1;
        }

        let avg = self.energy_history.iter().sum::<f32>() / self.energy_history.len() as f32;
        let is_beat = self.cooldown == 0
            && self.energy_history.len() >= 10
            && spectrum.bass_energy > avg * 1.4
            && spectrum.bass_energy > 0.15;

        if is_beat {
            self.cooldown = 12;
            let intensity = ((spectrum.bass_energy - avg * 1.4) / (1.0 - avg * 1.4))
                .min(1.0)
                .max(0.0);
            self.last_intensity = intensity;
            BeatResult {
                is_beat: true,
                intensity,
            }
        } else {
            self.last_intensity *= 0.9;
            BeatResult {
                is_beat: false,
                intensity: self.last_intensity,
            }
        }
    }

    // ══════════════════ 粒子系统 ══════════════════

    fn update_particles(&mut self, spectrum: &Spectrum, beat: &BeatResult) {
        let spawn_rate = 3.0 + spectrum.avg_energy * 12.0;
        let to_spawn = if beat.is_beat {
            (spawn_rate * 3.0) as u32
        } else {
            spawn_rate as u32
        };

        for _ in 0..to_spawn {
            if self.particles.len() < self.config.particle_count as usize {
                self.particles
                    .push(self.spawn_particle(spectrum.avg_energy));
            }
        }

        // 更新现有粒子
        let mut i = 0;
        while i < self.particles.len() {
            let p = &mut self.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.99;
            p.vy *= 0.99;
            p.vy += 0.02;
            p.life -= 1.0 / (p.max_life * 60.0);

            if p.life <= 0.0 {
                self.particles.swap_remove(i);
            } else {
                i += 1;
            }
        }
    }

    fn spawn_particle(&self, energy: f32) -> Particle {
        let angle = rand::thread_rng().gen_range(0.0..PI * 2.0);
        let speed = 0.5 + energy * 4.0 + rand::thread_rng().gen_range(0.0..2.0);
        let (min_hue, max_hue) = self.config.hue_range;
        let hue_range = (max_hue - min_hue).max(0.0);
        // 全屏随机位置
        let x = rand::thread_rng().gen_range(0.0..self.width as f32);
        let y = rand::thread_rng().gen_range(0.0..self.height as f32);

        Particle {
            x,
            y,
            vx: angle.cos() * speed,
            vy: angle.sin() * speed - 1.0,
            life: 1.0,
            max_life: 0.6 + rand::thread_rng().gen_range(0.0..0.8),
            size: 1.0 + energy * 4.0 + rand::thread_rng().gen_range(0.0..3.0),
            hue: min_hue + rand::thread_rng().gen_range(0.0..hue_range.max(f32::EPSILON)),
            alpha: 0.6 + rand::thread_rng().gen_range(0.0..0.4),
        }
    }

    // ══════════════════ 抖动 ══════════════════

    fn update_shake(&mut self, beat: &BeatResult) {
        if beat.is_beat {
            let max_shake = 12.0 * self.config.shake_intensity;
            self.shake_x = (rand::thread_rng().gen_range(-0.5..0.5)) * max_shake * beat.intensity;
            self.shake_y = (rand::thread_rng().gen_range(-0.5..0.5)) * max_shake * beat.intensity;
        } else {
            self.shake_x *= 0.85;
            self.shake_y *= 0.85;
        }
    }

    // ══════════════════ 渲染 ══════════════════

    fn draw(&mut self, spectrum: &Spectrum, beat: &BeatResult) {
        // 清屏（不透明深色背景 — 离线渲染没有底层画布叠加，必须用不透明背景）
        let fade = Color::from_rgba8(10, 10, 20, 255);
        self.pixmap.fill(fade);

        // 应用抖动变换（通过平移所有绘制操作）
        let shake_dx = self.shake_x;
        let shake_dy = self.shake_y;

        // 辉光
        self.draw_glow(spectrum, beat, shake_dx, shake_dy);

        // 粒子
        self.draw_particles(shake_dx, shake_dy);
    }

    fn draw_glow(&mut self, spectrum: &Spectrum, beat: &BeatResult, dx: f32, dy: f32) {
        let energy = spectrum.avg_energy;
        let beat_boost = if beat.is_beat {
            1.0 + beat.intensity * 0.5
        } else {
            1.0
        };
        let glow_radius = (60.0 + energy * 120.0) * self.config.glow_intensity * beat_boost;

        if glow_radius <= 0.0 {
            return;
        }

        let (min_hue, _max_hue) = self.config.hue_range;
        let mid_hue = (min_hue + 40.0) % 360.0;

        // 全屏多个随机辉光点，随能量增多
        // 🔥 优化：用半透明圆叠加模拟径向渐变，避免 tiny-skia RadialGradient 的昂贵逐像素计算
        let num_glows = 3 + (energy * 5.0) as usize;
        for i in 0..num_glows {
            let cx = rand::thread_rng().gen_range(0.0..self.width as f32) + dx;
            let cy = rand::thread_rng().gen_range(0.0..self.height as f32) + dy;
            let r = glow_radius * (0.5 + 0.5 * (i as f32 / num_glows as f32));

            // 用多层不透明度递减的圆模拟渐变效果
            let layers = 4;
            for l in 0..layers {
                let t = l as f32 / layers as f32;
                let lr = r * (1.0 - t * 0.7);
                let alpha1 = (0.3 * energy * beat_boost * 255.0 * (1.0 - t) / layers as f32) as u8;
                if alpha1 > 0 {
                    let color1 = hsl_to_rgba(min_hue, 1.0, 0.6, alpha1);
                    draw_solid_circle(&mut self.pixmap, cx, cy, lr, color1);
                }
                let alpha2 = (0.1 * energy * beat_boost * 255.0 * (1.0 - t) / layers as f32) as u8;
                if alpha2 > 0 {
                    let color2 = hsl_to_rgba(mid_hue, 1.0, 0.5, alpha2);
                    draw_solid_circle(&mut self.pixmap, cx, cy, lr, color2);
                }
            }
        }

        // 节拍时全屏闪光
        if beat.is_beat {
            let flash_alpha = (beat.intensity * 0.08 * 255.0) as u8;
            let flash = Color::from_rgba8(255, 255, 255, flash_alpha);
            self.pixmap.fill(flash);
        }
    }

    fn draw_particles(&mut self, dx: f32, dy: f32) {
        // 先画大光晕（用半透明实心圆代替径向渐变）
        for p in &self.particles {
            let alpha = (p.alpha * p.life * 255.0) as u8;
            if alpha == 0 {
                continue;
            }
            let x = p.x + dx;
            let y = p.y + dy;

            // 🔥 优化：多层递减不透明度的圆模拟径向渐变
            let layers: usize = 3;
            for l in 0..layers {
                let t = l as f32 / layers as f32;
                let lr = p.size * 3.0 * (1.0 - t * 0.75);
                let la = (alpha as f32 * (1.0 - t) / layers as f32) as u8;
                if la > 0 {
                    let color = hsl_to_rgba(p.hue, 1.0, 0.7, la);
                    draw_solid_circle(&mut self.pixmap, x, y, lr, color);
                }
            }
        }

        // 再画核心亮点（叠加）
        for p in &self.particles {
            if p.size <= 2.0 {
                continue;
            }
            let alpha = (p.alpha * p.life * 0.5 * 255.0) as u8;
            if alpha == 0 {
                continue;
            }
            let x = p.x + dx;
            let y = p.y + dy;
            let color = hsl_to_rgba(p.hue, 1.0, 0.85, alpha);
            draw_solid_circle(&mut self.pixmap, x, y, p.size * 0.5, color);
        }
    }
}

// ══════════════════ 绘制辅助函数 ══════════════════

fn hsl_to_rgba(h: f32, s: f32, l: f32, a: u8) -> Color {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;

    let (r1, g1, b1) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };

    let r = ((r1 + m) * 255.0).round() as u8;
    let g = ((g1 + m) * 255.0).round() as u8;
    let b = ((b1 + m) * 255.0).round() as u8;

    Color::from_rgba8(r, g, b, a)
}

/// 🔥 优化：用简单实心圆替代 tiny-skia RadialGradient
/// RadialGradient 内部对每个像素做插值计算，极其昂贵。
/// 多层实心圆叠加效果近似且快 5-10 倍。
fn draw_solid_circle(pixmap: &mut Pixmap, cx: f32, cy: f32, r: f32, color: Color) {
    if r <= 0.5 || color.alpha() == 0.0 {
        return;
    }

    let paint = Paint {
        shader: Shader::SolidColor(color),
        ..Default::default()
    };

    let path = match PathBuilder::from_circle(cx, cy, r) {
        Some(p) => p,
        None => return,
    };

    pixmap.fill_path(
        &path,
        &paint,
        FillRule::Winding,
        Transform::identity(),
        None,
    );
}
