import { publicBaseUrl } from "./config.ts";
import type { FeedOwner } from "./owner.ts";
import { runtime } from "./runtime.ts";

/** In-flight turns older than this are treated as hung. */
export const STALE_TURN_MS = 3 * 60_000;

/**
 * A deployment landing mid-turn can orphan the workflow run behind a
 * session: the turn never finishes and every later message queues behind
 * it. Steering cannot help, because the cancel is processed by the same dead
 * run. The cure is to retire the session, which the eve HTTP channel exposes
 * behind the deployment's own OIDC token, so the next send starts fresh. The
 * person's memory slot, preferences, and feeds are all keyed elsewhere and
 * survive.
 */
export async function healStaleSession(owner: FeedOwner): Promise<"healthy" | "reset" | "unknown"> {
  const { store, settings } = runtime();
  const staged = await store.peekStagedTurn(owner);
  if (!staged?.startedAt || Date.now() - Date.parse(staged.startedAt) < STALE_TURN_MS) return "healthy";
  const sessionId = await store.getSession(owner);
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!sessionId || !token) {
    await store.clearStagedTurn(owner);
    return "unknown";
  }
  try {
    const response = await fetch(`${publicBaseUrl(settings)}/eve/v1/session/${encodeURIComponent(sessionId)}/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "turn stale; likely orphaned by a deployment" }),
    });
    console.warn(`[agent] reset stale session ${sessionId} -> ${response.status}`);
  } catch (error) {
    console.warn(`[agent] could not reset stale session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await store.clearStagedTurn(owner);
  return "reset";
}
