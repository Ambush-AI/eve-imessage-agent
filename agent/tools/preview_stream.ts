import { defineTool } from "eve/tools";
import { z } from "zod";
import { runtime } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Show what an Ambush stream prompt would have matched recently, before creating or changing a stream. Retrieval only: no relevance filter, so expect some noise. Use it to check a prompt is aimed right and to show the person real examples.",
  inputSchema: z.object({
    prompt: z.string().min(2).max(10_000),
    lookback: z.enum(["7d", "14d", "30d"]).default("7d"),
    limit: z.number().int().min(1).max(50).default(12),
  }),
  label: { start: ({ lookback }) => `Preview prompt over ${lookback}` },
  async execute({ prompt, lookback, limit }) {
    const preview = await runtime().ambush.previewPrompt({ prompt, lookback, limit });
    return {
      matches: preview.matches.map((match) => ({
        headline: match.headline,
        source: match.source,
        url: match.url ?? undefined,
        published_at: match.published_at,
        score: Number(match.score.toFixed(3)),
      })),
      took_ms: preview.took_ms,
    };
  },
});
