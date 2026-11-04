//! Audio in the format `/api/speech/dictate` accepts (`src/server/practice/wav.ts`):
//! RIFF/WAVE, PCM, mono, 16-bit, 16 kHz, 0.5 to 60 seconds.

pub const TARGET_RATE: u32 = 16_000;
pub const MIN_SECONDS: f64 = 0.5;
pub const MAX_SECONDS: f64 = 60.0;

/// Converts mono samples to `to` Hz. Downsampling averages each output
/// sample's source span, a simple low-pass that keeps speech intelligible;
/// upsampling interpolates linearly.
pub fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() || from == 0 || to == 0 {
        return samples.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((samples.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f64 * ratio;
        if ratio > 1.0 {
            let start = position.floor() as usize;
            let end = (((i + 1) as f64) * ratio).floor().min(samples.len() as f64) as usize;
            let span = &samples[start..end.max(start + 1).min(samples.len())];
            out.push(span.iter().sum::<f32>() / span.len() as f32);
        } else {
            let index = position.floor() as usize;
            let fraction = (position - index as f64) as f32;
            let current = samples[index];
            let next = samples.get(index + 1).copied().unwrap_or(current);
            out.push(current + (next - current) * fraction);
        }
    }
    out
}

/// Largest absolute sample value; near zero means the microphone sent silence,
/// which is what macOS delivers while microphone access is denied.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0_f32, |max, sample| max.max(sample.abs()))
}

/// Encodes mono samples (-1.0 to 1.0) as 16-bit PCM WAV, cut at the limit.
pub fn encode_pcm16(samples: &[f32], rate: u32) -> Vec<u8> {
    let max_samples = (MAX_SECONDS * rate as f64) as usize;
    let samples = &samples[..samples.len().min(max_samples)];
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub fn seconds(sample_count: usize, rate: u32) -> f64 {
    if rate == 0 { 0.0 } else { sample_count as f64 / rate as f64 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, seconds: f64, hz: f32) -> Vec<f32> {
        let count = (rate as f64 * seconds) as usize;
        (0..count).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin() * 0.5).collect()
    }

    #[test]
    fn writes_the_header_the_server_validates() {
        let wav = encode_pcm16(&[0.0, 0.5, -0.5, 1.0], TARGET_RATE);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "16-bit");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 8);
        assert_eq!(wav.len(), 52);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -16384);
        assert_eq!(i16::from_le_bytes([wav[50], wav[51]]), i16::MAX);
    }

    #[test]
    fn cuts_audio_at_sixty_seconds() {
        let samples = vec![0.0; TARGET_RATE as usize * 61];
        let wav = encode_pcm16(&samples, TARGET_RATE);
        assert_eq!(wav.len(), 44 + TARGET_RATE as usize * 60 * 2);
        assert!(wav.len() <= 3 * 1024 * 1024);
    }

    #[test]
    fn resamples_common_microphone_rates() {
        let from_48k = resample(&tone(48_000, 1.0, 440.0), 48_000, TARGET_RATE);
        assert_eq!(from_48k.len(), 16_000);
        let from_44k = resample(&tone(44_100, 1.0, 440.0), 44_100, TARGET_RATE);
        assert_eq!(from_44k.len(), 16_000);
        let from_8k = resample(&tone(8_000, 1.0, 440.0), 8_000, TARGET_RATE);
        assert_eq!(from_8k.len(), 16_000);
        // A speech-band tone survives with most of its level.
        assert!(peak(&from_48k) > 0.4 && peak(&from_48k) <= 0.5);
        assert!(peak(&from_8k) > 0.4 && peak(&from_8k) <= 0.5);
    }

    #[test]
    fn detects_silence() {
        assert_eq!(peak(&[0.0; 100]), 0.0);
        assert_eq!(peak(&[0.1, -0.3, 0.2]), 0.3);
        assert_eq!(seconds(8_000, 16_000), 0.5);
    }
}
