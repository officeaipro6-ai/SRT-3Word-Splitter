/**
 * Independent verification of the Olive Odia ASR provider.
 *
 * 1. Stands up a LOCAL mock Olive /recognition server and asserts the client:
 *    - sends multipart/form-data with the EXACT uploaded audio bytes,
 *    - forces language=or, task=transcribe, to_simple=0, remove_pun=0,
 *    - parses the {results, code} response verbatim (NO spelling correction),
 *    - maps result.start/end into segment timestamps.
 * 2. Verifies provider selection still defaults to sarvam and olive is opt-in.
 * 3. Verifies error handling for HTTP failure and non-zero code.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import assert from 'node:assert';
import { transcribeRawOdiaWithOlive, isOliveConfigured } from '../server/oliveTranscriber';
import { getActiveProvider } from '../server/sarvamTranscriber';

const MOCK_RESULTS = [
  { result: 'ମୁଁ ଭାଷା ଅନୁବାଦକ |', start: 0, end: 3 },
  { result: 'ସାର୍ଭମ ଟେଷ୍ଟ ପାଇପଲାଇନ', start: 3, end: 6 },
];

let capturedHeaders: Record<string, string | string[] | undefined> = {};
let capturedBody: Buffer = Buffer.alloc(0);
let respondWith: { status: number; payload: unknown } = { status: 200, payload: { results: MOCK_RESULTS, code: 0 } };

function startMockOliveServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      capturedHeaders = req.headers;
      capturedBody = Buffer.concat(chunks);
      res.statusCode = respondWith.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(respondWith.payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function assertMultipartBody(body: Buffer, audioBytes: Buffer): void {
  const text = body.toString('latin1');
  assert.match(capturedHeaders['content-type'] as string, /multipart\/form-data/, 'must be multipart/form-data');
  assert.ok(text.includes('name="audio"'), 'must contain audio file part');
  assert.ok(text.includes('filename="odia_upload.wav"'), 'must contain odia_upload.wav filename');
  assert.match(text, /name="to_simple"/, 'must send to_simple');
  assert.match(text, /name="to_simple"\r\n\r\n0\r\n/, 'to_simple value 0 present');
  assert.match(text, /name="remove_pun"/, 'must send remove_pun');
  assert.match(text, /name="remove_pun"\r\n\r\n0\r\n/, 'remove_pun value 0 present');
  assert.match(text, /name="language"/, 'must send language');
  assert.match(text, /name="language"\r\n\r\nor\r\n/, 'language forced to or');
  assert.match(text, /name="task"/, 'must send task');
  assert.match(text, /name="task"\r\n\r\ntranscribe\r\n/, 'task is transcribe');
  assert.ok(body.indexOf(audioBytes) !== -1, 'EXACT uploaded audio bytes must be in the request body');
}

async function main(): Promise<void> {
  const { server, port } = await startMockOliveServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const audioBytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x52, 0x49, 0x46, 0x46, 0x42, 0x39]); // marker bytes + "RIFFB9"

  try {
    // ---- 1. Happy path: exact bytes + forced Odia + verbatim text + timestamps ----
    respondWith = { status: 200, payload: { results: MOCK_RESULTS, code: 0 } };
    const r = await transcribeRawOdiaWithOlive(audioBytes, 'audio/wav', { baseUrl });
    assertMultipartBody(capturedBody, audioBytes);
    assert.strictEqual(
      r.transcript,
      'ମୁଁ ଭାଷା ଅନୁବାଦକ | ସାର୍ଭମ ଟେଷ୍ଟ ପାଇପଲାଇନ',
      'transcript must be the verbatim Olive text (NO spelling correction)'
    );
    assert.strictEqual(r.languageCode, 'or', 'languageCode must be or');
    assert.strictEqual(r.detectedLanguage, 'Odia (ଓଡ଼ିଆ)');
    assert.strictEqual(r.durationSeconds, 6, 'durationSeconds must be max end');
    assert.strictEqual(r.chunks.length, 2);
    assert.strictEqual(r.chunks[0].startSeconds, 0);
    assert.strictEqual(r.chunks[0].endSeconds, 3);
    assert.strictEqual(r.chunks[1].startSeconds, 3);
    assert.strictEqual(r.chunks[1].endSeconds, 6);
    console.log('PASS 1: exact bytes sent, language=or forced, verbatim text, timestamps mapped');

    // ---- 2. HTTP failure -> friendly thrown error ----
    respondWith = { status: 503, payload: { detail: 'overloaded' } };
    await assert.rejects(
      () => transcribeRawOdiaWithOlive(audioBytes, 'audio/wav', { baseUrl }),
      /Olive recognition failed \(HTTP 503\)/,
      'must throw descriptive error on HTTP failure'
    );
    console.log('PASS 2: HTTP failure throws descriptive error');

    // ---- 3. Non-zero code -> error ----
    respondWith = { status: 200, payload: { results: [], code: 2 } };
    await assert.rejects(
      () => transcribeRawOdiaWithOlive(audioBytes, 'audio/wav', { baseUrl }),
      /reported error code 2/,
      'must throw on non-zero Olive error code'
    );
    console.log('PASS 3: non-zero code throws');

    // ---- 4. Empty results -> empty transcript, zero duration ----
    respondWith = { status: 200, payload: { results: [], code: 0 } };
    const empty = await transcribeRawOdiaWithOlive(audioBytes, 'audio/wav', { baseUrl });
    assert.strictEqual(empty.transcript, '');
    assert.strictEqual(empty.chunks.length, 0);
    assert.strictEqual(empty.durationSeconds, 0);
    console.log('PASS 4: empty results handled cleanly');
  } finally {
    server.close();
  }

  // ---- 5. Provider selection: sarvam is still the default; olive is opt-in ----
  const savedProvider = process.env.TRANSCRIPTION_PROVIDER;
  delete process.env.TRANSCRIPTION_PROVIDER;
  assert.strictEqual(getActiveProvider(), 'sarvam', 'default provider must remain sarvam');
  process.env.TRANSCRIPTION_PROVIDER = 'olive';
  assert.strictEqual(getActiveProvider(), 'olive', 'olive selectable via env');
  process.env.TRANSCRIPTION_PROVIDER = 'groq';
  assert.strictEqual(getActiveProvider(), 'groq', 'groq still selectable via env');
  if (savedProvider === undefined) delete process.env.TRANSCRIPTION_PROVIDER;
  else process.env.TRANSCRIPTION_PROVIDER = savedProvider;
  console.log('PASS 5: provider selection unchanged - sarvam default, groq + olive opt-in');

  // ---- 6. isOliveConfigured ----
  const savedOlive = process.env.OLIVE_API_URL;
  delete process.env.OLIVE_API_URL;
  assert.strictEqual(isOliveConfigured(), false, 'olive not configured when OLIVE_API_URL unset');
  process.env.OLIVE_API_URL = 'http://127.0.0.1:5000';
  assert.strictEqual(isOliveConfigured(), true, 'olive configured when OLIVE_API_URL set');
  process.env.OLIVE_API_URL = 'YOUR_OLIVE_API_URL_HERE';
  assert.strictEqual(isOliveConfigured(), false, 'placeholder value is not a config');
  if (savedOlive === undefined) delete process.env.OLIVE_API_URL;
  else process.env.OLIVE_API_URL = savedOlive;
  console.log('PASS 6: isOliveConfigured behaviour correct');

  console.log('\nALL OLIVE PROVIDER TESTS PASSED');
}

main().catch((e) => {
  console.error('\nOLIVE PROVIDER TEST FAILED:', e);
  process.exitCode = 1;
});