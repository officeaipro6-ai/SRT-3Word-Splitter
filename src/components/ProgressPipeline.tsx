import React from 'react';
import { Check, Loader2, Sparkles, AlertCircle, Clock, CheckCircle2, RotateCcw } from 'lucide-react';
import { PipelineStageInfo, PipelineStageId } from '../types';

interface ProgressPipelineProps {
  stages: PipelineStageInfo[];
  currentStageId: PipelineStageId;
  overallProgress: number;
  logMessages: string[];
  error?: string | null;
  onRetry?: () => void;
}

export const ProgressPipeline: React.FC<ProgressPipelineProps> = ({
  stages,
  currentStageId,
  overallProgress,
  logMessages,
  error,
  onRetry,
}) => {
  return (
    <div className="rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-slate-100 pb-4">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" />
            <span>Multi-Stage AI Audio & Subtitle Processing Pipeline</span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Strict sequential execution: Language ID → Native Odia Unicode Transcription → Waveform Acoustic Tagging
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-mono font-bold text-indigo-600">
            {Math.round(overallProgress)}%
          </div>
          <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
            Pipeline Progress
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            error ? 'bg-rose-500' : 'bg-gradient-to-r from-indigo-500 to-blue-600'
          }`}
          style={{ width: `${Math.max(4, overallProgress)}%` }}
        />
      </div>

      {/* 11 Stage Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
        {stages.map((stage) => {
          const isDone = stage.status === 'completed';
          const isInProgress = stage.status === 'in_progress';
          const isError = stage.status === 'error';

          return (
            <div
              key={stage.id}
              className={`p-2.5 rounded-xl border text-xs flex flex-col justify-between transition-all ${
                isDone
                  ? 'border-emerald-200 bg-emerald-50/50 text-emerald-900'
                  : isInProgress
                  ? 'border-indigo-300 bg-indigo-50/80 text-indigo-900 ring-2 ring-indigo-200/50 shadow-xs'
                  : isError
                  ? 'border-rose-300 bg-rose-50 text-rose-900'
                  : 'border-slate-100 bg-slate-50/60 text-slate-400'
              }`}
            >
              <div className="flex items-center justify-between gap-1 mb-1">
                <span className="font-mono text-[10px] font-bold opacity-75">
                  Stage {stage.stepNumber}
                </span>
                {isDone ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 stroke-[3]" />
                ) : isInProgress ? (
                  <Loader2 className="w-3.5 h-3.5 text-indigo-600 animate-spin" />
                ) : isError ? (
                  <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                ) : (
                  <Clock className="w-3 h-3 text-slate-300" />
                )}
              </div>

              <div className="font-medium text-[11px] leading-tight">
                {stage.label}
              </div>

              {stage.message && (
                <div className="mt-1 text-[10px] text-slate-500 line-clamp-1">
                  {stage.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Error display with user actionable Retry button */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-bold text-rose-950">Processing Interrupted</div>
              <p className="text-rose-800 leading-relaxed">{error}</p>
            </div>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              id="btn-retry-pipeline"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-semibold text-xs transition-colors cursor-pointer shrink-0 shadow-xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Retry Pipeline</span>
            </button>
          )}
        </div>
      )}

      {/* Real-time Acoustic & Execution Log */}
      <div className="rounded-xl bg-slate-900 p-3.5 text-slate-300 font-mono text-[11px] space-y-1 max-h-36 overflow-y-auto">
        <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 pb-1 border-b border-slate-800 flex justify-between">
          <span>Pipeline Telemetry & Acoustic Logs</span>
          <span className="text-emerald-400">LIVE</span>
        </div>
        {logMessages.map((log, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <span className="text-indigo-400 select-none">&gt;</span>
            <span className="leading-tight">{log}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
