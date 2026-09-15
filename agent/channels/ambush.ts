import { randomUUID } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import { batchEventPrompt, verifyAmbushWebhook, WebhookSignatureError } from "../lib/ambush-webhook.ts";
import { config } from "../lib/config.ts";
import { AMBUSH_WEBHOOK_PATH, decodeOwner, sendblueAuth } from "../lib/owner.ts";
import { canSendUnprompted } from "../lib/pacing.ts";
import { runtime } from "../lib/runtime.ts";
import { healStaleSession } from "../lib/session-health.ts";
import imessage from "./imessage.ts";

const MAX_BODY_BYTES = 2_000_000;

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Receives Ambush feed batches. Each conversation has its own destination
 * whose URL ends in the encoded owner, so the path says which session the
 * event belongs to. The path is only trusted once the signature verifies.
 *
 * Quiet hours, the daily cap, and mute are enforced here in code: items that
 * arrive when an unprompted text is not allowed go straight to the inbox
 * without a model turn. When a text is allowed, the agent decides whether
 * this is worth interrupting for or should wait.
 */
export default defineChannel({
  routes: [
    POST(`${AMBUSH_WEBHOOK_PATH}/:owner`, async (request, { to, attachSession, waitUntil, params }) => {
      const settings = config();
      let event;
      try {
        event = verifyAmbushWebhook(await readBody(request), request.headers, settings.AMBUSH_WEBHOOK_SECRET);
      } catch (error) {
        const status = error instanceof WebhookSignatureError ? 401 : 400;
        return new Response(status === 401 ? "Unauthorized" : "Invalid payload", { status });
      }
      /* Destination verification pings arrive before any feed exists. */
      if (event.type === "feed.news_item.test") return new Response(null, { status: 204 });
      if (event.data.count === 0) return new Response(null, { status: 204 });

      const owner = decodeOwner(params.owner);
      if (!owner) {
        console.warn(`[agent] signed webhook for feed ${event.feed_id} with an unreadable owner path`);
        return new Response(null, { status: 204 });
      }

      const { ambush, store } = runtime();
      const feedName = await ambush
        .getFeed(event.feed_id)
        .then((feed) => feed.name ?? "your feed")
        .catch(() => "your feed");

      const [user, prefs, unpromptedToday] = await Promise.all([
        store.getUser(owner).then((existing) => existing ?? store.touchUser(owner, false)),
        store.getPreferences(owner),
        store.unpromptedInLastDay(owner),
      ]);
      const verdict = canSendUnprompted({ prefs, user, unpromptedInLastDay: unpromptedToday });
      const items = event.data.items.map((item) => ({
        feedId: event.feed_id,
        feedName,
        headline: item.data.headline?.trim() || "(no headline)",
        emissionId: item.id,
        source: item.data.source,
        url: item.data.url,
        summary: item.data.summary,
      }));

      if (!verdict.ok) {
        const now = new Date().toISOString();
        await store.hold(
          owner,
          items.map((item) => ({ id: randomUUID(), ...item, receivedAt: now, note: `held automatically: ${verdict.reason}` })),
        );
        return new Response(null, { status: 202 });
      }

      await healStaleSession(owner);
      const heldCount = (await store.peekHeld(owner)).length;
      const prompt = batchEventPrompt(event, feedName, {
        heldCount,
        unpromptedToday,
        maxUnpromptedPerDay: prefs.maxUnpromptedPerDay,
      });
      await store.stageTurn(owner, {
        kind: "feed",
        items: items.map(({ feedId, feedName: name, headline, emissionId }) => ({ feedId, feedName: name, headline, emissionId })),
        sends: 0,
      });

      const deliver =
        owner.kind === "sendblue"
          ? to(imessage, { adapterName: owner.adapterName, threadId: owner.threadId })
              .send(prompt, {
                auth: sendblueAuth(owner.phone, owner.threadId, owner.adapterName),
                turnPolicy: "queue",
              })
              .then((session) => store.rememberSession(owner, session.id))
          : attachSession(owner.sessionId).send(prompt, { auth: null, turnPolicy: "queue" });
      waitUntil(deliver);
      return new Response(null, { status: 202 });
    }),
  ],
});
