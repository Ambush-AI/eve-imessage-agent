import { Redis } from "@upstash/redis";
import { z } from "zod";
import { type FeedOwner, feedOwnerSchema, ownerKey } from "./owner.ts";

/**
 * Everything that must outlive a session or be read outside one: the
 * dispatcher schedule cannot see session state, and a webhook for a feed
 * arrives with no session in hand. Upstash Redis over REST, so a cold
 * function pays no connection setup.
 */

export const preferencesSchema = z.object({
  timezone: z.string().default("America/Toronto"),
  /** Local hours during which unprompted texts are held. */
  quietStartHour: z.number().int().min(0).max(23).default(22),
  quietEndHour: z.number().int().min(0).max(23).default(8),
  /** Unprompted texts allowed per rolling 24h; replies to the user never count. */
  maxUnpromptedPerDay: z.number().int().min(0).max(50).default(4),
  /** Minimum minutes between two unprompted texts. */
  minGapMinutes: z.number().int().min(0).max(1440).default(60),
  /** Free-form notes the agent keeps about how this person wants to be texted. */
  style: z.string().max(1000).default(""),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const heldItemSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  feedName: z.string(),
  headline: z.string(),
  source: z.string().nullish(),
  url: z.string().nullish(),
  summary: z.string().nullish(),
  emissionId: z.string().nullish(),
  receivedAt: z.string(),
  /** Why the agent held it, in its own words. */
  note: z.string().nullish(),
});
export type HeldItem = z.infer<typeof heldItemSchema>;

export const reminderSchema = z.object({
  id: z.string(),
  what: z.string(),
  dueAt: z.string(),
  /** Minutes between repeats; null for one-shot. */
  everyMinutes: z.number().int().min(1).nullable(),
});
export type Reminder = z.infer<typeof reminderSchema>;

/** Which feed items a sent text was about, so a tapback can be traced back. */
export const stagedTurnSchema = z.object({
  /** Who started the turn: the person, or the app on its own initiative. */
  kind: z.enum(["inbound", "feed", "tick", "reminder"]),
  /** Provider id of the person's message, so the agent can react to it. */
  inboundMessageId: z.string().optional(),
  /** When the turn was staged; a stale entry means the turn never finished. */
  startedAt: z.string().optional(),
  /** Bubbles sent so far this turn. */
  sends: z.number().int().min(0).default(0),
  items: z
    .array(z.object({ feedId: z.string(), feedName: z.string(), headline: z.string(), emissionId: z.string().nullish() }))
    .default([]),
});
export type StagedTurn = z.infer<typeof stagedTurnSchema>;

export const sentMessageSchema = z.object({
  messageHandle: z.string(),
  at: z.string(),
  text: z.string().default(""),
  items: z.array(
    z.object({
      feedId: z.string(),
      feedName: z.string(),
      headline: z.string(),
      emissionId: z.string().nullish(),
    }),
  ),
});
export type SentMessage = z.infer<typeof sentMessageSchema>;

export const userRecordSchema = z.object({
  owner: feedOwnerSchema,
  firstSeenAt: z.string(),
  lastInboundAt: z.string().nullish(),
  lastUnpromptedAt: z.string().nullish(),
  muted: z.boolean().default(false),
});
export type UserRecord = z.infer<typeof userRecordSchema>;

const DAY_MS = 24 * 60 * 60_000;
const SENT_TTL_SECONDS = 14 * 24 * 60 * 60;

function key(owner: FeedOwner, ...parts: string[]): string {
  return ["imessage-agent", ownerKey(owner), ...parts].join(":");
}

/*
 * Global "when does this person next need attention" indexes, one per reason.
 * Member is the owner key, score is the epoch ms at which the tick should
 * look. The dispatcher reads three ranges per minute instead of every user's
 * state, so an idle minute costs three commands regardless of user count.
 */
const DUE_REMINDERS = "imessage-agent:due:reminders";
const DUE_HELD = "imessage-agent:due:held";

export const HELD_DIGEST_MIN_AGE_MS = 30 * 60_000;

function parseList<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createStore(redis: Redis) {
  return {
    /* ---- users ---- */
    async touchUser(owner: FeedOwner, inbound: boolean): Promise<UserRecord & { created: boolean }> {
      const now = new Date().toISOString();
      const existing = userRecordSchema.safeParse(await redis.get(key(owner, "user")));
      const record: UserRecord = existing.success
        ? { ...existing.data, ...(inbound ? { lastInboundAt: now } : {}) }
        : { owner, firstSeenAt: now, lastInboundAt: inbound ? now : null, lastUnpromptedAt: null, muted: false };
      await redis.set(key(owner, "user"), record);
      await redis.sadd("imessage-agent:users", ownerKey(owner));
      await redis.set(`imessage-agent:owner:${ownerKey(owner)}`, owner);
      return { ...record, created: !existing.success };
    },
    async getUser(owner: FeedOwner): Promise<UserRecord | null> {
      const parsed = userRecordSchema.safeParse(await redis.get(key(owner, "user")));
      return parsed.success ? parsed.data : null;
    },
    async setMuted(owner: FeedOwner, muted: boolean): Promise<void> {
      const user = (await this.getUser(owner)) ?? (await this.touchUser(owner, false));
      await redis.set(key(owner, "user"), { ...user, muted });
    },
    async markUnprompted(owner: FeedOwner): Promise<void> {
      const user = (await this.getUser(owner)) ?? (await this.touchUser(owner, false));
      const now = new Date().toISOString();
      await redis.set(key(owner, "user"), { ...user, lastUnpromptedAt: now });
      await redis.lpush(key(owner, "unprompted"), now);
      await redis.ltrim(key(owner, "unprompted"), 0, 99);
    },
    async unpromptedInLastDay(owner: FeedOwner): Promise<number> {
      const rows = await redis.lrange<string>(key(owner, "unprompted"), 0, 99);
      const cutoff = Date.now() - DAY_MS;
      return rows.filter((row) => Date.parse(row) > cutoff).length;
    },
    async listUsers(): Promise<FeedOwner[]> {
      const keys = await redis.smembers("imessage-agent:users");
      if (keys.length === 0) return [];
      const owners = await redis.mget<unknown[]>(...keys.map((entry) => `imessage-agent:owner:${entry}`));
      return parseList(feedOwnerSchema, owners);
    },

    /* ---- preferences ---- */
    async getPreferences(owner: FeedOwner): Promise<Preferences> {
      const parsed = preferencesSchema.safeParse((await redis.get(key(owner, "prefs"))) ?? {});
      return parsed.success ? parsed.data : preferencesSchema.parse({});
    },
    async updatePreferences(owner: FeedOwner, patch: Partial<Preferences>): Promise<Preferences> {
      const next = preferencesSchema.parse({ ...(await this.getPreferences(owner)), ...patch });
      await redis.set(key(owner, "prefs"), next);
      return next;
    },

    /* ---- held items (the inbox) ---- */
    async hold(owner: FeedOwner, items: HeldItem[]): Promise<number> {
      if (items.length === 0) return redis.llen(key(owner, "held"));
      await redis.rpush(key(owner, "held"), ...items);
      const oldest = items.reduce((min, item) => Math.min(min, Date.parse(item.receivedAt)), Number.POSITIVE_INFINITY);
      /* Keep the earliest ready time; a later batch never pushes it back. */
      await redis.zadd(DUE_HELD, { lt: true }, { score: oldest + HELD_DIGEST_MIN_AGE_MS, member: ownerKey(owner) });
      return redis.llen(key(owner, "held"));
    },
    async peekHeld(owner: FeedOwner): Promise<HeldItem[]> {
      return parseList(heldItemSchema, await redis.lrange(key(owner, "held"), 0, 199));
    },
    async clearHeld(owner: FeedOwner, ids?: string[]): Promise<void> {
      const remaining = ids ? (await this.peekHeld(owner)).filter((item) => !ids.includes(item.id)) : [];
      await redis.del(key(owner, "held"));
      if (remaining.length > 0) {
        await redis.rpush(key(owner, "held"), ...remaining);
        const oldest = remaining.reduce((min, item) => Math.min(min, Date.parse(item.receivedAt)), Number.POSITIVE_INFINITY);
        await redis.zadd(DUE_HELD, { score: oldest + HELD_DIGEST_MIN_AGE_MS, member: ownerKey(owner) });
      } else {
        await redis.zrem(DUE_HELD, ownerKey(owner));
      }
    },
    /** Pacing said not now; look again later instead of every minute. */
    async deferHeld(owner: FeedOwner, untilMs: number): Promise<void> {
      await redis.zadd(DUE_HELD, { xx: true }, { score: untilMs, member: ownerKey(owner) });
    },

    /* ---- reminders ---- */
    async addReminder(owner: FeedOwner, reminder: Reminder): Promise<void> {
      await redis.set(key(owner, "reminder", reminder.id), reminder);
      await redis.zadd(key(owner, "reminders"), { score: Date.parse(reminder.dueAt), member: reminder.id });
      await this.reindexReminders(owner);
    },
    /** Points the global index at this owner's earliest pending reminder. */
    async reindexReminders(owner: FeedOwner): Promise<void> {
      const [member, score] = await redis.zrange<(string | number)[]>(key(owner, "reminders"), 0, 0, { withScores: true });
      if (member === undefined || typeof score !== "number") {
        await redis.zrem(DUE_REMINDERS, ownerKey(owner));
        return;
      }
      await redis.zadd(DUE_REMINDERS, { score, member: ownerKey(owner) });
    },
    async listReminders(owner: FeedOwner): Promise<Reminder[]> {
      const ids = await redis.zrange<string[]>(key(owner, "reminders"), 0, -1);
      if (ids.length === 0) return [];
      const rows = await redis.mget<unknown[]>(...ids.map((id) => key(owner, "reminder", id)));
      return parseList(reminderSchema, rows);
    },
    async dueReminders(owner: FeedOwner, now = Date.now()): Promise<Reminder[]> {
      const ids = await redis.zrange<string[]>(key(owner, "reminders"), 0, now, { byScore: true });
      if (ids.length === 0) return [];
      const rows = await redis.mget<unknown[]>(...ids.map((id) => key(owner, "reminder", id)));
      return parseList(reminderSchema, rows);
    },
    /** One-shot reminders are removed; repeating ones are moved to their next due time. */
    async settleReminder(owner: FeedOwner, reminder: Reminder): Promise<void> {
      if (reminder.everyMinutes) {
        const next = new Date(Math.max(Date.now(), Date.parse(reminder.dueAt)) + reminder.everyMinutes * 60_000);
        await this.addReminder(owner, { ...reminder, dueAt: next.toISOString() });
        return;
      }
      await redis.zrem(key(owner, "reminders"), reminder.id);
      await redis.del(key(owner, "reminder", reminder.id));
      await this.reindexReminders(owner);
    },
    async removeReminder(owner: FeedOwner, id: string): Promise<boolean> {
      const removed = await redis.zrem(key(owner, "reminders"), id);
      await redis.del(key(owner, "reminder", id));
      await this.reindexReminders(owner);
      return removed > 0;
    },

    /* ---- dispatcher ---- */
    /** Owners with something ready as of `now`, by reason. Two commands. */
    async dueOwners(now = Date.now()): Promise<{ reminders: string[]; held: string[] }> {
      const [reminders, held] = await Promise.all([
        redis.zrange<string[]>(DUE_REMINDERS, 0, now, { byScore: true }),
        redis.zrange<string[]>(DUE_HELD, 0, now, { byScore: true }),
      ]);
      return { reminders, held };
    },
    async ownersByKey(keys: string[]): Promise<FeedOwner[]> {
      if (keys.length === 0) return [];
      return parseList(feedOwnerSchema, await redis.mget<unknown[]>(...keys.map((entry) => `imessage-agent:owner:${entry}`)));
    },

    /* ---- sent texts, for tapback attribution ---- */
    async recordSent(owner: FeedOwner, sent: SentMessage): Promise<void> {
      await redis.set(key(owner, "sent", sent.messageHandle), sent, { ex: SENT_TTL_SECONDS });
      await redis.lpush(key(owner, "sent-recent"), sent);
      await redis.ltrim(key(owner, "sent-recent"), 0, 19);
    },
    async getSent(owner: FeedOwner, messageHandle: string): Promise<SentMessage | null> {
      const parsed = sentMessageSchema.safeParse(await redis.get(key(owner, "sent", messageHandle)));
      return parsed.success ? parsed.data : null;
    },
    /** What the turn now starting is about, staged before the model runs so
     *  the reply can be attributed and counted once it is posted. */
    async stageTurn(owner: FeedOwner, staged: StagedTurn): Promise<void> {
      await redis.set(key(owner, "staged"), { ...staged, startedAt: staged.startedAt ?? new Date().toISOString() }, { ex: 15 * 60 });
    },
    async peekStagedTurn(owner: FeedOwner): Promise<StagedTurn | null> {
      const parsed = stagedTurnSchema.safeParse(await redis.get(key(owner, "staged")));
      return parsed.success ? parsed.data : null;
    },
    async takeStagedTurn(owner: FeedOwner): Promise<StagedTurn | null> {
      const value = await redis.get(key(owner, "staged"));
      await redis.del(key(owner, "staged"));
      const parsed = stagedTurnSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    async recentSent(owner: FeedOwner): Promise<SentMessage[]> {
      return parseList(sentMessageSchema, await redis.lrange(key(owner, "sent-recent"), 0, 19));
    },

    /* ---- session bookkeeping ---- */
    async rememberSession(owner: FeedOwner, sessionId: string): Promise<void> {
      await redis.set(key(owner, "session"), sessionId);
    },
    async getSession(owner: FeedOwner): Promise<string | null> {
      const value = await redis.get<string>(key(owner, "session"));
      return typeof value === "string" ? value : null;
    },
    async clearStagedTurn(owner: FeedOwner): Promise<void> {
      await redis.del(key(owner, "staged"));
    },

    /* ---- budget ---- */
    async countTurn(owner: FeedOwner): Promise<number> {
      const day = new Date().toISOString().slice(0, 10);
      const count = await redis.incr(key(owner, "turns", day));
      if (count === 1) await redis.expire(key(owner, "turns", day), 2 * 24 * 60 * 60);
      return count;
    },

    /* ---- dispatcher lease ---- */
    async claimTick(owner: FeedOwner, leaseSeconds: number): Promise<boolean> {
      const result = await redis.set(key(owner, "tick-lease"), Date.now(), { nx: true, ex: leaseSeconds });
      return result === "OK";
    },
  };
}

export type Store = ReturnType<typeof createStore>;

let store: Store | undefined;

export function agentStore(): Store {
  if (!store) {
    const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN are required for the agent store");
    store = createStore(new Redis({ url, token }));
  }
  return store;
}
