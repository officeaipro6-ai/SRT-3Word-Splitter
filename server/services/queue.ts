/**
 * Local durable transcription job queue + single in-process worker.
 *
 * Jobs live in the persistent store (survive restarts), so this is a "queue"
 * implemented the simplest possible way — no external broker, no new deps.
 * The worker:
 *   - rehydrates on boot (stale PROCESSING -> FAILED + refund, QUEUED stay);
 *   - claims one eligible QUEUED job at a time (single concurrency);
 *   - runs the injected pipeline (the exact legacy post-processing steps);
 *   - enforces a job timeout, auto-retry for transient failures only, and
 *     refunds credits whenever a job ends in FAILED.
 * A future cloud deployment swaps THIS class for a real QueueProvider-backed
 * worker without touching the API or credit layers.
 */
import { JobRepo } from '../db/repos';
import { type JobRecord, type JobInputRef } from '../db/types';
import { config } from '../config';
import { nestedLog } from '../logger';
import {
  type TranscriptionProviderResult,
  type TranscriptionProvider,
  ProviderNotConfiguredError,
} from '../providers/types';
import { type StorageProvider, srtKey } from './storage';
import { type CreditService } from './creditService';
import {
  ProviderSpendingError,
  assertProviderSpendingAllowed,
  reportProviderQuotaExhausted,
} from './providerSafety';

export interface RunPipelineInput {
  audioBuffer: Buffer;
  mimeType: string;
  provider: string;
  providerResult: TranscriptionProviderResult;
  fileDurationSeconds: number;
}

export interface RunPipelineResult {
  rawSrt: string;
  segmentCount: number;
  wordCount: number;
  provider: string;
}

export type RunPipeline = (input: RunPipelineInput) => Promise<RunPipelineResult>;

export interface JobQueueDeps {
  repo: JobRepo;
  storage: StorageProvider;
  credits: CreditService;
  getProvider: (name: string) => TranscriptionProvider;
  runPipeline: RunPipeline;
  pollMs?: number;
}

function isTransientError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '').toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('504') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  );
}

export class JobQueue {
  private readonly repo: JobRepo;
  private readonly storage: StorageProvider;
  private readonly credits: CreditService;
  private readonly getProvider: (name: string) => TranscriptionProvider;
  private readonly runPipeline: RunPipeline;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(deps: JobQueueDeps) {
    this.repo = deps.repo;
    this.storage = deps.storage;
    this.credits = deps.credits;
    this.getProvider = deps.getProvider;
    this.runPipeline = deps.runPipeline;
    this.pollMs = deps.pollMs ?? 2500;
  }

  /** Boot recovery: PROCESSING jobs are treated as interrupted (crash). */
  rehydrate(): void {
    const now = new Date().toISOString();
    for (const job of this.repo.listProcessing()) {
      this.credits.refundFinishedJob(job.userId, job.id, 'refund_interrupted_job');
      this.repo.update(job.id, {
        status: 'FAILED',
        errorCode: 'INTERRUPTED',
        lastError: 'Server restarted while the job was processing.',
        completedAt: now,
        startedAt: job.startedAt,
      });
      nestedLog.warn('job rehydrated as failed', { jobId: job.id, userId: job.userId });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Process at most one job per tick (single concurrency). */
  async tick(): Promise<void> {
    if (this.busy) return;
    const job = this.repo
      .listEligibleQueued(new Date().toISOString())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return;
    this.busy = true;
    try {
      await this.processWithTimeout(job);
    } finally {
      this.busy = false;
    }
  }

  private async processWithTimeout(job: JobRecord): Promise<void> {
    if (!this.repo.update(job.id, { status: 'PROCESSING', startedAt: new Date().toISOString(), nextRetryAt: undefined })) {
      return;
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Job timed out after ${Math.floor(config.jobTimeoutMs / 1000)}s.`)), config.jobTimeoutMs);
    });
    try {
      const result = await Promise.race([this.processOne(job), timeout]);
      const now = new Date().toISOString();
      this.repo.update(job.id, {
        status: 'COMPLETED',
        output: {
          srtKey: srtKey(job.id),
          rawSrt: result.rawSrt,
          segmentCount: result.segmentCount,
          wordCount: result.wordCount,
          provider: result.provider,
        },
        completedAt: now,
        lastError: undefined,
      });
      nestedLog.info('job completed', { jobId: job.id, userId: job.userId });
    } catch (err: any) {
      await this.handleFailure(job, err);
    }
  }

  private async processOne(job: JobRecord): Promise<RunPipelineResult> {
    // Hard provider-spending protection: checked IMMEDIATELY before calling the
    // provider so a job can never start an API call while the kill-switch is on
    // or the provider is quarantined after exhausting its quota. Applies to
    // every job, including jobs owned by ADMIN/UNLIMITED accounts.
    assertProviderSpendingAllowed();
    const provider = this.getProvider(job.provider);
    const audioBuffer = await this.storage.get(job.input.storageKey);
    if (!audioBuffer) {
      throw new Error(`Stored audio missing for job ${job.id} (${job.input.storageKey}).`);
    }
    const result = await provider.transcribe(audioBuffer, job.input.mimeType, {
      jobTimeoutMs: config.jobTimeoutMs,
    });
    return this.runPipeline({
      audioBuffer,
      mimeType: job.input.mimeType,
      provider: provider.name,
      providerResult: result,
      fileDurationSeconds: job.input.durationSeconds,
    });
  }

  private async handleFailure(job: JobRecord, err: unknown): Promise<void> {
    const now = new Date().toISOString();
    const message = String((err as Error)?.message || err || 'Unknown error');
    const lower = message.toLowerCase();
    const isProviderMissing = err instanceof ProviderNotConfiguredError;
    // Spending-protection blocks are TERMINAL: no retry loop may hammer the
    // provider while the kill-switch is on or the quota is exhausted.
    const isSpendingBlocked = err instanceof ProviderSpendingError;
    // Provider reported exhausted quota ("no credits available" / 402): put the
    // provider in quarantine so no further job starts until the operator
    // recharges. No auto-retry, no auto-buy.
    if (/402|insufficient_quota|no credits available/.test(lower)) {
      reportProviderQuotaExhausted();
      nestedLog.warn('provider quota exhausted — processing quarantined', { jobId: job.id, userId: job.userId });
    }
    const transient = !isSpendingBlocked && isTransientError(err);

    // Auto-retry transient failures (network/503) up to the configured cap.
    if (transient && job.retryCount < config.maxJobRetries) {
      const retryCount = job.retryCount + 1;
      const backoff = config.retryBackoffBaseMs * retryCount;
      this.repo.update(job.id, {
        status: 'QUEUED',
        retryCount,
        nextRetryAt: new Date(Date.now() + backoff).toISOString(),
        startedAt: undefined,
        lastError: message,
        errorCode: 'TRANSIENT',
      });
      nestedLog.warn('job scheduled for transient retry', { jobId: job.id, retryCount });
      return;
    }

    // Terminal failure: refund the charge so the user is never billed for a
    // job that did not produce an SRT.
    this.credits.refundFinishedJob(job.userId, job.id, 'refund_failed_job');
    const errorCode = isProviderMissing
      ? 'PROVIDER_NOT_CONFIGURED'
      : isSpendingBlocked
        ? 'PROVIDER_UNAVAILABLE'
        : transient
          ? 'TRANSIENT'
          : 'TRANSCRIPTION_FAILED';
    this.repo.update(job.id, {
      status: 'FAILED',
      completedAt: now,
      lastError: message.slice(0, 2000),
      errorCode,
      nextRetryAt: undefined,
    });
    nestedLog.error('job failed', {
      jobId: job.id,
      userId: job.userId,
      errorCode,
    });
  }
}

export type { JobInputRef };