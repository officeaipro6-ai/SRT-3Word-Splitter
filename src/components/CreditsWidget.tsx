import React, { useEffect, useState } from 'react';
import { Coins, ShieldCheck, UserRound } from 'lucide-react';
import { ensureSession, type SessionInfo } from '../lib/sessionClient';
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
            </>
          )}
        </div>
      </div>

      {showAdmin && session?.role === 'ADMIN' && <AdminDashboard />}
    </>
  );
};