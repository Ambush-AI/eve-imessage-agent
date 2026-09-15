import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeOwner, destinationUrl, encodeOwner, type FeedOwner, ownerFromSession, sendblueAuth } from "./owner.ts";

const thread: FeedOwner = { kind: "sendblue", adapterName: "sendblue", threadId: "sendblue:a:b", phone: "+15551234567" };

describe("owner encoding", () => {
  it("round-trips through the destination URL", () => {
    const url = destinationUrl("https://agent.example.com/", thread);
    assert.match(url, /^https:\/\/agent\.example\.com\/webhooks\/ambush\/[A-Za-z0-9_-]+$/);
    const token = url.split("/").pop() ?? "";
    assert.deepEqual(decodeOwner(token), thread);
    assert.deepEqual(decodeOwner(encodeOwner({ kind: "eve", sessionId: "s1" })), { kind: "eve", sessionId: "s1" });
  });

  it("rejects garbage and wrong shapes", () => {
    assert.equal(decodeOwner("not base64 json"), null);
    assert.equal(decodeOwner(Buffer.from('{"kind":"sendblue"}').toString("base64url")), null);
  });
});

describe("ownerFromSession", () => {
  it("derives a sendblue owner from the auth attributes", () => {
    const auth = sendblueAuth("+15551234567", "sendblue:a:b", "sendblue");
    assert.deepEqual(ownerFromSession({ id: "s1", auth: { current: auth, initiator: auth } }), thread);
  });

  it("falls back to the eve session when there is no thread", () => {
    assert.deepEqual(ownerFromSession({ id: "s1", auth: { current: null, initiator: null } }), { kind: "eve", sessionId: "s1" });
  });
});
