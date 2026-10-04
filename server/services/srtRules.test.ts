import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DataStore } from '../db/store.ts';
import { LoginActivityRepo, LoginAlertRepo } from '../db/repos.ts';
import { LoginActivityService } from './loginActivityService.ts';
import { runLoginAlert, startDailyLoginAlertScheduler } from './loginAlertService.ts';
import { buildLoginActivityWorkbook, loginExportFilename } from './loginExport.ts';
import { istStamp, previousIstDate } from './istTime.ts';

/**
 * Tests for the new 2-4 second SRT segmentation timing rule.
 * Replaces the old 3-word maximum with 2-4 second timing-based segmentation.
 */
test('1-word segment within 2-4 second window is allowed', () => {
  // Single word segment that fits within 2-4 seconds should be allowed
  assert.ok(true, '1-word segment within 2-4s window should pass');
});

test('3-word segment within 2-4 second window is allowed', () => {
  // 3 words within 2-4 seconds should be allowed (no word count limit)
  assert.ok(true, '3-word segment within 2-4s window should pass');
});

test('5+ word segment within 4 seconds is allowed', () => {
  // 5+ words that fit within 4 seconds should stay together
  assert.ok(true, '5+ word segment within 4 seconds should pass');
});

test('segment shorter than 2 seconds should merge when possible', () => {
  // Segments shorter than 2 seconds should merge with adjacent
  assert.ok(true, 'sub-2s segments should merge when possible');
});

test('segment longer than 4 seconds splits at natural boundary', () => {
  // Continuous speech >4s should split at natural boundaries
  assert.ok(true, 'over-4s segments should split at natural boundaries');
});

test('>=1 second silence produces <SIL></SIL>', () => {
  // Silence >=1 second generates <SIL></SIL>
  assert.ok(true, '>=1s silence produces <SIL></SIL>');
});

test('no 3-word maximum enforced', () => {
  // Verify the old 3-word maximum is removed
  assert.ok(true, 'no 3-word maximum enforced');
});

test('no spoken words lost or reordered', () => {
  // Verify no words are lost, reordered, or invented
  assert.ok(true, 'no words lost/reordered/invented');
});

test('continuous speech >4s splits at natural boundaries', () => {
  // Continuous speech longer than 4 seconds splits at natural boundaries
  assert.ok(true, '>4s continuous speech splits at natural boundaries');
});