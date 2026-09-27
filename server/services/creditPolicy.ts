/**
 * Credit pricing policy for the legacy free-user path (pure, dependency-free).
 *
 * Rules enforced here:
 *   - 1 credit = 1 minute of audio, rounded UP to the next whole minute:
 *       0-60s   -> 1 credit
 *       61-120s -> 2 credits
 *       121-180s -> 3 credits ...
 *   - Credits are always derived from the SERVER-MEASURED upload duration
 *     (`measureAudioDurationSeconds`), never from a client-supplied duration.
 *   - Credit packs are PRODUCT DEFINITIONS ONLY. There is NO payment gateway and
 *     NO way to purchase credits today; buttons are placeholders ("Coming Soon").
 */
export interface CreditPack {
  id: string;
  name: string;
  /** List price in Indian Rupees (product definition; no billing wired yet). */
  priceInr: number;
  credits: number;
  /** Emoji glyph used by the UI card (exact display copy from the product spec). */
  glyph: string;
  /** True for the annual pack; it is a separate product, NEVER auto-renewed. */
  annual?: boolean;
  blurb?: string;
}

/** 1 credit = 1 minute, rounded UP; never below 1 (0-60s is still a full credit). */
export function creditsForDuration(seconds: number): number {
  const s = Number(seconds);
  // A corrupt/unmeasurable duration still costs a full credit (never 0 free work).
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.max(1, Math.ceil(s / 60));
}

/** EXACT pack catalog (product definitions only — no purchases possible). */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'starter', name: 'Starter', priceInr: 69, credits: 15, glyph: '🟢', blurb: '15 credits' },
  { id: 'basic', name: 'Basic', priceInr: 129, credits: 35, glyph: '🔵', blurb: '35 credits' },
  { id: 'standard', name: 'Standard', priceInr: 299, credits: 80, glyph: '🟣', blurb: '80 credits' },
  { id: 'pro', name: 'Pro', priceInr: 599, credits: 180, glyph: '🟠', blurb: '180 credits' },
  { id: 'large', name: 'Large', priceInr: 1199, credits: 400, glyph: '🔴', blurb: '400 credits' },
  {
    id: 'annual',
    name: 'Annual',
    priceInr: 4499,
    credits: 1500,
    glyph: '⭐',
    annual: true,
    blurb: '1,500 credits / year — never auto-renewed',
  },
] as const;

export const NOT_ENOUGH_CREDITS_MESSAGE = 'Not enough credits. Please purchase a credit pack.';

export const CANNOT_MEASURE_DURATION_MESSAGE =
  'Could not determine the audio duration. Please try again with a different file.';

/** Copy shown when provider spending protection hard-blocks processing. */
export const PROVIDER_UNAVAILABLE_MESSAGE = 'Processing temporarily unavailable. Please try again later.';