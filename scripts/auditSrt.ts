import * as fs from "fs";

// --- SRT Parser ---
interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

function parseTime(timeStr: string): number {
  // "00:01:10,400" → ms
  const [h, m, rest] = timeStr.split(":");
  const [s, ms] = rest.split(",");
  return (
    parseInt(h) * 3600000 +
    parseInt(m) * 60000 +
    parseInt(s) * 1000 +
    parseInt(ms)
  );
}

function parseSrt(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.trim().split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    const index = parseInt(lines[0]);
    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!timeMatch) continue;
    const startMs = parseTime(timeMatch[1]);
    const endMs = parseTime(timeMatch[2]);
    const text = lines.slice(2).join("\n").trim();
    cues.push({ index, startMs, endMs, text });
  }
  return cues;
}

function msToTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mill = ms % 1000;
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    "," +
    String(mill).padStart(3, "0")
  );
}

function isSpeech(cue: Cue): boolean {
  const t = cue.text.replace(/<\/?SIL>/g, "").replace(/<\/?NOISE>/g, "").trim();
  if (t.length === 0) return false;
  return /[\u0B00-\u0B7F]/.test(cue.text);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function hasOdiaScript(text: string): boolean {
  return /[\u0B00-\u0B7F]/.test(text);
}

// --- Load files ---
const genPath = "C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\groq-pipeline-output.srt";
const refPath = "C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.srt";

const genContent = fs.readFileSync(genPath, "utf-8");
const refContent = fs.readFileSync(refPath, "utf-8");

const gen = parseSrt(genContent);
const ref = parseSrt(refContent);

// --- Check Results ---
interface CheckResult {
  name: string;
  result: "PASS" | "FAIL";
  details: string;
}

const results: CheckResult[] = [];

// 1. Chronological order: every cue's start <= end
{
  let failures: string[] = [];
  for (const c of gen) {
    if (c.startMs > c.endMs) {
      failures.push(`Cue ${c.index}: start ${msToTime(c.startMs)} > end ${msToTime(c.endMs)}`);
    }
  }
  results.push({
    name: "1. Chronological order",
    result: failures.length === 0 ? "PASS" : "FAIL",
    details: failures.length === 0
      ? `All ${gen.length} cues have start <= end`
      : failures.join("; "),
  });
}

// 2. No overlapping timestamps (allow exact equality)
{
  let overlaps: string[] = [];
  for (let i = 1; i < gen.length; i++) {
    if (gen[i].startMs < gen[i - 1].endMs) {
      overlaps.push(
        `Cue ${gen[i - 1].index} ends ${msToTime(gen[i - 1].endMs)}, ` +
          `Cue ${gen[i].index} starts ${msToTime(gen[i].startMs)} ` +
          `(${gen[i - 1].endMs - gen[i].startMs}ms overlap)`
      );
    }
  }
  results.push({
    name: "2. No overlapping timestamps",
    result: overlaps.length === 0 ? "PASS" : "FAIL",
    details: overlaps.length === 0
      ? "No overlaps detected"
      : overlaps.join("; "),
  });
}

// 3. Coverage
{
  const firstStart = gen[0].startMs;
  const lastEnd = gen[gen.length - 1].endMs;
  const expectedEnd = 203000; // 03:23
  const timelineSpan = lastEnd - firstStart;
  const coveredMs = gen.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
  const coveragePct = ((coveredMs / timelineSpan) * 100).toFixed(1);

  // Gaps > 0.5s
  let bigGaps: string[] = [];
  for (let i = 1; i < gen.length; i++) {
    const gap = gen[i].startMs - gen[i - 1].endMs;
    if (gap > 500) {
      bigGaps.push(
        `Gap after cue ${gen[i - 1].index}: ${msToTime(gen[i - 1].endMs)} → ${msToTime(gen[i].startMs)} (${gap}ms)`
      );
    }
  }

  const firstOk = firstStart === 0;
  const lastOk = Math.abs(lastEnd - expectedEnd) < 1000;

  results.push({
    name: "3. Coverage",
    result: firstOk && lastOk ? "PASS" : "FAIL",
    details:
      `First cue: ${msToTime(firstStart)} (expect 00:00:00,000) ` +
      `${firstOk ? "OK" : "FAIL"}; ` +
      `Last cue ends: ${msToTime(lastEnd)} (expect ~03:23,000) ${lastOk ? "OK" : "FAIL"}; ` +
      `Timeline: ${timelineSpan}ms, Covered: ${coveredMs}ms (${coveragePct}%); ` +
      `Gaps > 500ms: ${bigGaps.length === 0 ? "none" : bigGaps.join("; ")}`,
  });
}

// 4. Word count (speech cues only)
{
  const speechCues = gen.filter(isSpeech);
  let maxWords = 0;
  let violations: string[] = [];
  for (const c of speechCues) {
    const w = wordCount(c.text);
    if (w > maxWords) maxWords = w;
    if (w > 3) {
      violations.push(`Cue ${c.index}: "${c.text}" (${w} words)`);
    }
  }
  results.push({
    name: "4. Word count (speech ≤3)",
    result: violations.length === 0 ? "PASS" : "FAIL",
    details:
      `Speech cues: ${speechCues.length}, Max words: ${maxWords}. ` +
      (violations.length > 0
        ? `Violations: ${violations.join("; ")}`
        : "All within limit"),
  });
}

// 5. No <MB> tags
{
  const mbCues = gen.filter((c) => c.text.includes("<MB>") || c.text.includes("</MB>"));
  results.push({
    name: "5. No <MB> tags",
    result: mbCues.length === 0 ? "PASS" : "FAIL",
    details: mbCues.length === 0
      ? "Clean"
      : `Found in cues: ${mbCues.map((c) => c.index).join(", ")}`,
  });
}

// 6. No apostrophes
{
  const apoCues = gen.filter((c) => c.text.includes("'"));
  results.push({
    name: "6. No apostrophes",
    result: apoCues.length === 0 ? "PASS" : "FAIL",
    details: apoCues.length === 0
      ? "Clean"
      : `Found in cues: ${apoCues.map((c) => `${c.index}:"${c.text}"`).join("; ")}`,
  });
}

// 7. All speech text has Odia script
{
  const speechCues = gen.filter(isSpeech);
  const noOdia = speechCues.filter((c) => !hasOdiaScript(c.text));
  results.push({
    name: "7. Odia script in speech",
    result: noOdia.length === 0 ? "PASS" : "FAIL",
    details: noOdia.length === 0
      ? `All ${speechCues.length} speech cues have Odia characters`
      : `Missing Odia in: ${noOdia.map((c) => `${c.index}:"${c.text}"`).join("; ")}`,
  });
}

// 8. Reference timing comparison
{
  // Extract key phrases from both, try to match
  function extractSpeechText(cue: Cue): string {
    return cue.text
      .replace(/<\/?SIL>/g, "")
      .replace(/<\/?NOISE>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const genSpeech = gen
    .filter((c) => isSpeech(c))
    .map((c) => ({ ...c, clean: extractSpeechText(c) }));

  const refSpeech = ref
    .filter((c) => hasOdiaScript(c.text))
    .map((c) => ({
      ...c,
      clean: extractSpeechText(c),
    }));

  // Key phrases to look for in both
  const keyPhrases = [
    { phrase: "ଲକ୍ଷ୍ମୀ", genLabel: "laxmi", refLabel: "laxmi" },
    { phrase: "ଖେଚୁଡ", genLabel: "khechudi", refLabel: "khechudi" },
    { phrase: "ସାଧବ", genLabel: "sadhaba", refLabel: "sadhaba" },
    { phrase: "ଲୁଣ", genLabel: "luna", refLabel: "luna" },
    { phrase: "ପ୍ରେମ", genLabel: "prema", refLabel: "prema" },
    { phrase: "ଭକ୍ତି", genLabel: "bhakti", refLabel: "bhakti" },
  ];

  let timingIssues: string[] = [];
  let matched = 0;

  for (const kp of keyPhrases) {
    // Find first occurrence in generated
    const genHit = genSpeech.find((c) => c.clean.includes(kp.phrase));
    // Find first occurrence in reference
    const refHit = refSpeech.find((c) => c.clean.includes(kp.phrase));

    if (genHit && refHit) {
      matched++;
      const offset = Math.abs(genHit.startMs - refHit.startMs);
      if (offset > 2000) {
        timingIssues.push(
          `"${kp.phrase}": gen ${msToTime(genHit.startMs)} vs ref ${msToTime(refHit.startMs)} (Δ=${offset}ms)`
        );
      }
    }
  }

  results.push({
    name: "8. Reference timing comparison",
    result: timingIssues.length === 0 ? "PASS" : "FAIL",
    details:
      `Generated speech cues: ${genSpeech.length}, Ref speech cues: ${refSpeech.length}. ` +
      `Matched ${matched}/${keyPhrases.length} key phrases. ` +
      (timingIssues.length > 0
        ? `Offsets > 2s: ${timingIssues.join("; ")}`
        : "All matched phrases within 2s"),
  });
}

// 9. Segment 61 anomaly
{
  const c61 = gen.find((c) => c.index === 61);
  const c62 = gen.find((c) => c.index === 62);
  if (c61 && c62) {
    const d61 = c61.endMs - c61.startMs;
    const d62 = c62.endMs - c62.startMs;
    const w61 = wordCount(c61.text);
    const w62 = wordCount(c62.text);
    const isAnomalous = d61 > 5000 || d62 > 5000;
    results.push({
      name: "9. Segment 61-62 anomaly",
      result: "FAIL",
      details:
        `Cue 61: ${msToTime(c61.startMs)}→${msToTime(c61.endMs)} (${d61}ms, ${w61} words): "${c61.text}". ` +
        `Cue 62: ${msToTime(c62.startMs)}→${msToTime(c62.endMs)} (${d62}ms, ${w62} words): "${c62.text}". ` +
        `${isAnomalous ? "ANOMALY: very long durations for few words" : "OK"}`,
    });
  }
}

// 10. Segment 34-35 gap + all speech gaps > 100ms
{
  const c34 = gen.find((c) => c.index === 34);
  const c35 = gen.find((c) => c.index === 35);
  let gap3435 = "N/A";
  if (c34 && c35) {
    gap3435 = `${c35.startMs - c34.endMs}ms (${msToTime(c34.endMs)} → ${msToTime(c35.startMs)})`;
  }

  // All gaps between consecutive speech cues (NOT noise/silence)
  const speechOnly = gen.filter(isSpeech);
  let speechGaps: string[] = [];
  for (let i = 1; i < speechOnly.length; i++) {
    const gap = speechOnly[i].startMs - speechOnly[i - 1].endMs;
    if (gap > 100) {
      speechGaps.push(
        `Cue ${speechOnly[i - 1].index}→${speechOnly[i].index}: ` +
          `${msToTime(speechOnly[i - 1].endMs)} → ${msToTime(speechOnly[i].startMs)} (${gap}ms)`
      );
    }
  }

  results.push({
    name: "10. Speech-to-speech gaps >100ms",
    result: speechGaps.length === 0 ? "PASS" : "FAIL",
    details:
      `Cue 34→35 gap: ${gap3435}. ` +
      `Total speech-only gaps >100ms: ${speechGaps.length}. ` +
      (speechGaps.length > 0 ? speechGaps.join("; ") : "None"),
  });
}

// 11. Crossing chunk boundaries
{
  const issues: string[] = [];

  // Check cue 42/43 overlap
  const c42 = gen.find((c) => c.index === 42);
  const c43 = gen.find((c) => c.index === 43);
  if (c42 && c43) {
    if (c43.startMs < c42.endMs) {
      issues.push(
        `Cues 42/43 OVERLAP: 42 ends ${msToTime(c42.endMs)}, 43 starts ${msToTime(c43.startMs)} (${c42.endMs - c43.startMs}ms overlap)`
      );
    } else {
      issues.push(
        `Cues 42/43: no overlap (42 ends ${msToTime(c42.endMs)}, 43 starts ${msToTime(c43.startMs)})`
      );
    }
  }

  // Check cue 63/64 overlap
  const c63 = gen.find((c) => c.index === 63);
  const c64 = gen.find((c) => c.index === 64);
  if (c63 && c64) {
    if (c64.startMs < c63.endMs) {
      issues.push(
        `Cues 63/64 OVERLAP: 63 ends ${msToTime(c63.endMs)}, 64 starts ${msToTime(c64.startMs)} (${c63.endMs - c64.startMs}ms overlap)`
      );
    } else {
      issues.push(
        `Cues 63/64: no overlap (63 ends ${msToTime(c63.endMs)}, 64 starts ${msToTime(c64.startMs)})`
      );
    }
  }

  // Check cue 75/76/77/78
  for (const pair of [
    [75, 76],
    [76, 77],
    [77, 78],
  ]) {
    const a = gen.find((c) => c.index === pair[0]);
    const b = gen.find((c) => c.index === pair[1]);
    if (a && b) {
      if (b.startMs < a.endMs) {
        issues.push(
          `Cues ${pair[0]}/${pair[1]} OVERLAP: ${pair[0]} ends ${msToTime(a.endMs)}, ${pair[1]} starts ${msToTime(b.startMs)} (${a.endMs - b.startMs}ms)`
        );
      } else {
        issues.push(
          `Cues ${pair[0]}/${pair[1]}: no overlap (${pair[0]} ends ${msToTime(a.endMs)}, ${pair[1]} starts ${msToTime(b.startMs)})`
        );
      }
    }
  }

  // Also check cue 62 vs 63 (62 is long, 63 starts inside?)
  const c62b = gen.find((c) => c.index === 62);
  const c63b = gen.find((c) => c.index === 63);
  if (c62b && c63b && c63b.startMs < c62b.endMs) {
    issues.push(
      `Cues 62/63 OVERLAP: 62 ends ${msToTime(c62b.endMs)}, 63 starts ${msToTime(c63b.startMs)} (${c62b.endMs - c63b.startMs}ms)`
    );
  }

  const hasOverlap = issues.some((i) => i.includes("OVERLAP"));
  results.push({
    name: "11. Chunk boundary overlaps",
    result: hasOverlap ? "FAIL" : "PASS",
    details: issues.join("; "),
  });
}

// --- Print results ---
console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║              SRT AUDIT RESULTS                              ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

let passCount = 0;
let failCount = 0;
for (const r of results) {
  const status = r.result === "PASS" ? "✅ PASS" : "❌ FAIL";
  if (r.result === "PASS") passCount++;
  else failCount++;
  console.log(`CHECK: ${r.name}`);
  console.log(`  RESULT: ${status}`);
  console.log(`  DETAILS: ${r.details}`);
  console.log();
}

console.log(`═══════════════════════════════════════════════════════════════`);
console.log(`TOTAL: ${results.length} checks | PASS: ${passCount} | FAIL: ${failCount}`);
console.log(`═══════════════════════════════════════════════════════════════`);

// Return JSON
const json = {
  total: results.length,
  pass: passCount,
  fail: failCount,
  results: results.map((r) => ({
    check: r.name,
    result: r.result,
    details: r.details,
  })),
};

console.log("\nJSON_OUTPUT_START");
console.log(JSON.stringify(json, null, 2));
console.log("JSON_OUTPUT_END");
