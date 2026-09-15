import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  batchEventPrompt,
  signAmbushWebhook,
  verifyAmbushWebhook,
  WebhookSignatureError,
} from "./ambush-webhook.ts";

const secret = `whsec_${randomBytes(32).toString("base64")}`;

function batch(feedId = randomUUID(), count = 2) {
  const id = randomUUID();
  const channelId = randomUUID();
  const items = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    data: { headline: `Headline ${index + 1}`, source: "Reuters", url: `https://example.com/${index}` },
  }));
  return {
    id,
    type: "feed.news_items.emitted" as const,
    timestamp: new Date().toISOString(),
    feed_id: feedId,
    data: {
      count,
      included_count: count,
      has_more: false,
      items_url: `/api/v1/feeds/${feedId}/channels/${channelId}/batches/${id}/items`,
      items,
    },
  };
}

describe("verifyAmbushWebhook", () => {
  it("accepts a correctly signed batch", () => {
    const event = batch();
    const raw = JSON.stringify(event);
    const headers = signAmbushWebhook(raw, secret, `msg_${event.id}`);
    const parsed = verifyAmbushWebhook(raw, headers, secret);
    assert.equal(parsed.type, "feed.news_items.emitted");
    assert.equal(parsed.feed_id, event.feed_id);
  });

  it("rejects a tampered body", () => {
    const event = batch();
    const raw = JSON.stringify(event);
    const headers = signAmbushWebhook(raw, secret, `msg_${event.id}`);
    assert.throws(
      () => verifyAmbushWebhook(raw.replace("Headline 1", "Headline X"), headers, secret),
      WebhookSignatureError,
    );
  });

  it("rejects the wrong secret and a stale timestamp", () => {
    const event = batch();
    const raw = JSON.stringify(event);
    const other = `whsec_${randomBytes(32).toString("base64")}`;
    assert.throws(() => verifyAmbushWebhook(raw, signAmbushWebhook(raw, other, `msg_${event.id}`), secret));
    const stale = signAmbushWebhook(raw, secret, `msg_${event.id}`, Date.now() - 10 * 60_000);
    assert.throws(() => verifyAmbushWebhook(raw, stale, secret), WebhookSignatureError);
  });

  it("accepts a destination test ping", () => {
    const raw = JSON.stringify({
      id: randomUUID(),
      type: "feed.news_item.test",
      timestamp: new Date().toISOString(),
      feed_id: null,
      data: { test: true, channel_id: randomUUID() },
    });
    const parsed = verifyAmbushWebhook(raw, signAmbushWebhook(raw, secret, `msg_${randomUUID()}`), secret);
    assert.equal(parsed.type, "feed.news_item.test");
  });
});

describe("batchEventPrompt", () => {
  it("lists items and asks for a decision", () => {
    const event = batch(randomUUID(), 2);
    const prompt = batchEventPrompt(event, "AI news");
    assert.match(prompt, /^\[Stream event\] The stream "AI news"/);
    assert.match(prompt, /- \[[0-9a-f-]{36}\] Headline 1 — Reuters \(https:\/\/example\.com\/0\)/);
    assert.match(prompt, /hold_items/);
    assert.match(prompt, /send_text/);
  });

  it("caps the listing and reports the remainder", () => {
    const event = batch(randomUUID(), 14);
    const prompt = batchEventPrompt(event, "Big feed");
    assert.match(prompt, /Headline 10/);
    assert.doesNotMatch(prompt, /Headline 11/);
    assert.match(prompt, /and 4 more not shown/);
  });
});
