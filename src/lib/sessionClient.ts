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
}

const TOKEN_KEY = 'odia_srt_token';

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
  return {
    userId: data.userId,
    token: data.token || existing || '',
    credits: data.credits ?? 0,
    role: data.role === 'ADMIN' ? 'ADMIN' : 'USER',
    creditMode: data.creditMode === 'UNLIMITED' ? 'UNLIMITED' : 'NORMAL',
    unlimited: (data.creditMode ?? 'NORMAL') === 'UNLIMITED',
    freeTrialsUsed: data.freeTrialsUsed ?? 0,
    freeTrialLimit: data.freeTrialLimit ?? 0,
    freeTrialsRemaining: data.freeTrialsRemaining ?? data.freeTrialLimit ?? 0,
    createdAt: data.createdAt,
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