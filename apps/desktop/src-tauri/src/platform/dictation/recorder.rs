//! Microphone capture for dictation through cpal (WASAPI shared mode on Windows, the default
//! input device – CCC used the default capture endpoint too). Samples are downmixed to
//! mono and kept in memory at the device rate; nothing is written to disk. The cpal stream
//! is not `Send` on every platform, so it lives on its own thread until `stop`.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};

use crate::dictation::audio::{rms, to_mono, Recording};

#[derive(Default)]
struct Buffer {
    samples: Vec<f32>,
    rate: u32,
    level: f32,
    peak: f32,
}

#[derive(Default)]
pub struct Recorder {
    buffer: Arc<Mutex<Buffer>>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Recorder {
    pub fn start(&mut self) -> Result<(), String> {
        self.stop();
        if let Ok(mut b) = self.buffer.lock() {
            *b = Buffer::default();
        }
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let buffer = self.buffer.clone();
        let thread = std::thread::Builder::new()
            .name("dictation-mic".into())
            .spawn(move || match open_stream(buffer) {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.stop = Some(stop_tx);
                self.thread = Some(thread);
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("microphone thread ended".into()),
        }
    }

    pub fn level(&self) -> f32 {
        self.buffer.lock().map(|b| b.level).unwrap_or(0.0)
    }

    pub fn stop(&mut self) -> Recording {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        match self.buffer.lock() {
            Ok(mut b) => Recording { samples: std::mem::take(&mut b.samples), rate: b.rate, peak_rms: b.peak },
            Err(_) => Recording::default(),
        }
    }
}

fn open_stream(buffer: Arc<Mutex<Buffer>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("no microphone found")?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let channels = usize::from(supported.channels()).max(1);
    if let Ok(mut b) = buffer.lock() {
        b.rate = supported.sample_rate();
    }
    let format = supported.sample_format();
    let config = supported.config();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, channels, buffer, |s| s),
        SampleFormat::I16 => build::<i16>(&device, config, channels, buffer, |s| f32::from(s) / 32_768.0),
        SampleFormat::U16 => build::<u16>(&device, config, channels, buffer, |s| (f32::from(s) - 32_768.0) / 32_768.0),
        SampleFormat::I32 => build::<i32>(&device, config, channels, buffer, |s| s as f32 / 2_147_483_648.0),
        other => return Err(format!("unsupported microphone sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn build<T: SizedSample + Copy + Send + 'static>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    channels: usize,
    buffer: Arc<Mutex<Buffer>>,
    convert: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data.iter().map(|s| convert(*s)).collect();
                let mono = to_mono(&floats, channels);
                let level = rms(&mono);
                if let Ok(mut b) = buffer.lock() {
                    b.samples.extend_from_slice(&mono);
                    b.level = level;
                    b.peak = b.peak.max(level);
                }
            },
            |e| log::warn!("dictation: microphone stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}
