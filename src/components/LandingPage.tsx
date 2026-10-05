import React from 'react';
import {
  Volume2,
  Mic,
  Captions,
  AudioWaveform,
  ShieldCheck,
  Clock,
  ToggleRight,
  FileDown,
  CheckCircle2,
  Sparkles,
  Info,
  Upload,
  Languages,
} from 'lucide-react';

const FEATURES = [
  { icon: Mic, title: 'AI Speech Transcription', desc: 'Sarvam Saaras (saaras:v4) transcribes the exact uploaded audio in Odia, Hindi, or English.' },
  { icon: AudioWaveform, title: 'Waveform Acoustic Analysis', desc: 'Speech is verified against the real audio to tag background music (BGM), noise, fillers, and laughter.' },
  { icon: ShieldCheck, title: 'Strict Subtitle Rules A–E', desc: 'Segments target 2–4 seconds, silence ≥1.00s is preserved as <SIL></SIL>, and exports follow the strict rule set.' },
  { icon: Captions, title: 'Tagged SRT Export', desc: 'Valid, sequential SRT with <NOISE>, <FIL>, and <SIL> tags — ready for any media player.' },
];

const HOW_IT_WORKS = [
  { step: '1', icon: Upload, title: 'Upload', desc: 'Drop any audio or video file — MP3, WAV, M4A, MP4, MOV and more.' },
  { step: '2', icon: Languages, title: 'Choose Language', desc: 'Select Odia, Hindi, or English. The code is sent to the transcription provider.' },
  { step: '3', icon: AudioWaveform, title: 'Analyze', desc: 'Speech is transcribed and verified against the waveform for BGM, noise, and silence.' },
  { step: '4', icon: ToggleRight, title: 'Tag', desc: 'Rules A–E classify every segment: speech, music, noise, filler, laugh, or silence.' },
  { step: '5', icon: FileDown, title: 'Export', desc: 'Download a valid tagged SRT (or VTT / TXT / JSON) in seconds.' },
];

interface LandingPageProps {
  children?: React.ReactNode;
}

export const LandingPage: React.FC<LandingPageProps> = ({ children }) => {
  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-blue-700 to-indigo-800 text-white p-8 sm:p-12 shadow-lg shadow-indigo-200">
        <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute bottom-0 left-24 w-40 h-40 rounded-full bg-cyan-300/10 blur-2xl" />
        <div className="relative">
          <div className="flex items-center gap-2 text-indigo-200 text-xs font-bold uppercase tracking-widest mb-4">
            <Volume2 className="w-4 h-4" />
            <span>Odia Audio/Video → Tagged SRT</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight leading-tight">
            Speech-Aware Subtitles,
            <br />
            <span className="text-indigo-200">Per Word, Per Tag.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-indigo-100 text-sm sm:text-base leading-relaxed">
            AI-Powered Speech Transcription turns your Odia, Hindi, or English audio and video into
            rule-compliant, tagged SRT subtitles. Designed for accurate subtitle generation — with
            real {'<NOISE>'} and {'<SIL>'} tags verified against the waveform.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 border border-white/25 text-sm font-bold">
            <Sparkles className="w-4 h-4" />
            ODIA <span className="opacity-60">•</span> HINDI <span className="opacity-60">•</span> ENGLISH
          </div>
        </div>
      </div>

      {/* Upload + Language selection */}
      <div>{children}</div>

      {/* Features */}
      <div>
        <h2 className="text-lg font-bold text-slate-900 mb-4">What you get</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <f.icon className="w-6 h-6 text-indigo-600" />
              <h3 className="mt-3 text-sm font-bold text-slate-900">{f.title}</h3>
              <p className="mt-1 text-xs text-slate-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* How It Works */}
      <div>
        <h2 className="text-lg font-bold text-slate-900 mb-4">How it works</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {HOW_IT_WORKS.map((s) => (
            <div key={s.step} className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center h-7 w-7 rounded-full bg-indigo-600 text-white text-xs font-bold">
                  {s.step}
                </span>
                <s.icon className="w-4 h-4 text-indigo-500" />
              </div>
              <h3 className="mt-3 text-sm font-bold text-slate-900">{s.title}</h3>
              <p className="mt-1 text-xs text-slate-500 leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tip */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-amber-100 text-amber-700 shrink-0">
            <Info className="w-4 h-4" />
          </div>
          <div className="text-xs text-amber-900 leading-relaxed">
            <span className="font-bold">Accuracy tip:</span> Speak clearly with minimal background
            music, avoid overlapping voices, and keep unclear speech separate. Transcription quality
            depends on the audio — clear speech yields the most accurate subtitles. No transcription
            is 100% accurate.
          </div>
        </div>
      </div>

      {/* Compliance strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          Maximum 3 spoken words per segment
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          Silence ≥ 2.00s preserved
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          Real {'<NOISE>'} / {'<FIL>'} / {'<SIL>'} tags
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-indigo-500" />
          Sequential SRT timestamps
        </span>
      </div>
    </div>
  );
};