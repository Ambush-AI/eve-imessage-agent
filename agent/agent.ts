import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const modelId = process.env.AGENT_MODEL?.trim() || "openai/gpt-5.6-luna";

/*
 * On Vercel (or with a gateway key) the gateway id string is used as-is.
 * Locally with only OPENAI_API_KEY, the same model is called directly so a
 * developer can run the agent without linking a Vercel project first.
 */
const useDirectOpenAi =
  !process.env.VERCEL && !process.env.AI_GATEWAY_API_KEY && Boolean(process.env.OPENAI_API_KEY) && modelId.startsWith("openai/");

export default defineAgent({
  model: useDirectOpenAi
    ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId.slice("openai/".length))
    : modelId,
  reasoning: "medium",
});
