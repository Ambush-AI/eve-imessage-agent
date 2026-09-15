import { defineTool } from "eve/tools";
import { z } from "zod";
import { ownerFromSession } from "../lib/owner.ts";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Update how and when this person wants to be texted: their IANA time zone, quiet hours, how many unprompted texts per day are acceptable, the minimum gap between them, and free-form style notes. Only pass the fields that change.",
  inputSchema: z.object({
    timezone: z.string().min(1).optional(),
    quiet_start_hour: z.number().int().min(0).max(23).optional(),
    quiet_end_hour: z.number().int().min(0).max(23).optional(),
    max_unprompted_per_day: z.number().int().min(0).max(50).optional(),
    min_gap_minutes: z.number().int().min(0).max(1440).optional(),
    style: z.string().max(1000).optional(),
  }),
  label: { start: () => "Update texting preferences" },
  async execute(input, ctx) {
    const { store } = runtime();
    const prefs = await store.updatePreferences(ownerFromSession(ctx.session), {
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.quiet_start_hour !== undefined ? { quietStartHour: input.quiet_start_hour } : {}),
      ...(input.quiet_end_hour !== undefined ? { quietEndHour: input.quiet_end_hour } : {}),
      ...(input.max_unprompted_per_day !== undefined ? { maxUnpromptedPerDay: input.max_unprompted_per_day } : {}),
      ...(input.min_gap_minutes !== undefined ? { minGapMinutes: input.min_gap_minutes } : {}),
      ...(input.style !== undefined ? { style: input.style } : {}),
    });
    return { preferences: prefs };
  },
});
