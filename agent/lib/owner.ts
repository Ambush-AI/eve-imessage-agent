import { z } from "zod";

/**
 * Which conversation a feed belongs to. A Sendblue owner is an iMessage
 * thread; an eve owner is a plain HTTP session, which is how local
 * development without a phone line exercises the same path.
 */
export const feedOwnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sendblue"),
    adapterName: z.string().min(1),
    threadId: z.string().min(1),
    phone: z.string().min(1),
  }),
  z.object({ kind: z.literal("eve"), sessionId: z.string().min(1) }),
]);

export type FeedOwner = z.infer<typeof feedOwnerSchema>;

interface SessionLike {
  id: string;
  auth: {
    current: { principalId: string; attributes?: Record<string, unknown> } | null;
    initiator: { principalId: string; attributes?: Record<string, unknown> } | null;
  };
}

export const SENDBLUE_AUTHENTICATOR = "sendblue";

/** The auth context the iMessage channel attaches to every inbound turn. */
export function sendblueAuth(phone: string, threadId: string, adapterName: string) {
  return {
    authenticator: SENDBLUE_AUTHENTICATOR,
    principalType: "user" as const,
    principalId: phone,
    attributes: { threadId, adapterName, phone },
  };
}

/**
 * The owner of the current tool call, from the session's auth snapshot. The
 * initiator is preferred so a feed stays with the thread that created it.
 */
export function ownerFromSession(session: SessionLike): FeedOwner {
  const principal = session.auth.initiator ?? session.auth.current;
  const attributes = principal?.attributes ?? {};
  const threadId = attributes.threadId;
  const adapterName = attributes.adapterName;
  const phone = attributes.phone;
  if (typeof threadId === "string" && typeof adapterName === "string" && typeof phone === "string") {
    return { kind: "sendblue", adapterName, threadId, phone };
  }
  return { kind: "eve", sessionId: session.id };
}

/**
 * The owner travels inside the Ambush destination URL, so a webhook names
 * its conversation without any lookup on our side. The path is trusted only
 * after the Standard Webhooks signature verifies, and Ambush is the only
 * party holding that secret.
 */
export function encodeOwner(owner: FeedOwner): string {
  return Buffer.from(JSON.stringify(owner), "utf8").toString("base64url");
}

export function decodeOwner(token: string): FeedOwner | null {
  try {
    const parsed = feedOwnerSchema.safeParse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const AMBUSH_WEBHOOK_PATH = "/webhooks/ambush";

export function destinationUrl(publicBaseUrl: string, owner: FeedOwner): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${AMBUSH_WEBHOOK_PATH}/${encodeOwner(owner)}`;
}

/** Stable identity for "same owner" comparisons. */
export function ownerKey(owner: FeedOwner): string {
  return owner.kind === "sendblue" ? `sendblue:${owner.adapterName}:${owner.threadId}` : `eve:${owner.sessionId}`;
}

/**
 * Whether a destination belongs to this conversation. Matched on the owner
 * token at the end of the path, never on the host: a deployment can be
 * reached under more than one alias and the list endpoint reports the URL
 * as `label`.
 */
export function destinationBelongsTo(channel: { url?: string; label?: string; type?: string }, owner: FeedOwner): boolean {
  if (channel.type && channel.type !== "webhook") return false;
  const address = channel.url ?? channel.label ?? "";
  return address.endsWith(`${AMBUSH_WEBHOOK_PATH}/${encodeOwner(owner)}`);
}
