import { defineTool } from "eve/tools";
import { z } from "zod";
import { sendblue } from "../channels/imessage.ts";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Put an iMessage tapback on the person's latest message instead of, or before, replying in words. A heart on thanks, a thumbs-up on 'got it', a laugh on a joke, an exclamation on big news. If the tapback says it all, send no text afterwards.",
  inputSchema: z.object({
    reaction: z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]),
  }),
  label: { start: ({ reaction }) => `Tapback ${reaction}` },
  async execute({ reaction }, ctx) {
    const { store } = runtime();
    const owner = ownerFromSession(ctx.session);
    if (owner.kind !== "sendblue") return { error: "Tapbacks only work over iMessage." };
    const staged = await store.peekStagedTurn(owner);
    if (staged?.kind !== "inbound" || !staged.inboundMessageId) {
      return { error: "There is no message from the person in this turn to react to." };
    }
    try {
      await sendblue.addReaction(owner.threadId, staged.inboundMessageId, reaction);
    } catch (error) {
      /* Reactions are decoration: an unreactable message (SMS fallback, an
         old handle) should not derail the turn. */
      return { reacted: false, note: `Could not react: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}. Reply in words instead.` };
    }
    return { reacted: reaction };
  },
});
