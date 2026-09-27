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
}

export interface AdminTxn {
  id: string;
  userId: string;
  amount: number;
  type: string;
  reason: string;
  jobId?: string;
  adminUserId?: string;
  idempotencyKey?: string;
  createdAt: string;
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

export function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}