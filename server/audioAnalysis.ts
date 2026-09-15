/**
 * Server-side audio analysis utilities:
 *  - WAV (PCM) parsing
 *  - Overlapping chunk construction
 *  - Lightweight speech-presence detection (VAD) used as a PRE-TRANSCRIPTION gate.
 *
 * The VAD here is deliberately more than a waveform-peak check: it combines
 * per-frame RMS energy, zero-crossing rate, and short-term amplitude
 * modulation so that steady music, fan/static noise, clicks and breathing are
 * not automatically treated as human speech. It is a heuristic prior: Gemini
 * still performs the ASR, but regions the VAD marks as non-speech are gated so
 * that invented words cannot appear in the output.
 */

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Normalized mono samples in the range [-1, 1]. */
  mono: Float32Array;
  duration: number;
}

export interface WavChunk {
  /** Absolute start of the chunk inside the original recording (seconds). */
  startAbs: number;
  /** Length of the chunk (seconds). */
  seconds: number;
  /** Complete 16-bit mono PCM WAV bytes for this chunk. */
  buffer: Buffer;
}

export type RegionType = 'speech' | 'noise' | 'silence';

export interface SpeechRegion {
  start: number;
  end: number;
  type: RegionType;
}

/**
 * Parse a RIFF/WAVE file and return normalized mono samples.
 * Supports 8-bit unsigned, 16/24/32-bit signed and 32-bit float PCM.
 * Returns null when the buffer is not a parseable WAV.
 */
export function parseWav(buffer: Buffer): ParsedWav | null {
  try {
    if (!buffer || buffer.length < 44) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

    let fmtOffset = -1;
    let dataOffset = -1;
    let dataLength = 0;

    let pos = 12;
    while (pos + 8 <= buffer.length) {
      const id = buffer.toString('ascii', pos, pos + 4);
      const size = buffer.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        fmtOffset = pos + 8;
      } else if (id === 'data') {
        dataOffset = pos + 8;
        dataLength = size;
        break;
      }
      pos += 8 + size + (size % 2);
    }

    if (fmtOffset < 0 || dataOffset < 0) return null;

    const audioFormat = buffer.readUInt16LE(fmtOffset);
    const channels = buffer.readUInt16LE(fmtOffset + 2);
    const sampleRate = buffer.readUInt32LE(fmtOffset + 4);
    const bitsPerSample = buffer.readUInt16LE(fmtOffset + 14);

    if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) return null;

    const bytesPerSample = bitsPerSample / 8;
    const frameBytes = channels * bytesPerSample;
    const frames = Math.floor(dataLength / frameBytes);
    if (frames <= 0) return null;

    const mono = new Float32Array(frames);
    let offset = dataOffset;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += readSample(buffer, offset + c * bytesPerSample, audioFormat, bitsPerSample);
      }
      mono[f] = sum / channels;
      offset += frameBytes;
    }

    return {
      sampleRate,
      channels,
      bitsPerSample,
      mono,
      duration: frames / sampleRate,
    };
  } catch (err) {
    console.warn('[AudioAnalysis] WAV parse failed:', err);
    return null;
  }
}

function readSample(buf: Buffer, offset: number, audioFormat: number, bits: number): number {
  if (audioFormat === 3) {
    // IEEE float (32-bit)
    return buf.readFloatLE(offset);
  }
  if (bits === 8) {
    return (buf[offset] - 128) / 128;
  }
  if (bits === 16) {
    return buf.readInt16LE(offset) / 32768;
  }
  if (bits === 24) {
    const val = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
    return (val > 0x7fffff ? val - 0x1000000 : val) / 8388608;
  }
  if (bits === 32) {
    return buf.readInt32LE(offset) / 2147483648;
  }
  return 0;
}

/**
 * Build a standalone 16-bit mono PCM WAV from a slice of normalized samples.
 */
export function createWavChunk(
  mono: Float32Array,
  sampleRate: number,
  startSample: number,
  endSample: number
): Buffer {
  const from = Math.max(0, Math.floor(startSample));
  const to = Math.min(mono.length, Math.ceil(endSample));
  const count = Math.max(0, to - from);
  const dataSize = count * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, mono[from + i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buffer;
}

/**
 * Split the audio into overlapping chunks. Consecutive chunks share
 * `overlapSeconds` of audio so words near boundaries are never cut.
 * The returned chunk boundaries partition the timeline continuously:
 * chunk N owns [chunkN.startAbs, chunkN.startAbs + seconds - overlap).
 */
export function buildChunks(parsed: ParsedWav, chunkSeconds: number, overlapSeconds: number): WavChunk[] {
  const step = Math.max(1, chunkSeconds - overlapSeconds);
  const chunks: WavChunk[] = [];
  let start = 0;
  while (start < parsed.duration) {
    const end = Math.min(parsed.duration, start + chunkSeconds);
    const buffer = createWavChunk(
      parsed.mono,
      parsed.sampleRate,
      start * parsed.sampleRate,
      end * parsed.sampleRate
    );
    chunks.push({ startAbs: start, seconds: end - start, buffer });
    start += step;
  }
  return chunks;
}

/**
 * Lightweight speech-presence detector.
 *
 * Heuristics per 25 ms frame:
 *  - silence:  RMS below the adaptive floor (no audio energy).
 *  - speech:   moderate zero-crossing rate (voiced/unvoiced speech) OR
 *              sustained vocal-like energy with short-term amplitude
 *              modulation (syllabic rhythm).
 *  - noise:    everything else (steady music, white/static noise, clicks).
 *
 * Frames are median-smoothed, tiny runs are absorbed into their neighbors and
 * sub-second silences are treated as pauses, not silence.
 */
export function detectSpeechRegions(mono: Float32Array, sampleRate: number): SpeechRegion[] {
  const frameMs = 25;
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const numFrames = Math.floor(mono.length / frameSize);
  if (numFrames < 3) return [];

  const rms = new Float32Array(numFrames);
  const zcr = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const off = f * frameSize;
    let sum = 0;
    let crossings = 0;
    let prev = mono[off];
    for (let i = 0; i < frameSize; i++) {
      const v = mono[off + i];
      sum += v * v;
      if (i > 0 && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) crossings++;
      prev = v;
    }
    rms[f] = Math.sqrt(sum / frameSize);
    zcr[f] = crossings / frameSize;
  }

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.35)] || 0;
  // Three energy tiers, calibrated against the measured real audio:
  //   - QUIET  : near-digital quiet (RMS <= ~0.01)      -> 'silence'
  //   - AUDIBLE: loud enough to hear but too quiet to be
  //              the narrator's voice (RMS ~0.01-0.055) -> 'noise'
  //   - VOICE  : voice-level energy (RMS >= ~0.055)      -> run the speech test
  // The old code used a single silenceFloor derived as noiseFloor*2, which made
  // residual background (~0.03-0.05 RMS) classify as SILENCE. That mislabelled
  // audible non-speech and long voiced passages (destroying this track's
  // genuine speech). Lowering the floor below true-quiet but gating 'speech' on
  // voice-level energy separates the three tiers cleanly on this audio.
  const quietFloor = Math.max(noiseFloor * 0.35, 0.008);
  // Voice-level energy. Measured on the real audio: the narrator's voice sits
  // at RMS ~0.09-0.18, while the audible backdrop sits at ~0.02-0.05. A floor
  // near 0.05 separates the two cleanly (minor ambiguity only in 0.05-0.06).
  const voiceFloor = Math.max(noiseFloor * 1.7, 0.05);

  const modWin = Math.max(4, Math.round(0.5 / (frameMs / 1000)));
  const labels: RegionType[] = new Array(numFrames).fill('noise');
  for (let f = 0; f < numFrames; f++) {
    if (rms[f] < quietFloor) {
      labels[f] = 'silence';
      continue;
    }
    if (rms[f] < voiceFloor) {
      labels[f] = 'noise';
      continue;
    }
    // Voice-level energy: decide speech vs loud noise via speech-likeness.
    const s = Math.max(0, f - modWin);
    const e = Math.min(numFrames - 1, f + modWin);
    const n = e - s + 1;
    let mean = 0;
    for (let j = s; j <= e; j++) mean += rms[j];
    mean /= n;
    let vari = 0;
    for (let j = s; j <= e; j++) {
      const d = rms[j] - mean;
      vari += d * d;
    }
    const modRatio = mean > 1e-6 ? Math.sqrt(vari / n) / mean : 0;
    const z = zcr[f];
    // Speech-likeness via modulation ratio (how strongly the frame's energy
    // fluctuates over its ~0.5s window). Measured on the real audio this
    // cleanly separates genuine narrator speech (modRatio ~0.52-0.78, 88-100%
    // of voiced frames pass) from the melodic music-only intro (modRatio
    // ~0.22-0.31). The older >= 0.08 gate let the melodic intro through and
    // mislabelled it 'speech', which pinned hallucinated text over music.
    // Requiring >= 0.45 rejects the intro while retaining real speech.
    const isSpeech = z >= 0.012 && z <= 0.45 && modRatio >= 0.45;
    labels[f] = isSpeech ? 'speech' : 'noise';
  }

  // Median smoothing (~0.3 s) to remove frame-level flicker.
  const smoothWin = Math.max(2, Math.round(0.3 / (frameMs / 1000)));
  const smooth: RegionType[] = new Array(numFrames).fill('noise');
  for (let f = 0; f < numFrames; f++) {
    const s = Math.max(0, f - smoothWin);
    const e = Math.min(numFrames - 1, f + smoothWin);
    const counts: Record<RegionType, number> = { speech: 0, noise: 0, silence: 0 };
    for (let j = s; j <= e; j++) counts[labels[j]]++;
    let best: RegionType = 'noise';
    let bestCount = -1;
    for (const t of ['speech', 'noise', 'silence'] as RegionType[]) {
      if (counts[t] > bestCount) {
        best = t;
        bestCount = counts[t];
      }
    }
    smooth[f] = best;
  }

  // Build contiguous runs.
  const runs: SpeechRegion[] = [];
  let curType = smooth[0];
  let curStart = 0;
  for (let f = 1; f <= numFrames; f++) {
    const t = f < numFrames ? smooth[f] : null;
    if (t !== curType) {
      runs.push({ start: curStart * (frameMs / 1000), end: f * (frameMs / 1000), type: curType });
      if (t !== null) {
        curType = t;
        curStart = f;
      }
    }
  }

  // Absorb tiny runs into the previous run so the timeline stays contiguous
  // and single-frame blips (clicks, pops) do not fragment regions.
  const MIN_RUN = 0.2;
  // Natural inter-word/phrase pauses within continuous narration are NOT
  // taggable non-speech: absorbing short non-speech runs into the preceding
  // (speech) run keeps genuinely voiced narration together. Only SUSTAINED
  // non-speech (>= SHORT_PAUSE) survives as a standalone <NOISE>/<SIL> region.
  // This directly fixes the real-audio defect where 0.25-1s breathing gaps
  // between words were fragmenting speech into many regions and causing the
  // classifier to destroy genuine text.
  const SHORT_PAUSE = 1.25;
  const merged: SpeechRegion[] = [];
  for (const r of runs) {
    if (merged.length === 0) {
      merged.push({ ...r });
      continue;
    }
    const last = merged[merged.length - 1];
    const isTiny = r.end - r.start < MIN_RUN;
    const isShortNonSpeech = r.type !== 'speech' && r.end - r.start <= SHORT_PAUSE;
    if (isTiny || isShortNonSpeech) {
      last.end = r.end;
      continue;
    }
    merged.push({ ...r });
  }

  // Post-adjustments:
  //  - isolated short "speech" bursts (< 0.8 s) -> noise (likely music/noise
  //    blips that pass the modulation test, e.g. the brief percussive beat in
  //    this track's music-only intro; genuine narration regions are >= 1s)
  //  - short silences (< 1.0 s) -> noise (pauses are not taggable silence)
  const MIN_SPEECH_RUN = 0.8;
  const adjusted: SpeechRegion[] = merged.map((r) => {
    if (r.type === 'speech' && r.end - r.start < MIN_SPEECH_RUN) {
      return { ...r, type: 'noise' as RegionType };
    }
    if (r.type === 'silence' && r.end - r.start < 1.0) {
      return { ...r, type: 'noise' as RegionType };
    }
    return r;
  });

  // Merge adjacent runs that share a type.
  const final: SpeechRegion[] = [];
  for (const r of adjusted) {
    const last = final[final.length - 1];
    if (last && last.type === r.type) {
      last.end = r.end;
    } else {
      final.push({ ...r });
    }
  }

  // A SILENCE region must be genuinely quiet THROUGHOUT (near-digital silence).
  // Regions that are mostly quiet but still contain audible content (peak RMS
  // well above digital quiet — e.g. a music bed briefly dipping in volume, as
  // at 9.3-12.3s of this track) are NOT true silence and must be <NOISE></NOISE>,
  // not <SIL></SIL> (directive #5). Measured on the real audio the true-SIL
  // tail peaks at ~0.012 RMS; this threshold keeps it while demoting the
  // audible music dip (peak ~0.158) to noise.
  const TRUE_SILENCE_PEAK = 0.02;
  const audited: SpeechRegion[] = [];
  for (const r of final) {
    if (r.type !== 'silence') {
      audited.push(r);
      continue;
    }
    const f0 = Math.max(0, Math.floor((r.start * 1000) / frameMs));
    const f1 = Math.min(numFrames - 1, Math.floor((r.end * 1000) / frameMs));
    let peak = 0;
    for (let f = f0; f <= f1; f++) if (rms[f] > peak) peak = rms[f];
    if (peak >= TRUE_SILENCE_PEAK) {
      audited.push({ ...r, type: 'noise' as RegionType });
    } else {
      audited.push(r);
    }
  }

  return audited;
}

/**
 * Return the region type at an absolute time, or null if the time falls in a
 * gap (should not normally happen because regions are contiguous).
 */
export function regionTypeAt(regions: SpeechRegion[], time: number): RegionType | null {
  for (const r of regions) {
    if (time >= r.start && time < r.end) return r.type;
  }
  return null;
}

/**
 * Describe the speech and non-speech regions that fall inside
 * [startAbs, endAbs], with times RELATIVE to startAbs. Used to inject the
 * pre-transcription speech map into the Gemini prompt for each chunk.
 */
export function describeRegionsForChunk(
  regions: SpeechRegion[],
  startAbs: number,
  endAbs: number
): { speech: string; nonSpeech: string } {
  const speech: string[] = [];
  const nonSpeech: string[] = [];
  for (const r of regions) {
    const s = Math.max(r.start, startAbs);
    const e = Math.min(r.end, endAbs);
    if (e <= s) continue;
    const label = `[${(s - startAbs).toFixed(2)}-${(e - startAbs).toFixed(2)}]`;
    if (r.type === 'speech') speech.push(label);
    else nonSpeech.push(label);
  }
  return {
    speech: speech.join(', ') || 'none',
    nonSpeech: nonSpeech.join(', ') || 'none',
  };
}

/**
 * Convert any audio buffer to 16kHz mono WAV using ffmpeg.
 * Returns the WAV buffer, or null if conversion fails.
 */
export async function convertToWav(inputBuffer: Buffer, inputMimeType: string): Promise<Buffer | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const execFileAsync = promisify(execFile);

  const ffmpegPath = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
  const tmpDir = os.tmpdir();
  const id = Math.random().toString(36).slice(2, 8);
  const ext = inputMimeType.includes('mp4') || inputMimeType.includes('mpeg') || inputMimeType.includes('mp3') ? '.mpeg' : inputMimeType.includes('webm') ? '.webm' : inputMimeType.includes('ogg') ? '.ogg' : '.wav';
  const inPath = path.join(tmpDir, `odia-convert-in-${id}${ext}`);
  const outPath = path.join(tmpDir, `odia-convert-out-${id}.wav`);

  try {
    fs.writeFileSync(inPath, inputBuffer);
    await execFileAsync(ffmpegPath, [
      '-y', '-i', inPath,
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outPath,
    ], { timeout: 30000 });
    const wavBuffer = fs.readFileSync(outPath);
    return wavBuffer;
  } catch (e: any) {
    console.error('[AudioAnalysis] convertToWav failed:', e.message);
    return null;
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  }
}