import React, { useEffect, useState } from 'react';
import { Coins, Sparkles, Timer } from 'lucide-react';
import { fetchCreditPacks, type CreditPack, createCreditPurchaseOrder, verifyCreditPurchase } from '../lib/sessionClient';

// Razorpay global type declaration (loaded from https://checkout.razorpay.com/v1/checkout.js)
declare global {
  interface Window {
    Razorpay: any;
  }
}

/**
 * Additive user dashboard section: shows the SERVER-authoritative wallet
 * (available credits) plus the free-trial counter, then the credit pack cards.
 *
 * Purchases are handled via Razorpay Checkout (server-verified).
 * The button text changes to "Buy X Credits" when payment is configured.
 * If Razorpay is not configured, buttons show "Payments launching soon".
 */
export interface WalletView {
  credits: number;
  unlimited: boolean;
}

/**
 * DISPLAY copy only — the server is the single source of truth and enforces the
 * limit. Keep in sync with FREE_TRIAL_LIMIT in server/config.ts (frozen to 1)
 * and FREE_TRIAL_MAX_DURATION_SECONDS in server/services/freeTrialPolicy.ts
 * (120 seconds = 2 minutes for that single trial).
 */
const FREE_TRIAL_MAX_MINUTES = 2;

interface Props {
  wallet: WalletView | null;
  freeTrialsRemaining: number | null;
  freeTrialLimit: number;
}

export const CreditPacksPanel: React.FC<Props> = ({ wallet, freeTrialsRemaining, freeTrialLimit }) => {
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [razorpayLoaded, setRazorpayLoaded] = useState(false);
  const [purchasingPlanId, setPurchasingPlanId] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  // Load Razorpay script dynamically
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.Razorpay) {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => setRazorpayLoaded(true);
      script.onerror = () => console.error('Failed to load Razorpay script');
      document.body.appendChild(script);
    } else if (typeof window !== 'undefined' && window.Razorpay) {
      setRazorpayLoaded(true);
    }
    return () => {};
  }, []);

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

  const handlePurchase = async (planId: string) => {
    if (!razorpayLoaded) {
      setPurchaseError('Payment system is still loading. Please try again in a moment.');
      return;
    }

    setPurchasingPlanId(planId);
    setPurchaseError(null);

    try {
      // Step 1: Create order on server
      const order = await createCreditPurchaseOrder(planId);

      // Step 2: Open Razorpay Checkout
      const options = {
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'Odia SRT',
        description: `${order.plan.name} — ${order.plan.credits} credits`,
        order_id: order.orderId,
        handler: async (response: any) => {
          // Step 3: Verify payment on server
          try {
            const result = await verifyCreditPurchase({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              planId,
            });
            if (result.success) {
              // Refresh wallet credits
              // The parent component will refetch the wallet
              window.dispatchEvent(new CustomEvent('credits-updated', { detail: result.credits }));
            } else {
              setPurchaseError('Payment verification failed. Please contact support.');
              setPurchasingPlanId(null);
            }
          } catch (err: any) {
            setPurchaseError(err.message || 'Payment verification failed. Please contact support.');
            setPurchasingPlanId(null);
          }
        },
        modal: {
          ondismiss: () => {
            setPurchasingPlanId(null);
          },
        },
        theme: {
          color: '#0f172a',
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.on('payment.failed', (response: any) => {
        setPurchaseError(`Payment failed: ${response.error?.description || 'Unknown error'}`);
        setPurchasingPlanId(null);
      });
      rzp.open();
    } catch (err: any) {
      setPurchaseError(err.message || 'Failed to initiate payment. Please try again.');
      setPurchasingPlanId(null);
    } finally {
      // Ensure processing state is always reset, even if an unexpected error occurs
      // after the Razorpay modal opens but before handler/ondismiss fires
      // (the handler/ondismiss will also reset, but this is a safety net)
      if (purchasingPlanId === planId) {
        // Small delay to allow handler/ondismiss to run first if they will
        setTimeout(() => {
          setPurchasingPlanId(current => current === planId ? null : current);
        }, 0);
      }
    }
  };

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

      {freeTrialsRemaining !== null && freeTrialLimit > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-[11px] text-slate-600 space-y-0.5">
          <p className="font-semibold text-slate-700">
            {freeTrialLimit} Free Trial{freeTrialLimit === 1 ? '' : 's'} — Up to {FREE_TRIAL_MAX_MINUTES} minutes
            {freeTrialLimit === 1 ? '' : ' each'}
          </p>
          <p>Total free usage: up to {freeTrialLimit * FREE_TRIAL_MAX_MINUTES} minutes</p>
          <p className="text-slate-500">
            Files longer than {FREE_TRIAL_MAX_MINUTES} minutes cannot be processed with a free trial and
            need credits.
          </p>
        </div>
      )}

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
              <div className="text-[11px] text-slate-400">
                {pack.annual
                  ? 'One-time annual payment. It does not renew automatically.'
                  : 'One-time payment. It does not renew automatically.'}
              </div>
              <button
                type="button"
                disabled={purchasingPlanId === pack.id || !razorpayLoaded}
                onClick={() => handlePurchase(pack.id)}
                title={razorpayLoaded ? undefined : 'Payment system is still loading.'}
                className={`
                  mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold
                  ${purchasingPlanId === pack.id
                    ? 'bg-amber-500 text-white cursor-wait'
                    : razorpayLoaded
                    ? 'bg-slate-900 text-white hover:bg-slate-700'
                    : 'bg-slate-200 text-slate-500 cursor-not-allowed'}
                `}
              >
                {purchasingPlanId === pack.id ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-3.5 w-3.5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Processing...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    {pack.annual
                      ? `Buy ${pack.credits.toLocaleString('en-IN')} Credits`
                      : `Buy ${pack.credits} Credits`}
                  </>
                )}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400">Loading credit packs…</p>
      )}

      <p className="text-[11px] text-slate-400">
        {razorpayLoaded
          ? 'Payments are powered by Razorpay. Click a plan to purchase credits securely.'
          : 'Loading payment system… Credits are added by the operator (or by your free audio trials).'}
      </p>
    </section>
  );
};
