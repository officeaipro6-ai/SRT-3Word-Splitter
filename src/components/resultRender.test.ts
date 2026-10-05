import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToString, renderToStaticMarkup } from 'react-dom/server';
import { RuleComplianceAudit } from './RuleComplianceAudit';
import { ResultSummary } from './ResultSummary';
import { SubtitleTable } from './SubtitleTable';
import { RawSrtViewer } from './RawSrtViewer';
import { ExportToolbar } from './ExportToolbar';
import { AudioPlayerWaveform } from './AudioPlayerWaveform';
import { ErrorBoundary } from './ErrorBoundary';
import { applyTaggingRule, auditRuleCompliance } from '../utils/srtRules';
import type { SubtitleSegment, TranscriptionResult } from '../types';

/**
 * Regression tests for the production "blank white page after SRT generation"
 * bug. A React render-time throw with no ErrorBoundary unmounts the whole tree,
 * so every component that renders inside the results view must be proven to
 * render here.
 */

const ODIA = ['ଆଜି ସୋମବାର', 'ବର୍ଷା ବହୁତ ହେବ', 'କିନ୍ତୁ ରାହି ନାହିଁ', 'ପୁଣି ଆସିବା'];

function speechSegment(id: number, text: string): SubtitleSegment {
  const startSeconds = (id - 1) * 2.5;
  const endSeconds = startSeconds + 2.4;
  return {
    id,
    startSeconds,
    endSeconds,
    startTimeFormatted: '00:00:02,500',
    endTimeFormatted: '00:00:04,900',
    text,
    classification: 'CLEAR_SPEECH',
    taggedText: applyTaggingRule(text, 'CLEAR_SPEECH', endSeconds - startSeconds).taggedText,
    confidence: 0.98,
  };
}

function buildSegments(count: number): SubtitleSegment[] {
  return Array.from({ length: count }, (_, i) => speechSegment(i + 1, ODIA[i % ODIA.length]));
}

function buildResult(segments: SubtitleSegment[]): TranscriptionResult {
  return {
    detectedLanguage: 'Odia',
    languageCode: 'od-IN',
    languageName: 'Odia',
    requestedLanguage: 'odia',
    isLanguageDetected: false,
    isOdia: true,
    languageConfidence: 0,
    durationSeconds: 120,
    segments,
    rawSrt: '',
    stats: {
      totalSegments: segments.length,
      clearSpeechCount: segments.length,
      speechWithMusicNoiseCount: 0,
      noiseMusicOnlyCount: 0,
      fillerCount: 0,
      silenceCount: 0,
      unintelligibleCount: 0,
      totalDurationSeconds: 120,
      totalDurationFormatted: '00:02:00,000',
    },
  };
}

const noop = () => {};

test('auditRuleCompliance exposes timingRule (the key it actually returns)', () => {
  const audit = auditRuleCompliance(buildSegments(3));
  assert.ok(
    audit.ruleChecks.timingRule,
    'auditRuleCompliance must return ruleChecks.timingRule'
  );
  assert.equal(typeof audit.ruleChecks.timingRule.passed, 'boolean');
  assert.equal(typeof audit.ruleChecks.timingRule.nonCompliantCount, 'number');
});

test('auditRuleCompliance no longer declares/returns the phantom wordLimitRule', () => {
  const audit = auditRuleCompliance(buildSegments(3)) as unknown as Record<string, unknown>;
  assert.equal(
    (audit.ruleChecks as Record<string, unknown>).wordLimitRule,
    undefined,
    'ruleChecks.wordLimitRule must not exist: nothing returns it and the UI must not read it'
  );
});

test('RuleComplianceAudit renders without throwing (the blank-page crash)', () => {
  const html = renderToString(React.createElement(RuleComplianceAudit, { segments: buildSegments(5) }));
  assert.ok(html.length > 0);
  assert.match(html, /Timing Rule/);
});

test('RuleComplianceAudit renders for an empty segment list', () => {
  const html = renderToString(React.createElement(RuleComplianceAudit, { segments: [] }));
  assert.ok(html.length > 0);
});

test('RuleComplianceAudit renders tagged noise/silence/filler segments', () => {
  const tagged: SubtitleSegment[] = [
    {
      id: 1,
      startSeconds: 0,
      endSeconds: 1,
      startTimeFormatted: '00:00:00,000',
      endTimeFormatted: '00:00:01,000',
      text: '',
      classification: 'NOISE_ONLY',
      taggedText: '<NOISE></NOISE>',
    },
    {
      id: 2,
      startSeconds: 1,
      endSeconds: 3,
      startTimeFormatted: '00:00:01,000',
      endTimeFormatted: '00:00:03,000',
      text: 'hmm',
      classification: 'FILLER',
      taggedText: '<FIL>hmm</FIL>',
    },
    {
      id: 3,
      startSeconds: 3,
      endSeconds: 5,
      startTimeFormatted: '00:00:03,000',
      endTimeFormatted: '00:00:05,000',
      text: '',
      classification: 'SILENCE',
      taggedText: '<SIL></SIL>',
    },
  ];
  const html = renderToString(React.createElement(RuleComplianceAudit, { segments: tagged }));
  assert.ok(html.length > 0);
});

test('every results-view component renders for a production-sized result', () => {
  const segments = buildSegments(300);
  const result = buildResult(segments);
  const mediaInfo = {
    name: 'test.mp3',
    size: 1234,
    type: 'audio/mpeg',
    duration: 120,
    url: 'blob:test',
    isVideo: false,
  };

  const views: Array<[string, () => React.ReactElement]> = [
    ['ResultSummary', () => React.createElement(ResultSummary, { result, segments })],
    ['RuleComplianceAudit', () => React.createElement(RuleComplianceAudit, { segments })],
    [
      'SubtitleTable',
      () =>
        React.createElement(SubtitleTable, {
          segments,
          onUpdateSegment: noop,
          onDeleteSegment: noop,
          onAddSegment: noop,
          onPlaySegment: noop,
        }),
    ],
    [
      'RawSrtViewer',
      () =>
        React.createElement(RawSrtViewer, {
          segments,
          transcriptionResult: result,
          onCopySrt: noop,
          copied: false,
        }),
    ],
    [
      'ExportToolbar',
      () =>
        React.createElement(ExportToolbar, {
          fileName: 'test.mp3',
          segments,
          transcriptionResult: result,
          onCopySrt: noop,
          copied: false,
          onReset: noop,
        }),
    ],
    [
      'AudioPlayerWaveform',
      () =>
        React.createElement(AudioPlayerWaveform, {
          mediaInfo,
          segments,
          currentActiveSegment: null,
          currentTime: 0,
          onSeek: noop,
          onPlayPause: noop,
          isPlaying: false,
        }),
    ],
  ];

  for (const [name, make] of views) {
    assert.doesNotThrow(() => renderToString(make()), `${name} must render`);
  }
});

test('ErrorBoundary captures a render error and shows a message, not a blank page', () => {
  // Error boundaries are a client-side React feature: renderToString rethrows
  // instead of using the boundary. The boundary contract is therefore asserted
  // directly - it captures the error and renders a readable fallback.
  const captured = ErrorBoundary.getDerivedStateFromError(new Error('kaboom'));
  assert.ok(captured.error instanceof Error);
  assert.equal(captured.error?.message, 'kaboom');

  const instance = new ErrorBoundary({ children: null });
  instance.state = captured;
  const html = renderToStaticMarkup(instance.render());
  assert.match(html, /Something went wrong/);
  assert.match(html, /kaboom/);
  assert.match(html, /btn-error-boundary-reload/);
});

test('ErrorBoundary is mounted around the app surface', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'main.tsx'), 'utf8');
  assert.match(src, /ErrorBoundary/);
  assert.match(src, /<ErrorBoundary>\{surface\}<\/ErrorBoundary>/);
});

test('App renders a main-area view when a run completes with zero subtitles', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');
  assert.match(
    src,
    /!isProcessing\s*&&\s*transcriptionResult\s*&&\s*segments\.length\s*===\s*0/,
    'App.tsx must render an explicit state for a completed run that produced no cues, otherwise all four main-area gates are false and the page is blank'
  );
});

test('App results view is still gated on completed cues (unchanged behaviour)', () => {
  const src = readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');
  assert.match(src, /segments\.length\s*>\s*0\s*&&\s*!isProcessing/);
});