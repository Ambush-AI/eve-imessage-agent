import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const uuid = z.uuid();
const isoTimestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);

const itemDataSchema = z.looseObject({
  headline: z.string().optional(),
  summary: z.string().nullish(),
  source: z.string().nullish(),
  url: z.string().nullish(),
  published_at: z.string().nullish(),
});

export const batchEventSchema = z.object({
  id: uuid,
  type: z.literal("feed.news_items.emitted"),
  timestamp: isoTimestamp,
  feed_id: uuid,
  data: z.object({
    count,
    included_count: count,
    has_more: z.boolean(),
    items_url: z.string().max(512),
    items: z
      .array(z.object({ id: uuid, timestamp: isoTimestamp, data: itemDataSchema }))
      .max(1_000),
  }),
});

export const testEventSchema = z.object({
  id: uuid,
  type: z.literal("feed.news_item.test"),
  timestamp: isoTimestamp,
  feed_id: uuid.nullable(),
  data: z.object({ test: z.literal(true), channel_id: uuid }),
});

export const webhookEventSchema = z.discriminatedUnion("type", [
  batchEventSchema,
  testEventSchema,
]);

export type AmbushWebhookEvent = z.infer<typeof webhookEventSchema>;
export type AmbushBatchEvent = z.infer<typeof batchEventSchema>;

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

const MAX_SKEW_MS = 5 * 60_000;

function decodeCanonicalBase64(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function decodeSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("whsec_")) {
    throw new WebhookSignatureError("Webhook secret must start with whsec_");
  }
  const decoded = decodeCanonicalBase64(trimmed.slice("whsec_".length));
  if (!decoded || decoded.length < 32 || decoded.length > 64) {
    throw new WebhookSignatureError("Webhook secret must be 32-64 base64 bytes");
  }
  return decoded;
}

/**
 * Ambush signs with Standard Webhooks: HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${raw body}` keyed by the destination's
 * secret, sent as space-separated `v1,<base64>` signatures (two during a
 * rotation). The raw body is what is signed, so it is parsed only afterwards.
 */
export function verifyAmbushWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  nowMs = Date.now(),
): AmbushWebhookEvent {
  const webhookId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!webhookId || !timestamp || !/^\d{1,16}$/.test(timestamp) || !signatures) {
    throw new WebhookSignatureError("Missing webhook authentication headers");
  }
  const sentMs = Number(timestamp) * 1_000;
  if (sentMs > nowMs + MAX_SKEW_MS || nowMs - sentMs > MAX_SKEW_MS) {
    throw new WebhookSignatureError("Webhook timestamp is outside the accepted window");
  }

  const expected = createHmac("sha256", decodeSecret(secret))
    .update(`${webhookId}.${timestamp}.${raw}`)
    .digest();
  let verified = false;
  for (const signature of signatures.split(/\s+/)) {
    const [version, encoded] = signature.split(",");
    if (version !== "v1" || !encoded) continue;
    const supplied = decodeCanonicalBase64(encoded);
    if (supplied && supplied.length === expected.length) {
      verified = timingSafeEqual(supplied, expected) || verified;
    }
  }
  if (!verified) throw new WebhookSignatureError("Invalid webhook signature");

  const event = webhookEventSchema.parse(JSON.parse(raw));
  if (event.type === "feed.news_items.emitted" && webhookId !== `msg_${event.id}`) {
    throw new WebhookSignatureError("Webhook ID does not match the batch ID");
  }
  return event;
}

/** Produces the headers Ambush would send, for tests and local replay. */
export function signAmbushWebhook(
  raw: string,
  secret: string,
  webhookId: string,
  nowMs = Date.now(),
): Headers {
  const timestamp = String(Math.floor(nowMs / 1_000));
  const signature = createHmac("sha256", decodeSecret(secret))
    .update(`${webhookId}.${timestamp}.${raw}`)
    .digest("base64");
  return new Headers({
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
    "content-type": "application/json",
  });
}

const ITEMS_IN_PROMPT = 10;

export interface FeedEventContext {
  heldCount: number;
  unpromptedToday: number;
  maxUnpromptedPerDay: number;
}

/**
 * The message the agent reads when a feed delivers. Everything from the
 * payload is quoted as data; the framing tells the model what happened and
 * what it is being asked to decide.
 */
export function batchEventPrompt(event: AmbushBatchEvent, feedName: string, context?: FeedEventContext): string {
  const shown = event.data.items.slice(0, ITEMS_IN_PROMPT);
  const lines = shown.map((item) => {
    const data = item.data;
    const parts = [`- [${item.id}] ${data.headline?.trim() || "(no headline)"}`, data.source ? `— ${data.source}` : "", data.url ? `(${data.url})` : ""].filter(Boolean);
    const summary = data.summary?.trim();
    return summary ? `${parts.join(" ")}\n  ${summary.slice(0, 400)}` : parts.join(" ");
  });
  const hidden = event.data.count - shown.length;
  const budget = context
    ? `You have sent ${context.unpromptedToday} of ${context.maxUnpromptedPerDay} unprompted texts in the last day, and ${context.heldCount} item${context.heldCount === 1 ? " is" : "s are"} already waiting in the inbox.`
    : "";
  return [
    `[Stream event] The stream "${feedName}" (${event.feed_id}) delivered ${event.data.count} new item${event.data.count === 1 ? "" : "s"} at ${event.timestamp}.`,
    ...lines,
    hidden > 0 ? `…and ${hidden} more not shown.` : "",
    "",
    "This was pushed by the stream, not typed by the person. Decide: send_text now if it is genuinely worth interrupting for, or call hold_items with the ids to keep it for a better moment. Holding means sending nothing.",
    budget,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
