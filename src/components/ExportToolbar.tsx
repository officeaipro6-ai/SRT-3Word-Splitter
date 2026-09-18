import React from 'react';
import { Download, Copy, Check, FileText, RotateCcw, Sparkles } from 'lucide-react';
import { SubtitleSegment, TranscriptionResult } from '../types';
import {
  generateSrtContent,
  generateVttContent,
  generateTxtContent,
} from '../utils/srtRules';

interface ExportToolbarProps {
  fileName: string;
  segments: SubtitleSegment[];
  transcriptionResult: TranscriptionResult | null;
  onCopySrt: () => void;
  copied: boolean;
  onReset: () => void;
}

export const ExportToolbar: React.FC<ExportToolbarProps> = ({
  fileName,
  segments,
  transcriptionResult,
  onCopySrt,
  copied,
  onReset,
}) => {
  const baseName = fileName.replace(/\.[^/.]+$/, '') || 'tagged_subtitles';

  const downloadFile = (content: string, ext: string, mime: string) => {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadSrt = () => {
    const content = generateSrtContent(segments);
    downloadFile(content, 'srt', 'text/plain');
  };

  const handleDownloadVtt = () => {
    const content = generateVttContent(segments);
    downloadFile(content, 'vtt', 'text/vtt');
  };

  const handleDownloadTxt = () => {
    const content = generateTxtContent(segments);
    downloadFile(content, 'txt', 'text/plain');
  };

  const handleDownloadJson = () => {
    const content = JSON.stringify(transcriptionResult || { segments }, null, 2);
    downloadFile(content, 'json', 'application/json');
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
      {/* File Info Summary */}
      <div className="space-y-0.5">
        <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-indigo-600" />
          <span>Export Tagged Subtitles</span>
        </div>
        <p className="text-xs text-slate-500">
          Standard UTF-8 SRT with strict Unicode & Rule A–E tags
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onCopySrt}
          id="btn-toolbar-copy"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
        >
          {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
          <span>{copied ? 'Copied!' : 'Copy SRT'}</span>
        </button>

        <button
          onClick={handleDownloadVtt}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
        >
          <span>.VTT</span>
        </button>

        <button
          onClick={handleDownloadTxt}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
        >
          <span>.TXT</span>
        </button>

        <button
          onClick={handleDownloadJson}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
        >
          <span>.JSON</span>
        </button>

        {/* Primary Download SRT */}
        <button
          onClick={handleDownloadSrt}
          id="btn-download-srt-primary"
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-xs font-bold shadow-md shadow-indigo-200 transition-all cursor-pointer"
        >
          <Download className="w-4 h-4" />
          <span>Download Valid SRT</span>
        </button>
      </div>
    </div>
  );
};
