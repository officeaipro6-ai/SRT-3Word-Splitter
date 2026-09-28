import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCommunityGuidelines,
  fetchCommunityStatus,
  sendCommunityMessage,
  sendSupportRequest,
  reportProblem,
  type CommunityGuidelines,
  type RestrictionStatus,
  type SupportCategory,
} from '../lib/sessionClient';

/**
 * Community & Support (additive).
 *
 * This component is a THIN client. It never decides whether a message is
 * acceptable and never computes a penalty: it posts text (plus an optional
 * attachment) and renders whatever the server decided. That is what makes the
 * restriction real — bypassing this UI changes nothing, because the server
 * refuses the submission on its own.
 */

const TABS = [
  { id: 'post', label: 'Community post' },
  { id: 'support', label: 'Support request' },
  { id: 'report', label: 'Report a problem' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** mm:ss for a server-provided remaining duration. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const CommunitySupport: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('post');
  const [guidelines, setGuidelines] = useState<CommunityGuidelines | null>(null);
  const [status, setStatus] = useState<RestrictionStatus | null>(null);

  const [body, setBody] = useState('');
  const [category, setCategory] = useState<SupportCategory>('OTHER');
  const [attachment, setAttachment] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await fetchCommunityStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    fetchCommunityGuidelines().then(setGuidelines).catch(() => setGuidelines(null));
    void refreshStatus();
  }, [open, refreshStatus]);

  // Ticks the countdown locally from the SERVER-supplied remaining/expiry. The
  // countdown is display only — enforcement always happens server-side.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!status?.restricted) return;
    const id = window.setInterval(() => {
      if (status.expiresAt && new Date(status.expiresAt).getTime() <= Date.now()) {
        void refreshStatus();
        setNotice({
          tone: 'ok',
          text: 'Your temporary restriction has ended. You can post again.',
        });
      }
      forceTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [status, refreshStatus]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) {
      setNotice({ tone: 'error', text: 'Please write a message first.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result =
        tab === 'post'
          ? await sendCommunityMessage({ body: text, attachment })
          : tab === 'support'
            ? await sendSupportRequest({ body: text, category, attachment })
            : await reportProblem({ body: text, attachment });

      setNotice({
        tone: result.accepted ? 'ok' : result.outcome === 'ADMIN_REVIEW' ? 'ok' : 'warn',
        text: result.message,
      });
      if (result.restriction?.restricted) setStatus(result.restriction);
      // Only clear the composer when the server actually stored it.
      if (result.accepted || result.outcome === 'ADMIN_REVIEW') {
        setBody('');
        setAttachment(null);
        if (fileRef.current) fileRef.current.value = '';
      }
      void refreshStatus();
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Could not send your message.' });
    } finally {
      setBusy(false);
    }
  };

  const remaining = status?.expiresAt
    ? Math.max(0, new Date(status.expiresAt).getTime() - Date.now())
    : 0;
  const blocked = status?.restricted === true;
  const categories = guidelines?.categories ?? (['OTHER'] as SupportCategory[]);
  const categoryLabels = guidelines?.categoryLabels;
  const maxBytes = guidelines?.attachmentMaxBytes ?? 25 * 1024 * 1024;

  return (
    <div className="px-4 sm:px-6">
      <section className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 shadow-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left"
          aria-expanded={open}
        >
          <span className="text-lg font-bold text-slate-900">💬 Community &amp; Support</span>
          <span className="text-sm font-semibold text-slate-500">{open ? 'Hide' : 'Open'}</span>
        </button>

        {!open && (
          <p className="mt-2 text-sm text-slate-600">
            Ask a question, send a support request, or report a problem. Messages are read by the
            product owner, not posted publicly.
          </p>
        )}

        {open && (
          <div className="mt-4 space-y-4">
            {/* Guidelines — always visible, exactly as specified. */}
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wide text-amber-900">
                Community Guidelines
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                <li>Please communicate respectfully.</li>
                <li>Abusive, vulgar, threatening, harassing, or insulting language is not allowed.</li>
                <li>Violations may result in a temporary restriction.</li>
              </ul>
              <p className="mt-2 text-sm font-semibold text-amber-900">
                ⚠️ Please communicate respectfully. Abusive, threatening, vulgar, or insulting
                language may result in a temporary restriction.
              </p>
            </div>

            <p className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <span aria-hidden="true">🚫</span> No abusive language
            </p>

            {/* Restriction banner: rendered only from the server's own status. */}
            {blocked && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4">
                <h3 className="text-sm font-extrabold uppercase tracking-wide text-red-800">
                  Temporarily restricted
                </h3>
                <p className="mt-1 text-sm text-red-800">
                  You cannot post or send a support request right now. Time remaining:{' '}
                  <strong>{formatRemaining(remaining)}</strong>.
                </p>
                <p className="mt-1 text-xs text-red-700">
                  An admin can review or release this early. This restriction applies to this app
                  only.
                </p>
              </div>
            )}

            {notice && (
              <div
                role="status"
                className={`rounded-xl border p-3 text-sm ${
                  notice.tone === 'ok'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                    : notice.tone === 'warn'
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-red-300 bg-red-50 text-red-900'
                }`}
              >
                {notice.text}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
                    tab === t.id
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-300 bg-white text-slate-700'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="space-y-3">
              {tab !== 'post' && (
                <label className="block text-sm font-semibold text-slate-700">
                  Category
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as SupportCategory)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {categoryLabels?.[c] ?? c}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="block text-sm font-semibold text-slate-700">
                {tab === 'report' ? 'What went wrong?' : 'Message'}
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  maxLength={5000}
                  disabled={blocked}
                  placeholder="Describe the problem or ask your question."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal disabled:bg-slate-100"
                />
              </label>

              <label className="block text-sm font-semibold text-slate-700">
                Attachment (optional)
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*,audio/*"
                  disabled={blocked}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (f && f.size > maxBytes) {
                      setNotice({
                        tone: 'error',
                        text: `That file is too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))}MB.`,
                      });
                      e.target.value = '';
                      setAttachment(null);
                      return;
                    }
                    setAttachment(f);
                  }}
                  className="mt-1 block w-full text-sm font-normal"
                />
                <span className="mt-1 block text-xs font-normal text-slate-500">
                  Screenshot, screen recording or audio clip. Maximum{' '}
                  {Math.round(maxBytes / (1024 * 1024))}MB. Attachments are private and only
                  visible to the product owner.
                </span>
              </label>

              <button
                type="submit"
                disabled={busy || blocked}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send'}
              </button>
            </form>

            <p className="text-xs text-slate-500">
              Privacy: messages are visible only to the product owner and are never posted to a
              public feed.
            </p>
            {guidelines?.telegram && (
              <p className="text-xs text-slate-500">Telegram: {guidelines.telegram}</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

export default CommunitySupport;
