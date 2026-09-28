import React, { useEffect, useState } from 'react';
import { ShieldCheck, KeyRound } from 'lucide-react';
import { ensureSession, signInAsOwner, type SessionInfo } from '../lib/sessionClient';
import { AdminDashboard } from './AdminDashboard';

/**
 * The ONLY surface rendered on /admin.
 *
 * It deliberately imports nothing from the transcription application: no Header,
 * no FileUpload, no LanguageSelector, no SRT table. Whatever the URL after
 * /admin, the legacy transcription screen cannot be reached from here.
 *
 * Security is not enforced by this component. Every admin operation is
 * re-checked server-side by `auth()` + `requireAdmin`, and the ADMIN role itself
 * is only ever granted server-side after the caller presents
 * ADMIN_BOOTSTRAP_TOKEN *and* an email on the OWNER_EMAILS allowlist
 * (officeaipro6@gmail.com, sumitchinara@gmail.com by default). This component
 * only decides what to paint; hiding the UI grants nothing.
 */
export const AdminApp: React.FC = () => {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** The bootstrap token is submitted once and immediately dropped from state. */
  const submitOwnerSignIn = async () => {
    setOwnerBusy(true);
    setOwnerError(null);
    try {
      const next = await signInAsOwner({ adminBootstrapToken: ownerToken, ownerEmail });
      setSession(next);
      setOwnerToken('');
      setOwnerEmail('');
    } catch (e: any) {
      setOwnerError(e.message);
    } finally {
      setOwnerBusy(false);
    }
  };

  const isAdmin = session?.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans">
      <div className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
            <ShieldCheck className="w-4 h-4 text-violet-600" />
            Odia SRT — Admin Dashboard
          </div>
          {isAdmin ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-50 text-violet-700 border border-violet-200">
              <ShieldCheck className="w-3 h-3" />
              ADMIN
            </span>
          ) : (
            <a href="/" className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">
              Back to the app
            </a>
          )}
        </div>
      </div>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {loadError ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
            Could not reach the server: {loadError}
          </div>
        ) : !session ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
            Loading session…
          </div>
        ) : isAdmin ? (
          <AdminDashboard />
        ) : (
          <div className="max-w-xl mx-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <div>
              <h1 className="text-base font-bold text-slate-900">Owner sign-in required</h1>
              <p className="text-xs text-slate-500 mt-1">
                Admin access is limited to the product-owner accounts on the server-side
                allowlist. A browser cannot grant itself admin rights: the request must present the
                server-held bootstrap secret and an allowlisted email.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="Owner email…"
                autoComplete="username"
                className="px-2 py-1.5 rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <input
                type="password"
                value={ownerToken}
                onChange={(e) => setOwnerToken(e.target.value)}
                placeholder="Admin bootstrap token…"
                autoComplete="current-password"
                className="px-2 py-1.5 rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <button
                onClick={() => void submitOwnerSignIn()}
                disabled={ownerBusy || !ownerEmail || !ownerToken}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50 transition-colors cursor-pointer inline-flex items-center gap-1"
              >
                <KeyRound className="w-3 h-3" />
                {ownerBusy ? 'Signing in…' : 'Sign in as owner'}
              </button>
            </div>
            {ownerError && <div className="text-xs text-rose-600">{ownerError}</div>}
            <p className="text-[11px] text-slate-400">
              The token is sent once and never stored.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};
