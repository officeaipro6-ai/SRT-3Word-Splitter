/**
 * Browser-based audio extraction and waveform processing.
 * Extracts audio tracks from video files (MP4, MOV, WEBM) and audio files (MP3, WAV, M4A, etc.)
 */

export interface ExtractedAudioData {
  audioBuffer: AudioBuffer;
  wavBlob: Blob;
  duration: number;
  sampleRate: number;
  channels: number;
  peaks: number[]; // Normalized amplitude peaks (0.0 to 1.0)
}

/**
 * Extract audio track from any Audio or Video file and generate normalized waveform peaks
 */
export async function extractAudioFromMediaFile(
  file: File,
  onProgress?: (progress: number, status: string) => void
): Promise<ExtractedAudioData> {
  onProgress?.(10, 'Reading file into memory buffer...');
  const arrayBuffer = await file.arrayBuffer();

  onProgress?.(30, 'Decoding audio track with Web Audio API...');
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextClass();
  
  let audioBuffer: AudioBuffer;
  try {
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      // If browser decoding fails directly on video container (MKV, MOV, etc.), try playing through hidden media element
      onProgress?.(45, 'Falling back to media pipeline decode...');
      audioBuffer = await decodeViaMediaElement(file, audioContext);
    }
  } finally {
    // Safely close audioContext to free browser audio device resources
    if (audioContext.state !== 'closed') {
      audioContext.close().catch(() => {});
    }
  }

  onProgress?.(70, 'Analyzing waveform peaks...');
  const peaks = calculateWaveformPeaks(audioBuffer, 120);

  onProgress?.(85, 'Encoding optimized audio for AI transcription pipeline...');
  const wavBlob = await audioBufferToWavBlob(audioBuffer, 16000); // 16kHz mono for speech

  onProgress?.(100, 'Audio extraction complete.');

  return {
    audioBuffer,
    wavBlob,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    peaks,
  };
}

/**
 * Decode audio using an HTMLAudioElement or HTMLVideoElement fallback
 */
async function decodeViaMediaElement(file: File, audioContext: AudioContext): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.src = url;
    audio.crossOrigin = 'anonymous';

    audio.onloadedmetadata = async () => {
      try {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(buffer);
        URL.revokeObjectURL(url);
        resolve(decoded);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(new Error('Could not decode audio from media file. Ensure it contains a valid audio stream.'));
      }
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load media element for audio extraction.'));
    };
  });
}

/**
 * Calculate amplitude peaks across the audio duration for rendering waveform
 */
export function calculateWaveformPeaks(audioBuffer: AudioBuffer, numPeaks: number = 100): number[] {
  const channelData = audioBuffer.getChannelData(0);
  const totalSamples = channelData.length;
  const blockSize = Math.floor(totalSamples / numPeaks);
  const peaks: number[] = [];

  for (let i = 0; i < numPeaks; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, totalSamples);
    let max = 0;

    for (let j = start; j < end; j++) {
      const absVal = Math.abs(channelData[j]);
      if (absVal > max) {
        max = absVal;
      }
    }
    peaks.push(Math.min(1, max));
  }

  // Normalize peaks so highest peak is 1.0 (with a minimum floor for visibility)
  const maxPeak = Math.max(...peaks, 0.01);
  return peaks.map((p) => Math.max(0.08, p / maxPeak));
}

/**
 * Convert AudioBuffer to 16kHz mono WAV Blob (optimal size for speech AI API)
 */
export function audioBufferToWavBlob(buffer: AudioBuffer, targetSampleRate: number = 16000): Promise<Blob> {
  return new Promise((resolve) => {
    const numChannels = 1; // Mono
    const sampleRate = targetSampleRate;
    const offlineCtx = new OfflineAudioContext(numChannels, Math.ceil(buffer.duration * sampleRate), sampleRate);

    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    offlineCtx.startRendering().then((renderedBuffer) => {
      const wavBytes = encodeWAV(renderedBuffer.getChannelData(0), sampleRate);
      const blob = new Blob([wavBytes], { type: 'audio/wav' });
      resolve(blob);
    });
  });
}

/**
 * Encode raw float32 PCM samples into a valid 16-bit PCM WAV byte array
 */
function encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // RIFF chunk length
  view.setUint32(4, 36 + samples.length * 2, true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw PCM = 1)
  view.setUint16(20, 1, true);
  // channel count (1 = mono)
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sampleRate * 1 * 2)
  view.setUint32(28, sampleRate * 2, true);
  // block align (1 * 2)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, samples.length * 2, true);

  // Write the PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
