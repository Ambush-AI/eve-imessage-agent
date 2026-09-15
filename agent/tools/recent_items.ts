import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description: "Read the most recent items one of this conversation's streams has sent, for 'what came in lately' questions.",
  inputSchema: z.object({
    stream_id: z.string().uuid(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async execute({ stream_id, limit }, ctx) {
    const { ambush, owns } = runtime();
    if (!(await owns(ownerFromSession(ctx.session), stream_id))) {
      return { error: "That stream does not belong to this conversation." };
    }
    return { items: await ambush.listEmissions(stream_id, limit) };
  },
});
