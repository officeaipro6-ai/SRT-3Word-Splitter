import React from 'react';
import { Volume2, BookOpen, RotateCcw, Sparkles, CheckCircle2, ShieldCheck } from 'lucide-react';

interface HeaderProps {
  onOpenRules: () => void;
  onReset: () => void;
  hasData: boolean;
  detectedLanguage?: string;
  isOdia?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenRules,
  onReset,
  hasData,
  detectedLanguage,
  isOdia,
}) => {
  return (
    <header className="border-b border-slate-200 bg-white/95 backdrop-blur-sm sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        {/* Title and Branding */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-700 flex items-center justify-center text-white shadow-sm shadow-indigo-200">
            <Volume2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 tracking-tight">
                ODIA AUDIO/VIDEO → TAGGED SRT
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                ଓଡ଼ିଆ Unicode
              </span>
            </div>
            <p className="text-xs text-slate-500 hidden sm:block">
              Speech Transcription • Waveform Acoustic Analysis • Strict Subtitle Rules A–E
            </p>
          </div>
        </div>

        {/* Action Controls & Badges */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
          {detectedLanguage && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Language: <strong>{detectedLanguage}</strong></span>
              {isOdia && <span className="text-[10px] bg-emerald-200 px-1.5 py-0.2 rounded text-emerald-900 font-bold">MATCH</span>}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={onOpenRules}
              id="btn-rules-guide"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 hover:text-slate-900 transition-colors cursor-pointer border border-slate-200"
            >
              <BookOpen className="w-3.5 h-3.5 text-slate-500" />
              <span>Tagging Rules</span>
            </button>

            {hasData && (
              <button
                onClick={onReset}
                id="btn-reset-pipeline"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition-colors cursor-pointer"
                title="Process another media file"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Process Another</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
