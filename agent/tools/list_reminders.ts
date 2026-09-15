import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description: "List this person's pending reminders and standing tasks.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { store } = runtime();
    return { reminders: await store.listReminders(ownerFromSession(ctx.session)) };
  },
});
