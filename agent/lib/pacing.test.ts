import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSendUnprompted, controlWord, inQuietHours, parseTapback } from "./pacing.ts";
import { preferencesSchema } from "./store.ts";

const prefs = preferencesSchema.parse({ timezone: "UTC", quietStartHour: 22, quietEndHour: 8, maxUnpromptedPerDay: 3, minGapMinutes: 60 });
const owner = { kind: "eve" as const, sessionId: "s" };
const user = (patch: object = {}) => ({ owner, firstSeenAt: "x", lastInboundAt: null, lastUnpromptedAt: null, muted: false, ...patch });

describe("quiet hours", () => {
  it("handles windows that cross midnight", () => {
    assert.equal(inQuietHours(23, 22, 8), true);
    assert.equal(inQuietHours(3, 22, 8), true);
    assert.equal(inQuietHours(12, 22, 8), false);
    assert.equal(inQuietHours(9, 8, 17), true);
    assert.equal(inQuietHours(5, 5, 5), false);
  });
});

describe("canSendUnprompted", () => {
  const noon = new Date("2026-09-10T12:00:00Z");
  it("allows a rested user at midday", () => {
    assert.deepEqual(canSendUnprompted({ prefs, user: user(), unpromptedInLastDay: 0, now: noon }), { ok: true });
  });
  it("blocks muted, quiet hours, cap, and gap in that order", () => {
    assert.equal(canSendUnprompted({ prefs, user: user({ muted: true }), unpromptedInLastDay: 0, now: noon }).ok, false);
    assert.deepEqual(canSendUnprompted({ prefs, user: user(), unpromptedInLastDay: 0, now: new Date("2026-09-10T23:30:00Z") }), { ok: false, reason: "quiet_hours" });
    assert.deepEqual(canSendUnprompted({ prefs, user: user(), unpromptedInLastDay: 3, now: noon }), { ok: false, reason: "daily_cap" });
    assert.deepEqual(canSendUnprompted({ prefs, user: user({ lastUnpromptedAt: "2026-09-10T11:30:00Z" }), unpromptedInLastDay: 1, now: noon }), { ok: false, reason: "too_soon" });
  });
});

describe("parseTapback", () => {
  it("reads the cross-client tapback text", () => {
    assert.deepEqual(parseTapback("Disliked “OpenAI says it launched GPT-6…”"), { signal: "down", quoted: "OpenAI says it launched GPT-6…" });
    assert.deepEqual(parseTapback('Liked "hello there"'), { signal: "up", quoted: "hello there" });
    assert.equal(parseTapback("Laughed at “ok”")?.signal, "laugh");
    assert.equal(parseTapback("I liked that"), null);
  });
});

describe("controlWord", () => {
  it("recognises stop and start, not sentences", () => {
    assert.equal(controlWord("STOP"), "stop");
    assert.equal(controlWord("stop please"), "stop");
    assert.equal(controlWord("start"), "start");
    assert.equal(controlWord("stop sending me funding rounds, keep the rest"), null);
  });
});
