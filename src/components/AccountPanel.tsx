import React, { useEffect, useState } from 'react';
import { AtSign, LogIn, LogOut, KeyRound, MailCheck, UserRound } from 'lucide-react';
import {
  ensureSession,
  loginAccount,
  signupAccount,
  logoutAccount,
  resendVerificationEmail,
  notifyAuthChanged,
  type SessionInfo,
} from '../lib/sessionClient';

/**
 * Normal USER account strip — email/password sign-in, sign-up and sign-out.
 * This is completely separate from the ADMIN bootstrap flow: no bootstrap token
 * is ever entered here, and sign-up can never produce an ADMIN role (the
 * server enforces that).
 */
export const AccountPanel: React.FC = () => {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    ensureSession()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const onAuthChanged = () => refresh();
    window.addEventListener('odiasrt-auth-changed', onAuthChanged);
    return () => window.removeEventListener('odiasrt-auth-changed', onAuthChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNeedsVerification(null);
    setResendNotice(null);
    try {
      const next =
        mode === 'signup'
          ? await signupAccount({ email, password })
          : await loginAccount({ email, password });
      setSession(next);
      setShowForm(false);
      setEmail('');
      setPassword('');
      notifyAuthChanged();
    } catch (e: any) {
      // The server answers unverified logins with a distinct code so the UI can
      // offer a resend without ever treating it as a credential error.
      if (e?.code === 'EMAIL_NOT_VERIFIED') {
        setNeedsVerification(email);
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendVerification = async () => {
    const target = needsVerification ?? session?.email;
    if (!target) return;
    setResending(true);
    setResendNotice(null);
    setError(null);
    try {
      const message = await resendVerificationEmail(target);
      setResendNotice(message || 'A fresh verification link has been sent to your inbox.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setResending(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await logoutAccount();
      setSession(null);
      notifyAuthChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const isAccount = Boolean(session?.account && session?.email);

  return (
    <div className="border-b border-slate-200 bg-slate-900/95 backdrop-blur-sm text-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 flex flex-wrap items-center justify-end gap-2 text-xs">
        {loading ? (
          <span className="text-slate-400 animate-pulse">Account…</span>
        ) : isAccount ? (
          <>
            <span className="inline-flex items-center gap-1 text-slate-300">
              <UserRound className="w-3 h-3 text-emerald-400" />
              {session.email}
            </span>
            {session.emailVerified === false && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <MailCheck className="w-3 h-3" />
                Unverified inbox
                <button
                  onClick={() => void sendVerification()}
                  disabled={resending}
                  className="underline underline-offset-2 hover:text-amber-200 cursor-pointer disabled:opacity-50"
                >
                  {resending ? 'Sending…' : 'Resend link'}
                </button>
              </span>
            )}
            <button
              onClick={() => void signOut()}
              disabled={busy}
              className="px-2 py-1 rounded-lg text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
            >
              <LogOut className="w-3 h-3" />
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-2 py-1 rounded-lg text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer inline-flex items-center gap-1"
          >
            <KeyRound className="w-3 h-3" />
            Sign in / Create account
          </button>
        )}
      </div>
      {resendNotice && (
        <div className="bg-emerald-500/10 border-t border-emerald-500/20 text-emerald-300">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 text-xs">
            {resendNotice}
          </div>
        </div>
      )}
      {needsVerification && (
        <div className="bg-amber-500/10 border-t border-amber-500/20 text-amber-300">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center gap-2 text-xs">
            <MailCheck className="w-3 h-3" />
            <span>
              This email still needs to be verified. Check {needsVerification || 'your inbox'} for the
              verification link we sent, or request a new one.
            </span>
            <button
              onClick={() => void sendVerification()}
              disabled={resending}
              className="px-2 py-1 rounded-lg text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
            >
              {resending ? 'Sending…' : 'Resend verification link'}
            </button>
          </div>
        </div>
      )}
      {showForm && !isAccount && (
        <div className="bg-slate-900 border-t border-slate-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center gap-2 text-xs">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email…"
              autoComplete="email"
              className="px-2 py-1 rounded-lg bg-slate-800 text-slate-100 border border-slate-700 outline-none focus:ring-2 focus:ring-indigo-400 placeholder:text-slate-500"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'Password (8+ chars)…' : 'Password…'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              className="px-2 py-1 rounded-lg bg-slate-800 text-slate-100 border border-slate-700 outline-none focus:ring-2 focus:ring-indigo-400 placeholder:text-slate-500"
            />
            <button
              onClick={() => void submit()}
              disabled={busy || !email || !password}
              className="px-3 py-1 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 transition-colors cursor-pointer inline-flex items-center gap-1"
            >
              <LogIn className="w-3 h-3" />
              {busy ? '…' : mode === 'signup' ? 'Create account' : 'Sign in'}
            </button>
            <button
              onClick={() => setMode((m) => (m === 'login' ? 'signup' : 'login'))}
              className="text-slate-300 hover:text-white underline underline-offset-2 cursor-pointer"
            >
              {mode === 'login' ? 'No account? Create one' : 'Have an account? Sign in'}
            </button>
            <span className="inline-flex items-center gap-1 text-slate-400">
              <AtSign className="w-3 h-3" />
              Normal user account — no admin token needed.
            </span>
            {error && <span className="text-rose-400">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
};