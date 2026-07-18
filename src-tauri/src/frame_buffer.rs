use std::io::Write;
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

/// Shared frame buffer: JS pushes frames into pre-allocated memory,
/// a Rust background task drains them into FFmpeg stdin.
/// Frame data stays in Rust heap — zero IPC serialization of frame bytes.
///
/// Ring buffer: NUM_SLOTS pre-allocated frames.
/// JS writes to slot[frames_pushed % NUM_SLOTS], Rust reads from slot[frames_drained % NUM_SLOTS].
/// A Mutex protects the slots Vec for concurrent push/drain safety.

const NUM_SLOTS: usize = 8;

pub struct SharedFrameBuffer {
    inner: Arc<BufferInner>,
}

struct BufferInner {
    slots: Mutex<Vec<Vec<u8>>>,
    total_frames: AtomicU32,
    frames_pushed: AtomicU32,
    frames_drained: AtomicU32,
    done: AtomicBool,
    cancelled: AtomicBool,
    /// Set to true if FFmpeg pipe write failed (FFmpeg likely crashed).
    pipe_error: AtomicBool,
}

unsafe impl Send for SharedFrameBuffer {}
unsafe impl Sync for SharedFrameBuffer {}

impl SharedFrameBuffer {
    pub fn new(width: u32, height: u32, total_frames: u32) -> Self {
        let frame_size = (width * height * 4) as usize;
        let slots = vec![vec![0u8; frame_size]; NUM_SLOTS];

        Self {
            inner: Arc::new(BufferInner {
                slots: Mutex::new(slots),
                total_frames: AtomicU32::new(total_frames),
                frames_pushed: AtomicU32::new(0),
                frames_drained: AtomicU32::new(0),
                done: AtomicBool::new(false),
                cancelled: AtomicBool::new(false),
                pipe_error: AtomicBool::new(false),
            }),
        }
    }

    /// Clone for sharing with another thread (drain or push).
    pub fn clone_for_drain(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }

    /// Clone for sharing with the push side.
    pub fn clone_for_push(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }

    /// Push multiple frames (batch) into the buffer in one go.
    /// Returns (frames_pushed, last_frame_index).
    pub fn push_frames(&self, frames: &[&[u8]]) -> Result<(u32, u32), String> {
        let first_pushed = self.inner.frames_pushed.load(Ordering::Relaxed);
        let last_index = first_pushed + frames.len() as u32;

        for frame_data in frames.iter() {
            if self.inner.cancelled.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            if self.inner.pipe_error.load(Ordering::Relaxed) {
                return Err("FFmpeg pipe error".into());
            }

            loop {
                let pushed = self.inner.frames_pushed.load(Ordering::Relaxed);
                let drained = self.inner.frames_drained.load(Ordering::Relaxed);

                if pushed.saturating_sub(drained) >= NUM_SLOTS as u32 {
                    std::thread::yield_now();
                    continue;
                }

                let slot_idx = (pushed as usize) % NUM_SLOTS;
                {
                    let mut slots = self.inner.slots.lock().unwrap();
                    // Direct copy — no clear/extend, just overwrite the slot.
                    // Slot capacity >= frame_data length is guaranteed by construction.
                    let dest = &mut slots[slot_idx][..frame_data.len()];
                    dest.copy_from_slice(frame_data);
                }

                self.inner.frames_pushed.fetch_add(1, Ordering::Release);

                break;
            }
        }

        Ok((first_pushed, last_index))
    }

    /// Drain all available frames, calling the writer callback for each.
    /// Returns (frames_sent, done).
    pub fn drain<F>(&self, mut write_frame: F) -> (u32, bool)
    where
        F: FnMut(&[u8]) -> bool,
    {
        let pushed = self.inner.frames_pushed.load(Ordering::Acquire);
        let drained = self.inner.frames_drained.load(Ordering::Relaxed);
        let available = pushed.saturating_sub(drained);

        if available == 0 {
            return (0, self.inner.done.load(Ordering::Acquire));
        }

        let slots = self.inner.slots.lock().unwrap();
        let mut sent = 0u32;
        for i in 0..available {
            let slot_idx = ((drained + i) as usize) % NUM_SLOTS;
            if !write_frame(&slots[slot_idx]) {
                break;
            }
            sent += 1;
        }
        drop(slots);

        if sent > 0 {
            self.inner.frames_drained.fetch_add(sent, Ordering::Release);
        }

        (sent, self.inner.done.load(Ordering::Acquire))
    }

    /// Signal that JS has finished rendering all frames.
    pub fn mark_done(&self) {
        self.inner.done.store(true, Ordering::Release);
    }

    /// Cancel the export.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    /// Mark that the FFmpeg pipe has failed. This stops push_frame from blocking.
    pub fn mark_pipe_error(&self) {
        self.inner.pipe_error.store(true, Ordering::Release);
    }

    pub fn has_pipe_error(&self) -> bool {
        self.inner.pipe_error.load(Ordering::Acquire)
    }

    pub fn total_frames(&self) -> u32 {
        self.inner.total_frames.load(Ordering::Relaxed)
    }

    /// Update total frames (called when JS knows the actual count).
    pub fn set_total_frames(&self, total: u32) {
        self.inner.total_frames.store(total, Ordering::Relaxed);
    }
}

/// Background task: drains frames from buffer and writes to FFmpeg stdin.
/// Emits progress events to the frontend.
/// Returns early on pipe write error (FFmpeg likely crashed).
pub fn drain_to_ffmpeg(
    buffer: &SharedFrameBuffer,
    mut stdin: ChildStdin,
    app: &tauri::AppHandle,
) -> Result<u32, String> {
    let mut sent = 0u32;
    let drain_t0 = std::time::Instant::now();

    loop {
        if buffer.is_cancelled() {
            let elapsed = drain_t0.elapsed();
            let fps = if elapsed.as_secs_f64() > 0.0 {
                sent as f64 / elapsed.as_secs_f64()
            } else {
                0.0
            };
            eprintln!(
                "[export:drain] cancelled after {} frames, {:.1} fps",
                sent, fps
            );
            return Err("Cancelled".into());
        }

        let total = buffer.total_frames();

        let write_t0 = std::time::Instant::now();
        let (drained, done) = buffer.drain(|frame_data| match stdin.write_all(frame_data) {
            Ok(()) => true,
            Err(e) => {
                // Pipe write error means FFmpeg is gone — don't retry.
                eprintln!("[export] FFmpeg pipe write error: {e}");
                buffer.mark_pipe_error();
                false
            }
        });
        let write_ms = write_t0.elapsed().as_secs_f64() * 1000.0;

        sent += drained;

        if drained > 0 {
            let elapsed = drain_t0.elapsed();
            let fps = if elapsed.as_secs_f64() > 0.0 {
                sent as f64 / elapsed.as_secs_f64()
            } else {
                0.0
            };
            eprintln!(
                "[export:drain] frame {} write {:.1}ms drain {:.1}fps",
                sent, write_ms, fps
            );

            let pct = if total > 0 {
                (sent as f64 / total as f64 * 100.0) as u32
            } else {
                0
            };
            let _ = app.emit(
                "export-progress",
                serde_json::json!({
                    "current_frame": sent,
                    "total_frames": total,
                    "percent": pct,
                    "stage": "rendering"
                }),
            );
        }

        if done {
            let elapsed = drain_t0.elapsed();
            let fps = if elapsed.as_secs_f64() > 0.0 {
                sent as f64 / elapsed.as_secs_f64()
            } else {
                0.0
            };
            eprintln!("[export:drain] done {} frames, {:.1} fps total", sent, fps);
            break;
        }

        // Exit if pipe broke during this drain cycle.
        if buffer.has_pipe_error() {
            return Err("FFmpeg pipe closed".into());
        }

        // Only use sent >= total as an early-exit safety net when total is
        // actually known (> 0). When total == 0 (unknown), wait for done.
        if total > 0 && sent >= total {
            break;
        }

        std::thread::sleep(std::time::Duration::from_micros(500));
    }

    Ok(sent)
}
