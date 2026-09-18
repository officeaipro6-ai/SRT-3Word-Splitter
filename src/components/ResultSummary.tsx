import React from 'react';
import { Languages, Captions, MessageSquareText, Clock } from 'lucide-react';
import { SubtitleSegment, TranscriptionResult } from '../types';

interface ResultSummaryProps {
  result: TranscriptionResult;
  segments: SubtitleSegment[];
}

const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}h ${m}m ${s}s`
    : m > 0
      ? `${m}m ${s}s`
      : `${s}s`;
};

export const ResultSummary: React.FC<ResultSummaryProps> = ({ result, segments }) => {
  const spokenWords = segments.reduce(
    (acc, s) => acc + s.text.split(/\s+/).filter(Boolean).length,
    0
  );

  const languageLabel = result.languageName;

  const items = [
    {
      icon: Languages,
      label: 'Selected Language',
      value: languageLabel,
      sub: `Code: ${result.languageCode}`,
    },
    {
      icon: Captions,
      label: 'Total Subtitle Segments',
      value: String(result.segments.length),
      sub: `Max 3 words per segment`,
    },
    {
      icon: MessageSquareText,
      label: 'Total Spoken Words',
      value: spokenWords.toLocaleString(),
      sub: 'Across all clear-speech segments',
    },
    {
      icon: Clock,
      label: 'Audio Duration',
      value: formatDuration(result.durationSeconds),
      sub: 'Sequential SRT timestamps',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-in fade-in duration-300">
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center gap-2">
            <item.icon className="w-4 h-4 text-indigo-600" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {item.label}
            </span>
          </div>
          <div className="mt-2 text-lg font-extrabold text-slate-900">{item.value}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">{item.sub}</div>
        </div>
      ))}
    </div>
  );
};