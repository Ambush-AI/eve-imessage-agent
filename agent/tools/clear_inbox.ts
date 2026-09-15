import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description: "Remove held items from the inbox once they have been delivered or are no longer worth sending. Pass ids from read_inbox, or nothing to clear everything.",
  inputSchema: z.object({ ids: z.array(z.string()).max(200).optional() }),
  label: { start: ({ ids }) => (ids ? `Clear ${ids.length} held item${ids.length === 1 ? "" : "s"}` : "Clear inbox") },
  async execute({ ids }, ctx) {
    const { store } = runtime();
    await store.clearHeld(ownerFromSession(ctx.session), ids);
    return { cleared: ids?.length ?? "all" };
  },
});
