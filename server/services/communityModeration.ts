/**
 * Community & Support moderation service — the single server-side decision
 * point. Routes call it; the client never decides anything.
 *
 * Policy (strict but fair):
 *   1. FIRST confirmed violation  -> WARNING only. Recorded, never banned.
 *   2. REPEATED confirmed violation -> temporary restriction of exactly
 *      RESTRICTION_DURATION_MS (2 hours), stored server-side with start+expiry.
 *   3. While restricted, submissions are refused SERVER-SIDE before any
 *      content is stored, and the user is told the remaining time.
 *   4. UNCERTAIN classifications are flagged for admin review and NEVER
 *      restrict anyone — that is the false-positive protection.
 *   5. Only an authenticated, allowlisted ADMIN can extend or release a
 *      restriction. There is no automatic permanent ban, ever.
 *   6. Client-supplied timestamps, durations and moderation status are ignored.
 *      Every time value here is computed on the server.
 */
import type {
  ModerationCaseRecord,
  CommunityRestrictionRecord,
  SupportCategory,
  ViolationCategory,
} from '../db/types.ts';
import { ModerationRepo } from '../db/repos.ts';
import { analyzeCommunityText, type ModerationAnalysis } from './moderationClassifier.ts';

/** Automatic temporary restriction length: 2 hours. Server-fixed, never client-set. */
export const RESTRICTION_DURATION_MS = 2 * 60 * 60 * 1000;

/** Cap on how far an admin may extend in one action (7 days). */
export const MAX_ADMIN_EXTENSION_MS = 7 * 24 * 60 * 60 * 1000;

export const COMMUNITY_GUIDELINES = [
  'Community Guidelines',
  'Please communicate respectfully.',
  'Abusive, vulgar, threatening, harassing, or insulting language is not allowed.',
  'Violations may result in a temporary restriction.',
].join('\n');

/**
 * Telegram note. The app enforces its OWN restriction on its own submission
 * endpoints. It never claims to ban anyone inside Telegram: that needs a real
 * bot with moderation permissions, which is not configured.
 */
export const TELEGRAM_MODERATION_NOTE =
  'Telegram-native moderation (banning or muting a person inside Telegram) is NOT active: it requires a configured Telegram Bot API integration with the required admin permissions. This app enforces its own community restriction on its own Community & Support submissions.';

export type SubmissionOutcome = 'ACCEPTED' | 'WARNING' | 'RESTRICTED' | 'ADMIN_REVIEW' | 'BLOCKED';

export interface RestrictionStatus {
  restricted: boolean;
  startedAt?: string;
  expiresAt?: string;
  remainingMs: number;
  extendedCount: number;
  automatic: boolean;
}

export interface SubmissionInput {
  userId: string;
  kind: 'COMMUNITY' | 'SUPPORT';
  body: string;
  category?: SupportCategory;
  attachment?: { name: string; mime: string; bytes: number; key: string };
}

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  /** HTTP status the route should use. */
  status: number;
  message: string;
  accepted: boolean;
  case?: ModerationCaseRecord;
  restriction?: RestrictionStatus;
  analysis: ModerationAnalysis;
  messageId?: string;
}

export interface AdminActionResult {
  ok: boolean;
  reason?: string;
  restriction?: CommunityRestrictionRecord;
  case?: ModerationCaseRecord;
}

function excerptOf(body: string, max = 300): string {
  const oneLine = String(body ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export class CommunityModerationService {
  constructor(
    private readonly repo: ModerationRepo,
    private readonly opts: { now?: () => number } = {}
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Current restriction for a user; expired restrictions report as inactive. */
  statusFor(userId: string): RestrictionStatus {
    const active = this.repo.activeRestriction(userId, this.now());
    if (!active) {
      return { restricted: false, remainingMs: 0, extendedCount: 0, automatic: false };
    }
    const remainingMs = Math.max(0, new Date(active.expiresAt).getTime() - this.now());
    return {
      restricted: true,
      startedAt: active.startedAt,
      expiresAt: active.expiresAt,
      remainingMs,
      extendedCount: active.extendedCount,
      automatic: active.automatic,
    };
  }

  /**
   * Review a submission. Returns a decision; performs the server-side
   * enforcement. `input.attachment` is metadata only (bytes already stored).
   */
  reviewSubmission(input: SubmissionInput): SubmissionResult {
    const userId = input.userId;

    // ---- 1. Restriction is checked FIRST, before any content is stored.
    const restriction = this.statusFor(userId);
    if (restriction.restricted) {
      return {
        outcome: 'BLOCKED',
        status: 403,
        message: `Your community access is temporarily restricted. ${formatRemaining(restriction.remainingMs)} remaining.`,
        accepted: false,
        restriction,
        analysis: { verdict: 'CLEAN', categories: [], signals: [], confidence: 1 },
      };
    }

    const analysis = analyzeCommunityText(input.body);
    const primaryCategory: ViolationCategory = analysis.categories[0] ?? 'ABUSIVE';

    // ---- 2. Clean: accept and store.
    if (analysis.verdict === 'CLEAN') {
      const stored = this.repo.addMessage({
        userId,
        kind: input.kind,
        category: input.category,
        body: input.body,
        accepted: true,
        attachmentName: input.attachment?.name,
        attachmentMime: input.attachment?.mime,
        attachmentBytes: input.attachment?.bytes,
        attachmentKey: input.attachment?.key,
      });
      return {
        outcome: 'ACCEPTED',
        status: 201,
        message: 'Thank you. Your message has been received.',
        accepted: true,
        analysis,
        messageId: stored.id,
      };
    }

    // ---- 3. Uncertain: flag for a human, never punish.
    if (analysis.verdict === 'UNCERTAIN') {
      const moderationCase = this.repo.addCase({
        userId,
        category: primaryCategory,
        action: 'ADMIN_REVIEW',
        confidence: 'UNCERTAIN',
        automatic: true,
        reason: 'Ambiguous or contextual language: routed to an admin, not punished.',
        excerpt: excerptOf(input.body),
      });
      this.repo.addMessage({
        userId,
        kind: input.kind,
        category: input.category,
        body: input.body,
        accepted: false,
        moderationCaseId: moderationCase.id,
        attachmentName: input.attachment?.name,
        attachmentMime: input.attachment?.mime,
        attachmentBytes: input.attachment?.bytes,
        attachmentKey: input.attachment?.key,
      });
      return {
        outcome: 'ADMIN_REVIEW',
        status: 202,
        message:
          'Thanks — your message is pending a quick review by an admin so we can judge the context fairly. Nothing has been restricted.',
        accepted: false,
        case: moderationCase,
        analysis,
      };
    }

    // ---- 4. Confirmed abuse. First offence warns, a repeat restricts.
    const priorConfirmed = this.repo.confirmedCaseCount(userId);

    if (priorConfirmed === 0) {
      const moderationCase = this.repo.addCase({
        userId,
        category: primaryCategory,
        action: 'WARNING',
        confidence: 'CONFIRMED',
        automatic: true,
        reason: 'First confirmed community-guideline violation: warning issued, no restriction.',
        excerpt: excerptOf(input.body),
      });
      this.repo.addMessage({
        userId,
        kind: input.kind,
        category: input.category,
        body: input.body,
        accepted: false,
        moderationCaseId: moderationCase.id,
        attachmentName: input.attachment?.name,
        attachmentMime: input.attachment?.mime,
        attachmentBytes: input.attachment?.bytes,
        attachmentKey: input.attachment?.key,
      });
      return {
        outcome: 'WARNING',
        status: 422,
        message:
          'Community guideline warning: abusive, vulgar, threatening, harassing or insulting language is not allowed. This is your first warning — a further violation will result in a temporary restriction.',
        accepted: false,
        case: moderationCase,
        analysis,
      };
    }

    // Repeat offence: 2-hour server-side restriction.
    const restrictionRecord = this.repo.applyRestriction(
      {
        userId,
        durationMs: RESTRICTION_DURATION_MS,
        violationCount: priorConfirmed + 1,
        automatic: true,
      },
      this.now()
    );
    const moderationCase = this.repo.addCase({
      userId,
      category: primaryCategory,
      action: 'RESTRICTED',
      confidence: 'CONFIRMED',
      automatic: true,
      reason: 'Repeat confirmed community-guideline violation: temporary 2-hour restriction applied.',
      excerpt: excerptOf(input.body),
      restrictionStartedAt: restrictionRecord.startedAt,
      restrictionExpiresAt: restrictionRecord.expiresAt,
    });
    this.repo.addMessage({
      userId,
      kind: input.kind,
      category: input.category,
      body: input.body,
      accepted: false,
      moderationCaseId: moderationCase.id,
      attachmentName: input.attachment?.name,
      attachmentMime: input.attachment?.mime,
      attachmentBytes: input.attachment?.bytes,
        attachmentKey: input.attachment?.key,
    });

    const newStatus = this.statusFor(userId);
    return {
      outcome: 'RESTRICTED',
      status: 403,
      message: `Your community access is temporarily restricted for 2 hours because of repeated community-guideline violations. ${formatRemaining(newStatus.remainingMs)} remaining. An admin can review this.`,
      accepted: false,
      case: moderationCase,
      restriction: newStatus,
      analysis,
    };
  }

  // ---- Admin actions (routes additionally require auth() + requireAdmin) ----

  /** Manually extend an ACTIVE restriction. Duration is server-bounded. */
  extendRestriction(input: {
    userId: string;
    additionalMs: number;
    adminUserId: string;
    adminEmail?: string;
    note?: string;
  }): AdminActionResult {
    const requested = Number(input.additionalMs);
    if (!Number.isFinite(requested) || requested <= 0) {
      return { ok: false, reason: 'A positive extension duration is required.' };
    }
    const additionalMs = Math.min(requested, MAX_ADMIN_EXTENSION_MS);
    const record = this.repo.extendRestriction(input.userId, additionalMs, this.now());
    if (!record) {
      return { ok: false, reason: 'No active restriction found for that account.' };
    }
    const moderationCase = this.repo.addCase({
      userId: input.userId,
      category: 'ABUSIVE',
      action: 'RESTRICTION_EXTENDED',
      confidence: 'CONFIRMED',
      automatic: false,
      reason: 'Restriction extended manually by an admin.',
      adminUserId: input.adminUserId,
      adminEmail: input.adminEmail,
      adminNote: input.note,
      restrictionStartedAt: record.startedAt,
      restrictionExpiresAt: record.expiresAt,
    });
    return { ok: true, restriction: record, case: moderationCase };
  }

  /** Release a restriction early. */
  releaseRestriction(input: {
    userId: string;
    adminUserId: string;
    adminEmail?: string;
    note?: string;
  }): AdminActionResult {
    const record = this.repo.releaseRestriction(input.userId, input.adminUserId);
    if (!record) {
      return { ok: false, reason: 'No restriction found for that account.' };
    }
    const moderationCase = this.repo.addCase({
      userId: input.userId,
      category: 'ABUSIVE',
      action: 'RESTRICTION_RELEASED',
      confidence: 'CONFIRMED',
      automatic: false,
      reason: 'Restriction released manually by an admin.',
      adminUserId: input.adminUserId,
      adminEmail: input.adminEmail,
      adminNote: input.note,
      restrictionStartedAt: record.startedAt,
      restrictionExpiresAt: record.expiresAt,
    });
    return { ok: true, restriction: record, case: moderationCase };
  }

  /** Mark a case reviewed. */
  reviewCase(input: {
    caseId: string;
    adminUserId: string;
    adminEmail?: string;
    note?: string;
  }): AdminActionResult {
    const found = this.repo.getCase(input.caseId);
    if (!found) return { ok: false, reason: 'Case not found.' };
    const updated = this.repo.markReviewed(input.caseId, {
      adminUserId: input.adminUserId,
      adminEmail: input.adminEmail,
      note: input.note,
    });
    return updated ? { ok: true, case: updated } : { ok: false, reason: 'Case not found.' };
  }
}

/** Human-friendly remaining time, computed server-side. */
export function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  if (totalMinutes < 60) return `${totalMinutes} minute(s)`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
