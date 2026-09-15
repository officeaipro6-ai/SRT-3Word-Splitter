import {
  isGroqRateLimitError,
  isGroqTransientError,
} from '../server/groqTranscriber';

const cases: Array<{ name: string; error: any; expectRateLimit: boolean; expectTransient: boolean }> = [
  {
    name: '429 rate limit (Groq-style)',
    error: new Error('429 Too Many Requests: rate limit exceeded'),
    expectRateLimit: true,
    expectTransient: false,
  },
  {
    name: 'status 429 on error object',
    error: { status: 429, message: 'too many requests' },
    expectRateLimit: true,
    expectTransient: false,
  },
  {
    name: '503 UNAVAILABLE (transient, keep retrying)',
    error: new Error('503 Service Unavailable. Please retry.'),
    expectRateLimit: false,
    expectTransient: true,
  },
  {
    name: '500 INTERNAL (transient)',
    error: { status: 500, message: 'internal error' },
    expectRateLimit: false,
    expectTransient: true,
  },
  {
    name: 'network blip (fetch failed, transient)',
    error: new Error('fetch failed'),
    expectRateLimit: false,
    expectTransient: true,
  },
  {
    name: 'unrelated error (neither)',
    error: new Error('something else went wrong'),
    expectRateLimit: false,
    expectTransient: false,
  },
  {
    name: 'null error (neither)',
    error: null,
    expectRateLimit: false,
    expectTransient: false,
  },
  {
    name: 'quota keyword (rate limit)',
    error: new Error('quota exceeded for this key'),
    expectRateLimit: true,
    expectTransient: false,
  },
];

let failed = 0;
for (const c of cases) {
  const q = isGroqRateLimitError(c.error);
  const t = isGroqTransientError(c.error);
  const ok = q === c.expectRateLimit && t === c.expectTransient;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      rateLimit=${q} (expected ${c.expectRateLimit}), transient=${t} (expected ${c.expectTransient})`);
}

console.log(failed === 0 ? `\nAll ${cases.length} cases passed.` : `\n${failed} case(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
