//! Microphone capture on a thread of its own: some platforms do not allow an
//! audio stream to move between threads, so the stream lives and dies there.
//! Audio stays in memory and is never written to disk.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};

#[derive(Debug, Clone, thiserror::Error)]
pub enum AudioError {
    #[error("no microphone is available")]
    NoDevice,
    #[error("the microphone could not be opened")]
    Unavailable,
}

/// Mono samples between -1.0 and 1.0 at the device's own rate.
pub struct Recording {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

pub struct Recorder {
    stop: mpsc::Sender<()>,
    worker: JoinHandle<Recording>,
    started: Instant,
}

impl Recorder {
    /// Starts recording from the default input device. Returns once the
    /// stream runs, or with the reason it could not start. Recording ends by
    /// itself after `limit`.
    pub fn start(limit: Duration) -> Result<Self, AudioError> {
        let (stop, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("gloss-microphone".into())
            .spawn(move || record(stop_rx, ready_tx, limit))
            .map_err(|_| AudioError::Unavailable)?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self { stop, worker, started: Instant::now() }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => Err(AudioError::Unavailable),
        }
    }

    pub fn stop(self) -> Recording {
        let elapsed = self.started.elapsed();
        let _ = self.stop.send(());
        let mut recording = self.worker.join().unwrap_or(Recording { samples: Vec::new(), sample_rate: 0 });
        // A device that delivers faster than real time (some virtual ones do)
        // must not turn a short press into a long upload.
        let longest = ((elapsed.as_secs_f64() + 0.2) * f64::from(recording.sample_rate)) as usize;
        recording.samples.truncate(longest);
        recording
    }
}

fn record(stop: mpsc::Receiver<()>, ready: mpsc::SyncSender<Result<(), AudioError>>, limit: Duration) -> Recording {
    let opened = open_stream(limit);
    let (stream, buffer, sample_rate) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Recording { samples: Vec::new(), sample_rate: 0 };
        }
    };
    let _ = ready.send(Ok(()));
    // Ends on a stop signal, a dropped recorder or the time limit.
    match stop.recv_timeout(limit) {
        Ok(()) | Err(RecvTimeoutError::Disconnected) | Err(RecvTimeoutError::Timeout) => {}
    }
    drop(stream);
    let samples = buffer.lock().map(|mut samples| std::mem::take(&mut *samples)).unwrap_or_default();
    Recording { samples, sample_rate }
}

type Buffer = Arc<Mutex<Vec<f32>>>;

fn open_stream(limit: Duration) -> Result<(Stream, Buffer, u32), AudioError> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or(AudioError::NoDevice)?;
    let supported = device.default_input_config().map_err(|_| AudioError::Unavailable)?;
    let sample_rate = supported.sample_rate();
    let channels = usize::from(supported.channels().max(1));
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    // Bounded: a stuck stop signal cannot grow memory past the time limit.
    let capacity = (sample_rate as f64 * (limit.as_secs_f64() + 1.0)) as usize;
    let buffer: Buffer = Arc::new(Mutex::new(Vec::with_capacity(capacity)));

    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, channels, capacity, buffer.clone()),
        SampleFormat::I16 => build::<i16>(&device, &config, channels, capacity, buffer.clone()),
        SampleFormat::U16 => build::<u16>(&device, &config, channels, capacity, buffer.clone()),
        SampleFormat::I32 => build::<i32>(&device, &config, channels, capacity, buffer.clone()),
        SampleFormat::F64 => build::<f64>(&device, &config, channels, capacity, buffer.clone()),
        _ => Err(AudioError::Unavailable),
    }?;
    stream.play().map_err(|_| AudioError::Unavailable)?;
    Ok((stream, buffer, sample_rate))
}

fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    capacity: usize,
    buffer: Buffer,
) -> Result<Stream, AudioError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            *config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                // Never block the audio thread; a missed chunk is better than a glitch.
                let Ok(mut samples) = buffer.try_lock() else { return };
                for frame in data.chunks(channels) {
                    if samples.len() >= capacity {
                        return;
                    }
                    let sum: f32 = frame.iter().map(|sample| sample.to_sample::<f32>()).sum();
                    samples.push(sum / frame.len() as f32);
                }
            },
            |_| log::warn!("microphone stream reported an error"),
            None,
        )
        .map_err(|_| AudioError::Unavailable)
}
