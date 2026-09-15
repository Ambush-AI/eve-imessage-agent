import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Schedule a reminder or a standing task for this person. One-shot ('remind me Friday at 9 to call the bank') or repeating ('every weekday at 8 send a summary of my feeds'). The agent is woken at the due time with the text and decides what to send.",
  inputSchema: z.object({
    what: z.string().min(1).max(500).describe("What to do or say when it fires, in the person's words"),
    due_at: z.string().datetime({ offset: true }).describe("First time it fires, ISO 8601 with offset, in the person's time zone"),
    every_minutes: z.number().int().min(15).max(525_600).nullable().default(null).describe("Repeat interval, or null for one-shot"),
  }),
  label: { start: ({ every_minutes }) => (every_minutes ? "Create standing task" : "Set reminder") },
  async execute({ what, due_at, every_minutes }, ctx) {
    const { store } = runtime();
    const reminder = { id: randomUUID().slice(0, 8), what, dueAt: new Date(due_at).toISOString(), everyMinutes: every_minutes };
    await store.addReminder(ownerFromSession(ctx.session), reminder);
    return { reminder };
  },
});
