import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description: "Cancel a reminder or standing task by id (from list_reminders).",
  inputSchema: z.object({ id: z.string().min(1) }),
  label: { start: ({ id }) => `Cancel reminder ${id}` },
  async execute({ id }, ctx) {
    const { store } = runtime();
    return { removed: await store.removeReminder(ownerFromSession(ctx.session), id) };
  },
});
