import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouteTarget, servesAppShell } from './routeTarget.ts';

/**
 * The canonical production route contract:
 *
 *   /            -> the new multilingual Odia SRT app
 *   /admin[/...] -> the Admin Dashboard ONLY
 *   anything else-> 404 (never the transcription UI)
 *
 * These tests exist because the old behaviour (`app.get('*')` returning
 * index.html for every path) is exactly what let a legacy URL render the
 * transcription screen, and nothing stopped it from regressing.
 */

test('/ is the new application', () => {
  assert.equal(resolveRouteTarget('/'), 'app');
});

test('/admin resolves to the admin surface', () => {
  assert.equal(resolveRouteTarget('/admin'), 'admin');
});

test('the admin surface owns its whole subtree', () => {
  assert.equal(resolveRouteTarget('/admin/'), 'admin');
  assert.equal(resolveRouteTarget('/admin/users'), 'admin');
  assert.equal(resolveRouteTarget('/admin/provider/safety'), 'admin');
  assert.equal(resolveRouteTarget('/admin//users//1'), 'admin');
});

test('no other path may render a surface', () => {
  for (const p of [
    '/legacy',
    '/old-ui',
    '/test',
    '/index',
    '/adminx',
    '/administrator',
    '/api/process-audio',
    '/assets/index.js',
    '/Admin',           // case-sensitive on purpose
    '/admin/../legacy', // traversal must not smuggle another surface through
  ]) {
    assert.equal(resolveRouteTarget(p), 'not-found', `${p} must 404`);
  }
});

test('query strings and fragments are ignored', () => {
  assert.equal(resolveRouteTarget('/?foo=bar'), 'app');
  assert.equal(resolveRouteTarget('/admin?x=1'), 'admin');
  assert.equal(resolveRouteTarget('/legacy#x'), 'not-found');
});

test('missing or empty input falls back to root', () => {
  assert.equal(resolveRouteTarget(''), 'app');
  assert.equal(resolveRouteTarget('//'), 'app');
});

test('servesAppShell only for the two canonical surfaces', () => {
  assert.equal(servesAppShell('/'), true);
  assert.equal(servesAppShell('/admin'), true);
  assert.equal(servesAppShell('/legacy'), false);
  assert.equal(servesAppShell('/admin/anything'), true);
});
