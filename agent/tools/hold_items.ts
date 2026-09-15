import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Keep stream items for a better moment instead of texting them now. Pass the items from the stream event you want to hold; they surface again in the inbox when the person texts or at the next good delivery window.",
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          id: z.string().describe("The item id in square brackets from the stream event"),
          feed_id: z.string(),
          feed_name: z.string(),
          headline: z.string(),
          source: z.string().nullish(),
          url: z.string().nullish(),
          summary: z.string().nullish(),
        }),
      )
      .min(1)
      .max(50),
    note: z.string().max(300).optional().describe("Why these are being held, in a few words"),
  }),
  label: { start: ({ items }) => `Hold ${items.length} item${items.length === 1 ? "" : "s"}` },
  async execute({ items, note }, ctx) {
    const { store } = runtime();
    const owner = ownerFromSession(ctx.session);
    const now = new Date().toISOString();
    const count = await store.hold(
      owner,
      items.map((item) => ({
        id: randomUUID(),
        emissionId: item.id,
        feedId: item.feed_id,
        feedName: item.feed_name,
        headline: item.headline,
        source: item.source,
        url: item.url,
        summary: item.summary,
        receivedAt: now,
        note,
      })),
    );
    return { held: items.length, inbox_size: count };
  },
});
