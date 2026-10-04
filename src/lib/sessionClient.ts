/**
 * Server-side session + credits client for the additive admin/credits UI.
 *
 * The opaque session token may be kept in localStorage (it is not an
 * authorization claim); role / creditMode / balances are ALWAYS fetched fresh
 * from the server and never trusted from the browser.
 */

export interface SessionInfo {
  userId: string;
  token: string;
  credits: number;
  role: 'USER' | 'ADMIN';
  creditMode: 'NORMAL' | 'UNLIMITED';
  unlimited: boolean;
  freeTrialsUsed: number;
  freeTrialLimit: number;
  freeTrialsRemaining: number;
  createdAt?: string;
  /** Normalized account email when this session is an email/password account. */
  email?: string | null;
  /** True when the session is backed by a persisted email/password account. */
  account?: boolean;
  /** ISO timestamp of the last successful email login on this account. */
  lastLoginAt?: string | null;
}

const TOKEN_KEY = 'odia_srt_token';

/** Fired after account sign-in / sign-out so widgets refresh server state. */
export const AUTH_CHANGED_EVENT = 'odiasrt-auth-changed';

export function notifyAuthChanged(): void {
  try {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  } catch {
    /* event dispatch unavailable (e.g. SSR/non-browser) */
  }
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — session still works in-memory */
  }
}

export async function ensureSession(): Promise<SessionInfo> {
  const existing = getStoredToken();
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(existing ? {} : {}),
    ...(existing ? { headers: { 'Content-Type': 'application/json', 'x-user-token': existing } } : {}),
  });
  if (!res.ok) throw new Error(`Session creation failed (${res.status}).`);
  const data = await res.json();
  if (data.token) storeToken(data.token);
  return parseSession(data, data.token || existing || '');
}

/** Map a server session body to the client shape (single source of truth). */
function parseSession(data: any, token: string): SessionInfo {
  return {
    userId: data.userId,
    token,
    credits: data.credits ?? 0,
    role: data.role === 'ADMIN' ? 'ADMIN' : 'USER',
    creditMode: data.creditMode === 'UNLIMITED' ? 'UNLIMITED' : 'NORMAL',
    unlimited: (data.creditMode ?? 'NORMAL') === 'UNLIMITED',
    freeTrialsUsed: data.freeTrialsUsed ?? 0,
    freeTrialLimit: data.freeTrialLimit ?? 0,
    freeTrialsRemaining: data.freeTrialsRemaining ?? data.freeTrialLimit ?? 0,
    createdAt: data.createdAt,
    email: data.email ?? null,
    account: Boolean(data.account),
    lastLoginAt: data.lastLoginAt ?? null,
  };
}

/**
 * Owner sign-in: exchanges the server-side admin bootstrap token + an owner
 * email for a session whose role is ADMIN.
 *
 * The bootstrap token is sent once and never stored client-side; only the
 * resulting opaque session token is persisted (as for any user). The server is
 * authoritative: it ignores the requested role, verifies the email against its
 * OWNER_EMAILS allowlist and re-checks that email on every admin request.
 */
export async function signInAsOwner(opts: { adminBootstrapToken: string; ownerEmail: string }): Promise<SessionInfo> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminBootstrapToken: opts.adminBootstrapToken.trim(),
      ownerEmail: opts.ownerEmail.trim().toLowerCase(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Owner sign-in failed.');
  if (data.role !== 'ADMIN') throw new Error('That email is not an authorized owner.');
  storeToken(data.token);
  return {
    userId: data.userId,
    token: data.token,
    credits: data.credits ?? 0,
    role: 'ADMIN',
    creditMode: data.creditMode === 'UNLIMITED' ? 'UNLIMITED' : 'NORMAL',
    unlimited: (data.creditMode ?? 'NORMAL') === 'UNLIMITED',
    freeTrialsUsed: data.freeTrialsUsed ?? 0,
    freeTrialLimit: data.freeTrialLimit ?? 0,
    freeTrialsRemaining: data.freeTrialsRemaining ?? data.freeTrialLimit ?? 0,
    createdAt: data.createdAt,
  };
}

/**
 * Normal USER email/password sign-up — a separate auth surface from the
 * ADMIN bootstrap. Requires only an email + password; the server issues a
 * session token exactly like /api/session. Sign-up never grants ADMIN.
 */
export async function signupAccount(opts: {
  email: string;
  password: string;
  language?: string;
}): Promise<SessionInfo> {
  const res = await fetch('/api/account/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: opts.email.trim().toLowerCase(),
      password: opts.password,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Account creation failed.');
  storeToken(data.token);
  return parseSession(data, data.token);
}

/** Sign in to an existing email/password account. */
export async function loginAccount(opts: {
  email: string;
  password: string;
  language?: string;
}): Promise<SessionInfo> {
  const res = await fetch('/api/account/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: opts.email.trim().toLowerCase(),
      password: opts.password,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Sign-in failed.');
  storeToken(data.token);
  return parseSession(data, data.token);
}

/** Sign out: revoke the current token server-side and clear it locally. */
export async function logoutAccount(): Promise<void> {
  const res = await authFetch('/api/account/logout', { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Sign-out failed.');
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Authenticated fetch wrapper. */
export async function authFetch(
  path: string,
  init: RequestInit = {},
  token: string | null = getStoredToken()
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set('x-user-token', token || '');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...init, headers });
}

export interface AdminUserView {
  id: string;
  role: 'USER' | 'ADMIN';
  creditMode: 'NORMAL' | 'UNLIMITED';
  unlimited: boolean;
  credits: number;
  purchasedCredits: number;
  bonusCredits: number;
  totalGranted: number;
  totalUsed: number;
  createdAt: string;
  lastSeenAt: string | null;
  /** Server-verified owner email (only verified owner accounts have one). */
  ownerEmail?: string | null;
  /** Normal email/password account email (admin-visible only). */
  email?: string | null;
  /** ISO timestamp of the account's last email login (admin-visible only). */
  lastLoginAt?: string | null;
}

export interface AdminTxn {
  id: string;
  userId: string;
  amount: number;
  type: string;
  reason: string;
  jobId?: string;
  adminUserId?: string;
  /** Verified owner email recorded on manual admin adjustments. */
  adminEmail?: string;
  idempotencyKey?: string;
  createdAt: string;
  balanceBefore?: number;
  balanceAfter: number;
}

export interface AdminJob {
  id: string;
  userId: string;
  status: string;
  provider: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  errorCode?: string;
  creditsCharged?: number;
  input: { originalName: string; mimeType: string; sizeBytes: number; durationSeconds: number };
}

export async function fetchAdminUsers(): Promise<AdminUserView[]> {
  const res = await authFetch('/api/admin/users');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load users.');
  const data = await res.json();
  return data.users ?? [];
}

export async function fetchAdminUser(id: string): Promise<{ user: AdminUserView; transactions: AdminTxn[] }> {
  const res = await authFetch(`/api/admin/users/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Failed to load user detail.');
  return res.json();
}

export async function fetchAdminTransactions(userId?: string): Promise<AdminTxn[]> {
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const res = await authFetch(`/api/admin/transactions${qs}`);
  if (!res.ok) throw new Error('Failed to load transactions.');
  const data = await res.json();
  return data.transactions ?? [];
}

export async function fetchAdminJobs(userId?: string): Promise<AdminJob[]> {
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const res = await authFetch(`/api/admin/jobs${qs}`);
  if (!res.ok) throw new Error('Failed to load jobs.');
  const data = await res.json();
  return data.jobs ?? [];
}

// ------------------------------------------------- monthly login activity

/** One recorded login/session event, as returned by the admin API. */
export interface AdminLoginRow {
  id: string;
  userId: string;
  email?: string;
  loginDate: string;
  loginTime: string;
  istDateTime: string;
  month: string;
  occurredAt: string;
  method: string;
  outcome: 'SUCCESS' | 'FAILURE';
  failureCode?: string;
  ip?: string;
  userAgent?: string;
}

export interface AdminLoginPage {
  month: string;
  summary: {
    month: string;
    totalLogins: number;
    uniqueUsers: number;
    activeUsers: number;
    failedLogins: number;
  };
  rows: AdminLoginRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  availableMonths: string[];
}

export async function fetchAdminLoginActivity(params: {
  month?: string;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<AdminLoginPage> {
  const qs = new URLSearchParams();
  if (params.month) qs.set('month', params.month);
  if (params.q) qs.set('q', params.q);
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const suffix = qs.toString() ? `?${qs}` : '';
  const res = await authFetch(`/api/admin/login-activity${suffix}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load login activity.');
  return res.json();
}

/** The daily "yesterday's login activity" alert log, newest first. */
export async function fetchAdminLoginAlerts(): Promise<{
  alerts: Array<{
    id: string;
    alertDate: string;
    periodDate: string;
    month: string;
    generatedAt: string;
    totalLogins: number;
    uniqueUsers: number;
    newUsers: number;
    activeUsers: number;
    failedLogins: number;
    deliveryStatus: 'NOT_CONFIGURED' | 'DELIVERED' | 'FAILED';
    statusMessage: string;
  }>;
}> {
  const res = await authFetch('/api/admin/login-alerts');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load login alerts.');
  return res.json();
}

/**
 * Run the daily login-activity alert now. Safe to press repeatedly: the server
 * keys the alert on the day being reported, so a second press returns the
 * existing alert with `duplicate: true` instead of sending a new one.
 */
export async function runAdminLoginAlert(): Promise<{ duplicate: boolean }> {
  const res = await authFetch('/api/admin/login-alerts/run', { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to run the login alert.');
  return res.json();
}

/**
 * Download the login activity as Excel for a given month and optional query.
 */
export async function downloadAdminLoginExcel(month?: string, q?: string): Promise<Blob> {
  const qs = new URLSearchParams();
  if (month) qs.set('month', month);
  if (q) qs.set('q', q);
  const suffix = qs.toString() ? `?${qs}` : '';
  const res = await authFetch(`/api/admin/login-activity/export${suffix}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to download login activity Excel.');
  return res.blob();
}

/**
 * Manual credit adjustment (the admin UI's "add credits" action).
 * Records exactly one ADMIN_ADJUSTMENT ledger entry on the server: amount
 * added, balance before/after, the acting admin, the reason and a timestamp.
 */
export async function adjustCredits(opts: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}): Promise<{ transaction: AdminTxn; applied: boolean; user: AdminUserView }> {
  const res = await authFetch('/api/admin/credits/adjust', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Credit adjustment failed (${res.status}).`);
  }
  return res.json();
}

/** Legacy alias: the server records the same ADMIN_ADJUSTMENT entry. */
export async function grantCredits(opts: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}): Promise<AdminTxn> {
  const res = await authFetch('/api/admin/credits/grant', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Grant failed (${res.status}).`);
  }
  return (await res.json()).transaction;
}

export async function debitCredits(opts: {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}): Promise<AdminTxn> {
  const res = await authFetch('/api/admin/credits/debit', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Deduct failed (${res.status}).`);
  }
  return (await res.json()).transaction;
}

export interface CreditPack {
  id: string;
  name: string;
  priceInr: number;
  credits: number;
  glyph: string;
  annual?: boolean;
  blurb?: string;
}

/** Public credit pack catalog. Display-only: no purchase endpoint exists yet. */
export async function fetchCreditPacks(): Promise<CreditPack[]> {
  const res = await fetch('/api/credits/packs');
  if (!res.ok) throw new Error(`Failed to load credit packs (${res.status}).`);
  const data = await res.json();
  return data.packs ?? [];
}

export type ProviderSafetyStatus = 'AVAILABLE' | 'WARNING' | 'BLOCKED';

export interface ProviderSafety {
  provider: string;
  status: ProviderSafetyStatus;
  reason: 'KILL_SWITCH' | 'QUOTA_EXHAUSTED' | null;
  blocked: boolean;
  reasonText: string;
  lastError: string | null;
  lastHttpStatus: number | null;
  lastErrorAt: string | null;
  blockedAt: string | null;
  updatedAt: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastResetAt: string | null;
  lastResetBy: string | null;
  balance: {
    known: boolean;
    percent: number | null;
    source: string | null;
    unit: string | null;
    updatedAt: string | null;
  };
  message: string;
  history: Array<{
    at: string;
    from: string;
    to: string;
    reason: string;
    kind: string;
    httpStatus?: number;
    notified: boolean;
  }>;
  /** False when the provider exposes no verified balance/quota API. */
  balanceSourceAvailable: boolean;
}

/** Locally stored provider safety state (AVAILABLE / WARNING / BLOCKED). */
export async function fetchProviderSafety(): Promise<ProviderSafety> {
  const res = await authFetch('/api/admin/provider/safety');
  if (!res.ok) throw new Error('Failed to load provider safety state.');
  const data = await res.json();
  return data.providerSafety;
}

/** Manual operator reset to AVAILABLE, after credits were added provider-side. */
export async function resetProviderSafety(): Promise<ProviderSafety> {
  const res = await authFetch('/api/admin/provider/safety/reset', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Reset failed (${res.status}).`);
  }
  const data = await res.json();
  return data.providerSafety;
}

export interface OwnerAlert {
  id: string;
  event: 'PROVIDER_WARNING' | 'PROVIDER_BLOCKED' | 'LOW_BALANCE' | 'QUOTA_EXHAUSTED';
  provider: string;
  title: string;
  body: string;
  reason: string | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  balancePercent: number | null;
  balanceSource: string | null;
  at: string;
  delivered: boolean;
  deliveries: string[];
  note: string | null;
}

/**
 * Recent owner alerts. `delivery.connected` is false until a real channel (e.g.
 * WhatsApp) is configured — the UI must never imply a working integration.
 */
export async function fetchAdminAlerts(): Promise<{
  alerts: OwnerAlert[];
  delivery: { transports: string[]; connected: boolean; note: string | null };
}> {
  const res = await authFetch('/api/admin/alerts');
  if (!res.ok) throw new Error('Failed to load alerts.');
  return res.json();
}

export function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Community & Support
//
// IMPORTANT: these are thin transport wrappers only. Nothing here decides
// whether a message is acceptable, computes a restriction, or supplies a
// duration/timestamp — every moderation fact comes back from the server.
// ---------------------------------------------------------------------------

export type SupportCategory =
  | 'TRANSCRIPTION'
  | 'TIMING'
  | 'TAGGING'
  | 'SRT'
  | 'CREDITS'
  | 'LOGIN'
  | 'OTHER';

export type ModerationOutcome = 'ACCEPTED' | 'WARNING' | 'RESTRICTED' | 'ADMIN_REVIEW' | 'BLOCKED';

export interface CommunityGuidelines {
  guidelines: string;
  categories: SupportCategory[];
  categoryLabels: Record<SupportCategory, string>;
  attachmentMaxBytes: number;
  attachmentAccept: string;
  telegram: string;
}

export interface RestrictionStatus {
  restricted: boolean;
  startedAt?: string;
  expiresAt?: string;
  remainingMs: number;
  extendedCount: number;
  automatic: boolean;
}

export interface CommunitySubmissionResult {
  outcome: ModerationOutcome;
  message: string;
  accepted: boolean;
  messageId?: string;
  restriction?: RestrictionStatus;
  case?: { id: string; action: string; category: string; createdAt: string };
}

export async function fetchCommunityGuidelines(): Promise<CommunityGuidelines> {
  // Public: contains no user data, so a plain fetch is correct here.
  const res = await fetch('/api/community/guidelines');
  if (!res.ok) throw new Error('Failed to load community guidelines.');
  return res.json();
}

export async function fetchCommunityStatus(): Promise<RestrictionStatus> {
  const res = await authFetch('/api/community/status');
  if (!res.ok) throw new Error('Failed to load community status.');
  const data = (await res.json()) as RestrictionStatus;
  return data;
}

/**
 * Submit a message. `kind` picks the endpoint; the server uses the ROUTE to
 * decide the kind, so a client cannot mislabel a support request as a post.
 * A 403/422 is a valid moderation answer, not a transport error, so the
 * server's message is surfaced to the user instead of throwing.
 */
async function submitCommunity(
  endpoint: string,
  opts: { body: string; category?: SupportCategory; attachment?: File | null }
): Promise<CommunitySubmissionResult> {
  const form = new FormData();
  form.append('body', opts.body);
  if (opts.category) form.append('category', opts.category);
  if (opts.attachment) form.append('attachment', opts.attachment);
  const res = await authFetch(endpoint, { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as Partial<CommunitySubmissionResult> & {
    error?: string;
  };
  if (!res.ok && !data.outcome) {
    throw new Error(data.error || 'Could not send your message.');
  }
  return {
    outcome: data.outcome ?? 'ACCEPTED',
    message: data.message || data.error || '',
    accepted: data.accepted === true,
    messageId: data.messageId,
    restriction: data.restriction,
    case: data.case,
  };
}

export function sendCommunityMessage(opts: {
  body: string;
  attachment?: File | null;
}): Promise<CommunitySubmissionResult> {
  return submitCommunity('/api/community/messages', opts);
}

export function sendSupportRequest(opts: {
  body: string;
  category?: SupportCategory;
  attachment?: File | null;
}): Promise<CommunitySubmissionResult> {
  return submitCommunity('/api/community/support', opts);
}

export function reportProblem(opts: {
  body: string;
  attachment?: File | null;
}): Promise<CommunitySubmissionResult> {
  return submitCommunity('/api/community/reports', opts);
}

// ---- Admin moderation (owner-only; the server enforces that, not the UI) ----

export interface AdminModerationCase {
  id: string;
  userId: string;
  email: string | null;
  ownerEmail: string | null;
  category: string;
  action: string;
  confidence: string;
  automatic: boolean;
  createdAt: string;
  reason: string | null;
  excerpt: string | null;
  adminNote: string | null;
  reviewedAt: string | null;
  restrictionStartedAt: string | null;
  restrictionExpiresAt: string | null;
}

export interface AdminActiveRestriction {
  userId: string;
  email: string | null;
  ownerEmail: string | null;
  startedAt: string;
  expiresAt: string;
  extendedCount: number;
  automatic: boolean;
}

export interface AdminModerationMessage {
  id: string;
  userId: string;
  kind: string;
  category: string | null;
  body: string;
  accepted: boolean;
  createdAt: string;
  attachmentName: string | null;
  attachmentMime: string | null;
  attachmentBytes: number | null;
  attachmentKey: string | null;
}

export async function fetchAdminModeration(): Promise<{
  activeRestrictions: AdminActiveRestriction[];
  cases: AdminModerationCase[];
  messages: AdminModerationMessage[];
  telegram: string;
}> {
  const res = await authFetch('/api/admin/moderation');
  if (!res.ok) throw new Error('Failed to load moderation.');
  return res.json();
}

export async function markModerationCaseReviewed(
  caseId: string,
  note?: string
): Promise<{ ok: true }> {
  const res = await authFetch(
    `/api/admin/moderation/cases/${encodeURIComponent(caseId)}/review`,
    { method: 'POST', body: JSON.stringify({ note }) }
  );
  if (!res.ok) throw new Error('Failed to mark the case reviewed.');
  return { ok: true };
}

export async function extendRestriction(
  userId: string,
  additionalMs: number,
  note?: string
): Promise<{ ok: true }> {
  const res = await authFetch('/api/admin/moderation/restrictions/extend', {
    method: 'POST',
    body: JSON.stringify({ userId, additionalMs, note }),
  });
  if (!res.ok) throw new Error('Failed to extend the restriction.');
  return { ok: true };
}

export async function releaseRestriction(
  userId: string,
  note?: string
): Promise<{ ok: true }> {
  const res = await authFetch('/api/admin/moderation/restrictions/release', {
    method: 'POST',
    body: JSON.stringify({ userId, note }),
  });
  if (!res.ok) throw new Error('Failed to release the restriction.');
  return { ok: true };
}

/** Admin-only, authenticated attachment URL. Never linkable by a normal user. */
export function adminAttachmentUrl(userId: string, key: string): string {
  return `/api/admin/moderation/attachments/${encodeURIComponent(userId)}/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

// ============================================================================
// CREDIT PURCHASE — Razorpay integration (server-verified)
// ============================================================================

export interface CreateOrderRequest {
  planId: string;
}

export interface CreateOrderResponse {
  orderId: string;
  amount: number; // in paise
  currency: 'INR';
  keyId: string;
  plan: {
    id: string;
    name: string;
    credits: number;
    priceInr: number;
  };
}

export interface VerifyPaymentRequest {
  orderId: string;
  paymentId: string;
  signature: string;
  planId: string;
}

export interface VerifyPaymentResponse {
  success: boolean;
  transaction: any;
  credits: number;
  alreadyProcessed: boolean;
}

/**
 * Create a Razorpay order for a credit purchase.
 * The server resolves the plan and amount from locked server-side definitions.
 */
export async function createCreditPurchaseOrder(planId: string): Promise<CreateOrderResponse> {
  const res = await authFetch('/api/credits/purchase/order', {
    method: 'POST',
    body: JSON.stringify({ planId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create order (${res.status})`);
  }
  return res.json();
}

/**
 * Verify a payment after Razorpay checkout.
 * The server verifies the Razorpay signature and credits the account only on success.
 */
export async function verifyCreditPurchase(input: VerifyPaymentRequest): Promise<VerifyPaymentResponse> {
  const res = await authFetch('/api/credits/purchase/verify', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Payment verification failed (${res.status})`);
  }
  return res.json();
}