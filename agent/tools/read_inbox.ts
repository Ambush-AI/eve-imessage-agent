import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description: "Read the stream items being held for this person, oldest first, plus their delivery preferences and pacing status.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { store } = runtime();
    const owner = ownerFromSession(ctx.session);
    const [held, prefs, user, unpromptedToday] = await Promise.all([
      store.peekHeld(owner),
      store.getPreferences(owner),
      store.getUser(owner),
      store.unpromptedInLastDay(owner),
    ]);
    return {
      held: held.map((item) => ({
        id: item.id,
        feed: item.feedName,
        feed_id: item.feedId,
        emission_id: item.emissionId,
        headline: item.headline,
        source: item.source,
        url: item.url,
        received_at: item.receivedAt,
        note: item.note,
      })),
      preferences: prefs,
      unprompted_texts_last_day: unpromptedToday,
      last_unprompted_at: user?.lastUnpromptedAt ?? null,
      muted: user?.muted ?? false,
    };
  },
});
