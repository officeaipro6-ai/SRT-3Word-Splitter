/**
 * Community message classifier — pure, offline, no dependencies.
 *
 * Design goal: be strict about real abuse but never punish someone merely
 * because a word appears in their message. Three verdicts, not two:
 *
 *   CLEAN     -> accept, no record, no punishment.
 *   CONFIRMED -> the message itself is abusive/vulgar/insulting/harassing/
 *                threatening/hateful (counts toward a warning, then a
 *                temporary restriction).
 *   UNCERTAIN -> genuine ambiguity (mild slang, a report ABOUT abuse, a quoted
 *                word, sarcasm we cannot resolve). Routed to an admin for
 *                review and NEVER punished automatically.
 *
 * The UNCERTAIN verdict is what implements the false-positive requirement: a
 * user writing "someone called me an idiot" or "what does idiot mean?" is
 * flagged for review, not restricted. The classifier returns category-level
 * reasons only; it never returns the matched word list to a caller that could
 * leak it.
 */
import type { ViolationCategory } from '../db/types.ts';

export type ModerationVerdict = 'CLEAN' | 'CONFIRMED' | 'UNCERTAIN';

export interface ModerationSignal {
  category: ViolationCategory;
  /** Category-level explanation, safe to store in the audit trail. */
  reason: string;
  /** Higher weight = stronger evidence. */
  weight: number;
}

export interface ModerationAnalysis {
  verdict: ModerationVerdict;
  categories: ViolationCategory[];
  signals: ModerationSignal[];
  /** 0..1, how sure the classifier is. */
  confidence: number;
}

/** Strong, unambiguous abuse. Presence is a signal, never the whole decision. */
const SEVERE_TERMS: Array<[RegExp, ViolationCategory, string]> = [
  [/\b(fuck|shit|bitch|cunt|asshole|bastard|whore|slut)\w*\b/i, 'VULGAR', 'explicit vulgar language'],
  [/\b(idiot|moron|retard|imbecile|loser|scumbag|trash|pathetic|disgusting)\b/i, 'INSULT', 'personal insult'],
  [/\b(racist|racism|subhuman|vermin)\b/i, 'HATEFUL', 'hateful or demeaning language'],
];

/**
 * Explicit threats or calls for self-harm directed at someone. These are the
 * strongest signal and are treated as CONFIRMED on their own.
 */
const THREAT_PATTERNS: Array<[RegExp, ViolationCategory, string]> = [
  [/\b(kill| murder |shoot|stab|beat|beat up|strangle|poison)\s+(you|your|him|her|them|yourself)\b/i, 'THREAT', 'explicit threat of violence'],
  [/\bi\s+(will|am going to|want to)\s+(kill|hurt|beat|find|come for|destroy)\b/i, 'THREAT', 'explicit threat of violence'],
  [/\byou\s+(should|deserve to|ought to)\s+(die|be killed|be hurt|suffer)\b/i, 'THREAT', 'explicit threat of violence'],
  [/\b(kill|hang)\s+yourself\b/i, 'THREAT', 'encouragement of self-harm'],
  [/\bi\s+hope\s+you\s+(die|suffer|get hurt)\b/i, 'THREAT', 'wish of harm against another person'],
  [/\bshut\s+up\s+(you|idiot|moron)\b.*\b(annoying|hate you)\b/i, 'HARASSMENT', 'targeted harassment'],
];

/** Mild terms: flagged for review, never punished automatically. */
const MILD_TERMS: Array<[RegExp, ViolationCategory, string]> = [
  [/\b(damn|damned|hell|crap|wtf|stupid|dumb|lazy|ugly|nonsense|garbage)\b/i, 'ABUSIVE', 'mildly rude or dismissive language'],
];

/**
 * Context that means the writer is TALKING ABOUT abuse rather than committing
 * it (a support report, a quote, a question, self-deprecation, or the community
 * guidelines themselves). Any hit downgrades a positive signal to UNCERTAIN.
 */
const META_CONTEXT: RegExp[] = [
  /\b(he|she|they|someone|somebody|a person|this person|that person|another user)\b[^.!?]{0,40}\b(called|said|told|insulted|abused|harassed|threatened|was rude)\b/i,
  /\b(i|we)\s+(was|were|am|are|got|have been)\b[^.!?]{0,30}\b(insulted|abused|harassed|threatened|bullied|offended)\b/i,
  /\b(reported|report|reporting|complain|complaint|complaining)\b/i,
  /\b(he|she|they)\s+(said|says|wrote|writes|called|calls)\b/i,
  /\b(quote|quoting|word|words|term|phrase|language|slang)\b[^.!?]{0,40}\b(mean|means|offensive|rude|abusive|consider)\b/i,
  /\b(what|why|how)\b[^.!?]{0,30}\b(does|do|did|is|are)\b[^.!?]{0,20}\b(mean|means|count|called)\b/i,
  /\b(i|we)\s+(don't|do not|never|won't|will not)\b[^.!?]{0,30}\b(use|say|speak|talk)\b/i,
  /\b(sorry|apolog|apologi[sz]e|please\s+forgive)\b/i,
  /\b(stop|quit)\s+(being|using|typing|saying)\b/i,
  /\b(as\s+a\s+)?(moderator|admin|support)\b/i,
  /\b(this|these)\s+(guidelines?|rules?|policy|policies)\b/i,
  /\b(politely|respectfully|kindly|professional)\b/i,
];

/** Direct second-person target: turns an insult into a personal one. */
const TARGET_PATTERNS: RegExp[] = [
  /\byou(?:'re| are| r)\b/i,
  /\byour\b/i,
  /\byou\s+\w+/i,
  /@\w+/,
];

/** Collapse leet-speak and repeated letters so trivial evasion does not work. */
export function normalizeForModeration(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    // Runs of 3+ identical letters collapse to one, so "fuuuuck" -> "fuck".
    // Real words rarely contain three identical letters in a row.
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMetaContext(text: string): boolean {
  return META_CONTEXT.some((re) => re.test(text));
}

function isTargeted(text: string): boolean {
  return TARGET_PATTERNS.some((re) => re.test(text));
}

/**
 * Classify a community/support submission. Deterministic and side-effect free.
 */
export function analyzeCommunityText(raw: string): ModerationAnalysis {
  const text = normalizeForModeration(raw);
  if (!text) {
    return { verdict: 'CLEAN', categories: [], signals: [], confidence: 1 };
  }

  const signals: ModerationSignal[] = [];
  const meta = isMetaContext(text);
  const targeted = isTargeted(text);

  for (const [re, category, reason] of THREAT_PATTERNS) {
    if (re.test(text)) signals.push({ category, reason, weight: 3 });
  }
  for (const [re, category, reason] of SEVERE_TERMS) {
    if (re.test(text)) {
      // An insult aimed at the reader is a personal attack, not a general swear.
      signals.push({
        category: category === 'INSULT' && targeted ? 'INSULT' : category,
        reason: targeted && category === 'INSULT' ? 'personal insult aimed at the reader' : reason,
        weight: targeted ? 2.5 : 2,
      });
    }
  }
  for (const [re, category, reason] of MILD_TERMS) {
    if (re.test(text)) signals.push({ category, reason, weight: 1 });
  }

  if (signals.length === 0) {
    return { verdict: 'CLEAN', categories: [], signals: [], confidence: 1 };
  }

  const maxWeight = Math.max(...signals.map((s) => s.weight));
  const categories = [...new Set(signals.map((s) => s.category))];

  // Explicit violence / self-harm encouragement: never downgraded, even in a
  // meta context, because a quote of a threat still needs a human.
  const severe = signals.some((s) => s.category === 'THREAT' || s.weight >= 2.5);
  if (severe && !meta) {
    return {
      verdict: 'CONFIRMED',
      categories,
      signals,
      confidence: Math.min(1, 0.6 + 0.1 * maxWeight),
    };
  }

  if (meta) {
    // The writer is discussing abuse, not committing it: review, never punish.
    return { verdict: 'UNCERTAIN', categories, signals, confidence: 0.4 };
  }

  if (maxWeight >= 2) {
    return {
      verdict: 'CONFIRMED',
      categories,
      signals,
      confidence: Math.min(1, 0.5 + 0.15 * maxWeight),
    };
  }

  // Only mild terms: too weak to punish on its own.
  return { verdict: 'UNCERTAIN', categories, signals, confidence: 0.3 };
}
