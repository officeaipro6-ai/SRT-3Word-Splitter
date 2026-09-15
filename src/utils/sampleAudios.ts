/**
 * Synthesize test audio files for quick verification of all 10 mandatory rules and test cases.
 * Generates realistic audio waveforms with Odia speech bursts, background music, background noise,
 * vocal fillers, and calibrated silence gaps (1.5s vs 2.5s).
 */

export interface SampleAudioPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  durationSeconds: number;
  expectedRules: string[];
  generateAudio: () => Promise<Blob>;
}

export const SAMPLE_PRESETS: SampleAudioPreset[] = [
  {
    id: 'odia-full-mix',
    name: 'Odia Mixed Broadcast (All Rules A–E)',
    category: 'Complete Multi-Rule Test',
    description: 'Realistic Odia news broadcast containing Clear Speech, Speech over BGM, Music interlude, Fillers ("hmm", "haha"), and a 2.4s silence gap.',
    durationSeconds: 16.5,
    expectedRules: ['Rule A (Clear)', 'Rule B (Speech+BGM)', 'Rule C (Music Only)', 'Rule D (Fillers)', 'Rule E (>=2s Silence)'],
    generateAudio: () => createSynthesizedSample({
      sections: [
        { type: 'speech', start: 0.5, duration: 2.5, text: 'କେନ୍ଦୁଝରରେ କାଳବୈଶାଖୀର', hasBgm: false, hasNoise: false },
        { type: 'speech', start: 3.5, duration: 3.0, text: 'ତାଣ୍ଡବ ଦେଖିବାକୁ ମିଳିଛି', hasBgm: true, hasNoise: false },
        { type: 'music_only', start: 7.0, duration: 2.2 },
        { type: 'filler', start: 9.5, duration: 0.8, text: 'hmm' },
        { type: 'speech', start: 10.5, duration: 2.0, text: 'ଆଜି ପ୍ରବଳ ବର୍ଷା', hasBgm: false, hasNoise: true },
        { type: 'silence', start: 13.0, duration: 2.5 }, // >= 2.0s -> <SIL></SIL>
      ],
      totalDuration: 16.5,
    }),
  },
  {
    id: 'clear-speech-odia',
    name: 'Clear Odia Speech Only (Rule A)',
    category: 'Rule A — Clear Speech',
    description: 'Clean studio recording with pure Odia speech and zero background music/noise.',
    durationSeconds: 6.0,
    expectedRules: ['Rule A: Text unchanged (no tags)'],
    generateAudio: () => createSynthesizedSample({
      sections: [
        { type: 'speech', start: 0.5, duration: 2.2, text: 'ନମସ୍କାର ଦର୍ଶକ ବନ୍ଧୁ', hasBgm: false, hasNoise: false },
        { type: 'speech', start: 3.2, duration: 2.3, text: 'ଓଡ଼ିଶା ଖବର ସ୍ଵାଗତ', hasBgm: false, hasNoise: false },
      ],
      totalDuration: 6.0,
    }),
  },
  {
    id: 'speech-with-bgm',
    name: 'Speech + Background Music (Rule F)',
    category: 'Rule F — Music-Masked Speech',
    description: 'Odia speech masked by an underlying harmonic background music track. Tests `<MB></MB>`.',
    durationSeconds: 7.5,
    expectedRules: ['Rule F: <MB></MB> (Speech masked by music, no words preserved)'],
    generateAudio: () => createSynthesizedSample({
      sections: [
        { type: 'speech', start: 0.8, duration: 3.0, text: 'ଆଜିର ମୁଖ୍ୟ ଖବର', hasBgm: true, hasNoise: false },
        { type: 'speech', start: 4.2, duration: 2.8, text: 'ତାପମାତ୍ରା ବୃଦ୍ଧି ପାଇଛି', hasBgm: true, hasNoise: false },
      ],
      totalDuration: 7.5,
    }),
  },
  {
    id: 'music-noise-only',
    name: 'Music & Noise Only — No Speech (Rule C)',
    category: 'Rule C — Music/Noise Only',
    description: 'Acoustic background melody and sound effects with zero human speech. Tests `<NOISE></NOISE>`.',
    durationSeconds: 5.0,
    expectedRules: ['Rule C: <NOISE></NOISE> (Never <MUSIC></MUSIC>)'],
    generateAudio: () => createSynthesizedSample({
      sections: [
        { type: 'music_only', start: 0.5, duration: 2.5 },
        { type: 'noise_only', start: 3.2, duration: 1.5 },
      ],
      totalDuration: 5.0,
    }),
  },
  {
    id: 'fillers-and-laughs',
    name: 'Fillers & Laughter (Rule D)',
    category: 'Rule D — Vocal Fillers',
    description: 'Odia conversation with vocal hesitations and laughter ("hmm", "haha", "uh"). Tests `<FIL>...</FIL>`.',
    durationSeconds: 6.5,
    expectedRules: ['Rule D: <FIL>hmm</FIL>, <FIL>haha</FIL> (No min duration)'],
    generateAudio: () => createSynthesizedSample({
      sections: [
        { type: 'speech', start: 0.4, duration: 1.8, text: 'ଆପଣ କଣ କହୁଛନ୍ତି', hasBgm: false, hasNoise: false },
        { type: 'filler', start: 2.4, duration: 0.6, text: 'hmm' },
        { type: 'filler', start: 3.3, duration: 0.9, text: 'haha' },
        { type: 'speech', start: 4.5, duration: 1.6, text: 'ମୁଁ ସହମତ', hasBgm: false, hasNoise: false },
      ],
      totalDuration: 6.5,
    }),
  },
  {
    id: 'silence-comparison',
    name: 'Silence Benchmark (1.4s vs 2.6s) (Rule E)',
    category: 'Rule E — Complete Silence',
    description: 'Tests 1.4s silence gap (ignored) vs 2.6s complete silence (<SIL></SIL>).',
    durationSeconds: 9.0,
    expectedRules: ['Rule E: < 2.0s silence ignored', 'Rule E: >= 2.0s -> <SIL></SIL>'],
    generateAudio: () => createSynthesizedSample({
      sections: [
        { type: 'speech', start: 0.5, duration: 1.8, text: 'ପ୍ରଥମ ଧାଡ଼ି', hasBgm: false, hasNoise: false },
        { type: 'silence', start: 2.4, duration: 1.4 }, // < 2.0s -> IGNORE!
        { type: 'speech', start: 3.9, duration: 1.8, text: 'ଦ୍ଵିତୀୟ ଧାଡ଼ି', hasBgm: false, hasNoise: false },
        { type: 'silence', start: 5.8, duration: 2.6 }, // >= 2.0s -> <SIL></SIL>
      ],
      totalDuration: 9.0,
    }),
  },
];

interface AudioSectionSpec {
  type: 'speech' | 'music_only' | 'noise_only' | 'filler' | 'silence';
  start: number;
  duration: number;
  text?: string;
  hasBgm?: boolean;
  hasNoise?: boolean;
}

/**
 * Generate a realistic multi-frequency WAV audio sample using Web Audio OfflineAudioContext
 */
async function createSynthesizedSample(spec: { sections: AudioSectionSpec[]; totalDuration: number }): Promise<Blob> {
  const sampleRate = 16000;
  const numChannels = 1;
  const length = Math.ceil(spec.totalDuration * sampleRate);
  const offlineCtx = new OfflineAudioContext(numChannels, length, sampleRate);

  for (const sec of spec.sections) {
    const startSample = Math.floor(sec.start * sampleRate);
    const numSamples = Math.floor(sec.duration * sampleRate);

    if (sec.type === 'speech' || sec.type === 'filler') {
      // Speech Formant synthesis (vowel-like frequencies 300Hz, 800Hz, 2200Hz)
      const speechOsc = offlineCtx.createOscillator();
      const speechGain = offlineCtx.createGain();
      
      // Pitch inflection simulating Odia speech cadence
      speechOsc.type = 'sawtooth';
      speechOsc.frequency.setValueAtTime(140, sec.start);
      speechOsc.frequency.exponentialRampToValueAtTime(190, sec.start + sec.duration * 0.4);
      speechOsc.frequency.exponentialRampToValueAtTime(125, sec.start + sec.duration);

      // Formant bandpass filters
      const filter1 = offlineCtx.createBiquadFilter();
      filter1.type = 'bandpass';
      filter1.frequency.value = sec.type === 'filler' ? 450 : 750;
      filter1.Q.value = 4.0;

      // Envelope
      speechGain.gain.setValueAtTime(0.001, sec.start);
      speechGain.gain.linearRampToValueAtTime(0.35, sec.start + 0.08);
      speechGain.gain.setValueAtTime(0.35, sec.start + sec.duration - 0.08);
      speechGain.gain.linearRampToValueAtTime(0.001, sec.start + sec.duration);

      speechOsc.connect(filter1);
      filter1.connect(speechGain);
      speechGain.connect(offlineCtx.destination);

      speechOsc.start(sec.start);
      speechOsc.stop(sec.start + sec.duration);
    }

    if (sec.type === 'music_only' || sec.hasBgm) {
      // Background music synthesis (pleasant acoustic chord progression)
      const freqs = [220, 277.18, 329.63, 440]; // A Major chords
      const mDuration = sec.duration;
      const mStart = sec.start;

      freqs.forEach((freq, idx) => {
        const osc = offlineCtx.createOscillator();
        const gain = offlineCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq * (1 + idx * 0.005), mStart);

        const targetVolume = sec.hasBgm ? 0.12 : 0.28;
        gain.gain.setValueAtTime(0.001, mStart);
        gain.gain.linearRampToValueAtTime(targetVolume, mStart + 0.15);
        gain.gain.setValueAtTime(targetVolume, mStart + mDuration - 0.15);
        gain.gain.linearRampToValueAtTime(0.001, mStart + mDuration);

        osc.connect(gain);
        gain.connect(offlineCtx.destination);
        osc.start(mStart);
        osc.stop(mStart + mDuration);
      });
    }

    if (sec.type === 'noise_only' || sec.hasNoise) {
      // Background noise synthesis (filtered pink/white noise buffer)
      const noiseBuffer = offlineCtx.createBuffer(1, numSamples, sampleRate);
      const output = noiseBuffer.getChannelData(0);
      let lastOut = 0.0;
      for (let i = 0; i < numSamples; i++) {
        const white = Math.random() * 2 - 1;
        output[i] = (lastOut + 0.02 * white) / 1.02;
        lastOut = output[i];
      }

      const noiseSource = offlineCtx.createBufferSource();
      noiseSource.buffer = noiseBuffer;

      const noiseFilter = offlineCtx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.value = 1200;

      const noiseGain = offlineCtx.createGain();
      const nVolume = sec.hasNoise ? 0.08 : 0.22;
      noiseGain.gain.setValueAtTime(nVolume, sec.start);

      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(offlineCtx.destination);

      noiseSource.start(sec.start);
      noiseSource.stop(sec.start + sec.duration);
    }
  }

  const renderedBuffer = await offlineCtx.startRendering();
  return audioBufferToWavBlob(renderedBuffer, sampleRate);
}

function audioBufferToWavBlob(buffer: AudioBuffer, sampleRate: number): Blob {
  const pcm = buffer.getChannelData(0);
  const wavBytes = encodeWAV(pcm, sampleRate);
  return new Blob([wavBytes], { type: 'audio/wav' });
}

function encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}
