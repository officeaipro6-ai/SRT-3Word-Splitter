import React, { useRef, useState } from 'react';
import { Upload, FileAudio, FileVideo, Sparkles, Music, Mic, CheckCircle2, Play, AlertCircle, ArrowRight } from 'lucide-react';
import { MediaFileInfo } from '../types';
import { SAMPLE_PRESETS, SampleAudioPreset } from '../utils/sampleAudios';
import { extractAudioFromMediaFile } from '../utils/audioExtractor';

interface FileUploadProps {
  onFileSelected: (info: MediaFileInfo) => void;
  isProcessing: boolean;
  selectedFile: MediaFileInfo | null;
  onStartPipeline: () => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({
  onFileSelected,
  isProcessing,
  selectedFile,
  onStartPipeline,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [extractingAudio, setExtractingAudio] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState({ progress: 0, text: '' });
  const [loadingPresetId, setLoadingPresetId] = useState<string | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = async (file: File) => {
    const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name);
    const objectUrl = URL.createObjectURL(file);

    setExtractingAudio(true);
    setExtractionProgress({ progress: 10, text: isVideo ? 'Extracting audio from video track...' : 'Decoding audio stream...' });

    try {
      const extracted = await extractAudioFromMediaFile(file, (p, text) => {
        setExtractionProgress({ progress: p, text });
      });

      onFileSelected({
        name: file.name,
        size: file.size,
        type: file.type || (isVideo ? 'video/mp4' : 'audio/wav'),
        duration: extracted.duration,
        url: objectUrl,
        isVideo,
        file,
        audioBlob: extracted.wavBlob,
      });
    } catch (err: any) {
      console.error('Extraction error:', err);
      // Fallback: direct file usage
      onFileSelected({
        name: file.name,
        size: file.size,
        type: file.type || 'audio/wav',
        duration: 0,
        url: objectUrl,
        isVideo,
        file,
        audioBlob: file,
      });
    } finally {
      setExtractingAudio(false);
    }
  };

  const handleLoadPreset = async (preset: SampleAudioPreset) => {
    setLoadingPresetId(preset.id);
    setExtractingAudio(true);
    setExtractionProgress({ progress: 25, text: `Synthesizing ${preset.name}...` });

    try {
      const blob = await preset.generateAudio();
      const testFile = new File([blob], `${preset.id}.wav`, { type: 'audio/wav' });
      const objectUrl = URL.createObjectURL(blob);

      const extracted = await extractAudioFromMediaFile(testFile, (p, text) => {
        setExtractionProgress({ progress: p, text });
      });

      onFileSelected({
        name: `${preset.name} (${preset.id}.wav)`,
        size: blob.size,
        type: 'audio/wav',
        duration: extracted.duration || preset.durationSeconds,
        url: objectUrl,
        isVideo: false,
        file: testFile,
        audioBlob: extracted.wavBlob,
      });
    } catch (err) {
      console.error('Preset loading error:', err);
    } finally {
      setLoadingPresetId(null);
      setExtractingAudio(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatDuration = (secs: number) => {
    if (!secs || isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      {/* Upload Box */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !isProcessing && !extractingAudio && fileInputRef.current?.click()}
        id="dropzone-media-upload"
        className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer ${
          isDragging
            ? 'border-indigo-500 bg-indigo-50/50 scale-[1.005]'
            : selectedFile
            ? 'border-emerald-300 bg-emerald-50/20 hover:border-emerald-400'
            : 'border-slate-300 bg-slate-50/70 hover:border-indigo-400 hover:bg-slate-50'
        } ${isProcessing || extractingAudio ? 'pointer-events-none opacity-80' : ''}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.mp4,.mov,.webm,.mkv,.ogg,.flac"
          className="hidden"
          onChange={handleFileInputChange}
        />

        <div className="flex flex-col items-center justify-center space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-indigo-100/80 text-indigo-600 flex items-center justify-center shadow-xs">
            {selectedFile?.isVideo ? (
              <FileVideo className="w-7 h-7" />
            ) : (
              <Upload className="w-7 h-7" />
            )}
          </div>

          <div>
            <h3 className="text-base font-semibold text-slate-800">
              {selectedFile ? 'File Ready for Processing' : 'Upload Audio or Video for Odia Tagged SRT'}
            </h3>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Drag and drop any audio or video file, or click to browse.
              <br />
              <span className="font-mono text-[11px] text-slate-400">
                Supports MP3, WAV, M4A, AAC, MP4, MOV, WEBM, MKV
              </span>
            </p>
          </div>

          {extractingAudio && (
            <div className="w-full max-w-xs space-y-1.5 pt-2">
              <div className="flex justify-between text-xs text-indigo-700 font-medium">
                <span>{extractionProgress.text}</span>
                <span>{Math.round(extractionProgress.progress)}%</span>
              </div>
              <div className="w-full h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all duration-200"
                  style={{ width: `${extractionProgress.progress}%` }}
                />
              </div>
            </div>
          )}

          {selectedFile && !extractingAudio && (
            <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-700 shadow-xs">
              <span className="font-medium text-slate-900 truncate max-w-[220px]">{selectedFile.name}</span>
              <span className="text-slate-300">•</span>
              <span className="text-slate-500">{formatFileSize(selectedFile.size)}</span>
              <span className="text-slate-300">•</span>
              <span className="font-mono text-indigo-600 font-semibold">{formatDuration(selectedFile.duration)}</span>
              {selectedFile.isVideo && (
                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px]">
                  Video Audio Extracted
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Start Action Bar if File is Loaded */}
      {selectedFile && !isProcessing && (
        <div className="p-4 rounded-xl bg-gradient-to-r from-indigo-50 via-white to-blue-50 border border-indigo-100 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="text-sm font-bold text-slate-900">Audio Ready for 7-Step Pipeline</span>
            </div>
            <p className="text-xs text-slate-600">
              Detect Odia speech → generate timestamps → acoustic background check → apply Rules A–E.
            </p>
          </div>

          <button
            onClick={onStartPipeline}
            id="btn-start-transcription"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-medium text-sm shadow-md shadow-indigo-200 transition-all cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            <span>Start Odia Processing</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Sample Audio Presets for Instant Rule Verification */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Instant Rule Verification Presets (1-Click Test Audio)
            </h4>
          </div>
          <span className="text-[11px] text-slate-400">
            Synthesized with speech, music, noise, fillers & calibrated silence
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {SAMPLE_PRESETS.map((preset) => {
            const isLoading = loadingPresetId === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() => handleLoadPreset(preset)}
                disabled={isProcessing || extractingAudio}
                className="text-left p-3 rounded-xl border border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/30 transition-all cursor-pointer flex flex-col justify-between group disabled:opacity-60"
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="font-semibold text-xs text-slate-800 group-hover:text-indigo-700">
                      {preset.name}
                    </span>
                    <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                      {preset.durationSeconds}s
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 line-clamp-2 leading-relaxed">
                    {preset.description}
                  </p>
                </div>

                <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-[10px]">
                  <div className="flex flex-wrap gap-1">
                    {preset.expectedRules.map((r, i) => (
                      <span key={i} className="px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 font-medium">
                        {r}
                      </span>
                    ))}
                  </div>
                  <span className="text-indigo-600 font-semibold flex items-center gap-0.5 group-hover:translate-x-0.5 transition-transform">
                    {isLoading ? 'Loading...' : 'Load'} →
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
