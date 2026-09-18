import React from 'react';
import { Languages, Sparkles } from 'lucide-react';
import { SupportedLanguage } from '../types';

interface LanguageSelectorProps {
  value: SupportedLanguage;
  onChange: (lang: SupportedLanguage) => void;
  disabled?: boolean;
}

const LANGUAGE_OPTIONS: { value: SupportedLanguage; label: string; sub: string }[] = [
  { value: 'odia', label: 'ଓଡ଼ିଆ (Odia)', sub: 'od-IN' },
  { value: 'hindi', label: 'हिन्दी (Hindi)', sub: 'hi-IN' },
  { value: 'english', label: 'English', sub: 'en-IN' },
];

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  value,
  onChange,
  disabled,
}) => {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex items-center gap-2 mb-3">
        <Languages className="w-4 h-4 text-indigo-600" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
          Transcription Language
        </h3>
        <span className="text-[11px] text-slate-400 ml-auto">Sent to provider</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        {LANGUAGE_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              disabled={disabled}
              className={`text-left p-3 rounded-xl border text-sm transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                selected
                  ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-1.5">
                {selected ? (
                  <Sparkles className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className={`font-semibold ${selected ? 'text-indigo-700' : 'text-slate-800'}`}>
                  {opt.label}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] font-mono text-slate-400">{opt.sub}</div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-slate-500">
        The selected language is sent with every processing request and controls the ASR provider
        language (Odia = od-IN, Hindi = hi-IN, English = en-IN). Select the language spoken in your
        audio/video before starting.
      </p>
    </div>
  );
};