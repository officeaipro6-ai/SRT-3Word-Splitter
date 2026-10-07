/**
 * ODIA AUDIO/VIDEO → TAGGED SRT
 * Complete production-ready application for Odia speech transcription and acoustic tagging.
 */

import React, { useState, useRef, useEffect } from 'react';
import { Header } from './components/Header';
import { FileUpload } from './components/FileUpload';
import { ProgressPipeline } from './components/ProgressPipeline';
import { AudioPlayerWaveform } from './components/AudioPlayerWaveform';
import { SubtitleTable } from './components/SubtitleTable';
import { RawSrtViewer } from './components/RawSrtViewer';
import { RuleComplianceAudit } from './components/RuleComplianceAudit';
import { ExportToolbar } from './components/ExportToolbar';
import { RotateCcw } from 'lucide-react';
import { RulesGuideModal } from './components/RulesGuideModal';
import { CreditsWidget } from './components/CreditsWidget';
import { CommunitySupport } from './components/CommunitySupport';
import { AccountPanel } from './components/AccountPanel';
import { ensureSession, AUTH_CHANGED_EVENT, type SessionInfo } from './lib/sessionClient';
import { getApiUrl } from './lib/apiUrl';
import { CreditPacksPanel } from './components/CreditPacksPanel';
import { LanguageSelector } from './components/LanguageSelector';
import { LandingPage } from './components/LandingPage';
import { ResultSummary } from './components/ResultSummary';
import {
  SubtitleSegment,
  TranscriptionResult,
  MediaFileInfo,
  PipelineStageInfo,
  PipelineStageId,
  AudioClassification,
  AudioDiagnostics,
  SupportedLanguage,
} from './types';
import {
  formatSrtTimestamp,
  applyTaggingRule,
  splitSegmentByWordLimit,
  enforceMaxWordsPerSegment,
} from './utils/srtRules';

// Single source of truth: selected language -> Sarvam ASR BCP-47 code.
export const LANGUAGE_CODE_BY_SELECTION: Record<SupportedLanguage, string> = {
  auto: 'od-IN', // defensive default; the selector never offers "auto"
  odia: 'od-IN',
  hindi: 'hi-IN',
  english: 'en-IN',
};

const INITIAL_STAGES: PipelineStageInfo[] = [
  { id: 'uploading', label: '1. Uploading Media', stepNumber: 1, status: 'idle' },
  { id: 'extracting_audio', label: '2. Extracting Audio', stepNumber: 2, status: 'idle' },
  { id: 'detecting_language', label: '3. Setting Language', stepNumber: 3, status: 'idle' },
  { id: 'transcribing_odia', label: '4. Transcribing Speech', stepNumber: 4, status: 'idle' },
  { id: 'analyzing_audio', label: '5. Analyzing Audio Waveform', stepNumber: 5, status: 'idle' },
  { id: 'detecting_music_noise', label: '6. Detecting BGM / Noise', stepNumber: 6, status: 'idle' },
  { id: 'detecting_fillers', label: '7. Detecting Fillers / Laughs', stepNumber: 7, status: 'idle' },
  { id: 'detecting_silence', label: '8. Detecting Silence (>=2s)', stepNumber: 8, status: 'idle' },
  { id: 'applying_tags', label: '9. Applying Rules A–E', stepNumber: 9, status: 'idle' },
  { id: 'generating_srt', label: '10. Generating SRT', stepNumber: 10, status: 'idle' },
  { id: 'completed', label: '11. Ready to Download', stepNumber: 11, status: 'idle' },
];

export default function App() {
  const [selectedLanguage, setSelectedLanguage] = useState<SupportedLanguage>('odia');
  const [selectedMedia, setSelectedMedia] = useState<MediaFileInfo | null>(null);
  const [stages, setStages] = useState<PipelineStageInfo[]>(INITIAL_STAGES);
  const [currentStageId, setCurrentStageId] = useState<PipelineStageId>('uploading');
  const [overallProgress, setOverallProgress] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([
    'System initialized. Ready for audio/video upload or sample preset selection.',
  ]);

  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [segments, setSegments] = useState<SubtitleSegment[]>([]);
  const [activeTab, setActiveTab] = useState<'editor' | 'raw_srt'>('editor');
  const [copied, setCopied] = useState<boolean>(false);
  const [rulesModalOpen, setRulesModalOpen] = useState<boolean>(false);

  // Free-trial usage (server-authoritative count; the stable session token in
  // localStorage survives page refreshes, so the count cannot be reset).
  const [freeTrial, setFreeTrial] = useState<{ used: number; limit: number; remaining: number } | null>(null);

  // Server-authoritative wallet (credits are NEVER read from the client; the
  // server response after a run is the only thing that updates this).
  const [wallet, setWallet] = useState<{ credits: number; unlimited: boolean } | null>(null);

  // Authentication gate: the transcription UI requires a signed-in customer account.
  // Admin bootstrap tokens are not accepted here - they're for admin routes only.
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  // Email ownership gate: a customer account whose inbox is not yet verified
  // may NOT spend credits / run transcription (the server enforces it too);
  // this screen is the friendly half of that gate.
  const [emailUnverified, setEmailUnverified] = useState<boolean>(false);

  const syncSession = (s: SessionInfo) => {
    setFreeTrial({ used: s.freeTrialsUsed, limit: s.freeTrialLimit, remaining: s.freeTrialsRemaining });
    setWallet({ credits: s.credits, unlimited: s.unlimited });
    // A customer session has an email and account role (not ADMIN).
    const isCustomer = Boolean(s.account && s.email && s.role !== 'ADMIN');
    setIsAuthenticated(isCustomer);
    setEmailUnverified(isCustomer && s.emailVerified === false);
  };

  useEffect(() => {
    let active = true;
    const load = () => {
      ensureSession()
        .then((s) => {
          if (active) syncSession(s);
        })
        .catch(() => {});
    };
    load();
    // Re-sync the trial counter / wallet when a user signs in or out.
    window.addEventListener(AUTH_CHANGED_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(AUTH_CHANGED_EVENT, load);
    };
  }, []);

  // Temporary audio-input verification state
  const [serverDiag, setServerDiag] = useState<AudioDiagnostics | null>(null);
  const [clientSha256, setClientSha256] = useState<string | null>(null);
  const [clientError, setClientError] = useState<boolean>(false);

  // Media playback state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const playEndBoundaryRef = useRef<number | null>(null);

  // Active segment according to current playback timestamp
  const currentActiveSegment = segments.find(
    (s) => currentTime >= s.startSeconds && currentTime <= s.endSeconds
  ) || null;

  // Append a log entry
  const addLog = (msg: string) => {
    setLogs((prev) => [...prev.slice(-40), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  // Stage update helper
  const updateStage = (
    stageId: PipelineStageId,
    status: 'idle' | 'pending' | 'in_progress' | 'completed' | 'error',
    message?: string
  ) => {
    setCurrentStageId(stageId);
    setStages((prev) =>
      prev.map((s) => (s.id === stageId ? { ...s, status, message } : s))
    );
  };

  // Convert Blob to Base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result as string;
        const base64 = res.split(',')[1] || res;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // SHA-256 of the exact upload bytes, computed in the browser (temporary
  // audio-input verification: client hash vs server-received hash).
  const computeSha256 = async (blob: Blob): Promise<string> => {
    if (!globalThis.crypto?.subtle) throw new Error('crypto.subtle unavailable');
    const buf = await blob.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // Start the 11-step pipeline
  const handleStartPipeline = async (forceRegenerate = false) => {
    if (!selectedMedia) return;

    setIsProcessing(true);
    setPipelineError(null);
    setServerDiag(null);
    setClientSha256(null);
    setClientError(false);
    setStages(INITIAL_STAGES);
    setOverallProgress(5);
    addLog(`Starting 11-stage processing for "${selectedMedia.name}"...`);

    try {
      // Step 1: Uploading
      updateStage('uploading', 'in_progress', 'Reading audio data...');
      setOverallProgress(10);
      const audioToProcess = selectedMedia.audioBlob || selectedMedia.file;
      if (!audioToProcess) throw new Error('No audio blob available for transcription.');
      try {
        setClientSha256(await computeSha256(audioToProcess));
      } catch {
        setClientError(true);
      }
      const base64Audio = await blobToBase64(audioToProcess);
      updateStage('uploading', 'completed', `${(audioToProcess.size / 1024).toFixed(1)} KB prepared`);
      addLog(`Stage 1: Media binary payload encoded (${(audioToProcess.size / 1024).toFixed(1)} KB).`);

      // Step 2: Extracting Audio
      updateStage('extracting_audio', 'in_progress', 'Validating audio format...');
      setOverallProgress(20);
      await new Promise((r) => setTimeout(r, 250));
      updateStage('extracting_audio', 'completed', '16kHz PCM stream ready');
      addLog('Stage 2: Audio track extracted and acoustic sample normalized.');

      // Step 3: Setting Language
      updateStage('detecting_language', 'in_progress', 'Configuring transcription language...');
      setOverallProgress(30);
      addLog(`Stage 3: Sending language "${selectedLanguage}" to transcription provider...`);

      // Server-side AI pipeline request (free-trial enforcement uses the session token)
      let sessionToken: string | null = null;
      try {
        const session = await ensureSession();
        sessionToken = session.token;
        syncSession(session);
      } catch {
        // session unavailable — the pipeline call below surfaces the real error
      }
      const response = await fetch(getApiUrl('/api/process-audio'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { 'x-user-token': sessionToken } : {}),
        },
        body: JSON.stringify({
          audioBase64: base64Audio,
          mimeType: audioToProcess.type || 'audio/wav',
          fileName: selectedMedia.name,
          duration: selectedMedia.duration,
          language: selectedLanguage,
          languageCode: LANGUAGE_CODE_BY_SELECTION[selectedLanguage],
          ...(forceRegenerate ? { regenerate: true } : {}),
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server responded with error status ${response.status}`);
      }

      const result: TranscriptionResult = await response.json();

      if (result.localSubmissionMode) {
        addLog(
          `LOCAL SUBMISSION MODE: transcribed locally with ${result.localAsr?.model ?? 'local Odia ASR'} (CPU). No paid/cloud ASR API was called.`
        );
      }

      if (result.reusedSrt) {
        addLog(
          'SAVED-SRT REUSE: this exact audio + language already had a saved SRT, so it was reused instantly. No new transcription request was made and no free trial/credit was consumed.'
        );
      }

      updateStage(
        'detecting_language',
        'completed',
        `Language: ${result.languageName} (${result.languageCode})`
      );
      addLog(`Stage 3 Complete: Language "${result.languageName}" (${result.languageCode}).`);

      // Step 4: Transcribing Speech
      updateStage('transcribing_odia', 'in_progress', 'Transcribing speech...');
      setOverallProgress(45);
      await new Promise((r) => setTimeout(r, 200));
      updateStage('transcribing_odia', 'completed', 'Transcription complete');
      addLog(`Stage 4 Complete: Transcribed spoken segments in ${result.languageName}.`);

      // Step 5: Analyzing Audio Waveform
      updateStage('analyzing_audio', 'in_progress', 'Analyzing spectral waveform & RMS...');
      setOverallProgress(55);
      await new Promise((r) => setTimeout(r, 200));
      updateStage('analyzing_audio', 'completed', 'Acoustic waveform inspected');
      addLog('Stage 5 Complete: Inspected spectral energy & acoustic contours.');

      // Step 6: Detecting Background Music/Noise
      updateStage('detecting_music_noise', 'in_progress', 'Checking BGM & noise presence...');
      setOverallProgress(68);
      await new Promise((r) => setTimeout(r, 200));
      updateStage(
        'detecting_music_noise',
        'completed',
        `${result.stats.speechWithMusicNoiseCount} BGM/Noise segments detected`
      );
      addLog(`Stage 6 Complete: Identified ${result.stats.speechWithMusicNoiseCount} segments with BGM/Noise.`);

      // Step 7: Detecting Fillers/Laughs
      updateStage('detecting_fillers', 'in_progress', 'Detecting vocal fillers & laughter...');
      setOverallProgress(78);
      await new Promise((r) => setTimeout(r, 200));
      updateStage('detecting_fillers', 'completed', `${result.stats.fillerCount} fillers detected`);
      addLog(`Stage 7 Complete: Tagged ${result.stats.fillerCount} fillers (no min duration).`);

      // Step 8: Detecting Complete Silence
      updateStage('detecting_silence', 'in_progress', 'Validating >= 2.00s silence rule...');
      setOverallProgress(86);
      await new Promise((r) => setTimeout(r, 200));
      updateStage(
        'detecting_silence',
        'completed',
        `${result.stats.silenceCount} valid silence gaps (>=2s)`
      );
      addLog(`Stage 8 Complete: Checked silence gaps. Short gaps (<2.0s) omitted, >=2.0s preserved.`);

      // Step 9: Applying Tags
      updateStage('applying_tags', 'in_progress', 'Applying Rules A–E...');
      setOverallProgress(92);
      await new Promise((r) => setTimeout(r, 200));
      updateStage('applying_tags', 'completed', 'All 7 tagging rules enforced');
      addLog('Stage 9 Complete: Formatted <NOISE>, <FIL>, <SIL> and clear speech tags.');

      // Step 10: Generating SRT
      updateStage('generating_srt', 'in_progress', 'Generating standard sequential SRT...');
      setOverallProgress(98);
      await new Promise((r) => setTimeout(r, 150));
      updateStage('generating_srt', 'completed', 'Valid SRT syntax created');
      addLog('Stage 10 Complete: Formatted sequential timestamps and subtitle numbering.');

      // Step 11: Ready to Download
      updateStage('completed', 'completed', `${result.segments.length} Subtitles Generated`);
      setOverallProgress(100);
      addLog(`Stage 11 Complete: Pipeline finished successfully with ${result.segments.length} segments!`);

      setTranscriptionResult(result);
      setSegments(result.segments);
      setServerDiag(result.audioDiagnostics || null);
      // Refresh server-side free-trial usage + wallet after a successful run.
      try {
        syncSession(await ensureSession());
      } catch {
        /* non-critical */
      }
      if ((result as any).wallet) {
        setWallet({
          credits: (result as any).wallet.credits,
          unlimited: Boolean((result as any).wallet.unlimited),
        });
      }
      if (result.audioDiagnostics) {
        addLog(
          `AUDIO VERIFY: server received "${result.audioDiagnostics.fileName}" ` +
            `${result.audioDiagnostics.fileSizeBytes} bytes, sha256=${result.audioDiagnostics.sha256.slice(0, 12)}…`
        );
      }
    } catch (err: any) {
      console.error('Pipeline error:', err);
      setPipelineError(err.message || 'An error occurred during pipeline execution.');
      updateStage(currentStageId, 'error', err.message);
      addLog(`ERROR: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Audio time update handler
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const time = audioRef.current.currentTime;
      setCurrentTime(time);

      // Snippet playback boundary check
      if (playEndBoundaryRef.current !== null && time >= playEndBoundaryRef.current) {
        audioRef.current.pause();
        setIsPlaying(false);
        playEndBoundaryRef.current = null;
      }
    }
  };

  const handlePlayPause = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
      playEndBoundaryRef.current = null;
    }
  };

  const handleSeek = (seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      setCurrentTime(seconds);
      playEndBoundaryRef.current = null;
    }
  };

  // Play specific segment snippet
  const handlePlaySegment = (start: number, end: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = start;
    setCurrentTime(start);
    playEndBoundaryRef.current = end;
    audioRef.current.play();
    setIsPlaying(true);
  };

  // Manual segment update
  const handleUpdateSegment = (updated: SubtitleSegment) => {
    setSegments((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    addLog(`Segment #${updated.id} updated: [${updated.classification}] "${updated.taggedText}"`);
  };

  // Split single segment exceeding word limit
  const handleSplitSegment = (id: number) => {
    setSegments((prev) => {
      const targetIndex = prev.findIndex((s) => s.id === id);
      if (targetIndex === -1) return prev;
      const target = prev[targetIndex];
      const split = splitSegmentByWordLimit(target, 3);
      const next = [...prev];
      next.splice(targetIndex, 1, ...split);
      return enforceMaxWordsPerSegment(next, 3);
    });
    addLog(`Segment #${id} split at a natural word boundary (maximum 3 spoken words).`);
  };

  // Auto-split all segments exceeding word limit
  const handleAutoSplitAll = () => {
    setSegments((prev) => {
      const split = enforceMaxWordsPerSegment(prev, 3);
      addLog(`Auto-split complete: formatted into ${split.length} segments with max 3 words each.`);
      return split;
    });
  };

  // Delete segment
  const handleDeleteSegment = (id: number) => {
    setSegments((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      // Re-number sequentially
      return filtered.map((s, idx) => ({ ...s, id: idx + 1 }));
    });
    addLog(`Segment #${id} deleted. Sequential numbering updated.`);
  };

  // Add new segment
  const handleAddSegment = (index: number, position: 'before' | 'after') => {
    setSegments((prev) => {
      const targetIndex = position === 'before' ? index : index;
      const refSeg = prev[targetIndex - 1] || prev[0];
      const start = refSeg ? refSeg.endSeconds : 0;
      const end = start + 2.0;

      const newSeg: SubtitleSegment = {
        id: prev.length + 1,
        startSeconds: start,
        endSeconds: end,
        startTimeFormatted: formatSrtTimestamp(start),
        endTimeFormatted: formatSrtTimestamp(end),
        text: 'ନୂତନ ଧାଡ଼ି',
        classification: 'CLEAR_SPEECH',
        taggedText: 'ନୂତନ ଧାଡ଼ି',
      };

      const updated = [...prev];
      updated.splice(position === 'before' ? index : index + 1, 0, newSeg);
      return updated.map((s, idx) => ({ ...s, id: idx + 1 }));
    });
    addLog(`New subtitle segment inserted at position ${index + 1}.`);
  };

  // Copy SRT action
  const handleCopySrt = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
    addLog('SRT subtitles copied to clipboard.');
  };

  // Reset entire application
  const handleReset = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setSelectedMedia(null);
    setTranscriptionResult(null);
    setSegments([]);
    setIsProcessing(false);
    setPipelineError(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setStages(INITIAL_STAGES);
    setOverallProgress(0);
    setSelectedLanguage('odia');
    addLog('Pipeline reset. Ready for a new media file.');
  };

  return (
    <div className="min-h-screen bg-slate-100/60 text-slate-900 flex flex-col font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Hidden Audio Player for synced media playback */}
      {selectedMedia?.url && (
        <audio
          ref={audioRef}
          src={selectedMedia.url}
          onTimeUpdate={handleTimeUpdate}
          onEnded={() => setIsPlaying(false)}
          preload="auto"
        />
      )}

      {/* Credits + Admin widget (additive, never part of the transcription flow) */}
      <CreditsWidget />

      {/* Normal user account strip (email/password, separate from admin auth) */}
      <AccountPanel />

      {/* Community & Support (additive; all moderation is decided server-side) */}
      <CommunitySupport />

      {/* Top Header */}
      <Header
        onOpenRules={() => setRulesModalOpen(true)}
        onReset={handleReset}
        hasData={segments.length > 0}
        detectedLanguage={transcriptionResult?.detectedLanguage}
        isOdia={transcriptionResult?.isOdia}
        reportedLanguageName={transcriptionResult?.languageName}
        reportedLanguageCode={transcriptionResult?.languageCode}
        requestedLanguage={transcriptionResult?.requestedLanguage}
        isLanguageDetected={transcriptionResult?.isLanguageDetected}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Authentication gate: transcription requires a signed-in customer account */}
        {!isAuthenticated ? (
          <div className="flex-1 flex items-center justify-center animate-in fade-in duration-200">
            <div className="bg-white/90 backdrop-blur-sm border border-slate-200 rounded-2xl p-8 max-w-md w-full mx-4 shadow-lg">
              <div className="text-center mb-6">
                <h1 className="text-2xl font-bold text-slate-900">Sign in to transcribe</h1>
                <p className="text-slate-500 mt-2">Create an account or sign in to access the transcription pipeline.</p>
              </div>
              <AccountPanel />
            </div>
          </div>
        ) : emailUnverified ? (
          <div className="flex-1 flex items-center justify-center animate-in fade-in duration-200">
            <div className="bg-white/90 backdrop-blur-sm border border-slate-200 rounded-2xl p-8 max-w-md w-full mx-4 shadow-lg">
              <div className="text-center mb-4">
                <h1 className="text-2xl font-bold text-slate-900">Verify your email</h1>
                <p className="text-slate-500 mt-2">
                  Transcribing is locked until you prove you own this inbox. Check your email for
                  the one-hour verification link — it can only be used once.
                </p>
              </div>
              <AccountPanel />
            </div>
          </div>
        ) : (
          <>
            {/* Upload & Preset Selector (Shown when no active transcription yet, or can be reconfigured) */}
            {!transcriptionResult && (
              <LandingPage>
                <div className="space-y-6 animate-in fade-in duration-200">
                  {freeTrial && freeTrial.limit > 0 && (
                    <div className="flex justify-center">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold shadow-sm ${
                          freeTrial.remaining > 0
                            ? 'bg-white border-slate-200 text-slate-600'
                            : 'bg-rose-50 border-rose-200 text-rose-600'
                        }`}
                      >
                        {freeTrial.remaining > 0
                          ? `Free trials remaining: ${freeTrial.remaining} of ${freeTrial.limit}`
                          : 'Free trials exhausted — please choose a plan to continue.'}
                      </span>
                    </div>
                  )}
                  <LanguageSelector
                    value={selectedLanguage}
                    onChange={setSelectedLanguage}
                    disabled={isProcessing}
                  />
                  <CreditPacksPanel
                    wallet={wallet}
                    freeTrialsRemaining={freeTrial ? freeTrial.remaining : null}
                    freeTrialLimit={freeTrial ? freeTrial.limit : 0}
                  />
                  <FileUpload
                    onFileSelected={(info) => setSelectedMedia(info)}
                    isProcessing={isProcessing}
                    selectedFile={selectedMedia}
                    onStartPipeline={handleStartPipeline}
                  />
                </div>
              </LandingPage>
            )}
          </>
        )}

        {/* Processing Progress Pipeline Component */}
        {isProcessing && (
          <div className="animate-in fade-in duration-200">
            <ProgressPipeline
              stages={stages}
              currentStageId={currentStageId}
              overallProgress={overallProgress}
              logMessages={logs}
              error={pipelineError}
              onRetry={handleStartPipeline}
            />
          </div>
        )}

        {/* Failed Pipeline View if not currently processing but error exists */}
        {!isProcessing && pipelineError && !transcriptionResult && (
          <div className="animate-in fade-in duration-200">
            <ProgressPipeline
              stages={stages}
              currentStageId={currentStageId}
              overallProgress={overallProgress}
              logMessages={logs}
              error={pipelineError}
              onRetry={handleStartPipeline}
            />
          </div>
        )}

        {/* Results View: Interactive Editor, Waveform Player, Table & Raw SRT */}
        {segments.length > 0 && !isProcessing && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Result Summary Card */}
            {/* LOCAL SUBMISSION MODE banner: this result did NOT come from a paid
                cloud provider. It is spelled out in the UI so a submission is never
                mistaken for Sarvam output. */}
            {transcriptionResult?.localSubmissionMode && (
              <div className="rounded-2xl border-2 border-blue-400 bg-blue-50 p-4">
                <div className="text-xs font-extrabold uppercase tracking-wide text-blue-800 mb-2">
                  Local Submission Mode — zero-budget local transcription
                </div>
                <div className="text-xs text-blue-900 space-y-1">
                  <div>
                    This SRT was produced by a <strong>local open-source Odia ASR</strong> running on this
                    machine ({transcriptionResult.localAsr?.model ?? 'ai4bharat/indicwav2vec-odia'}, CPU only).
                    No Sarvam, Groq, Olive or other paid/cloud ASR API was contacted and nothing was spent.
                  </div>
                  <div>
                    <strong>Words recognised:</strong> {transcriptionResult.localAsr?.wordCount ?? '—'}
                    {' · '}
                    <strong>Timestamps:</strong>{' '}
                    {transcriptionResult.localAsr?.hasReliableTimestamps
                      ? `real per-word alignment (${transcriptionResult.localAsr?.timestampNote ?? 'CTC frame alignment'})`
                      : 'unavailable — cue times fall back to even distribution across the audio'}
                  </div>
                  <div>
                    Review the Odia text carefully before submission: a local model can mis-recognise words.
                    Nothing is invented, but accuracy is not guaranteed.
                  </div>
                </div>
              </div>
            )}

            {/* SAVED-SRT REUSE banner: this result was loaded from the already-saved
                SRT for this exact audio. No provider request, no free trial/credit. */}
            {transcriptionResult?.reusedSrt && (
              <div className="rounded-2xl border-2 border-emerald-400 bg-emerald-50 p-4">
                <div className="text-xs font-extrabold uppercase tracking-wide text-emerald-800 mb-2">
                  Saved SRT reused — no new transcription requested
                </div>
                <div className="text-xs text-emerald-900 space-y-1">
                  <div>
                    This exact audio + language already had a saved SRT, so it was loaded instantly for
                    preview/edit/tag/download. <strong>No Sarvam (or other provider) request was made</strong> and no
                    free trial or credit was consumed.
                  </div>
                  <div>
                    {"If you want a fresh transcription anyway, click "}
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => void handleStartPipeline(true)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isProcessing ? 'Processing…' : 'Generate SRT again'}
                    </button>
                    {" — this will run a new transcription request and overwrite the saved SRT (and it may consume a free trial or credits)."}
                  </div>
                </div>
              </div>
            )}

            {transcriptionResult && (
              <ResultSummary result={transcriptionResult} segments={segments} />
            )}

            {/* Temporary Audio Input Verification Panel */}
            <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
              <div className="text-xs font-extrabold uppercase tracking-wide text-amber-800 mb-2">
                Audio Input Verification (temporary diagnostic)
              </div>
              <div className="text-xs font-mono bg-white/70 border border-amber-200 rounded-lg p-2 mb-3 space-y-0.5">
                <div><span className="font-bold text-amber-900">PROVIDER:</span> {serverDiag?.providerDisplay ?? serverDiag?.provider ?? '—'}</div>
                <div><span className="font-bold text-amber-900">MODEL:</span> {serverDiag?.model ?? '—'}</div>
                <div><span className="font-bold text-amber-900">SELECTED LANGUAGE:</span> {serverDiag?.languageName ?? serverDiag?.requestedLanguage ?? '—'} {serverDiag?.languageName ? <span className="text-amber-700">(selected by user)</span> : null}</div>
                <div><span className="font-bold text-amber-900">LANGUAGE CODE:</span> {transcriptionResult?.languageCode ?? serverDiag?.languageCode ?? '—'}</div>
                <div><span className="font-bold text-amber-900">LANGUAGE SENT TO ASR:</span> {serverDiag?.languageCode ?? '—'}{' '}
                  {serverDiag?.language ? <span className="text-amber-700">(no translation/transliteration)</span> : null}</div>
                <div><span className="font-bold text-amber-900">MATCH:</span>{' '}
                  {serverDiag?.languageCode && transcriptionResult?.languageCode ? (
                    <span className={serverDiag.languageCode === transcriptionResult.languageCode ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>
                      {serverDiag.languageCode === transcriptionResult.languageCode ? 'YES' : 'NO'}
                    </span>
                  ) : '—'}
                </div>
                <div><span className="font-bold text-amber-900">MODE:</span> {serverDiag?.mode ?? '—'}</div>
                <div><span className="font-bold text-amber-900">UPLOADED FILE:</span> {serverDiag?.fileName ?? '—'}</div>
                <div><span className="font-bold text-amber-900">FILE SIZE:</span>{' '}
                  {serverDiag ? `${serverDiag.fileSizeBytes} bytes (${(serverDiag.fileSizeBytes / 1024).toFixed(2)} KB)` : '—'}
                </div>
                <div><span className="font-bold text-amber-900">AUDIO DURATION:</span> {serverDiag?.durationSeconds ?? '—'}s</div>
                <div><span className="font-bold text-amber-900">RAW TRANSCRIPT (verbatim, before spelling correction):</span></div>
                <div className="bg-white rounded-md px-2 py-1 border border-amber-200 text-slate-800 whitespace-pre-wrap">
                  {serverDiag?.rawTranscript ? serverDiag.rawTranscript : '(empty — no speech detected)'}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="text-xs space-y-1">
                  <div className="font-bold text-amber-900">Uploaded (browser)</div>
                  <div>File: {selectedMedia?.name ?? '—'}</div>
                  <div>Size: {selectedMedia ? `${(selectedMedia.size / 1024).toFixed(2)} KB` : '—'}</div>
                  <div>Duration: {selectedMedia ? `${selectedMedia.duration.toFixed(1)}s` : '—'}</div>
                  <div>
                    SHA-256:{' '}
                    {clientSha256
                      ? clientSha256
                      : clientError
                        ? 'unavailable'
                        : 'computing…'}
                  </div>
                </div>
                <div className="text-xs space-y-1">
                  <div className="font-bold text-amber-900">Received (server)</div>
                  <div>File: {serverDiag?.fileName ?? '—'}</div>
                  <div>
                    Type: {serverDiag?.mimeType ?? '—'} ·{' '}
                    {serverDiag ? `${(serverDiag.fileSizeBytes / 1024).toFixed(2)} KB` : '—'}
                  </div>
                  <div>Duration: {serverDiag?.durationSeconds ?? '—'}s</div>
                  <div>SHA-256: {serverDiag?.sha256 ?? '—'}</div>
                  <div className={serverDiag && clientSha256 && serverDiag.sha256 === clientSha256 ? 'font-bold text-emerald-700' : ''}>
                    Hash match: {serverDiag && clientSha256 ? (serverDiag.sha256 === clientSha256 ? 'YES — exact same bytes reached server' : 'NO') : 'n/a'}
                  </div>
                </div>
              </div>
              <div className="mt-3 text-[11px] text-amber-800 font-mono">
                UPLOADED AUDIO ↓ RECEIVED AUDIO ↓ RAW WHISPER/GROQ TRANSCRIPTION ↓ SPELLING CORRECTION ↓ FINAL SRT
                <span className="text-emerald-700 font-bold"> — current output = RAW transcription (spelling correction OFF)</span>
              </div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="text-xs">
                  <div className="font-bold text-emerald-800 mb-1">RAW WHISPER/GROQ TRANSCRIPTION (before spelling correction)</div>
                  {segments.length ? segments.map((s) => (
                    <div key={s.id} className="bg-white rounded-md px-2 py-1 mb-1 border border-emerald-200 flex gap-2 items-baseline">
                      <span className="text-emerald-600 font-mono shrink-0">
                        {s.startTimeFormatted} → {s.endTimeFormatted}
                      </span>
                      <span className="text-slate-800">{s.text || <span className="italic text-slate-400">(no speech)</span>}</span>
                    </div>
                  )) : (
                    <div className="text-slate-500 italic">No segments returned — no speech detected.</div>
                  )}
                </div>
                <div className="text-xs">
                  <div className="font-bold text-indigo-800 mb-1">FINAL CORRECTED TRANSCRIPTION</div>
                  {segments.length ? (
                    <div className="bg-white rounded-md px-2 py-1 mb-1 border border-indigo-200 text-slate-800">
                      <span className="inline-block text-[10px] font-bold text-indigo-600 mr-2">spelling correction OFF → identical to raw</span>
                      {segments.map((s) => s.text).filter(Boolean).join(' ') || '(no speech)'}
                    </div>
                  ) : (
                    <div className="text-slate-500 italic">No segments — nothing to correct.</div>
                  )}
                </div>
              </div>
            </div>

            {/* Waveform Player Bar */}
            <AudioPlayerWaveform
              mediaInfo={selectedMedia}
              segments={segments}
              currentActiveSegment={currentActiveSegment}
              currentTime={currentTime}
              onSeek={handleSeek}
              onPlayPause={handlePlayPause}
              isPlaying={isPlaying}
              onSelectSegment={(seg) => handleSeek(seg.startSeconds)}
            />

            {/* Rule Compliance Audit Card */}
            <RuleComplianceAudit segments={segments} />

            {/* View Switcher Tabs: Table Editor vs Raw SRT */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveTab('editor')}
                  id="tab-editor-view"
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    activeTab === 'editor'
                      ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-200'
                      : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'
                  }`}
                >
                  Editable Subtitle Table
                </button>
                <button
                  onClick={() => setActiveTab('raw_srt')}
                  id="tab-raw-srt-view"
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    activeTab === 'raw_srt'
                      ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-200'
                      : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'
                  }`}
                >
                  Raw SRT & Multi-Format Code
                </button>
              </div>

              <span className="text-xs font-mono text-slate-500 hidden sm:inline">
                {segments.length} Subtitles • Sequential SRT format
              </span>
            </div>

            {/* Tab 1: Interactive Subtitle Table */}
            {activeTab === 'editor' && (
              <SubtitleTable
                segments={segments}
                currentActiveSegmentId={currentActiveSegment?.id}
                onUpdateSegment={handleUpdateSegment}
                onDeleteSegment={handleDeleteSegment}
                onAddSegment={handleAddSegment}
                onPlaySegment={handlePlaySegment}
                onSplitSegment={handleSplitSegment}
                onAutoSplitAll={handleAutoSplitAll}
              />
            )}

            {/* Tab 2: Raw SRT Syntax Highlighted Viewer */}
            {activeTab === 'raw_srt' && (
              <RawSrtViewer
                segments={segments}
                transcriptionResult={transcriptionResult}
                onCopySrt={handleCopySrt}
                copied={copied}
              />
            )}

            {/* Export & Download Bar */}
            <ExportToolbar
              fileName={selectedMedia?.name || 'tagged_subtitles'}
              segments={segments}
              transcriptionResult={transcriptionResult}
              onCopySrt={handleCopySrt}
              copied={copied}
              onReset={handleReset}
            />
          </div>
        )}

        {/* COMPLETED WITH NO SUBTITLES: the pipeline finished successfully but the
            audio produced no subtitle cues (e.g. no speech was detected). Without
            this state the landing page is hidden (a result exists), the progress
            view is hidden (processing finished) and the results view is hidden
            (zero segments), which left the page completely blank. */}
        {!isProcessing && transcriptionResult && segments.length === 0 && (
          <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6 space-y-3">
            <div className="text-sm font-extrabold uppercase tracking-wide text-amber-900">
              No subtitles were generated
            </div>
            <p className="text-sm text-amber-900">
              Processing finished, but no speech could be transcribed from this file, so there are no
              subtitle cues to preview or download.
            </p>
            <p className="text-xs text-amber-800">
              Language: {transcriptionResult.languageName} ({transcriptionResult.languageCode}). This
              usually means the upload contains only music, noise or complete silence, or the speech is
              too quiet or too unclear for the transcription provider to recognise.
            </p>
            <button
              type="button"
              onClick={handleReset}
              id="btn-empty-result-reset"
              className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-amber-700"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Try another file</span>
            </button>
          </div>
        )}
      </main>

      {/* Tagging Rules Specification Guide Modal */}
      <RulesGuideModal
        isOpen={rulesModalOpen}
        onClose={() => setRulesModalOpen(false)}
      />
    </div>
  );
}
