import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Create an Ambush stream for this person. The prompt is a first-person description of which real-world events they want: name concrete subjects and the event types that qualify, use 'such as' to open a category, and state exclusions. The stream is routed to this conversation so its events reach the person here.",
  inputSchema: z.object({
    prompt: z.string().min(10).max(10_000),
    name: z.string().min(1).max(80).optional(),
  }),
  label: { start: ({ name }) => `Create stream${name ? ` "${name}"` : ""}` },
  async execute({ prompt, name }, ctx) {
    const { ambush, destinationFor, settings, countFeeds } = runtime();
    const owner = ownerFromSession(ctx.session);
    if ((await countFeeds(owner)) >= settings.MAX_STREAMS_PER_CONVERSATION) {
      return { error: `This person already has ${settings.MAX_STREAMS_PER_CONVERSATION} streams; pause or refine one instead of adding another.` };
    }
    /* Destination first: if Ambush cannot reach us, no feed is created. */
    const channelId = await destinationFor(owner);
    const created = await ambush.createFeed({ prompt, name });
    await ambush.attachChannel(created.feed_id, channelId, settings.STREAM_BATCH_MINUTES);
    const feed = await ambush.getFeed(created.feed_id);
    return { stream_id: created.feed_id, name: feed.name, status: feed.status };
  },
});
