import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, RotateCcw, Volume2, VolumeX, SkipBack, SkipForward, FastForward } from 'lucide-react';
import { SubtitleSegment, MediaFileInfo } from '../types';
import { formatSrtTimestamp } from '../utils/srtRules';

interface AudioPlayerWaveformProps {
  mediaInfo: MediaFileInfo | null;
  segments: SubtitleSegment[];
  currentActiveSegment: SubtitleSegment | null;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onPlayPause: () => void;
  isPlaying: boolean;
  onSelectSegment?: (segment: SubtitleSegment) => void;
}

export const AudioPlayerWaveform: React.FC<AudioPlayerWaveformProps> = ({
  mediaInfo,
  segments,
  currentActiveSegment,
  currentTime,
  onSeek,
  onPlayPause,
  isPlaying,
  onSelectSegment,
}) => {
  const waveformRef = useRef<HTMLDivElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);

  const duration = mediaInfo?.duration || (segments.length > 0 ? segments[segments.length - 1].endSeconds : 10);

  const handleWaveformClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!waveformRef.current || duration <= 0) return;
    const rect = waveformRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const targetSeconds = ratio * duration;
    onSeek(targetSeconds);
  };

  const handleSkipSegment = (direction: 'prev' | 'next') => {
    if (segments.length === 0) return;
    const currentIndex = currentActiveSegment
      ? segments.findIndex((s) => s.id === currentActiveSegment.id)
      : -1;

    if (direction === 'prev') {
      const prevIdx = Math.max(0, currentIndex - 1);
      onSeek(segments[prevIdx].startSeconds);
      onSelectSegment?.(segments[prevIdx]);
    } else {
      const nextIdx = Math.min(segments.length - 1, currentIndex + 1);
      onSeek(segments[nextIdx].startSeconds);
      onSelectSegment?.(segments[nextIdx]);
    }
  };

  // Generate 80 stylized waveform bars based on segment density
  const totalBars = 90;
  const progressRatio = duration > 0 ? currentTime / duration : 0;

  const getClassificationColor = (classification?: string) => {
    switch (classification) {
      case 'CLEAR_SPEECH':
        return 'bg-emerald-500 text-emerald-950 border-emerald-300';
      case 'SPEECH_WITH_MUSIC':
      case 'SPEECH_WITH_NOISE':
        return 'bg-amber-500 text-amber-950 border-amber-300';
      case 'MUSIC_ONLY':
      case 'NOISE_ONLY':
        return 'bg-orange-500 text-orange-950 border-orange-300';
      case 'FILLER':
      case 'LAUGH':
        return 'bg-purple-500 text-purple-950 border-purple-300';
      case 'SILENCE':
        return 'bg-slate-400 text-slate-900 border-slate-300';
      case 'UNINTELLIGIBLE_SPEECH':
        return 'bg-cyan-500 text-cyan-950 border-cyan-300';
      default:
        return 'bg-indigo-500 text-indigo-950 border-indigo-300';
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
      {/* Waveform & Timeline Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center font-bold text-xs">
            {mediaInfo?.isVideo ? 'VID' : 'AUD'}
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-800 truncate max-w-[280px]">
              {mediaInfo?.name || 'Audio Waveform Stream'}
            </div>
            <div className="text-[10px] font-mono text-slate-400">
              {formatSrtTimestamp(currentTime)} / {formatSrtTimestamp(duration)}
            </div>
          </div>
        </div>

        {/* Current Subtitle Tag Badge */}
        {currentActiveSegment && (
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-50 border border-slate-200 text-xs">
            <span className="font-mono text-[10px] text-slate-400">#{currentActiveSegment.id}</span>
            <span className={`px-2 py-0.2 rounded-full font-bold text-[10px] uppercase tracking-wider ${getClassificationColor(currentActiveSegment.classification)}`}>
              {currentActiveSegment.classification.replace(/_/g, ' ')}
            </span>
          </div>
        )}
      </div>

      {/* Interactive Waveform Canvas */}
      <div className="space-y-1.5">
        <div
          ref={waveformRef}
          onClick={handleWaveformClick}
          className="relative h-20 bg-slate-900 rounded-xl p-2.5 flex items-center justify-between gap-[2px] cursor-pointer overflow-hidden group select-none shadow-inner"
        >
          {/* Segment Marker Overlays on the timeline */}
          {segments.map((seg) => {
            const leftPct = (seg.startSeconds / duration) * 100;
            const widthPct = ((seg.endSeconds - seg.startSeconds) / duration) * 100;
            const isCurrent = currentActiveSegment?.id === seg.id;

            return (
              <div
                key={seg.id}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                className={`absolute top-0 bottom-0 pointer-events-none transition-all ${
                  isCurrent
                    ? 'bg-indigo-500/25 border-x border-indigo-400 z-10'
                    : 'border-r border-slate-700/50 hover:bg-white/5'
                }`}
              />
            );
          })}

          {/* Waveform Bars */}
          {Array.from({ length: totalBars }).map((_, i) => {
            const barRatio = i / totalBars;
            const barTime = barRatio * duration;
            const isPlayed = barRatio <= progressRatio;

            // Height curve simulating natural audio bursts
            const hash = Math.sin(i * 0.45) * Math.cos(i * 0.8) * 0.4 + 0.55;
            const heightPct = Math.max(15, Math.min(95, hash * 100));

            // Find segment classification at this timestamp
            const matchingSeg = segments.find(
              (s) => barTime >= s.startSeconds && barTime <= s.endSeconds
            );

            let barColor = isPlayed ? 'bg-indigo-400' : 'bg-slate-700';
            if (matchingSeg) {
              if (matchingSeg.classification === 'CLEAR_SPEECH') {
                barColor = isPlayed ? 'bg-emerald-400' : 'bg-emerald-800/80';
              } else if (
                matchingSeg.classification === 'SPEECH_WITH_MUSIC' ||
                matchingSeg.classification === 'SPEECH_WITH_NOISE'
              ) {
                barColor = isPlayed ? 'bg-amber-400' : 'bg-amber-800/80';
              } else if (matchingSeg.classification === 'FILLER' || matchingSeg.classification === 'LAUGH') {
                barColor = isPlayed ? 'bg-purple-400' : 'bg-purple-800/80';
              } else if (matchingSeg.classification === 'SILENCE') {
                barColor = isPlayed ? 'bg-slate-500' : 'bg-slate-800';
              } else if (matchingSeg.classification === 'UNINTELLIGIBLE_SPEECH') {
                barColor = isPlayed ? 'bg-cyan-400' : 'bg-cyan-800/80';
              }
            }

            return (
              <div
                key={i}
                style={{ height: `${heightPct}%` }}
                className={`w-full rounded-full transition-all duration-75 ${barColor} group-hover:opacity-90`}
              />
            );
          })}

          {/* Current Playhead Scrubber */}
          <div
            style={{ left: `${progressRatio * 100}%` }}
            className="absolute top-0 bottom-0 w-[2px] bg-rose-500 shadow-md shadow-rose-500/50 pointer-events-none z-20"
          >
            <div className="w-2.5 h-2.5 -ml-1 rounded-full bg-rose-500 absolute -top-1 shadow-xs" />
          </div>
        </div>

        {/* Timeline Time Marker Labels */}
        <div className="flex justify-between text-[10px] font-mono text-slate-400 px-1">
          <span>00:00:00,000</span>
          <span>{formatSrtTimestamp(duration * 0.25)}</span>
          <span>{formatSrtTimestamp(duration * 0.5)}</span>
          <span>{formatSrtTimestamp(duration * 0.75)}</span>
          <span>{formatSrtTimestamp(duration)}</span>
        </div>
      </div>

      {/* Active Subtitle Preview Card */}
      <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-center">
        {currentActiveSegment ? (
          <div className="space-y-1.5 animate-in fade-in duration-150">
            <div className="text-base sm:text-lg font-bold text-slate-900 font-sans tracking-wide">
              {currentActiveSegment.taggedText || currentActiveSegment.text || '<NOISE></NOISE>'}
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-slate-500 font-mono">
              <span>{currentActiveSegment.startTimeFormatted}</span>
              <span>→</span>
              <span>{currentActiveSegment.endTimeFormatted}</span>
              {currentActiveSegment.acousticNote && (
                <span className="text-[11px] text-slate-400 font-sans italic">
                  ({currentActiveSegment.acousticNote})
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-400 py-1 italic">
            Play audio or click on any segment to preview Odia subtitle
          </div>
        )}
      </div>

      {/* Transport Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        {/* Playback Transport Buttons */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => handleSkipSegment('prev')}
            id="btn-prev-segment"
            className="p-2 rounded-xl text-slate-700 hover:bg-slate-100 active:bg-slate-200 transition-colors cursor-pointer"
            title="Previous Subtitle Segment"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            onClick={() => onSeek(Math.max(0, currentTime - 2))}
            className="px-2.5 py-1.5 rounded-xl text-xs text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer font-mono"
            title="Rewind 2 seconds"
          >
            -2s
          </button>

          <button
            onClick={onPlayPause}
            id="btn-play-pause-toggle"
            className="p-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white shadow-md shadow-indigo-200 transition-all cursor-pointer"
          >
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 fill-current" />}
          </button>

          <button
            onClick={() => onSeek(Math.min(duration, currentTime + 2))}
            className="px-2.5 py-1.5 rounded-xl text-xs text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer font-mono"
            title="Forward 2 seconds"
          >
            +2s
          </button>

          <button
            onClick={() => handleSkipSegment('next')}
            id="btn-next-segment"
            className="p-2 rounded-xl text-slate-700 hover:bg-slate-100 active:bg-slate-200 transition-colors cursor-pointer"
            title="Next Subtitle Segment"
          >
            <SkipForward className="w-4 h-4" />
          </button>
        </div>

        {/* Speed & Volume Controls */}
        <div className="flex items-center gap-2">
          {/* Speed Selector */}
          <div className="flex items-center rounded-xl bg-slate-100 p-0.5 text-xs font-medium">
            {[0.75, 1.0, 1.25, 1.5].map((rate) => (
              <button
                key={rate}
                onClick={() => setPlaybackRate(rate)}
                className={`px-2 py-1 rounded-lg transition-all cursor-pointer ${
                  playbackRate === rate
                    ? 'bg-white text-indigo-700 font-bold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
