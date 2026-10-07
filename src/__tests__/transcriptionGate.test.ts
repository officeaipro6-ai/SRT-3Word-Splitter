import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptionGate } from '../lib/sessionClient';

// The client-side half of the transcription gate (server authority lives in
// server/authz.ts `authorizeTranscriber`). Together they prove a valid ADMIN
// session reaches the transcription UI directly, with no second customer login.

test('a valid admin session unlocks the transcription UI with no second customer login', () => {
  const gate = transcriptionGate({ role: 'ADMIN', account: false, email: null, emailVerified: false });
  assert.deepEqual(gate, { authenticated: true, emailUnverified: false });
});

test('a verified customer session reaches the transcription UI', () => {
  const gate = transcriptionGate({ role: 'USER', account: true, email: 'a@example.com', emailVerified: true });
  assert.deepEqual(gate, { authenticated: true, emailUnverified: false });
});

test('an unverified customer is authenticated but must prove the inbox first', () => {
  const gate = transcriptionGate({ role: 'USER', account: true, email: 'a@example.com', emailVerified: false });
  assert.deepEqual(gate, { authenticated: true, emailUnverified: true });
});

test('a guest with no account sees the sign-in screen', () => {
  const gate = transcriptionGate({ role: 'USER', account: false, email: null, emailVerified: false });
  assert.deepEqual(gate, { authenticated: false, emailUnverified: false });
});

test('a customer session is never rendered as an admin session', () => {
  // The admin promotion is derived from the server-assigned role only: a
  // customer session with an allowlisted-looking email stays a customer.
  const gate = transcriptionGate({
    role: 'USER',
    account: true,
    email: 'officeaipro6@gmail.com',
    emailVerified: true,
  });
  assert.deepEqual(gate, { authenticated: true, emailUnverified: false });
});
