import { defineTool } from "eve/tools";
import { z } from "zod";
import { sendblue, stopTyping } from "../channels/imessage.ts";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

/** Bubbles one turn may send; a confused model cannot flood the thread. */
const MAX_SENDS_PER_TURN = 4;

/**
 * The only way words reach the person. Nothing the model writes outside this
 * tool is delivered, so staying quiet is simply not calling it.
 */
export default defineTool({
  description:
    "Send one text bubble to the person. This is the only way anything reaches them; whatever you write outside this tool is never delivered. Call it once per bubble, in order, up to four per turn, and never twice with the same text: a sent bubble is sent. Keep bubbles short like real texts. To say nothing, do not call it. After your last bubble, write \"done\" and stop.",
  inputSchema: z.object({ text: z.string().min(1).max(2_000) }),
  label: { start: ({ text }) => `Text: ${text.slice(0, 40)}${text.length > 40 ? "…" : ""}` },
  async execute({ text }, ctx) {
    const { store } = runtime();
    const owner = ownerFromSession(ctx.session);
    if (owner.kind !== "sendblue") return { sent: false, note: "There is no phone on this conversation." };
    const staged = (await store.peekStagedTurn(owner)) ?? { kind: "inbound" as const, items: [], sends: 0 };
    if (staged.sends >= MAX_SENDS_PER_TURN) {
      return { sent: false, note: `You have already sent ${MAX_SENDS_PER_TURN} bubbles this turn. You are done; write "done" and stop.` };
    }
    /* A repeat of a bubble already sent this turn is the model looping, not
       a new message. Refuse it and tell the model to end the turn. */
    const recent = await store.recentSent(owner);
    const normalized = text.replace(/\s+/gu, " ").trim().toLowerCase();
    const duplicate = recent.slice(0, staged.sends).some((sent) => sent.text.replace(/\s+/gu, " ").trim().toLowerCase() === normalized);
    if (duplicate) {
      return { sent: false, note: "That bubble was already sent this turn; it reached them. You are done; write \"done\" and stop." };
    }
    const posted = await sendblue.postMessage(owner.threadId, text);
    /* A text the agent chose to send on its own counts against pacing once
       per turn; replies to the person never do. */
    if (staged.kind !== "inbound" && staged.sends === 0) await store.markUnprompted(owner);
    await store.recordSent(owner, { messageHandle: posted.id, at: new Date().toISOString(), text, items: staged.items });
    await store.stageTurn(owner, { ...staged, sends: staged.sends + 1 });
    await stopTyping(owner.threadId);
    return {
      sent: true,
      bubbles_this_turn: staged.sends + 1,
      note: "Delivered. If that was your last bubble, write \"done\" and stop; do not send it again.",
    };
  },
});
