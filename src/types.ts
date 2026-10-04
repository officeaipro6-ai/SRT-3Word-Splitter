export type AudioClassification =
  | 'CLEAR_SPEECH'
  | 'SPEECH_WITH_MUSIC'
  | 'SPEECH_WITH_NOISE'
  | 'MUSIC_ONLY'
  | 'NOISE_ONLY'
  | 'FILLER'
  | 'LAUGH'
  | 'SILENCE'
  | 'UNINTELLIGIBLE_SPEECH';

export interface SubtitleSegment {
  id: number;
  startSeconds: number;
  endSeconds: number;
  startTimeFormatted: string; // "00:00:02,514"
  endTimeFormatted: string;   // "00:00:03,041"
  text: string;               // Odia text or filler term
  classification: AudioClassification;
  taggedText: string;         // Resulting text after applying Rules A-E
  confidence?: number;
  acousticNote?: string;
  wordTimings?: Array<{
  word: string;
  startSeconds: number;
  endSeconds: number;
}>;
}

export type PipelineStageId =
  | 'uploading'
  | 'extracting_audio'
  | 'detecting_language'
  | 'transcribing_odia'
  | 'analyzing_audio'
  | 'detecting_music_noise'
  | 'detecting_fillers'
  | 'detecting_silence'
  | 'applying_tags'
  | 'generating_srt'
  | 'completed';

export interface PipelineStageInfo {
  id: PipelineStageId;
  label: string;
  stepNumber: number;
  status: 'idle' | 'pending' | 'in_progress' | 'completed' | 'error';
  message?: string;
  timestamp?: number;
}

export interface TranscriptionStats {
  totalSegments: number;
  clearSpeechCount: number;
  speechWithMusicNoiseCount: number;
  noiseMusicOnlyCount: number;
  fillerCount: number;
  silenceCount: number;
  unintelligibleCount: number;
  totalDurationSeconds: number;
  totalDurationFormatted: string;
}

export interface AudioDiagnostics {
  provider?: string;
  providerDisplay?: string;
  model?: string;
  language?: string;
  languageCode?: string;
  asrReportedLanguage?: string;
  languageName?: string;
  requestedLanguage?: SupportedLanguage;
  mode?: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSeconds: number;
  sha256: string;
  rawTranscript?: string;
  chunkCount?: number;
  wordCount?: number;
  languageSentToWhisper?: string;
  rawSegmentCount?: number;
  rawWordCount?: number;
  finalSegmentCount?: number;
  maxWordsPerSegment?: number;
}

export type SupportedLanguage = 'auto' | 'odia' | 'hindi' | 'english';

export interface TranscriptionResult {
  detectedLanguage: string;
  languageCode: string;
  languageName: string;
  requestedLanguage: SupportedLanguage;
  isLanguageDetected: boolean;
  isOdia: boolean;
  languageConfidence: number;
  durationSeconds: number;
  segments: SubtitleSegment[];
  rawSrt: string;
  stats: TranscriptionStats;
  notes?: string[];
  audioDiagnostics?: AudioDiagnostics;
  /**
   * SAVED-SRT REUSE: true when this result came from the already-saved SRT for
   * the exact same uploaded audio + language. No provider request was made and
   * no free trial/credit was consumed.
   */
  reusedSrt?: boolean;
  /**
   * LOCAL SUBMISSION MODE: true when this result came from the local,
   * zero-budget, open-source Odia ASR instead of a paid cloud provider.
   */
  localSubmissionMode?: boolean;
  localAsr?: {
    model: string;
    modelDir: string | null;
    device: string;
    wordCount: number;
    hasReliableTimestamps: boolean;
    timestampNote: string | null;
    meanLogProb: number | null;
    inferenceSeconds: number | null;
  };
}

export interface MediaFileInfo {
  name: string;
  size: number;
  type: string;
  duration: number;
  url: string;
  isVideo: boolean;
  file?: File;
  audioBlob?: Blob;
}
