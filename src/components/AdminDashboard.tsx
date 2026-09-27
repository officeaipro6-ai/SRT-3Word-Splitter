import React, { useCallback, useEffect, useState } from 'react';
import { Search, Users2, ArrowDownToLine, ArrowUpFromLine, History, ListChecks, ShieldCheck, Loader2 } from 'lucide-react';
import {
  fetchAdminUsers,
  fetchAdminUser,
  fetchAdminTransactions,
  fetchAdminJobs,
  grantCredits,
  debitCredits,
  makeIdempotencyKey,
  type AdminUserView,
  type AdminTxn,
  type AdminJob,
} from '../lib/sessionClient';

type Section = 'users' | 'transactions' | 'jobs';

interface PendingOp {
  mode: 'grant' | 'debit';
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * Admin dashboard — Users, Credits, Grant/Deduct, Transaction History, Jobs.
 * Cosmetics only: the server independently authenticates the ADMIN session and
 * enforces reason-mandatory + idempotency for every credit mutation.
 */
export const AdminDashboard: React.FC = () => {
  const [section, setSection] = useState<Section>('users');
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ user: AdminUserView; transactions: AdminTxn[] } | null>(null);
  const [txns, setTxns] = useState<AdminTxn[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
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
      else setLoading('users');
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
      const fn = pending.mode === 'grant' ? grantCredits : debitCredits;
      const txn = await fn({
        userId: pending.userId,
        amount: pending.amount,
        reason: pending.reason.trim(),
        idempotencyKey: pending.idempotencyKey,
      });
      flash(
        `${pending.mode === 'grant' ? 'Granted' : 'Deducted'} ${txn.amount} credits — new balance ${txn.balanceAfter}.`
      );
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

  const filteredUsers = users.filter(
    (u) => u.id.includes(query) || (query && u.id.slice(0, 8) === query.toLowerCase())
  );

  const tabCls = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
      active ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
    }`;

  const txnType = (t: AdminTxn) => {
    switch (t.type) {
      case 'ADMIN_GRANT':
        return <span className="text-emerald-600 font-bold">+{t.amount} grant</span>;
      case 'ADMIN_DEBIT':
        return <span className="text-rose-600 font-bold">−{t.amount} debit</span>;
      case 'DEBIT':
        return <span className="text-slate-600">−{t.amount} charge</span>;
      case 'REFUND':
        return <span className="text-amber-600">+{t.amount} refund</span>;
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
                    placeholder="Filter by user id…"
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
                        <ArrowDownToLine className="w-3 h-3 text-emerald-600" /> Grant credits
                      </div>
                      <input
                        type="number" min={1} value={grantAmount}
                        onChange={(e) => setGrantAmount(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs"
                      />
                      <input
                        value={grantReason}
                        onChange={(e) => setGrantReason(e.target.value)}
                        placeholder="Reason (required)…"
                        className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-xs"
                      />
                      <button
                        onClick={() => openConfirm('grant')}
                        className="w-full py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors cursor-pointer"
                      >
                        Grant
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
                  </tr>
                </thead>
                <tbody>
                  {txns.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="py-1.5 pr-2 text-slate-400 whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                      <td className="py-1.5 pr-2 font-mono text-slate-600">{t.userId.slice(0, 8)}</td>
                      <td className="py-1.5 pr-2">{txnType(t)}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{t.balanceAfter}</td>
                      <td className="py-1.5 pr-2 text-slate-500">{t.reason}</td>
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
      </div>

      {/* ── Confirm modal (grant/deduct) ─────────────────────────────────── */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="rounded-2xl bg-white w-full max-w-sm p-5 space-y-3 shadow-xl">
            <div className="text-sm font-bold text-slate-800">
              Confirm {pending.mode === 'grant' ? 'Grant' : 'Deduct'}
            </div>
            <div className="text-xs text-slate-600 space-y-1">
              <div>User: <span className="font-mono">{pending.userId}</span></div>
              <div>Amount: <strong>{pending.amount} credits</strong></div>
              <div>Reason: <em>{pending.reason || '—'}</em></div>
              <div className="text-[10px] text-slate-400">Audited as {pending.mode === 'grant' ? 'ADMIN_GRANT' : 'ADMIN_DEBIT'} with an idempotency key (duplicate requests never double-apply).</div>
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