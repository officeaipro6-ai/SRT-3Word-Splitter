import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  LocalAsrUnavailableError,
  isLocalModelAvailable,
  isLocalSubmissionModeEnabled,
  localModelDir,
  localModelMissingMessage,
  stripSpokenPunctuation,
  transcribeRawOdiaWithLocalAsr,
} from './localTranscriber.ts';

/** Run `fn` with the given env applied, then restore the previous env exactly. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// The mode must be OFF unless the operator explicitly turns it on. This is the
// single most important safety property: production must stay on Sarvam.
// ---------------------------------------------------------------------------

test('LOCAL SUBMISSION MODE is off unless explicitly enabled', () => {
  withEnv({ LOCAL_SUBMISSION_MODE: undefined }, () => {
    assert.equal(isLocalSubmissionModeEnabled(), false);
  });
  for (const off of ['false', '0', 'no', 'off', '', '  ']) {
    withEnv({ LOCAL_SUBMISSION_MODE: off }, () => {
      assert.equal(isLocalSubmissionModeEnabled(), false, `expected "${off}" to be off`);
    });
  }
  for (const on of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
    withEnv({ LOCAL_SUBMISSION_MODE: on }, () => {
      assert.equal(isLocalSubmissionModeEnabled(), true, `expected "${on}" to be on`);
    });
  }
});

// ---------------------------------------------------------------------------
// Model location: always inside the project, never on C:, never Downloads.
// ---------------------------------------------------------------------------

test('the local model dir defaults to the project models folder', () => {
  withEnv({ LOCAL_ASR_MODEL_DIR: undefined }, () => {
    assert.equal(localModelDir(), path.join(process.cwd(), 'models', 'indicwav2vec-odia'));
  });
});

test('an override inside the project is honoured', () => {
  withEnv({ LOCAL_ASR_MODEL_DIR: 'models/indicwav2vec-odia' }, () => {
    assert.equal(localModelDir(), path.join(process.cwd(), 'models', 'indicwav2vec-odia'));
  });
});

test('a model path outside the project is refused (no C:\\ / Downloads usage)', () => {
  for (const outside of [
    'C:\\Users\\sures\\Downloads\\indicwav2vec-odia',
    'C:\\hf-cache\\models\\indicwav2vec-odia',
    path.join(process.cwd(), '..', 'elsewhere', 'model'),
  ]) {
    withEnv({ LOCAL_ASR_MODEL_DIR: outside }, () => {
      assert.throws(() => localModelDir(), /must point inside the project directory/);
    });
  }
});

test('a missing model reports unavailable and is never treated as available', () => {
  withEnv({ LOCAL_ASR_MODEL_DIR: path.join(process.cwd(), 'models', '__definitely_missing__') }, () => {
    assert.equal(isLocalModelAvailable(), false);
  });
});

test('the missing-model message is explicit and promises no guessed transcript', () => {
  withEnv({ LOCAL_ASR_MODEL_DIR: path.join(process.cwd(), 'models', 'indicwav2vec-odia') }, () => {
    const msg = localModelMissingMessage();
    assert.match(msg, /not installed/i);
    assert.match(msg, /indicwav2vec-odia/);
    assert.match(msg, /LOCAL_SUBMISSION_MODE=false/); // how to get back to production
    assert.match(msg, /none is guessed|not produced/i);
  });
});

// ---------------------------------------------------------------------------
// Spoken text: punctuation removed, DIGITS and letters preserved.
// ---------------------------------------------------------------------------

test('spoken punctuation is stripped but Odia letters and digits survive', () => {
  assert.equal(stripSpokenPunctuation('ନମସ୍କାର, ବଣ୍ଡିଆ!'), 'ନମସ୍କାର ବଣ୍ଡିଆ');
  // Odia danda (U+0964) is punctuation and must go.
  assert.equal(stripSpokenPunctuation('ଶୁଭରଦିନ୍ଦ\u0964ଆଉ'), 'ଶୁଭରଦିନ୍ଦଆଉ');
  // Digits are spoken content and must be preserved.
  assert.equal(stripSpokenPunctuation('୨୦୨୬ ସାଲ'), '୨୦୨୬ ସାଲ');
  assert.equal(stripSpokenPunctuation(''), '');
  // Trailing punctuation must NOT create a phantom extra word, because the
  // SRT splitter counts words by whitespace.
  assert.equal(
    stripSpokenPunctuation('ନମସ୍କାର, ବଣ୍ଡିଆ').split(/\s+/).length,
    2
  );
  // Existing real spaces are preserved and collapsed, not doubled up.
  assert.equal(stripSpokenPunctuation('କ   ଖ'), 'କ ଖ');
  assert.equal(stripSpokenPunctuation('  କ  ,  ଖ  '), 'କ ଖ');
  // The tagging characters must survive for the downstream NOISE/FIL rules.
  assert.equal(stripSpokenPunctuation('<NOISE>'), '<NOISE>');
});

// ---------------------------------------------------------------------------
// The honesty guarantee: with no model there is NO text. It must reject, and
// must never resolve with a cached / fixture / placeholder transcript.
// ---------------------------------------------------------------------------

test('local transcription refuses when the mode is off', async () => {
  await withEnv({ LOCAL_SUBMISSION_MODE: 'false' }, async () => {
    await assert.rejects(
      () => transcribeRawOdiaWithLocalAsr(Buffer.from('not-audio'), 'audio/wav'),
      (err: any) => {
        assert.ok(err instanceof LocalAsrUnavailableError);
        assert.match(err.message, /not enabled/i);
        return true;
      }
    );
  });
});

test('with the mode on but no model installed it throws instead of inventing text', async () => {
  await withEnv(
    {
      LOCAL_SUBMISSION_MODE: 'true',
      LOCAL_ASR_MODEL_DIR: path.join(process.cwd(), 'models', '__definitely_missing__'),
    },
    async () => {
      let result: any = null;
      let thrown: any = null;
      try {
        result = await transcribeRawOdiaWithLocalAsr(Buffer.from('not-audio'), 'audio/wav');
      } catch (err) {
        thrown = err;
      }
      // No transcript may ever be produced without the real model.
      assert.equal(result, null, 'must not resolve with a transcript when the model is missing');
      assert.ok(thrown instanceof LocalAsrUnavailableError);
      assert.equal((thrown as any).code, 'LOCAL_ASR_UNAVAILABLE');
    }
  );
});

test('it also refuses empty audio rather than emitting anything', async () => {
  await withEnv(
    {
      LOCAL_SUBMISSION_MODE: 'true',
      LOCAL_ASR_MODEL_DIR: path.join(process.cwd(), 'models', '__definitely_missing__'),
    },
    async () => {
      await assert.rejects(
        () => transcribeRawOdiaWithLocalAsr(Buffer.alloc(0), 'audio/wav'),
        LocalAsrUnavailableError
      );
    }
  );
});
