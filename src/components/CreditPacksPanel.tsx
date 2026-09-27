import React, { useEffect, useState } from 'react';
import { Coins, Sparkles, Timer } from 'lucide-react';
import { fetchCreditPacks, type CreditPack } from '../lib/sessionClient';

/**
 * Additive user dashboard section: shows the SERVER-authoritative wallet
 * (available credits) plus the free-trial counter, then the credit pack cards.
 *
 * Purchases are NOT possible yet (there is no payment gateway), so every button
 * is an inert "Coming Soon" placeholder. Nothing here can create credits: the
 * only way credits exist is a server-side admin grant.
 */
export interface WalletView {
  credits: number;
  unlimited: boolean;
}

interface Props {
  wallet: WalletView | null;
  freeTrialsRemaining: number | null;
  freeTrialLimit: number;
}

export const CreditPacksPanel: React.FC<Props> = ({ wallet, freeTrialsRemaining, freeTrialLimit }) => {
  const [packs, setPacks] = useState<CreditPack[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchCreditPacks()
      .then((p) => {
        if (!cancelled) setPacks(p);
      })
      .catch(() => {
        /* catalog unavailable — the wallet row above still renders */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-sm p-5 shadow-sm space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-700">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 border border-slate-200 px-2.5 py-1">
            <Coins className="w-3.5 h-3.5 text-slate-500" />
            Available Credits:{' '}
            {wallet === null ? '—' : wallet.unlimited ? 'Unlimited' : wallet.credits}
          </span>
          {freeTrialsRemaining !== null && freeTrialLimit > 0 && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
                freeTrialsRemaining > 0
                  ? 'bg-white border-slate-200 text-slate-600'
                  : 'bg-rose-50 border-rose-200 text-rose-600'
              }`}
            >
              <Timer className="w-3.5 h-3.5" />
              Free Trials Remaining: {freeTrialsRemaining} of {freeTrialLimit}
            </span>
          )}
        </div>
        <p className="text-[11px] text-slate-500">
          1 credit = 1 minute of audio (rounded up). Costs are calculated on the audio you upload.
        </p>
      </header>

      {packs.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {packs.map((pack) => (
            <article
              key={pack.id}
              className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-2 shadow-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-800">
                  {pack.glyph} {pack.name}
                </span>
                {pack.annual && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                    Annual
                  </span>
                )}
              </div>
              <div className="text-2xl font-extrabold text-slate-900">
                ₹{pack.priceInr.toLocaleString('en-IN')}
                {pack.annual && (
                  <span className="ml-1 text-sm font-semibold text-slate-500">/ year</span>
                )}
              </div>
              <div className="text-xs text-slate-600">
                {pack.credits.toLocaleString('en-IN')} credits
                {pack.blurb ? ` · ${pack.blurb}` : ''}
              </div>
              <div className="text-[11px] text-slate-400">
                {pack.annual
                  ? 'One-time annual payment. It does not renew automatically.'
                  : 'One-time payment. It does not renew automatically.'}
              </div>
              <button
                type="button"
                disabled
                title="Payments are not available yet."
                className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-200 text-slate-500 px-3 py-1.5 text-xs font-semibold cursor-not-allowed"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Coming Soon
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400">Loading credit packs…</p>
      )}

      <p className="text-[11px] text-slate-400">
        Payments are not enabled yet, so no purchase can be made. Credits are added by the
        operator (or by your free audio trials).
      </p>
    </section>
  );
};
