//! Dictation sound cues (CCC `SoundCues`): short sine tones, built once as in-memory WAV
//! files and played asynchronously by the OS.

use std::sync::OnceLock;

use crate::dictation::Sound;

const RATE: u32 = 22_050;
const FADE_MS: u32 = 8;

pub fn wav_for(sound: Sound) -> &'static [u8] {
    static START: OnceLock<Vec<u8>> = OnceLock::new();
    static STOP: OnceLock<Vec<u8>> = OnceLock::new();
    static ERROR: OnceLock<Vec<u8>> = OnceLock::new();
    match sound {
        Sound::Start => START.get_or_init(|| wav(&[(660.0, 70), (880.0, 90)])),
        Sound::Stop => STOP.get_or_init(|| wav(&[(880.0, 70), (620.0, 90)])),
        Sound::Error => ERROR.get_or_init(|| wav(&[(300.0, 140)])),
    }
}

/// 16-bit mono PCM WAV of consecutive tones `(Hz, ms)` with short fades (no clicks).
pub fn wav(tones: &[(f32, u32)]) -> Vec<u8> {
    let mut pcm: Vec<i16> = Vec::new();
    for &(freq, ms) in tones {
        let n = RATE * ms / 1_000;
        let fade = (RATE * FADE_MS / 1_000).max(1);
        for i in 0..n {
            let envelope = (i.min(n - 1 - i) as f32 / fade as f32).min(1.0);
            let v = (2.0 * std::f32::consts::PI * freq * i as f32 / RATE as f32).sin() * 0.25 * envelope;
            pcm.push((v * f32::from(i16::MAX)) as i16);
        }
    }
    let data_len = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_valid_pcm_wav_of_the_right_length() {
        let w = wav(&[(660.0, 100)]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        let data_len = u32::from_le_bytes([w[40], w[41], w[42], w[43]]);
        assert_eq!(data_len, 2 * 2_205);
        assert_eq!(w.len(), 44 + data_len as usize);
        // Fades in from silence.
        assert_eq!(i16::from_le_bytes([w[44], w[45]]), 0);
        assert!(!wav_for(Sound::Error).is_empty());
    }
}
