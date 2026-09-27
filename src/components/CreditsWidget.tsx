import React, { useEffect, useState } from 'react';
import { Coins, ShieldCheck, UserRound, KeyRound } from 'lucide-react';
import { ensureSession, signInAsOwner, type SessionInfo } from '../lib/sessionClient';
import { AdminDashboard } from './AdminDashboard';

/**
 * Additive UI: shows the user's credit status (server-authoritative) and, for
 * ADMIN sessions, an entry point to the admin dashboard. Rendering the widget
 * is cosmetic — every admin operation is re-checked server-side.
 */
export const CreditsWidget: React.FC = () => {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showOwnerForm, setShowOwnerForm] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerToken, setOwnerToken] = useState('');
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [ownerBusy, setOwnerBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Owner sign-in. The bootstrap token is submitted once and immediately
   * dropped from component state; it is never written to storage.
   */
  const submitOwnerSignIn = async () => {
    setOwnerBusy(true);
    setOwnerError(null);
    try {
      const next = await signInAsOwner({ adminBootstrapToken: ownerToken, ownerEmail });
      setSession(next);
      setOwnerToken('');
      setOwnerEmail('');
      setShowOwnerForm(false);
    } catch (e: any) {
      setOwnerError(e.message);
    } finally {
      setOwnerBusy(false);
    }
  };

  return (
    <>
      <div className="border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 flex items-center justify-end gap-2 text-xs">
          {error ? (
            <span className="text-slate-400 italic">Credits unavailable</span>
          ) : !session ? (
            <span className="text-slate-400 animate-pulse">Loading credits…</span>
          ) : (
            <>
              {session.role === 'ADMIN' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                  <ShieldCheck className="w-3 h-3" />
                  Admin
                </span>
              )}
              {session.unlimited ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 text-slate-100 font-semibold">
                  <Coins className="w-3.5 h-3.5 text-amber-300" />
                  Credits: Unlimited
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 font-medium">
                  <Coins className="w-3.5 h-3.5 text-slate-500" />
                  Credits: {session.credits}
                </span>
              )}
              <span className="inline-flex items-center gap-1 px-2 text-slate-400">
                <UserRound className="w-3 h-3" />
                {session.userId.slice(0, 8)}
                <span className="sr-only">(opaque account id)</span>
              </span>
              {session.role === 'ADMIN' && (
                <button
                  onClick={() => setShowAdmin((v) => !v)}
                  className="px-3 py-1 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors cursor-pointer"
                >
                  {showAdmin ? 'Hide' : 'Admin'}
                </button>
              )}
              {session.role !== 'ADMIN' && (
                <button
                  onClick={() => setShowOwnerForm((v) => !v)}
                  title="Owner sign-in"
                  className="px-2 py-1 rounded-lg text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors cursor-pointer inline-flex items-center gap-1"
                >
                  <KeyRound className="w-3 h-3" />
                  Owner
                </button>
              )}
            </>
          )}
        </div>
        {showOwnerForm && session?.role !== 'ADMIN' && (
          <div className="bg-white/90 border-b border-slate-200">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center gap-2 text-xs">
              <input
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="Owner email…"
                className="px-2 py-1 rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <input
                type="password"
                value={ownerToken}
                onChange={(e) => setOwnerToken(e.target.value)}
                placeholder="Admin bootstrap token…"
                className="px-2 py-1 rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <button
                onClick={() => void submitOwnerSignIn()}
                disabled={ownerBusy || !ownerEmail || !ownerToken}
                className="px-3 py-1 rounded-lg text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {ownerBusy ? 'Signing in…' : 'Sign in as owner'}
              </button>
              <span className="text-slate-400">
                Verified against the server OWNER_EMAILS allowlist. The token is sent once and not stored.
              </span>
              {ownerError && <span className="text-rose-600">{ownerError}</span>}
            </div>
          </div>
        )}
      </div>

      {showAdmin && session?.role === 'ADMIN' && <AdminDashboard />}
    </>
  );
};