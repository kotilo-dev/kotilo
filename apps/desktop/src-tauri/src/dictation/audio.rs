//! Microphone samples to what the hub's Whisper expects: 16 kHz mono f32 (CCC spec §22.2).
//! Same maths as `Hub.Core/Dictation/AudioSamples.cs`; trimming and padding stay in the hub.

pub const WHISPER_RATE: u32 = 16_000;

/// Below this RMS a buffer counts as silence (about -46 dBFS).
pub const SILENCE_RMS: f32 = 0.005;

/// Averages interleaved channels into one.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Downsampling averages the source samples each output sample covers (a box filter,
/// enough against aliasing for speech); upsampling interpolates linearly.
pub fn resample(mono: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || mono.is_empty() || from_rate == 0 || to_rate == 0 {
        return mono.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let length = (mono.len() as f64 / ratio) as usize;
    (0..length)
        .map(|i| {
            let start = i as f64 * ratio;
            if ratio > 1.0 {
                let from = start as usize;
                let to = mono.len().min((start + ratio).ceil() as usize);
                let slice = &mono[from..to.max(from)];
                slice.iter().sum::<f32>() / slice.len().max(1) as f32
            } else {
                let index = start as usize;
                let next = (index + 1).min(mono.len() - 1);
                let t = (start - index as f64) as f32;
                mono[index] * (1.0 - t) + mono[next] * t
            }
        })
        .collect()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Little-endian f32 bytes: the body of `POST /v1/dictation/transcribe`.
pub fn to_le_bytes(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// What a recording produced: mono samples at the device rate plus the loudest buffer.
#[derive(Debug, Clone, Default)]
pub struct Recording {
    pub samples: Vec<f32>,
    pub rate: u32,
    pub peak_rms: f32,
}

impl Recording {
    /// False when the microphone delivered (near) silence the whole time – usually a muted
    /// device or the Windows microphone privacy setting.
    pub fn heard_anything(&self) -> bool {
        self.peak_rms > SILENCE_RMS / 2.0
    }

    pub fn seconds(&self) -> f64 {
        if self.rate == 0 {
            0.0
        } else {
            self.samples.len() as f64 / self.rate as f64
        }
    }

    pub fn to_whisper(&self) -> Vec<f32> {
        resample(&self.samples, self.rate, WHISPER_RATE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_48k_becomes_mono_16k() {
        let frames = 4_800;
        let stereo: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let v = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin() * 0.5;
                [v, v]
            })
            .collect();
        let mono = to_mono(&stereo, 2);
        assert_eq!(mono.len(), frames);
        let out = resample(&mono, 48_000, WHISPER_RATE);
        assert_eq!(out.len(), 1_600);
        assert!((rms(&out) - rms(&mono)).abs() < 0.02);
    }

    #[test]
    fn upsampling_interpolates() {
        assert_eq!(resample(&[0.0, 1.0], 8_000, 16_000), vec![0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn silence_detection_and_wire_format() {
        let quiet = Recording { samples: vec![0.0; 16_000], rate: 16_000, peak_rms: 0.001 };
        assert!(!quiet.heard_anything());
        assert_eq!(quiet.seconds(), 1.0);
        let loud = Recording { peak_rms: 0.1, ..quiet };
        assert!(loud.heard_anything());
        assert_eq!(to_le_bytes(&[1.0, -0.5]), [1.0f32.to_le_bytes(), (-0.5f32).to_le_bytes()].concat());
    }
}
