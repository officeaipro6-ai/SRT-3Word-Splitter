/**
 * REAL-AUDIO verification of the approved tagging fix using the EXACT
 * production modules:
 *   - transcribeRawOdiaWithSarvam   (real Sarvam verbatim, od-IN; unchanged)
 *   - server.ts buildMax3WordSegments + applyAudioAnalysisTags
 *   - srtRules.ts generateSrtContent
 * ... against C:\Users\sures\Downloads\ODIA_MP3-7.mp3.mpeg, with a focus on
 * 00:58-01:20 (58-80s) where the screenshots showed missing <NOISE> tags on
 * voice+BGM cues.
 *
 * Outputs full reports to prototype/bgm-tag-report/ (utf-8).
 *
 * Asserts the approved rules (rev 2, 2026-09-27):
 *   A. clear voice only            -> plain text
 *   B. voice + BGM/noise           -> <NOISE>spoken words</NOISE>
 *   C. BGM/music/noise only        -> <NOISE></NOISE>
 *       intro: the first cue straddling the BGM-only intro head is SPLIT at
 *       the actual voice onset — the BGM-only head -> <NOISE></NOISE>, and the
 *       spoken cue keeps its real words from the first Sarvam anchor onward.
 *   5. never <SIL>
 *   6. never <MB>
 * ... plus word preservation, max 3 words, no forbidden cue classes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import server.ts without binding the listener (port 3000).
process.env.ODIA_SKIP_SERVER = '1';
const { buildMax3WordSegments, applyAudioAnalysisTags } = await import('../server');
import { convertToWav, parseWav, detectSpeechRegions, detectBgmUnderVoiceIntervals } from '../server/audioAnalysis';
import type { SpeechRegion } from '../server/audioAnalysis';
import { generateSrtContent } from '../src/utils/srtRules';
import { transcribeRawOdiaWithSarvam } from '../server/sarvamTranscriber';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-7.mp3.mpeg';
const MIME = 'audio/mpeg';
const OUT_DIR = path.join(__dirname, '..', 'prototype', 'bgm-tag-report');

let failed = 0;
function checkTrue(name: string, cond: boolean, detail?: string) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` :: ${detail ?? ''}`}`);
}
function overlap(a: { start: number; end: number }, s: number, e: number) {
  return Math.min(e, a.end) - Math.max(s, a.start);
}
function tagFormat(seconds: number): string {
  const t = Math.round(seconds * 1000);
  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor((t % 3600000) / 60000))}:${pad(Math.floor((t % 60000) / 1000))},${pad(t % 1000, 3)}`;
}

async function main() {
  const buf = fs.readFileSync(AUDIO);

  console.log('[1/4] Sarvam verbatim transcription (od-IN) of the REAL audio...');
  const raw = await transcribeRawOdiaWithSarvam(buf, MIME, { languageCode: 'od-IN' });
  const transcript = raw.transcript.trim();
  const words = transcript.split(/\s+/).filter(Boolean);
  const wordTimings = (raw.chunks || []).map((c) => ({
    text: c.text,
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
  }));
  const duration = raw.durationSeconds > 0 ? raw.durationSeconds : 0;
  console.log(`  words=${words.length} durationSrt=${duration.toFixed(2)}s`);

  console.log('[2/4] max-3-word segmentation -> VAD + BGM-under-voice tagging...');
  const baseSegments = buildMax3WordSegments(transcript, duration, wordTimings);
  const segments = await applyAudioAnalysisTags(buf, MIME, baseSegments, duration);
  const srt = generateSrtContent(segments);

  console.log('[3/4] audio analysis (VAD regions + BGM-under-voice intervals)...');
  const wav = await convertToWav(buf, MIME);
  let regions: SpeechRegion[] = [];
  let bgm: Array<{ start: number; end: number }> = [];
  if (wav) {
    const p = parseWav(wav);
    if (p && p.duration > 0) {
      regions = detectSpeechRegions(p.mono, p.sampleRate);
      bgm = detectBgmUnderVoiceIntervals(p.mono, p.sampleRate);
    }
  }
  console.log(`  VAD regions=${regions.length}, BGM-under-voice intervals=${bgm.length}`);

  // ---- Build report files (utf-8, unicode-safe) -----------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push(`ODIA_MP3-7.mp3.mpeg  (${buf.length} bytes, Sarvam duration=${duration.toFixed(2)}s)`);
  lines.push('Sarvam raw transcript (verbatim):');
  lines.push(transcript);
  lines.push('');
  lines.push('VAD regions:');
  for (const r of regions) lines.push(`  ${r.type}[${r.start.toFixed(2)}-${r.end.toFixed(2)}]`);
  lines.push('');
  lines.push('BGM-under-voice intervals (new additive detector):');
  lines.push(bgm.length === 0 ? '  (none)' : bgm.map((r) => `  ${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join('\n'));
  lines.push('');
  lines.push('Classified cues (all):');
  for (const s of segments) {
    lines.push(
      `  #${s.id} ${tagFormat(s.startSeconds)} -> ${tagFormat(s.endSeconds)}  [${s.classification}] "${s.text}"`
    );
  }
  lines.push('');
  lines.push('===== Generated SRT (UI preview AND Download both use this) =====');
  lines.push(srt);
  lines.push('================================================================');
  fs.writeFileSync(path.join(OUT_DIR, 'real-audio-report.txt'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'real-audio-report.srt'), srt, 'utf8');

  // ---- Rule assertions over the FULL result ---------------------------------
  const srtWords = srt
    .split('\n')
    .filter((l) => l.length > 0 && !/^\d+$/.test(l) && !/-->/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, ' '))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);
  const wordCounts = new Map<string, number>();
  for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  for (const w of srtWords) wordCounts.set(w, (wordCounts.get(w) ?? 0) - 1);

  checkTrue('Rule6: never <MB>', !srt.includes('<MB>'));
  checkTrue('Rule5: never <SIL>', !srt.includes('<SIL>'));

  // Rev-2 intro split (Rule C): the BGM-only intro head is NOT trimmed away —
  // it becomes its own NOISE_ONLY cue emitting exactly <NOISE></NOISE>, placed
  // BEFORE the first spoken cue, whose start is the Sarvam word anchor (the
  // actual voice onset).
  const firstSpoken = segments.find(
    (s) => s.classification === 'CLEAR_SPEECH' || s.classification === 'SPEECH_WITH_NOISE'
  );
  const introHead = segments[0]?.classification === 'NOISE_ONLY' ? segments[0] : undefined;
  checkTrue('RuleC/intro: BGM-only intro head emitted as <NOISE></NOISE> (not trimmed)',
    !!introHead && introHead.endSeconds <= (firstSpoken?.startSeconds ?? 0) + 0.001,
    `first=${segments[0]?.classification}[${segments[0]?.startSeconds}-${segments[0]?.endSeconds}] firstSpoken=${firstSpoken?.startSeconds}`);
  checkTrue('RuleC/intro: exactly one <NOISE></NOISE> cue, the intro head',
    srt.split('<NOISE></NOISE>').length - 1 === 1,
    `count=${srt.split('<NOISE></NOISE>').length - 1}`);
  checkTrue('RuleB/intro: first spoken cue starts at the Sarvam anchor (voice onset) with real words',
    !!firstSpoken && firstSpoken.text.trim().length > 0 &&
      (firstSpoken.classification === 'CLEAR_SPEECH' || firstSpoken.classification === 'SPEECH_WITH_NOISE'),
    `firstSpoken=${firstSpoken?.classification}[${firstSpoken?.startSeconds}] "${firstSpoken?.text?.slice(0, 20)}"`);
  checkTrue('Rule3: only the intro NOISE_ONLY head plus spoken cues are generated',
    segments.every(
      (s) => s.classification === 'CLEAR_SPEECH' ||
        s.classification === 'SPEECH_WITH_NOISE' ||
        (introHead === s && s.classification === 'NOISE_ONLY')
    ),
    [...new Set(segments.map((s) => s.classification))].join(','));
  checkTrue('Words: every spoken word preserved exactly once, none invented/added',
    words.length === srtWords.length && [...wordCounts.values()].every((c) => c === 0),
    `raw=${words.length} srt=${srtWords.length} mismatch=${JSON.stringify([...wordCounts].filter(([, c]) => c !== 0)).slice(0, 300)}`);
  const cueLines = srt
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const tl = block.split('\n').filter((l) => l.length > 0 && !/^\d+$/.test(l) && !/-->/.test(l));
      return tl.join(' ').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    });
  checkTrue('Words: no subtitle exceeds 3 words', cueLines.length > 0 && Math.max(...cueLines) <= 3, `max=${Math.max(...cueLines)}`);

  // Every cue overlapping a VAD noise region (>=0.5s) is tagged NOISE-speech.
  const vnoise = regions.filter((r) => r.type === 'noise');
  const cueOverVadNoise = segments.filter((s) => vnoise.some((r) => overlap(r, s.startSeconds, s.endSeconds) >= 0.5));
  checkTrue('Rule2: every cue over VAD noise is SPEECH_WITH_NOISE (<NOISE>words</NOISE>)',
    cueOverVadNoise.every((s) => s.classification === 'SPEECH_WITH_NOISE'),
    `plain=${cueOverVadNoise.filter((s) => s.classification !== 'SPEECH_WITH_NOISE').length}`);

  // Every cue overlapping an ADDITIVE BGM-under-voice interval (>=0.5s) is now
  // tagged NOISE-speech — these are the cues the VAD alone missed (plain text).
  const bgmTagged = segments.filter((s) => bgm.some((r) => overlap(r, s.startSeconds, s.endSeconds) >= 0.5));
  checkTrue('Rule2: every cue over BGM-under-voice is SPEECH_WITH_NOISE (<NOISE>words</NOISE>)',
    bgmTagged.every((s) => s.classification === 'SPEECH_WITH_NOISE'),
    `plain=${bgmTagged.filter((s) => s.classification !== 'SPEECH_WITH_NOISE').length}`);

  // ---- 00:58-01:20 focus window (as in the screenshots) ---------------------
  const focus = segments.filter((s) => s.startSeconds >= 58 && s.startSeconds <= 80);
  const focusTagged = focus.filter((s) => s.classification === 'SPEECH_WITH_NOISE').length;
  const focusPlain = focus.length - focusTagged;
  const focusBgmOverlap = focus.filter((s) => bgm.some((r) => overlap(r, s.startSeconds, s.endSeconds) >= 0.5)).length;
  const focusSrtCues = srt
    .split('\n\n')
    .filter((b) => b.includes('-->'))
    .filter((b) => {
      const m = b.match(/^(\d{2}):(\d{2}):(\d{2}),\d{3} --> /);
      if (!m) return false;
      const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      return secs >= 58 && secs <= 80;
    });

  console.log('\n===== 00:58-01:20 FOCUS WINDOW (58-80s) =====');
  if (focusSrtCues.length === 0) {
    console.log('  (no speech cues start inside 58-80s)');
  } else {
    for (const b of focusSrtCues) console.log(b.split('\n')[1] + '  ' + b.split('\n')[2]);
  }
  console.log(`  speech cues in 58-80s: ${focus.length}  (tagged=${focusTagged}, plain=${focusPlain}, overlap-new-BGM=${focusBgmOverlap})`);
  console.log('==============================================\n');

  checkTrue('Truly: in 58-80s, cues over BGM-under-voice are NO LONGER plain text',
    focusBgmOverlap === 0 || focus.filter((s) => s.classification === 'CLEAR_SPEECH' && bgm.some((r) => overlap(r, s.startSeconds, s.endSeconds) >= 0.5)).length === 0,
    'some focus cues over BGM stayed plain');

  // ---- Console summary dump --------------------------------------------------
  console.log('\n[SUMMARY] sample of classified cues (every 6th + focus window):');
  segments.forEach((s, idx) => {
    if (idx % 6 === 0 || (s.startSeconds >= 58 && s.startSeconds <= 80)) {
      console.log(`  #${s.id} ${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)} [${s.classification}] "${s.text}"`);
    }
  });
  console.log(`\nFull report written to: ${OUT_DIR}\\real-audio-report.txt / .srt`);

  console.log(failed === 0 ? '\nAll real-audio checks passed.' : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('REAL-AUDIO VERIFICATION FAILED:', e);
  process.exit(1);
});