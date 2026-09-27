import React, { useCallback, useEffect, useState } from 'react';
import {
  Search,
  Users2,
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  ListChecks,
  ShieldCheck,
  Loader2,
  Activity,
  Bell,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import {
  fetchAdminUsers,
  fetchAdminUser,
  fetchAdminTransactions,
  fetchAdminJobs,
  adjustCredits,
  debitCredits,
  makeIdempotencyKey,
  fetchProviderSafety,
  resetProviderSafety,
  fetchAdminAlerts,
  type AdminUserView,
  type AdminTxn,
  type AdminJob,
  type ProviderSafety,
  type OwnerAlert,
} from '../lib/sessionClient';

type Section = 'users' | 'transactions' | 'jobs' | 'provider';

interface PendingOp {
  mode: 'grant' | 'debit';
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * Admin dashboard — Users, Credits, Grant/Deduct, Transaction History, Jobs and
 * Provider Safety.
 *
 * Manual credit changes are sent to the server as ADMIN_ADJUSTMENT requests; the
 * server authenticates the verified-owner session, records the audit entry
 * (amount, balance before/after, admin email, reason, timestamp) and is the only
 * place where balances or roles are ever written. This UI is deliberately
 * cosmetic in that sense — it cannot grant itself any authority.
 */
export const AdminDashboard: React.FC = () => {
  const [section, setSection] = useState<Section>('users');
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ user: AdminUserView; transactions: AdminTxn[] } | null>(null);
  const [txns, setTxns] = useState<AdminTxn[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [safety, setSafety] = useState<ProviderSafety | null>(null);
  const [alerts, setAlerts] = useState<OwnerAlert[]>([]);
  const [alertDelivery, setAlertDelivery] = useState<{ transports: string[]; connected: boolean; note: string | null } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOp | null>(null);
  const [grantAmount, setGrantAmount] = useState(10);
  const [grantReason, setGrantReason] = useState('');
  const [debitAmount, setDebitAmount] = useState(1);
  const [debitReason, setDebitReason] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  };

  const refreshUsers = useCallback(async () => {
    const list = await fetchAdminUsers();
    setUsers(list);
    return list;
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading('users');
      try {
        await refreshUsers();
      } catch (e: any) {
        flash(e.message);
      } finally {
        setLoading(null);
      }
    })();
  }, [refreshUsers]);

  const loadSection = async (s: Section) => {
    setSection(s);
    setLoading(s);
    try {
      if (s === 'transactions') setTxns(await fetchAdminTransactions());
      else if (s === 'jobs') setJobs(await fetchAdminJobs());
      else if (s === 'provider') {
        setSafety(await fetchProviderSafety());
        const alertData = await fetchAdminAlerts();
        setAlerts(alertData.alerts);
        setAlertDelivery(alertData.delivery);
      } else setLoading('users');
    } catch (e: any) {
      flash(e.message);
    } finally {
      setLoading(null);
    }
  };

  const selectUser = async (id: string) => {
    setSelectedId(id);
    setLoading('detail');
    try {
      setSelected(await fetchAdminUser(id));
    } catch (e: any) {
      flash(e.message);
    } finally {
      setLoading(null);
    }
  };

  const openConfirm = (mode: 'grant' | 'debit') => {
    setConfirmError(null);
    setPending({
      mode,
      userId: selected!.user.id,
      amount: mode === 'grant' ? grantAmount : debitAmount,
      reason: mode === 'grant' ? grantReason : debitReason,
      idempotencyKey: makeIdempotencyKey(),
    });
  };

  const executePending = async () => {
    if (!pending) return;
    if (!pending.reason.trim()) {
      setConfirmError('A reason is required for the credit audit trail.');
      return;
    }
    if (!Number.isInteger(pending.amount) || pending.amount <= 0) {
      setConfirmError('Amount must be a positive whole number.');
      return;
    }
    setLoading('op');
    try {
      let txn: AdminTxn;
      if (pending.mode === 'grant') {
        // Canonical manual adjustment: the server records ONE ADMIN_ADJUSTMENT
        // entry (amount added, balance before/after, admin email, reason, time).
        const result = await adjustCredits({
          userId: pending.userId,
          amount: pending.amount,
          reason: pending.reason.trim(),
          idempotencyKey: pending.idempotencyKey,
        });
        txn = result.transaction;
        const before = txn.balanceBefore ?? result.user.credits - txn.amount;
        flash(
          `ADMIN_ADJUSTMENT recorded: +${txn.amount} credits (${before} → ${txn.balanceAfter}). Ledger entry ${txn.id.slice(0, 8)}…`
        );
      } else {
        txn = await debitCredits({
          userId: pending.userId,
          amount: pending.amount,
          reason: pending.reason.trim(),
          idempotencyKey: pending.idempotencyKey,
        });
        flash(`Deducted ${txn.amount} credits — new balance ${txn.balanceAfter}.`);
      }
      setPending(null);
      setGrantReason('');
      setDebitReason('');
      await selectUser(pending.userId);
      await refreshUsers();
    } catch (e: any) {
      setConfirmError(e.message);
    } finally {
      setLoading(null);
    }
  };

  /** Manual operator reset: only valid after provider credits were added. */
  const doResetProvider = async () => {
    if (!safety?.blocked) return;
    if (
      !window.confirm(
        'Reset provider state to AVAILABLE?\n\nOnly do this AFTER you have added credits to the provider account. ' +
          'The app never recharges automatically.'
      )
    ) {
      return;
    }
    setResetting(true);
    try {
      const view = await resetProviderSafety();
      setSafety(view);
      flash(`Provider ${view.provider} reset to ${view.status}.`);
    } catch (e: any) {
      flash(e.message);
    } finally {
      setResetting(false);
    }
  };

  const filteredUsers = users.filter((u) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      u.id.toLowerCase().includes(q) ||
      (typeof u.ownerEmail === 'string' && u.ownerEmail.toLowerCase().includes(q))
    );
  });

  const tabCls = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
      active ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
    }`;

  const txnType = (t: AdminTxn) => {
    switch (t.type) {
      case 'ADMIN_ADJUSTMENT':
        return <span className="text-emerald-600 font-bold">+{t.amount} adjustment</span>;
      case 'ADMIN_DEBIT':
        return <span className="text-rose-600 font-bold">−{t.amount} debit</span>;
      case 'DEBIT':
        return <span className="text-slate-600">−{t.amount} charge</span>;
      case 'USAGE':
        return <span className="text-slate-600">−{t.amount} used</span>;
      case 'REFUND':
        return <span className="text-amber-600">+{t.amount} refund</span>;
      case 'RELEASE':
        return <span className="text-amber-600">+{t.amount} released</span>;
      case 'RESERVATION':
        return <span className="text-slate-500">{t.amount} reserved</span>;
      case 'CREDIT':
        return <span className="text-emerald-500">+{t.amount} credit</span>;
      default:
        return <span>{t.type} {t.amount}</span>;
    }
  };

  return (
    <div className="border-b border-slate-200 bg-slate-50 py-4">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-violet-600" />
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-slate-700">Admin Dashboard</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button className={tabCls(section === 'users')} onClick={() => void loadSection('users')}>
              <span className="inline-flex items-center gap-1"><Users2 className="w-3.5 h-3.5" /> Users</span>
            </button>
            <button className={tabCls(section === 'transactions')} onClick={() => void loadSection('transactions')}>
              <span className="inline-flex items-center gap-1"><History className="w-3.5 h-3.5" /> Transactions</span>
            </button>
            <button className={tabCls(section === 'jobs')} onClick={() => void loadSection('jobs')}>
              <span className="inline-flex items-center gap-1"><ListChecks className="w-3.5 h-3.5" /> Jobs</span>
            </button>
            <button className={tabCls(section === 'provider')} onClick={() => void loadSection('provider')}>
              <span className="inline-flex items-center gap-1"><Activity className="w-3.5 h-3.5" /> Provider</span>
            </button>
          </div>
        </div>

        {notice && <div className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{notice}</div>}
        {loading && (
          <div className="text-xs text-slate-400 inline-flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> loading…
          </div>
        )}

        {/* ── Users section ─────────────────────────────────────────────── */}
        {section === 'users' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by user id or owner email…"
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
              </div>
              <div className="max-h-96 overflow-auto space-y-1">
                {filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => void selectUser(u.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs border transition-colors cursor-pointer ${
                      selectedId === u.id
                        ? 'bg-indigo-50 border-indigo-300'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium text-slate-700">{u.id}</span>
                      {u.unlimited ? (
                        <span className="text-[10px] font-bold text-slate-100 bg-slate-900 rounded-md px-1.5 py-0.5">⚭ UNLIMITED</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-indigo-600 rounded-md px-1.5 py-0.5 bg-indigo-50">{u.credits} credits</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                      <span>{u.role}</span>
                      {u.ownerEmail && (
                        <>
                          <span>·</span>
                          <span className="text-amber-600">owner {u.ownerEmail}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>granted {u.totalGranted}</span>
                      <span>·</span>
                      <span>used {u.totalUsed}</span>
                      <span>·</span>
                      <span>created {new Date(u.createdAt).toLocaleString()}</span>
                    </div>
                  </button>
                ))}
                {filteredUsers.length === 0 && <div className="text-xs text-slate-400 italic px-2 py-4">No users match.</div>}
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-4">
              {!selected ? (
                <div className="text-xs text-slate-400 italic py-8 text-center">Select a user to view balance, ledger and adjust credits.</div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="font-mono text-xs font-semibold text-slate-700 break-all">{selected.user.id}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600">balance {selected.user.credits}</span>
                      {selected.user.ownerEmail && (
                        <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700">owner {selected.user.ownerEmail}</span>
                      )}
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600">granted {selected.user.totalGranted}</span>
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600">used {selected.user.totalUsed}</span>
                      {selected.user.purchasedCredits > 0 && (
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">purchased {selected.user.purchasedCredits}</span>
                      )}
                      {selected.user.bonusCredits > 0 && (
                        <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700">bonus {selected.user.bonusCredits}</span>
                      )}
                      {selected.user.unlimited && (
                        <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-100 font-bold">UNLIMITED</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                      <div className="text-[11px] font-bold text-slate-600 inline-flex items-center gap-1">
                        <ArrowDownToLine className="w-3 h-3 text-emerald-600" /> Add credits (adjustment)
                      </div>
                      <input
                        type="number" min={1} value={grantAmount}
                        onChange={(e) => setGrantAmount(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs"
                      />
                      <input
                        value={grantReason}
                        onChange={(e) => setGrantReason(e.target.value)}
                        placeholder="Reason (required, stored in ledger)…"
                        className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs"
                      />
                      <button
                        onClick={() => openConfirm('grant')}
                        className="w-full py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors cursor-pointer"
                      >
                        Add credits
                      </button>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                      <div className="text-[11px] font-bold text-slate-600 inline-flex items-center gap-1">
                        <ArrowUpFromLine className="w-3 h-3 text-rose-600" /> Deduct credits
                      </div>
                      <input
                        type="number" min={1} value={debitAmount}
                        onChange={(e) => setDebitAmount(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs"
                      />
                      <input
                        value={debitReason}
                        onChange={(e) => setDebitReason(e.target.value)}
                        placeholder="Reason (required)…"
                        className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs"
                      />
                      <button
                        onClick={() => openConfirm('debit')}
                        className="w-full py-1.5 rounded-lg text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 transition-colors cursor-pointer"
                      >
                        Deduct
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-bold text-slate-600 mb-1.5">Recent transactions</div>
                    <div className="max-h-44 overflow-auto text-xs space-y-1">
                      {selected.transactions.length === 0 ? (
                        <div className="text-slate-400 italic">No transactions yet.</div>
                      ) : (
                        selected.transactions.map((t) => (
                          <div key={t.id} className="rounded-md bg-slate-50 p-1.5 flex justify-between gap-2">
                            <span className="truncate">
                              {txnType(t)} <span className="text-slate-400">· {t.reason}</span>
                              {t.balanceBefore != null && (
                                <span className="text-slate-400"> · {t.balanceBefore} → {t.balanceAfter}</span>
                              )}
                              {t.adminEmail && <span className="text-amber-600"> · by {t.adminEmail}</span>}
                            </span>
                            <span className="text-slate-400 shrink-0">{new Date(t.createdAt).toLocaleTimeString()}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Transactions section ───────────────────────────────────────── */}
        {section === 'transactions' && (
          <div className="rounded-xl bg-white border border-slate-200 p-4">
            <div className="max-h-[28rem] overflow-auto text-xs">
              <table className="w-full">
                <thead className="text-left text-slate-500 sticky top-0 bg-white">
                  <tr>
                    <th className="py-1.5 pr-2 font-semibold">Time</th>
                    <th className="py-1.5 pr-2 font-semibold">User</th>
                    <th className="py-1.5 pr-2 font-semibold">Type</th>
                    <th className="py-1.5 pr-2 font-semibold">Balance</th>
                    <th className="py-1.5 pr-2 font-semibold">Reason</th>
                    <th className="py-1.5 pr-2 font-semibold">Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {txns.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="py-1.5 pr-2 text-slate-400 whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                      <td className="py-1.5 pr-2 font-mono text-slate-600">{t.userId.slice(0, 8)}</td>
                      <td className="py-1.5 pr-2">{txnType(t)}</td>
                      <td className="py-1.5 pr-2 text-slate-500">
                        {t.balanceBefore != null ? `${t.balanceBefore} → ${t.balanceAfter}` : t.balanceAfter}
                      </td>
                      <td className="py-1.5 pr-2 text-slate-500">{t.reason}</td>
                      <td className="py-1.5 pr-2 text-amber-600">{t.adminEmail ?? (t.adminUserId ? t.adminUserId.slice(0, 8) : '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {txns.length === 0 && <div className="text-slate-400 italic py-6 text-center">No transactions.</div>}
            </div>
          </div>
        )}

        {/* ── Jobs section ───────────────────────────────────────────────── */}
        {section === 'jobs' && (
          <div className="rounded-xl bg-white border border-slate-200 p-4">
            <div className="max-h-[28rem] overflow-auto text-xs">
              <table className="w-full">
                <thead className="text-left text-slate-500 sticky top-0 bg-white">
                  <tr>
                    <th className="py-1.5 pr-2 font-semibold">Created</th>
                    <th className="py-1.5 pr-2 font-semibold">User</th>
                    <th className="py-1.5 pr-2 font-semibold">Status</th>
                    <th className="py-1.5 pr-2 font-semibold">Provider</th>
                    <th className="py-1.5 pr-2 font-semibold">File</th>
                    <th className="py-1.5 pr-2 font-semibold">Charged</th>
                    <th className="py-1.5 pr-2 font-semibold">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} className="border-t border-slate-100">
                      <td className="py-1.5 pr-2 text-slate-400 whitespace-nowrap">{new Date(j.createdAt).toLocaleString()}</td>
                      <td className="py-1.5 pr-2 font-mono text-slate-600">{j.userId.slice(0, 8)}</td>
                      <td className="py-1.5 pr-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          j.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700'
                            : j.status === 'FAILED' || j.status === 'CANCELLED' ? 'bg-rose-50 text-rose-700'
                            : 'bg-amber-50 text-amber-700'
                        }`}>{j.status}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-slate-500">{j.provider}</td>
                      <td className="py-1.5 pr-2 text-slate-600 truncate max-w-[16rem]">{j.input.originalName}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{j.creditsCharged ?? '—'}</td>
                      <td className="py-1.5 pr-2 text-rose-500 truncate max-w-[14rem]">{j.lastError ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {jobs.length === 0 && <div className="text-slate-400 italic py-6 text-center">No jobs.</div>}
            </div>
          </div>
        )}

        {/* ── Provider section ────────────────────────────────────────────── */}
        {section === 'provider' && (
          <div className="space-y-4">
            <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-slate-800">Transcription provider safety</div>
                {safety && (
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    safety.status === 'AVAILABLE' ? 'bg-emerald-50 text-emerald-700'
                      : safety.status === 'WARNING' ? 'bg-amber-50 text-amber-700'
                      : 'bg-rose-50 text-rose-700'
                  }`}>{safety.status}</span>
                )}
              </div>
              {safety ? (
                <div className="text-xs text-slate-600 space-y-1">
                  <div>Provider: <strong>{safety.provider}</strong>{safety.blocked && <span className="text-rose-600 font-semibold"> — all ASR calls are blocked</span>}</div>
                  <div>{safety.message}</div>
                  <div className="text-[10px] text-slate-500">
                    Consecutive failures: {safety.consecutiveFailures}
                    {safety.lastErrorAt && <> · last error {new Date(safety.lastErrorAt).toLocaleString()}</>}
                    {safety.lastHttpStatus && <> (HTTP {safety.lastHttpStatus})</>}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Balance: {safety.balance.known && safety.balance.percent != null
                      ? `${safety.balance.percent.toFixed(1)}% remaining`
                      : 'unknown — this provider exposes no verified balance/quota API, so no percentage is shown.'}
                  </div>
                  {safety.lastResetAt && (
                    <div className="text-[10px] text-slate-400">Last manual reset: {new Date(safety.lastResetAt).toLocaleString()} by {safety.lastResetBy ?? 'unknown'}</div>
                  )}
                  {safety.lastError && (
                    <div className="text-[10px] text-rose-500 break-words">Last provider error: {safety.lastError}</div>
                  )}
                  {safety.blocked && (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => void doResetProvider()}
                        disabled={resetting}
                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> {resetting ? 'Resetting…' : 'Reset to AVAILABLE'}
                      </button>
                      <span className="text-[10px] text-slate-400">Only after adding credits provider-side. The app never recharges automatically.</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-slate-400 italic">No provider state loaded yet.</div>
              )}
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-2">
              <div className="text-sm font-bold text-slate-800">Recent owner alerts</div>
              {alertDelivery && !alertDelivery.connected && (
                <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 inline-flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{alertDelivery.note ?? 'No notification channel is connected — alerts are only recorded locally.'}</span>
                </div>
              )}
              {alerts.length === 0 ? (
                <div className="text-xs text-slate-400 italic py-3 text-center">No alerts recorded.</div>
              ) : (
                <div className="max-h-72 overflow-auto space-y-2 text-xs">
                  {alerts.map((a) => (
                    <div key={a.id} className="border border-slate-100 rounded-lg p-2 space-y-1">
                      <div className="flex items-center gap-2 font-semibold text-slate-700">
                        <Bell className="w-3.5 h-3.5 text-slate-400" />
                        {a.title}
                        <span className="ml-auto text-[10px] font-normal text-slate-400">{new Date(a.at).toLocaleString()}</span>
                      </div>
                      <pre className="text-[11px] text-slate-600 whitespace-pre-wrap font-sans">{a.body}</pre>
                      <div className="text-[10px] text-slate-400">
                        Delivery: {a.delivered ? `sent via ${a.deliveries.join(', ')}` : 'not sent (no channel connected)'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Confirm modal (grant/deduct) ─────────────────────────────────── */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="rounded-2xl bg-white w-full max-w-sm p-5 space-y-3 shadow-xl">
            <div className="text-sm font-bold text-slate-800">
              Confirm {pending.mode === 'grant' ? 'Credit adjustment' : 'Deduct'}
            </div>
            <div className="text-xs text-slate-600 space-y-1">
              <div>User: <span className="font-mono">{pending.userId}</span></div>
              <div>Amount: <strong>{pending.amount} credits</strong></div>
              <div>Reason: <em>{pending.reason || '—'}</em></div>
              <div className="text-[10px] text-slate-400">Audited as {pending.mode === 'grant' ? 'ADMIN_ADJUSTMENT' : 'ADMIN_DEBIT'} with an idempotency key (duplicate requests never double-apply). The ledger stores the balance before and after this change, plus the acting admin's verified email.</div>
            </div>
            {confirmError && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5">{confirmError}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setPending(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => void executePending()}
                disabled={loading === 'op'}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors cursor-pointer ${
                  pending.mode === 'grant' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                } disabled:opacity-60`}
              >
                {loading === 'op' ? 'Applying…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};