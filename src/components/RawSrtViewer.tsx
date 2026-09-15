import React, { useState } from 'react';
import { Copy, Check, FileText, Code2, Download, CheckCircle2 } from 'lucide-react';
import { SubtitleSegment, TranscriptionResult } from '../types';
import {
  generateSrtContent,
  generateVttContent,
  generateTxtContent,
} from '../utils/srtRules';

interface RawSrtViewerProps {
  segments: SubtitleSegment[];
  transcriptionResult: TranscriptionResult | null;
  onCopySrt: () => void;
  copied: boolean;
}

export const RawSrtViewer: React.FC<RawSrtViewerProps> = ({
  segments,
  transcriptionResult,
  onCopySrt,
  copied,
}) => {
  const [activeTab, setActiveTab] = useState<'SRT' | 'VTT' | 'TXT' | 'JSON'>('SRT');

  // Preview and exported content are identical: real tags (<NOISE>, <FIL>,
  // <SIL>, <MB>) are emitted from each segment's classification so the
  // downloaded SRT carries exactly what the UI shows.
  const srtContent = generateSrtContent(segments);
  const vttContent = generateVttContent(segments);
  const txtContent = generateTxtContent(segments);
  const jsonContent = JSON.stringify(transcriptionResult || { segments }, null, 2);

  const exportSrtContent = generateSrtContent(segments);
  const exportVttContent = generateVttContent(segments);
  const exportTxtContent = generateTxtContent(segments);

  const getCurrentContent = () => {
    switch (activeTab) {
      case 'SRT':
        return srtContent;
      case 'VTT':
        return vttContent;
      case 'TXT':
        return txtContent;
      case 'JSON':
        return jsonContent;
      default:
        return srtContent;
    }
  };

  const getExportContent = () => {
    switch (activeTab) {
      case 'SRT':
        return exportSrtContent;
      case 'VTT':
        return exportVttContent;
      case 'TXT':
        return exportTxtContent;
      case 'JSON':
        return jsonContent;
      default:
        return exportSrtContent;
    }
  };

  const handleCopyCurrent = () => {
    navigator.clipboard.writeText(getExportContent());
    onCopySrt();
  };

  // Syntax highlight SRT lines
  const renderHighlightedSrt = (raw: string) => {
    const lines = raw.split('\n');
    return lines.map((line, idx) => {
      const isNumber = /^\d+$/.test(line.trim());
      const isTimestamp = /^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,\.]\d{3}$/.test(line.trim());

      if (isNumber) {
        return (
          <div key={idx} className="text-slate-500 font-bold select-none">
            {line}
          </div>
        );
      }

      if (isTimestamp) {
        return (
          <div key={idx} className="text-indigo-400 font-mono">
            {line}
          </div>
        );
      }

      // Check for tags
      if (line.includes('<NOISE>') || line.includes('</NOISE>')) {
        return (
          <div key={idx} className="text-amber-300 font-medium">
            {line}
          </div>
        );
      }

      if (line.includes('<FIL>') || line.includes('</FIL>')) {
        return (
          <div key={idx} className="text-purple-300 font-medium">
            {line}
          </div>
        );
      }

      if (line.includes('<SIL>') || line.includes('</SIL>')) {
        return (
          <div key={idx} className="text-slate-400 font-medium">
            {line}
          </div>
        );
      }

      if (line.includes('<MB>') || line.includes('</MB>')) {
        return (
          <div key={idx} className="text-cyan-300 font-medium">
            {line}
          </div>
        );
      }

      return (
        <div key={idx} className="text-emerald-300">
          {line}
        </div>
      );
    });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-950 text-slate-100 overflow-hidden shadow-md space-y-0">
      {/* Header Bar */}
      <div className="px-5 py-3.5 bg-slate-900 border-b border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl bg-slate-800 p-0.5 text-xs font-mono">
            {(['SRT', 'VTT', 'TXT', 'JSON'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  activeTab === tab
                    ? 'bg-indigo-600 text-white font-bold shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                .{tab.toLowerCase()}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-400 font-mono hidden sm:inline">
            Standard UTF-8 Output
          </span>
        </div>

        {/* Copy Button */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button
            onClick={handleCopyCurrent}
            id="btn-copy-raw-srt"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied to Clipboard!' : `Copy .${activeTab.toLowerCase()}`}</span>
          </button>
        </div>
      </div>

      {/* Code Viewer Body — no height cap: EVERY subtitle, including the final
          segments, is shown in full (never hidden behind a scroll fold). */}
      <div className="p-5 font-mono text-xs leading-relaxed bg-slate-950 select-text">
        {activeTab === 'SRT' ? (
          renderHighlightedSrt(srtContent)
        ) : (
          <pre className="text-slate-300 whitespace-pre-wrap">{getCurrentContent()}</pre>
        )}
      </div>

      {/* Legend Footer */}
      <div className="px-5 py-2.5 bg-slate-900/80 border-t border-slate-800/80 flex flex-wrap items-center justify-between text-[11px] text-slate-400 gap-2">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" /> Clear Speech
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-400" /> &lt;NOISE&gt;
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-purple-400" /> &lt;FIL&gt;
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-400" /> &lt;SIL&gt;
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cyan-400" /> &lt;MB&gt;
          </span>
        </div>
        <div className="font-mono text-[10px] text-slate-500">
          Strict sequential SRT formatting
        </div>
      </div>
    </div>
  );
};
