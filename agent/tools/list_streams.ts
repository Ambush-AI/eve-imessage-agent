import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownedStreamIds } from "../lib/destinations.ts";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description: "List the Ambush streams that belong to this conversation, with their current status and prompt.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { ambush } = runtime();
    const ids = await ownedStreamIds(ambush, ownerFromSession(ctx.session));
    const feeds = await Promise.all(
      ids.map(async (feedId) => {
        const feed = await ambush.getFeed(feedId);
        return { stream_id: feed.feed_id, name: feed.name, status: feed.status, prompt: feed.current_prompt_revision?.prompt ?? null };
      }),
    );
    return { streams: feeds };
  },
});
