import type { Preferences, UserRecord } from "./store.ts";

export interface PacingInput {
  prefs: Preferences;
  user: UserRecord | null;
  unpromptedInLastDay: number;
  now?: Date;
}

export type PacingVerdict =
  | { ok: true }
  | { ok: false; reason: "muted" | "quiet_hours" | "daily_cap" | "too_soon" };

/** Hour of day in the user's zone; falls back to UTC on a bad zone name. */
export function localHour(now: Date, timezone: string): number {
  try {
    const text = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(now);
    return Number.parseInt(text, 10) % 24;
  } catch {
    return now.getUTCHours();
  }
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Whether an unprompted text is allowed right now. Replies to the user never
 * go through this; only texts the agent initiates do. The rules exist to keep
 * the line looking like a conversation rather than a broadcaster.
 */
export function canSendUnprompted(input: PacingInput): PacingVerdict {
  const now = input.now ?? new Date();
  if (input.user?.muted) return { ok: false, reason: "muted" };
  if (inQuietHours(localHour(now, input.prefs.timezone), input.prefs.quietStartHour, input.prefs.quietEndHour)) {
    return { ok: false, reason: "quiet_hours" };
  }
  if (input.unpromptedInLastDay >= input.prefs.maxUnpromptedPerDay) return { ok: false, reason: "daily_cap" };
  const last = input.user?.lastUnpromptedAt ? Date.parse(input.user.lastUnpromptedAt) : 0;
  if (now.getTime() - last < input.prefs.minGapMinutes * 60_000) return { ok: false, reason: "too_soon" };
  return { ok: true };
}

const TAPBACK = /^(Liked|Disliked|Loved|Laughed at|Emphasized|Questioned)\s+[“"](.+)[”"]$/su;

export type TapbackSignal = "up" | "down" | "love" | "laugh" | "emphasize" | "question";

/**
 * iMessage renders a tapback as text like `Liked “…”` when it crosses to a
 * non-native client, and Sendblue forwards that as an ordinary inbound
 * message. This reads that shape; a native reaction payload, if Sendblue
 * ever documents one, would be handled alongside it.
 */
export function parseTapback(text: string): { signal: TapbackSignal; quoted: string } | null {
  const match = TAPBACK.exec(text.trim());
  if (!match) return null;
  const verbs: Record<string, TapbackSignal> = {
    Liked: "up",
    Disliked: "down",
    Loved: "love",
    "Laughed at": "laugh",
    Emphasized: "emphasize",
    Questioned: "question",
  };
  const signal = verbs[match[1] ?? ""];
  return signal ? { signal, quoted: (match[2] ?? "").trim() } : null;
}

const STOP_WORDS = /^(stop|unsubscribe|quiet|mute)\b/iu;
const START_WORDS = /^(start|unmute|resume)\b/iu;

export function controlWord(text: string): "stop" | "start" | null {
  const trimmed = text.trim();
  if (trimmed.length > 12) return null;
  if (STOP_WORDS.test(trimmed)) return "stop";
  if (START_WORDS.test(trimmed)) return "start";
  return null;
}
