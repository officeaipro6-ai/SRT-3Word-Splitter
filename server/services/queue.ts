/**
 * Local durable transcription job queue + single in-process worker.
 *
 * Jobs live in the persistent store (survive restarts), so this is a "queue"
 * implemented the simplest possible way — no external broker, no new deps.
 * The worker:
 *   - rehydrates on boot (stale PROCESSING -> FAILED + refund, QUEUED stay);
 *   - claims one eligible QUEUED job at a time (single concurrency);
 *   - runs the injected pipeline (the exact legacy post-processing steps);
 *   - enforces a job timeout, and refunds credits whenever a job ends in
 *     FAILED. There is NO automatic retry loop: a failed request is terminal
 *     and is never auto-resubmitted, so a provider call is never repeated.
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
import { runDetached } from '../http/asyncRoute';
import type { AsyncCreditService } from './creditFacade';
import {
  ProviderSpendingError,
  type ProviderSafetyService,
  classifyProviderFailure,
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
  credits: AsyncCreditService;
  getProvider: (name: string) => TranscriptionProvider;
  runPipeline: RunPipeline;
  /** Persisted provider safety state: the pre-call gate + failure reporting. */
  providerSafety: ProviderSafetyService;
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
  private readonly credits: AsyncCreditService;
  private readonly getProvider: (name: string) => TranscriptionProvider;
  private readonly runPipeline: RunPipeline;
  private readonly pollMs: number;
  private readonly providerSafety: ProviderSafetyService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(deps: JobQueueDeps) {
    this.repo = deps.repo;
    this.storage = deps.storage;
    this.credits = deps.credits;
    this.getProvider = deps.getProvider;
    this.runPipeline = deps.runPipeline;
    this.providerSafety = deps.providerSafety;
    this.pollMs = deps.pollMs ?? 2500;
  }

  /**
   * Boot recovery: PROCESSING jobs are treated as interrupted (crash).
   *
   * Async because the refund is a real credit transaction on the libSQL
   * provider. The ORDER is deliberately unchanged: the refund commits BEFORE the
   * job is marked FAILED, exactly as in the synchronous version, so a crash
   * between the two leaves a refunded-but-still-processing job rather than a
   * failed job that was never paid back.
   */
  async rehydrate(): Promise<void> {
    const now = new Date().toISOString();
    // Async: JobRepo.listProcessing() awaits the libSQL provider's
    // getProcessingJobs(). Calling it without await is what threw
    // "Cannot read properties of undefined (reading 'filter')" in production.
    for (const job of await this.repo.listProcessing()) {
      await this.credits.refundFinishedJob(job.userId, job.id, 'refund_interrupted_job');
      await this.repo.update(job.id, {
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
      runDetached('queue.tick', () => this.tick());
    }, this.pollMs);
    runDetached('queue.tick:initial', () => this.tick());
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
    const job = (
      await this.repo.listEligibleQueued(new Date().toISOString())
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return;
    this.busy = true;
    try {
      await this.processWithTimeout(job);
    } finally {
      this.busy = false;
    }
  }

  private async processWithTimeout(job: JobRecord): Promise<void> {
    if (!(await this.repo.update(job.id, { status: 'PROCESSING', startedAt: new Date().toISOString(), nextRetryAt: undefined }))) {
      return;
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Job timed out after ${Math.floor(config.jobTimeoutMs / 1000)}s.`)), config.jobTimeoutMs);
    });
    try {
      const result = await Promise.race([this.processOne(job), timeout]);
      const now = new Date().toISOString();
      await this.repo.update(job.id, {
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
      // A successful provider call clears the transient failure counter (it can
      // never clear a BLOCKED state — only an admin reset does that).
      this.providerSafety.reportSuccess();
    } catch (err: any) {
      await this.handleFailure(job, err);
    }
  }

  private async processOne(job: JobRecord): Promise<RunPipelineResult> {
    // Provider safety gate: checked IMMEDIATELY before calling the provider so a
    // job can never start an API call while the locally stored state is BLOCKED
    // (402 / insufficient quota) or the operator kill-switch is on. Applies to
    // every job, including jobs owned by ADMIN/UNLIMITED accounts.
    this.providerSafety.assertProviderSpendingAllowed();
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
    const isProviderMissing = err instanceof ProviderNotConfiguredError;
    // A provider-safety block is TERMINAL: no retry loop may hammer the provider
    // while the state is BLOCKED.
    const isSpendingBlocked = err instanceof ProviderSpendingError;
    // Classify the failure and let the PERSISTED state machine decide. A
    // reliable 402 (insufficient_quota / "no credits available") transitions the
    // provider to BLOCKED: no further job may start an API call, there is no
    // retry, no automatic recharge and no paid fallback provider. Only an admin
    // reset returns it to AVAILABLE.
    const failure = classifyProviderFailure({ message });
    let state: ReturnType<ProviderSafetyService['view']> | null = null;
    if (failure.kind !== 'UNKNOWN' || isSpendingBlocked) {
      state = this.providerSafety.reportFailure(failure);
    }
    const isNowBlocked = state?.blocked === true || isSpendingBlocked;
    if (state?.status === 'BLOCKED') {
      nestedLog.warn('provider BLOCKED — no further provider calls until an admin reset', {
        jobId: job.id,
        provider: state.provider,
        reason: state.reason,
      });
    }
    const transient = !isNowBlocked && !isSpendingBlocked && isTransientError(err);

    // No automatic retry loop for failed requests: a failed transcription
    // request is never auto-resubmitted (that would repeat the same provider/
    // Sarvam call). Failed jobs are terminal, classified as TRANSIENT when the
    // cause was a transient provider/network error but never re-queued here.

    // Terminal failure: refund the charge so the user is never billed for a
    // job that did not produce an SRT.
    await this.credits.refundFinishedJob(job.userId, job.id, 'refund_failed_job');
    const errorCode = isProviderMissing
      ? 'PROVIDER_NOT_CONFIGURED'
      : isSpendingBlocked || failure.kind === 'QUOTA_EXHAUSTED' || failure.kind === 'PAYMENT_REQUIRED'
        ? 'PROVIDER_BLOCKED'
        : transient
          ? 'TRANSIENT'
          : 'TRANSCRIPTION_FAILED';
    await this.repo.update(job.id, {
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