import React, { useState } from 'react';
import {
  Play,
  Trash2,
  Plus,
  Edit2,
  Check,
  Search,
  Filter,
  Volume2,
  Music,
  Sparkles,
  Clock,
  AlertTriangle,
  RotateCcw,
  Scissors,
} from 'lucide-react';
import { SubtitleSegment, AudioClassification } from '../types';
import { formatSrtTimestamp, parseSrtTimestamp, applyTaggingRule, countWords } from '../utils/srtRules';

interface SubtitleTableProps {
  segments: SubtitleSegment[];
  currentActiveSegmentId?: number;
  onUpdateSegment: (updated: SubtitleSegment) => void;
  onDeleteSegment: (id: number) => void;
  onAddSegment: (index: number, position: 'before' | 'after') => void;
  onPlaySegment: (start: number, end: number) => void;
  onSplitSegment?: (id: number) => void;
  onAutoSplitAll?: () => void;
}

export const SubtitleTable: React.FC<SubtitleTableProps> = ({
  segments,
  currentActiveSegmentId,
  onUpdateSegment,
  onDeleteSegment,
  onAddSegment,
  onPlaySegment,
  onSplitSegment,
  onAutoSplitAll,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('ALL');

  const nonCompliantSegmentsCount = segments.filter((s) => {
    if (
      s.classification === 'SILENCE' ||
      s.classification === 'MUSIC_ONLY' ||
      s.classification === 'NOISE_ONLY' ||
      s.classification === 'UNINTELLIGIBLE_SPEECH'
    ) {
      return false;
    }
    return countWords(s.text || s.taggedText) > 3;
  }).length;

  // Filter segments
  const filteredSegments = segments.filter((seg) => {
    const matchesSearch =
      seg.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
      seg.taggedText.toLowerCase().includes(searchQuery.toLowerCase()) ||
      seg.startTimeFormatted.includes(searchQuery) ||
      seg.endTimeFormatted.includes(searchQuery);

    if (!matchesSearch) return false;

    if (filterType === 'ALL') return true;
    if (filterType === 'CLEAR') return seg.classification === 'CLEAR_SPEECH';
    if (filterType === 'NOISE')
      return (
        seg.classification === 'SPEECH_WITH_MUSIC' ||
        seg.classification === 'SPEECH_WITH_NOISE' ||
        seg.classification === 'MUSIC_ONLY' ||
        seg.classification === 'NOISE_ONLY'
      );
    if (filterType === 'FILLER') return seg.classification === 'FILLER' || seg.classification === 'LAUGH';
    if (filterType === 'SILENCE') return seg.classification === 'SILENCE';
    if (filterType === 'UNINTELLIGIBLE') return seg.classification === 'UNINTELLIGIBLE_SPEECH' || seg.classification === 'SPEECH_WITH_MUSIC';

    return true;
  });

  const handleClassificationChange = (seg: SubtitleSegment, newClass: AudioClassification) => {
    const duration = seg.endSeconds - seg.startSeconds;
    const { taggedText } = applyTaggingRule(seg.text, newClass, duration);
    onUpdateSegment({
      ...seg,
      classification: newClass,
      taggedText,
    });
  };

  const handleTextChange = (seg: SubtitleSegment, newText: string) => {
    const duration = seg.endSeconds - seg.startSeconds;
    const { taggedText } = applyTaggingRule(newText, seg.classification, duration);
    onUpdateSegment({
      ...seg,
      text: newText,
      taggedText,
    });
  };

  const handleStartTimeChange = (seg: SubtitleSegment, formatted: string) => {
    const startSec = parseSrtTimestamp(formatted);
    const duration = seg.endSeconds - startSec;
    const { taggedText } = applyTaggingRule(seg.text, seg.classification, duration);
    onUpdateSegment({
      ...seg,
      startSeconds: startSec,
      startTimeFormatted: formatted,
      taggedText,
    });
  };

  const handleEndTimeChange = (seg: SubtitleSegment, formatted: string) => {
    const endSec = parseSrtTimestamp(formatted);
    const duration = endSec - seg.startSeconds;
    const { taggedText } = applyTaggingRule(seg.text, seg.classification, duration);
    onUpdateSegment({
      ...seg,
      endSeconds: endSec,
      endTimeFormatted: formatted,
      taggedText,
    });
  };

  const getTagBadge = (classification: AudioClassification, taggedText: string, duration: number) => {
    if (classification === 'CLEAR_SPEECH') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
          Rule A: Clear
        </span>
      );
    }
    if (classification === 'SPEECH_WITH_NOISE') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
          Rule B: &lt;NOISE&gt;
        </span>
      );
    }
    if (classification === 'SPEECH_WITH_MUSIC') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-cyan-50 text-cyan-800 border border-cyan-200">
          Rule F: &lt;MB&gt;
        </span>
      );
    }
    if (classification === 'MUSIC_ONLY' || classification === 'NOISE_ONLY') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-orange-50 text-orange-800 border border-orange-200">
          Rule C: &lt;NOISE&gt;&lt;/NOISE&gt;
        </span>
      );
    }
    if (classification === 'FILLER' || classification === 'LAUGH') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-purple-50 text-purple-800 border border-purple-200">
          Rule D: &lt;FIL&gt;
        </span>
      );
    }
    if (classification === 'SILENCE') {
      if (duration >= 2.0) {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-800 border border-slate-300">
            Rule E: &lt;SIL&gt;
          </span>
        );
      } else {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            &lt; 2.0s (Will be ignored)
          </span>
        );
      }
    }
    if (classification === 'UNINTELLIGIBLE_SPEECH' || classification === 'SPEECH_WITH_MUSIC') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-cyan-50 text-cyan-800 border border-cyan-200">
          Rule F: &lt;MB&gt;
        </span>
      );
    }
    return null;
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs space-y-4 p-5">
      {/* Top Table Control Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-slate-900">
              Editable Subtitle & Acoustic Tag Table
            </h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono">
              {segments.length} segments
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
              Max 3 Words / Segment
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Changes auto-apply tagging rules, enforce the 3-word limit, and instantly update final downloaded SRT.
          </p>
        </div>

        {/* Search & Filter Controls */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* Auto-Split Button if any segments exceed 3 words */}
          {nonCompliantSegmentsCount > 0 && onAutoSplitAll && (
            <button
              onClick={onAutoSplitAll}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer animate-pulse"
              title="Automatically split all segments containing > 3 words into consecutive parts"
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>Auto-Split {nonCompliantSegmentsCount} Segments (&gt;3 words)</span>
            </button>
          )}

          {/* Search Box */}
          <div className="relative flex-1 sm:w-52">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search text or time..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs focus:bg-white focus:outline-indigo-500 transition-all"
            />
          </div>

          {/* Filter Pills */}
          <div className="flex items-center rounded-xl bg-slate-100 p-0.5 text-xs">
            {[
              { id: 'ALL', label: 'All' },
              { id: 'CLEAR', label: 'Clear' },
              { id: 'NOISE', label: 'Noise/BGM' },
              { id: 'FILLER', label: 'Filler' },
              { id: 'SILENCE', label: 'Silence' },
              { id: 'UNINTELLIGIBLE', label: 'MB' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilterType(f.id)}
                className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  filterType === f.id
                    ? 'bg-white text-indigo-700 font-bold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Add Segment Button */}
          <button
            onClick={() => onAddSegment(segments.length, 'after')}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold border border-indigo-200 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Segment</span>
          </button>
        </div>
      </div>

      {/* Table Container */}
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase text-[10px] tracking-wider">
              <th className="py-2.5 px-3 w-12 text-center">#</th>
              <th className="py-2.5 px-3 w-32">Start (SRT)</th>
              <th className="py-2.5 px-3 w-32">End (SRT)</th>
              <th className="py-2.5 px-3 min-w-[220px]">Transcribed Text</th>
              <th className="py-2.5 px-3 w-48">Classification</th>
              <th className="py-2.5 px-3 min-w-[180px]">Tagged Output Preview</th>
              <th className="py-2.5 px-3 w-28 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredSegments.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400 text-xs">
                  No subtitle segments match your current filter.
                </td>
              </tr>
            ) : (
              filteredSegments.map((seg, index) => {
                const isCurrent = currentActiveSegmentId === seg.id;
                const duration = seg.endSeconds - seg.startSeconds;
                const wordCount = countWords(seg.text || seg.taggedText);
                const isOverLimit =
                  wordCount > 3 &&
                  seg.classification !== 'SILENCE' &&
                  seg.classification !== 'MUSIC_ONLY' &&
                  seg.classification !== 'NOISE_ONLY' &&
                  seg.classification !== 'UNINTELLIGIBLE_SPEECH';

                return (
                  <tr
                    key={seg.id}
                    className={`transition-colors ${
                      isOverLimit
                        ? 'bg-amber-50/40'
                        : isCurrent
                        ? 'bg-indigo-50/70 font-medium'
                        : index % 2 === 0
                        ? 'bg-white'
                        : 'bg-slate-50/30'
                    } hover:bg-slate-50`}
                  >
                    {/* Number */}
                    <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-500">
                      {seg.id}
                    </td>

                    {/* Start Time */}
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={seg.startTimeFormatted}
                        onChange={(e) => handleStartTimeChange(seg, e.target.value)}
                        className="w-full font-mono text-xs px-2 py-1 rounded bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                      />
                    </td>

                    {/* End Time */}
                    <td className="py-2 px-3">
                      <div className="space-y-0.5">
                        <input
                          type="text"
                          value={seg.endTimeFormatted}
                          onChange={(e) => handleEndTimeChange(seg, e.target.value)}
                          className="w-full font-mono text-xs px-2 py-1 rounded bg-slate-50 border border-slate-200 focus:bg-white focus:border-indigo-500 focus:outline-hidden"
                        />
                        <div className="text-[10px] font-mono text-slate-400">
                          {duration.toFixed(3)}s
                        </div>
                      </div>
                    </td>

                    {/* Text Editor */}
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={seg.text}
                        placeholder={
                          seg.classification === 'MUSIC_ONLY' || seg.classification === 'NOISE_ONLY'
                            ? '(Non-speech noise)'
                            : seg.classification === 'SILENCE'
                            ? 'silence'
                            : seg.classification === 'UNINTELLIGIBLE_SPEECH'
                            ? '(Speech not understandable)'
                            : 'Enter text...'
                        }
                        onChange={(e) => handleTextChange(seg, e.target.value)}
                        className={`w-full font-sans text-xs px-2.5 py-1.5 rounded-lg border focus:bg-white focus:outline-hidden ${
                          isOverLimit
                            ? 'border-amber-400 bg-amber-50/50 focus:border-amber-600'
                            : 'border-slate-200 focus:border-indigo-500'
                        }`}
                      />

                      {/* Word Count Indicator & Split Alert */}
                      <div className="mt-1 flex items-center justify-between">
                        {isOverLimit ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-amber-800 font-semibold">
                            <AlertTriangle className="w-3 h-3 text-amber-600" />
                            <span>{wordCount} words (Maximum 3)</span>
                            {onSplitSegment && (
                              <button
                                onClick={() => onSplitSegment(seg.id)}
                                className="ml-1 px-1.5 py-0.5 rounded bg-amber-200 hover:bg-amber-300 text-amber-900 text-[10px] font-bold transition-colors cursor-pointer"
                              >
                                Split now
                              </button>
                            )}
                          </div>
                        ) : wordCount > 0 && seg.classification !== 'SILENCE' && seg.classification !== 'MUSIC_ONLY' && seg.classification !== 'NOISE_ONLY' && seg.classification !== 'UNINTELLIGIBLE_SPEECH' ? (
                          <span className="text-[10px] font-mono text-slate-400">
                            {wordCount} / 3 words
                          </span>
                        ) : null}

                        {seg.acousticNote && (
                          <span className="text-[10px] text-slate-400 italic truncate max-w-[140px]">
                            {seg.acousticNote}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Classification Selector */}
                    <td className="py-2 px-3">
                      <select
                        value={seg.classification}
                        onChange={(e) =>
                          handleClassificationChange(seg, e.target.value as AudioClassification)
                        }
                        className="w-full text-xs px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 font-medium text-slate-800 focus:bg-white focus:border-indigo-500 focus:outline-hidden cursor-pointer"
                      >
                        <option value="CLEAR_SPEECH">Clear Speech (Rule A)</option>
                        <option value="SPEECH_WITH_MUSIC">Speech + Background Music (Rule F)</option>
                        <option value="SPEECH_WITH_NOISE">Speech + Background Noise (Rule B)</option>
                        <option value="MUSIC_ONLY">Music Only (Rule C)</option>
                        <option value="NOISE_ONLY">Noise Only (Rule C)</option>
                        <option value="FILLER">Filler (hmm, uh, um) (Rule D)</option>
                        <option value="LAUGH">Laughter (haha) (Rule D)</option>
                        <option value="SILENCE">Complete Silence (Rule E)</option>
                        <option value="UNINTELLIGIBLE_SPEECH">Unintelligible Speech (Rule F)</option>
                      </select>
                    </td>

                    {/* Tagged Preview Output */}
                    <td className="py-2 px-3">
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-slate-800 font-bold bg-slate-50 px-2 py-1 rounded border border-slate-200 break-words whitespace-pre-wrap max-w-[360px]">
                          {seg.taggedText}
                        </div>
                        <div>{getTagBadge(seg.classification, seg.taggedText, duration)}</div>
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-2 px-3 text-center">
                      <div className="inline-flex items-center gap-1">
                        {isOverLimit && onSplitSegment && (
                          <button
                            onClick={() => onSplitSegment(seg.id)}
                            className="p-1.5 rounded-lg text-amber-600 hover:bg-amber-100 hover:text-amber-900 transition-colors cursor-pointer"
                            title="Split segment into maximum 3-word parts"
                          >
                            <Scissors className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => onPlaySegment(seg.startSeconds, seg.endSeconds)}
                          className="p-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50 hover:text-indigo-800 transition-colors cursor-pointer"
                          title="Play audio snippet for this segment"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                        </button>
                        <button
                          onClick={() => onAddSegment(index, 'after')}
                          className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer"
                          title="Insert new segment below"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteSegment(seg.id)}
                          className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50 hover:text-rose-700 transition-colors cursor-pointer"
                          title="Delete subtitle segment"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
