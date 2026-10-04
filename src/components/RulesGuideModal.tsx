import React from 'react';
import { X, CheckCircle2, AlertTriangle, Music, Mic, VolumeX, Sparkles, Clock, Info } from 'lucide-react';

interface RulesGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RulesGuideModal: React.FC<RulesGuideModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/80">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <span>Exact Subtitle Tagging Specification</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 font-semibold">
                Rules A – F
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Strict execution order: Language Selection → Speech Transcription → Acoustic Analysis → Tagging
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 text-sm text-slate-700">
          {/* 3-Word Limit Mandatory Rule */}
          <div className="p-4 rounded-xl bg-indigo-50/80 border border-indigo-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-indigo-950 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-indigo-600" />
                MANDATORY RULE — 2–4 Second Duration Per Subtitle Segment
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-indigo-200 text-indigo-900">
                2–4 Seconds / Segment
              </span>
            </div>
            <p className="text-xs text-indigo-950/90">
              Each subtitle segment targets <strong>2–4 seconds</strong>. There is <strong>NO maximum word count</strong>. Segments naturally fit spoken words within the timing boundary. If a segment exceeds 4 seconds, it is split at a natural speech boundary. Segments under 2 seconds may be merged with adjacent spoken content.
            </p>
            <ul className="text-xs list-disc list-inside space-y-1 text-indigo-900">
              <li>Original Unicode text is preserved exactly (no rewriting, translation, or omissions).</li>
              <li>Words are never split across segments.</li>
              <li>Timestamps are recalculated proportionally and remain continuous.</li>
              <li><code>&lt;NOISE&gt;</code>, <code>&lt;FILLER&gt;</code>, and <code>&lt;SILENCE&gt;</code> tags remain intact on all split segments. (Tags do not count toward the 3-word limit).</li>
            </ul>
            <div className="p-2.5 bg-white rounded-lg border border-indigo-200 font-mono text-xs text-slate-800 space-y-1">
              <div className="text-slate-500 text-[10px] font-sans font-bold">EXAMPLE:</div>
              <div className="text-slate-400">Before: &lt;NOISE&gt;ଓଡ଼ିଶାରେ ଆଜି ବହୁତ ଭଲ ପାଗ ରହିଛି&lt;/NOISE&gt;</div>
              <div className="text-indigo-700 font-bold">
                Segment 1: &lt;NOISE&gt;ଓଡ଼ିଶାରେ ଆଜି ବହୁତ&lt;/NOISE&gt;<br />
                Segment 2: &lt;NOISE&gt;ଭଲ ପାଗ ରହିଛି&lt;/NOISE&gt;
              </div>
            </div>
          </div>

          {/* Rule A */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 flex items-center gap-1.5">
                <Mic className="w-4 h-4 text-emerald-600" />
                RULE A — Clear Speech
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                Unchanged Speech
              </span>
            </div>
            <p className="text-xs text-slate-600">
              If the segment contains clear speech and there is <strong>NO audible background music or noise</strong>: Output the speech text unchanged. <strong>DO NOT add any tag.</strong>
            </p>
            <div className="p-2.5 bg-white rounded-lg border border-slate-200 font-mono text-xs text-slate-800">
              1<br />
              00:00:02,514 --&gt; 00:00:03,041<br />
              <span className="text-emerald-700 font-bold">କେନ୍ଦୁଝରରେ</span>
            </div>
          </div>

          {/* Rule B */}
          <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-amber-950 flex items-center gap-1.5">
                <Music className="w-4 h-4 text-amber-600" />
                RULE B — Speech + Background Noise
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-amber-200 text-amber-900">
                &lt;NOISE&gt;speech&lt;/NOISE&gt;
              </span>
            </div>
            <p className="text-xs text-amber-900/90">
              If speech is present <strong>AND any audible background noise is present</strong> (no music): Put the entire spoken text inside <code>&lt;NOISE&gt;</code>.
            </p>
            <div className="p-2.5 bg-white rounded-lg border border-amber-200 font-mono text-xs text-slate-800">
              2<br />
              00:00:03,041 --&gt; 00:00:04,000<br />
              <span className="text-amber-700 font-bold">&lt;NOISE&gt;କାଳବୈଶାଖୀର&lt;/NOISE&gt;</span>
            </div>
          </div>

          {/* Rule C */}
          <div className="p-4 rounded-xl bg-orange-50/70 border border-orange-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-orange-950 flex items-center gap-1.5">
                <VolumeX className="w-4 h-4 text-orange-600" />
                RULE C — Only Music or Only Noise (No Speech)
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-orange-200 text-orange-900">
                &lt;NOISE&gt;&lt;/NOISE&gt;
              </span>
            </div>
            <p className="text-xs text-orange-900/90">
              If there is <strong>NO speech</strong> and the segment contains only Music, BGM, Sound Effects, Clap, Cough, Bang, Environmental Noise: Output exactly <code>&lt;NOISE&gt;&lt;/NOISE&gt;</code>. <strong>Do NOT use &lt;MUSIC&gt;&lt;/MUSIC&gt;.</strong>
            </p>
            <div className="p-2.5 bg-white rounded-lg border border-orange-200 font-mono text-xs text-slate-800">
              3<br />
              00:00:05,000 --&gt; 00:00:05,700<br />
              <span className="text-orange-700 font-bold">&lt;NOISE&gt;&lt;/NOISE&gt;</span>
            </div>
          </div>

          {/* Rule D */}
          <div className="p-4 rounded-xl bg-purple-50/70 border border-purple-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-purple-950 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-purple-600" />
                RULE D — Fillers & Laughs
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-purple-200 text-purple-900">
                &lt;FIL&gt;...&lt;/FIL&gt;
              </span>
            </div>
            <p className="text-xs text-purple-900/90">
              Detect fillers and laughs (hmm, hm, hmmm, uh, um, ah, oh, haa, hehe, haha, laughter). Wrap only the filler/laugh content. <strong>FILLER has NO minimum duration</strong> (even 100ms or 2 seconds).
            </p>
            <div className="p-2.5 bg-white rounded-lg border border-purple-200 font-mono text-xs text-slate-800">
              4<br />
              00:00:18,100 --&gt; 00:00:20,175<br />
              <span className="text-purple-700 font-bold">&lt;FIL&gt;hmm&lt;/FIL&gt;</span>
            </div>
          </div>

          {/* Rule E */}
          <div className="p-4 rounded-xl bg-slate-100 border border-slate-300 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-slate-600" />
                RULE E — Complete Silence (Duration Rule)
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-slate-200 text-slate-800">
                &gt;= 2.00s Only
              </span>
            </div>
            <p className="text-xs text-slate-700">
              Only create a SILENCE tag when audio is <strong>COMPLETE silence for 1.00 seconds or longer</strong>:
            </p>
            <ul className="text-xs list-disc list-inside space-y-1 text-slate-600">
              <li><strong>0–0.99 seconds</strong> complete silence = <strong>IGNORE</strong></li>
              <li><strong>1.00 seconds or more</strong> complete silence = <code>&lt;SIL&gt;&lt;/SIL&gt;</code></li>
              <li>Background music/noise means it is NOT silence.</li>
            </ul>
            <div className="p-2.5 bg-white rounded-lg border border-slate-300 font-mono text-xs text-slate-800">
              5<br />
              00:00:22,500 --&gt; 00:00:25,000<br />
              <span className="text-slate-700 font-bold">&lt;SIL&gt;&lt;/SIL&gt;</span>
            </div>
          </div>

          {/* Rule F */}
          <div className="p-4 rounded-xl bg-cyan-50/70 border border-cyan-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-cyan-950 flex items-center gap-1.5">
                <Info className="w-4 h-4 text-cyan-600" />
                RULE F — Unintelligible / Music-Masked Speech
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-cyan-200 text-cyan-900">
                Plain text (no &lt;MB&gt;)
              </span>
            </div>
            <p className="text-xs text-cyan-900/90">
              If a segment contains <strong>human speech</strong> that cannot be understood (mumbling, heavy distortion, mixed with loud noise, or speech <strong>masked by background music</strong>), the segment's actual existing transcript text is output as <strong>plain text</strong>. <code>&lt;MB&gt;&lt;/MB&gt;</code> tagging is <strong>disabled</strong>: <code>&lt;MB&gt;</code> is never generated, and missing words are never invented.
            </p>
            <div className="p-2.5 bg-white rounded-lg border border-cyan-200 font-mono text-xs text-slate-800">
              6<br />
              00:00:30,000 --&gt; 00:00:33,200<br />
              ଏହି ଖବର
            </div>
          </div>

          {/* Summary of Durations & Speech Guarantee */}
          <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 text-xs text-blue-900 space-y-1.5">
            <div className="font-bold text-blue-950 flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4 text-blue-600" />
              Key Pipeline Guarantees
            </div>
            <p>• <strong>Never lose speech</strong>: Speech is never replaced with empty tags.</p>
            <p>• <strong>Strict Unicode preservation</strong>: words stay in their native script (ଓଡ଼ିଆ, हिन्दी, English), never transliterated.</p>
            <p>• <strong>Normal sequential SRT numbering</strong> (1, 2, 3...) with standard timestamps.</p>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs transition-colors cursor-pointer"
          >
            Got It, Close Guide
          </button>
        </div>
      </div>
    </div>
  );
};
