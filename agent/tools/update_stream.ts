import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Change one of this conversation's streams: rewrite its prompt, rename it, or pause/resume it. Only streams created in this conversation can be changed.",
  inputSchema: z
    .object({
      stream_id: z.string().uuid(),
      prompt: z.string().min(10).max(10_000).optional(),
      name: z.string().min(1).max(80).optional(),
      status: z.enum(["active", "paused"]).optional(),
    })
    .refine((input) => input.prompt || input.name || input.status, {
      message: "Provide at least one of prompt, name, or status",
    }),
  label: { start: ({ status }) => (status ? `Set stream ${status}` : "Update stream") },
  async execute({ stream_id, prompt, name, status }, ctx) {
    const { ambush, owns } = runtime();
    if (!(await owns(ownerFromSession(ctx.session), stream_id))) {
      return { error: "That stream does not belong to this conversation." };
    }
    const updated = await ambush.updateFeed(stream_id, { prompt, name, status });
    return { stream_id: updated.feed_id, status: updated.status, revision_id: updated.prompt_revision_id };
  },
});
