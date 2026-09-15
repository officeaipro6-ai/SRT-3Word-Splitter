import dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import { parseWav, detectSpeechRegions, buildChunks, regionTypeAt } from '../server/audioAnalysis';
import { transcribeWithWhisper } from '../server/groqTranscriber';
import { applyTaggingRule, formatSrtTimestamp, enforceMaxWordsPerSegment, generateSrtContent } from '../src/utils/srtRules';

const WAV_PATH = String.raw`C:\Users\sures\AppData\Local\Temp\opencode\ODIA_MP3-3-16k-mono.wav`;
const WINDOW_START = 10;
const WINDOW_END = 40;
const LONG_AUDIO_CHUNK_SECONDS = 30;
const CHUNK_OVERLAP_SECONDS = 2;
const SINGLE_CALL_MAX_SECONDS = 45;

function f(n: number) { return n.toFixed(3); }

async function main() {
  const audioBuffer = fs.readFileSync(WAV_PATH);
  const parsed = parseWav(audioBuffer)!;
  const regions = detectSpeechRegions(parsed.mono, parsed.sampleRate);
  const duration = parsed.duration;

  const SPEECH_CLASSES = new Set(['CLEAR_SPEECH','SPEECH_WITH_MUSIC','SPEECH_WITH_NOISE','FILLER','LAUGH']);

  function stripApo(t: string): string { return t.replace(/'/g,'').replace(/\u2019/g,'').replace(/\u2018/g,''); }

  function overlapFrac(a:{start:number;end:number}, pred:(t:string)=>boolean): number {
    if (a.end <= a.start) return 0;
    let total = 0;
    for (const r of regions) { if (!pred(r.type)) continue; const s = Math.max(a.start,r.start), e = Math.min(a.end,r.end); if (e>s) total += e-s; }
    return Math.min(1, total / (a.end - a.start));
  }

  function maxOverlapAtom(atomList:Array<{start:number;end:number}>, r:{start:number;end:number}): number {
    let mx = 0;
    for (const a of atomList) { if (a.end<=a.start) continue; const s=Math.max(a.start,r.start), e=Math.min(a.end,r.end); if (e>s) mx=Math.max(mx,(e-s)/(r.end-r.start)); }
    return mx;
  }

  console.log('=== AUDIO ===');
  console.log(`Duration: ${duration.toFixed(2)}s, sampleRate=${parsed.sampleRate}`);

  // VAD
  const windowRegions = regions.filter(r => r.end > WINDOW_START && r.start < WINDOW_END);
  console.log(`\n=== VAD REGIONS (${WINDOW_START}-${WINDOW_END}s): ${windowRegions.length} ===`);
  for (const r of windowRegions) {
    const tag = r.type==='speech'?'SPK':r.type==='noise'?'NSE':'SIL';
    console.log(`  ${f(r.start)}->${f(r.end)} ${tag} ${(r.end-r.start).toFixed(3)}s`);
  }

  // Chunks
  const chunkSec = duration > SINGLE_CALL_MAX_SECONDS ? LONG_AUDIO_CHUNK_SECONDS : duration;
  const chunks = buildChunks(parsed, chunkSec, CHUNK_OVERLAP_SECONDS);
  console.log(`\nChunks: ${chunks.length} of ~${chunkSec}s, overlap=${CHUNK_OVERLAP_SECONDS}s`);

  const allAtoms: any[] = [];
  let cursor = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const keepUntil = ci < chunks.length - 1
      ? chunk.startAbs + chunk.seconds - CHUNK_OVERLAP_SECONDS
      : chunk.startAbs + chunk.seconds;

    const inWindowStart = keepUntil > WINDOW_START && chunk.startAbs < WINDOW_END;
    if (!inWindowStart && chunk.startAbs >= WINDOW_END) break;
    if (!inWindowStart && keepUntil <= WINDOW_START) { cursor = keepUntil; continue; }

    console.log(`\n=== CHUNK ${ci+1}/${chunks.length} offset=${f(chunk.startAbs)} keepUntil=${f(keepUntil)} ===`);

    const whisperResult = await transcribeWithWhisper(chunk.buffer, 'audio/wav', 'or', chunk.startAbs);

    const wSegs = whisperResult.segments.filter(s => s.endSeconds > WINDOW_START && s.startSeconds < WINDOW_END);
    console.log(`Whisper segments in window: ${wSegs.length}`);
    for (const s of wSegs) {
      const wc = (s.words||[]).map(w => `"${stripApo(w.word)}" ${w.startSeconds.toFixed(2)}-${w.endSeconds.toFixed(2)}`).join(', ');
      console.log(`  [${f(s.startSeconds)}-${f(s.endSeconds)}] "${s.text}" words=[${wc}]`);
    }

    // Classify each Whisper segment
    const longSilences = regions.filter(r => r.type === 'silence' && r.end - r.start >= 2.0);
    const classified = whisperResult.segments.map(seg => {
      const segDur = seg.endSeconds - seg.startSeconds;
      let spkOv=0, nseOv=0, musOv=0, lsOv=0;
      for (const r of regions) {
        const s2=Math.max(seg.startSeconds,r.start), e2=Math.min(seg.endSeconds,r.end);
        if(e2<=s2) continue;
        if(r.type==='speech') spkOv+=(e2-s2);
        else if(r.type==='noise') nseOv+=(e2-s2);
        else if(r.type==='silence') { if(longSilences.some(ls=>r.start>=ls.start&&r.end<=ls.end)) lsOv+=(e2-s2); }
      }
      for(const ls of longSilences){const s2=Math.max(seg.startSeconds,ls.start),e2=Math.min(seg.endSeconds,ls.end);if(e2>s2)lsOv+=e2-s2;}
      const spkF=segDur>0?spkOv/segDur:0, nseF=segDur>0?nseOv/segDur:0, lsF=segDur>0?lsOv/segDur:0, musF=segDur>0?musOv/segDur:0;

      let cls: string;
      if(seg.text.trim().length===0){
        if(lsF>=0.6&&segDur>=2.0) cls='SILENCE';
        else if(nseF>=0.5||musF>=0.5) cls='NOISE_ONLY';
        else cls='NOISE_ONLY';
      } else {
        if(spkF>=0.5){if(musF>0.3)cls='SPEECH_WITH_MUSIC';else if(nseF>0.3)cls='SPEECH_WITH_NOISE';else cls='CLEAR_SPEECH';}
        else if(spkF>=0.3) cls='CLEAR_SPEECH';
        else cls='CLEAR_SPEECH';
      }
      return { ...seg, classification:cls, spkF, nseF, lsF, musF };
    });

    // Print classification table for window
    const clsWindow = classified.filter(s => s.endSeconds > WINDOW_START && s.startSeconds < WINDOW_END);
    if (clsWindow.length > 0) {
      console.log(`\n  CLASSIFY TABLE:`);
      console.log(`  ${'segment'.padEnd(25)} ${'spkFrac'.padEnd(8)} ${'nseFrac'.padEnd(8)} ${'classification'.padEnd(22)} text`);
      for (const s of clsWindow) {
        const dur = (s.endSeconds-s.startSeconds).toFixed(1);
        console.log(`  [${f(s.startSeconds)}-${f(s.endSeconds)}] ${s.spkF.toFixed(3).padEnd(8)} ${s.nseF.toFixed(3).padEnd(8)} ${s.classification.padEnd(22)} "${s.text.slice(0,25)}"`);
      }
    }

    // toAtom
    for (const raw of classified) {
      const text = stripApo((raw.text||'').trim());
      let startSec = Number(raw.startSeconds), endSec = Number(raw.endSeconds);
      if(!Number.isFinite(startSec)||!Number.isFinite(endSec)) continue;
      const wts: Array<{word:string;startSeconds:number;endSeconds:number}> = [];
      if(Array.isArray(raw.words)){
        for(const w of raw.words){const ws=Number(w?.startSeconds),we=Number(w?.endSeconds);if(typeof w?.word==='string'&&Number.isFinite(ws)&&Number.isFinite(we))wts.push({word:stripApo(w.word),startSeconds:ws,endSeconds:we});}
      }
      if(SPEECH_CLASSES.has(raw.classification)&&wts.length>0){startSec=Math.min(...wts.map(w=>w.startSeconds));endSec=Math.max(...wts.map(w=>w.endSeconds));endSec=Math.max(endSec,startSec+0.001);}
      const atom={start:startSec,end:endSec,text,classification:raw.classification,wordTimings:wts.length>0?wts:undefined};
      if(atom.start<cursor) continue;
      if(atom.start>=keepUntil) continue;
      allAtoms.push(atom);
    }
    cursor = keepUntil;
  }

  // Show all atoms in window
  const wAtoms = allAtoms.filter(a => a.end > WINDOW_START && a.start < WINDOW_END);
  console.log(`\n=== ALL ATOMS (before gating): ${wAtoms.length} in window ===`);
  for (const a of wAtoms) {
    const spkF = overlapFrac(a, t => t==='speech');
    const nseF = overlapFrac(a, t => t==='noise');
    console.log(`  [${f(a.start)}-${f(a.end)}] cls=${a.classification.padEnd(20)} spkF=${spkF.toFixed(3)} nseF=${nseF.toFixed(3)} text="${a.text.slice(0,30)}"`);
    if(a.wordTimings&&a.wordTimings.length>0) console.log(`    words=[${a.wordTimings.map((w:any)=>`"${w.word}" ${w.startSeconds.toFixed(2)}-${w.endSeconds.toFixed(2)}`).join(', ')}]`);
  }

  // Apply gating
  console.log(`\n=== APPLY GATING ===`);
  for (const a of allAtoms) {
    if (a.end <= a.start) continue;
    const before = a.classification;
    const beforeText = a.text.slice(0,20);
    if (SPEECH_CLASSES.has(a.classification)) {
      if (a.text.length > 0) {
        const spkF = overlapFrac(a, t => t==='speech');
        // Replicate the isLongUnsplit guard from geminiOdiaPipeline.ts
        const dur = a.end - a.start;
        const hasWt = a.wordTimings && a.wordTimings.length > 0;
        let isSyntheticTimings = false;
        if (hasWt && a.wordTimings!.length > 1 && dur > 5) {
          const firstStart = a.wordTimings![0].startSeconds;
          const lastEnd = a.wordTimings![a.wordTimings!.length - 1].endSeconds;
          const wordSpan = lastEnd - firstStart;
          if (wordSpan / dur > 0.8) isSyntheticTimings = true;
        }
        const isLongUnsplit = dur > 10 && (!hasWt || isSyntheticTimings);
        if (spkF < 0.4 && !isLongUnsplit) {
          const lsF = overlapFrac(a, t => true);
          if (lsF >= 0.6 && dur >= 2.0) { a.classification = 'SILENCE'; a.text = ''; }
          else { a.classification = 'NOISE_ONLY'; a.text = ''; }
        }
      } else {
        const spkF = overlapFrac(a, t => t==='speech');
        if (spkF >= 0.5) a.classification = 'UNINTELLIGIBLE_SPEECH';
        else a.classification = 'NOISE_ONLY';
        a.text = '';
      }
    }
    const inW = a.end > WINDOW_START && a.start < WINDOW_END;
    if (inW && before !== a.classification) {
      console.log(`  GATED [${f(a.start)}-${f(a.end)}]: ${before} -> ${a.classification} text="${beforeText}" -> "${a.text.slice(0,20)}" spkF=${overlapFrac(a,t=>t==='speech').toFixed(3)}`);
    }
  }

  const gatedW = allAtoms.filter(a => a.end > WINDOW_START && a.start < WINDOW_END);
  console.log(`\nAtoms after gating (window): ${gatedW.length}`);
  for (const a of gatedW) {
    console.log(`  [${f(a.start)}-${f(a.end)}] cls=${a.classification.padEnd(20)} text="${a.text.slice(0,30)}"`);
  }

  // Add region coverage
  console.log(`\n=== ADD REGION COVERAGE ===`);
  const result = [...allAtoms];
  let added = 0;
  for (const r of regions) {
    if (r.end - r.start < 0.05) continue;
    const cov = maxOverlapAtom(result, r) >= 0.4;
    if (cov) continue;
    if (r.type === 'speech' && r.end - r.start >= 0.8) {
      result.push({ start: r.start, end: r.end, text: '', classification: 'UNINTELLIGIBLE_SPEECH' });
      if (r.start >= WINDOW_START && r.start < WINDOW_END) { console.log(`  ADDED [${f(r.start)}-${f(r.end)}] UNINTELLIGIBLE_SPEECH`); added++; }
    } else if (r.type === 'noise') {
      result.push({ start: r.start, end: r.end, text: '', classification: 'NOISE_ONLY' });
      if (r.start >= WINDOW_START && r.start < WINDOW_END) { console.log(`  ADDED [${f(r.start)}-${f(r.end)}] NOISE_ONLY`); added++; }
    } else if (r.type === 'silence' && r.end - r.start >= 2.0) {
      result.push({ start: r.start, end: r.end, text: '', classification: 'SILENCE' });
    }
  }
  console.log(`Added ${added} coverage atoms in window`);

  // Sort and resolve
  console.log(`\n=== SORT & RESOLVE ===`);
  const valid = result.filter(a => Number.isFinite(a.start) && Number.isFinite(a.end) && a.start >= 0 && a.end > a.start && a.end <= duration + 0.05);
  valid.sort((a: any, b: any) => a.start - b.start || a.end - b.end);
  const resolved: any[] = [];
  for (const a of valid) {
    const prev = resolved[resolved.length - 1];
    if (prev && a.start < prev.end) {
      const aIsSpk = SPEECH_CLASSES.has(a.classification) && a.text.length > 0;
      const pIsSpk = SPEECH_CLASSES.has(prev.classification) && prev.text.length > 0;
      if (!aIsSpk) a.start = Math.max(a.start, prev.end);
      else if (!pIsSpk) prev.end = Math.min(prev.end, a.start);
      if (a.end <= a.start) continue;
    }
    resolved.push(a);
  }
  const resW = resolved.filter((a:any) => a.end > WINDOW_START && a.start < WINDOW_END);
  console.log(`Resolved atoms (window): ${resW.length}`);
  for (const a of resW) {
    console.log(`  [${f(a.start)}-${f(a.end)}] cls=${a.classification.padEnd(20)} text="${a.text.slice(0,30)}"`);
  }

  // Atoms to segments
  console.log(`\n=== ATOMS -> SEGMENTS (applyTaggingRule) ===`);
  let cid = 1;
  const segs: any[] = [];
  for (const a of resolved) {
    let ss = a.start, es = a.end;
    if (SPEECH_CLASSES.has(a.classification) && a.wordTimings && a.wordTimings.length > 0) {
      ss = Math.max(0, Math.min(...a.wordTimings.map((w:any)=>w.startSeconds)));
      es = Math.max(...a.wordTimings.map((w:any)=>w.endSeconds));
      es = Math.max(es, ss + 0.001);
    }
    const { taggedText } = applyTaggingRule(a.text, a.classification, es - ss);
    segs.push({ id:cid++, startSeconds:ss, endSeconds:es, startTimeFormatted:formatSrtTimestamp(ss), endTimeFormatted:formatSrtTimestamp(es), text:a.text, classification:a.classification, taggedText, wordTimings:a.wordTimings||[] });
  }
  const segW = segs.filter((s:any) => s.endSeconds > WINDOW_START && s.startSeconds < WINDOW_END);
  for (const s of segW) {
    console.log(`  [${s.startTimeFormatted} -> ${s.endTimeFormatted}] [${s.classification}]`);
    console.log(`    taggedText = ${JSON.stringify(s.taggedText)}`);
    console.log(`    text       = ${JSON.stringify(s.text)}`);
  }

  // Enforce max 3 words
  const enforced = enforceMaxWordsPerSegment(segs, 3);
  const enfW = enforced.filter((s:any) => s.endSeconds > WINDOW_START && s.startSeconds < WINDOW_END);
  console.log(`\n=== ENFORCE MAX 3 WORDS ===`);
  console.log(`Segments in window: ${enfW.length}`);
  for (const s of enfW) {
    const wc = (s.text||'').trim().split(/\s+/).filter((w:string)=>w.length>0).length;
    console.log(`  [${s.startTimeFormatted} -> ${s.endTimeFormatted}] [${s.classification}] words=${wc} tagged=${JSON.stringify(s.taggedText)}`);
  }

  // Final SRT
  console.log(`\n=== FINAL SRT (window) ===`);
  const fullSrt = generateSrtContent(enforced);
  const lines = fullSrt.split('\n');
  let inW = false;
  for (const line of lines) {
    const tsMatch = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (tsMatch) {
      const ss = parseInt(tsMatch[1])*3600 + parseInt(tsMatch[2])*60 + parseInt(tsMatch[3]) + parseInt(tsMatch[4])/1000;
      inW = ss >= WINDOW_START && ss < WINDOW_END;
    }
    if (inW) console.log(`  ${line}`);
  }

  // Summary: count classification types in full output
  console.log(`\n=== FULL OUTPUT CLASSIFICATION SUMMARY ===`);
  const allEnforced = enforceMaxWordsPerSegment(segs, 3);
  const counts: Record<string, number> = {};
  for (const s of allEnforced) {
    counts[s.classification] = (counts[s.classification] || 0) + 1;
  }
  for (const [k, v] of Object.entries(counts).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`);
  }
  console.log(`  Total segments: ${allEnforced.length}`);

  console.log(`\n=== DIAGNOSTIC COMPLETE ===`);
}

main().catch(err => { console.error('ERROR:', err.message || err); process.exit(1); });
