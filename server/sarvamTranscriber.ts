/**
 * Sarvam AI Speech-to-Text (Saaras) integration for Odia transcription.
 *
 * Sarvam Saaras is designed for Indian languages and natively supports Odia
 * (`od-IN`). This is the ACTIVE transcription provider for this Odia project.
 *
 * It uses the Sarvam BATCH API (/speech-to-text/job/v1) because the real-time
 * REST endpoint (/speech-to-text) rejects audio longer than 30 seconds with
 * HTTP 400 ("Audio duration exceeds the maximum limit of 30 seconds"). The
 * batch API accepts audio up to 2 hours.
 *
 * Batch settings:
 *   - model         : saaras:v4
 *   - language_code : od-IN       (force Odia)
 *   - mode          : verbatim    (exact word-for-word; preserves every spoken
 *                                  word/filler - no normalization, no removal,
 *                                  no translation, no transliteration)
 *   - with_timestamps: true       (chunk-level timestamps)
 *
 * Flow (synchronous, polled - no public webhook required):
 *   1) init      POST /speech-to-text/job/v1                      -> job_id
 *   2) upload-f  POST /speech-to-text/job/v1/upload-files         -> presigned URL
 *   3) PUT       the exact uploaded audio bytes to presigned URL
 *   4) start     POST /speech-to-text/job/v1/{job_id}/start
 *   5) status    GET  /speech-to-text/job/v1/{job_id}/status      -> until completed
 *   6) download  POST /speech-to-text/job/v1/download-files       -> presigned output URL
 *   7) GET       the transcript JSON -> verbatim `transcript`
 *
 * The key comes from the server-side `SARVAM_API_KEY` env var. The key is
 * NEVER sent to the browser, is NEVER logged, and is NEVER bundled into the
 * frontend. Only the exact uploaded bytes are sent to Sarvam.
 *
 * This raw path performs NO spelling correction, NO word re-ordering, and NO
 * max-3-word segmentation (segmentation is deferred until the raw Odia text
 * is verified by the user).
 */

const BATCH_API_BASE = 'https://api.sarvam.ai/speech-to-text/job/v1';

export interface SarvamChunk {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface SarvamRawResult {
  /** The full raw transcript verbatim, exactly as returned by Sarvam. */
  transcript: string;
  /** BCP-47 language code used ('od-IN'). */
  languageCode: string;
  /** Human label for the UI. */
  detectedLanguage: string;
  /** Audio duration in seconds, if known. */
  durationSeconds: number;
  /** Chunk-level timestamps (sentence/phrase chunks), if returned. */
  chunks: SarvamChunk[];
}

export function isSarvamConfigured(): boolean {
  const key = process.env.SARVAM_API_KEY;
  return Boolean(key && key.trim() && key.trim() !== 'YOUR_SARVAM_API_KEY_HERE');
}

/**
 * Resolve the active transcription provider from the environment.
 * Default is Sarvam; Groq is kept available as an explicit testing fallback.
 */
export function getActiveProvider(): 'sarvam' | 'groq' {
  const p = (process.env.TRANSCRIPTION_PROVIDER || 'sarvam').trim().toLowerCase();
  if (p === 'groq') return 'groq';
  return 'sarvam';
}

function detectExt(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('mp3')) return 'mp3';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('m4a')) return 'm4a';
  if (m.includes('aac')) return 'aac';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('wav')) return 'wav';
  return 'wav';
}

function authHeaders(): Record<string, string> {
  return { 'api-subscription-key': (process.env.SARVAM_API_KEY as string).trim() };
}

async function throwOnBad(res: Response, what: string): Promise<any> {
  const rawBody = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = data ? JSON.stringify(data) : rawBody || '(empty response body)';
    throw new Error(`Sarvam ${what} failed (HTTP ${res.status}): ${detail}`);
  }
  return { data, rawBody };
}

/**
 * Step 1: initialise a batch job.
 * Returns the job_id.
 */
async function initBatchJob(): Promise<string> {
  const res = await fetch(`${BATCH_API_BASE}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_parameters: {
        model: 'saaras:v4',
        language_code: 'od-IN',
        mode: 'verbatim',
        with_timestamps: true,
      },
    }),
  });
  const { data } = await throwOnBad(res, 'job initiate');
  const jobId = data && data.job_id;
  if (!jobId) throw new Error(`Sarvam job initiate returned no job_id: ${JSON.stringify(data)}`);
  return jobId;
}

/**
 * Step 2: get a presigned upload URL for the file, then PUT the exact bytes.
 */
async function uploadAudio(jobId: string, fileBytes: Uint8Array, fileName: string, mimeType: string): Promise<void> {
  const linkRes = await fetch(`${BATCH_API_BASE}/upload-files`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, files: [fileName] }),
  });
  const { data } = await throwOnBad(linkRes, 'upload link');
  const urls = data && data.upload_urls;
  const entry = urls && urls[fileName];
  const fileUrl = entry && (entry.file_url || (entry as any).fileUrl);
  if (!fileUrl) throw new Error(`Sarvam upload link missing for ${fileName}: ${JSON.stringify(data)}`);

  const putRes = await fetch(fileUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'x-ms-blob-type': 'BlockBlob' },
    body: fileBytes,
  });
  if (!putRes.ok) {
    const putBody = await putRes.text().catch(() => '');
    throw new Error(`Sarvam audio upload (PUT) failed (HTTP ${putRes.status}): ${putBody || '(empty)'}`);
  }
}

/**
 * Step 4: start processing the job.
 */
async function startBatchJob(jobId: string): Promise<void> {
  const res = await fetch(`${BATCH_API_BASE}/${encodeURIComponent(jobId)}/start`, {
    method: 'POST',
    headers: authHeaders(),
  });
  await throwOnBad(res, 'job start');
}

/**
 * Step 5: poll status until terminal, then return the output file name(s).
 */
async function pollUntilComplete(jobId: string, timeoutMs: number): Promise<{ outputFileNames: string[]; jobState: string }> {
  const start = Date.now();
  const pollIntervalMs = 5000;
  for (;;) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Sarvam batch job timed out after ${Math.floor(timeoutMs / 1000)}s (still processing). The job id is ${jobId}.`);
    }
    const res = await fetch(`${BATCH_API_BASE}/${encodeURIComponent(jobId)}/status`, {
      method: 'GET',
      headers: authHeaders(),
    });
    const { data } = await throwOnBad(res, 'job status');
    const state = data && data.job_state;
    if (state === 'Completed' || state === 'PartiallyCompleted') {
      const outputs: string[] = [];
      const details = data && data.job_details;
      if (Array.isArray(details)) {
        for (const d of details) {
          const outs = d && d.outputs;
          if (Array.isArray(outs)) {
            for (const o of outs) {
              const n = o && (o.file_name || (o as any).fileName);
              if (n) outputs.push(n);
            }
          }
        }
      }
      if (outputs.length === 0) throw new Error(`Sarvam job completed but no output files found: ${JSON.stringify(data)}`);
      return { outputFileNames: outputs, jobState: state };
    }
    if (state === 'Failed') {
      throw new Error(`Sarvam batch job failed: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Step 6+7: get a presigned download URL and fetch the transcript JSON.
 */
async function downloadTranscript(jobId: string, outputFileNames: string[]): Promise<SarvamRawResult> {
  const dlRes = await fetch(`${BATCH_API_BASE}/download-files`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, files: outputFileNames }),
  });
  const { data } = await throwOnBad(dlRes, 'download link');
  const urls = data && data.download_urls;
  const fileName = outputFileNames[0];
  const entry = urls && urls[fileName];
  const fileUrl = entry && (entry.file_url || (entry as any).fileUrl);
  if (!fileUrl) throw new Error(`Sarvam download link missing for ${fileName}: ${JSON.stringify(data)}`);

  const outRes = await fetch(fileUrl, { method: 'GET' });
  if (!outRes.ok) {
    const body = await outRes.text().catch(() => '');
    throw new Error(`Sarvam transcript download failed (HTTP ${outRes.status}): ${body || '(empty)'}`);
  }
  const raw = await outRes.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new Error(`Sarvam transcript output could not be parsed as JSON: ${raw.slice(0, 500)}`);
  }

  const transcript = ((parsed.transcript || '').trim());
  const languageCode = (parsed.language_code || 'od-IN');
  const chunks: SarvamChunk[] = [];
  try {
    const ts = parsed.timestamps;
    const words = ts && (Array.isArray(ts.chunks) ? ts.chunks : Array.isArray(ts.words) ? ts.words : null);
    const starts = ts && (Array.isArray(ts.start_time_seconds) ? ts.start_time_seconds : null);
    const ends = ts && (Array.isArray(ts.end_time_seconds) ? ts.end_time_seconds : null);
    if (words && Array.isArray(starts) && Array.isArray(ends)) {
      const n = Math.min(words.length, starts.length, ends.length);
      for (let i = 0; i < n; i++) {
        chunks.push({
          text: String(words[i] ?? '').trim(),
          startSeconds: Number(starts[i]) || 0,
          endSeconds: Number(ends[i]) || 0,
        });
      }
    }
  } catch {
    // Timestamps are best-effort.
  }

  const durationSeconds =
    parsed.duration_seconds || (chunks.length > 0 ? chunks[chunks.length - 1].endSeconds : 0);

  return {
    transcript,
    languageCode,
    detectedLanguage: languageCode === 'od-IN' ? 'Odia (ଓଡ଼ିଆ)' : languageCode,
    durationSeconds,
    chunks,
  };
}

/**
 * Transcribe an audio buffer with Sarvam Saaras (batch API) and return the RAW
 * Odia text exactly as recognised (verbatim), with no spelling correction and
 * no segmentation.
 *
 * @param audioBuffer  The EXACT bytes uploaded by the browser.
 * @param mimeType     MIME type of the audio.
 * @param opts         Optional settings (e.g. job timeout).
 */
export async function transcribeRawOdiaWithSarvam(
  audioBuffer: Buffer,
  mimeType: string = 'audio/wav',
  opts: { jobTimeoutMs?: number } = {}
): Promise<SarvamRawResult> {
  if (!isSarvamConfigured()) {
    throw new Error(
      'SARVAM_API_KEY is not configured in the .env file. Set SARVAM_API_KEY=<your key> in E:\\Odia-SRT-App\\.env and restart the server.'
    );
  }

  const timeoutMs = opts.jobTimeoutMs && opts.jobTimeoutMs > 0 ? opts.jobTimeoutMs : 180000;
  const ext = detectExt(mimeType);
  const fileName = `odia_upload.${ext}`;
  const fileBytes = new Uint8Array(audioBuffer);

  console.log(`[SARVAM BATCH] init job (model=saaras:v4, language_code=od-IN, mode=verbatim)...`);
  const jobId = await initBatchJob();

  console.log(`[SARVAM BATCH] ${jobId} uploading ${audioBuffer.length} bytes...`);
  await uploadAudio(jobId, fileBytes, fileName, mimeType);

  console.log(`[SARVAM BATCH] ${jobId} starting job...`);
  await startBatchJob(jobId);

  console.log(`[SARVAM BATCH] ${jobId} polling for completion (timeout ${Math.floor(timeoutMs / 1000)}s)...`);
  const { outputFileNames } = await pollUntilComplete(jobId, timeoutMs);

  console.log(`[SARVAM BATCH] ${jobId} downloading outputs: ${outputFileNames.join(', ')}...`);
  return await downloadTranscript(jobId, outputFileNames);
}
