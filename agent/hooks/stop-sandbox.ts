import { defineHook } from "eve/hooks";

/**
 * Sandbox memory is billed for as long as the sandbox runs. A texting
 * assistant is idle between turns, so release the compute after each turn;
 * the durable filesystem survives and the handle resumes on the next use.
 */
export default defineHook({
  events: {
    async "turn.completed"(_event, ctx) {
      try {
        const sandbox = await ctx.getSandbox();
        await sandbox.stop();
      } catch (error) {
        console.warn(`[agent] sandbox stop skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },
});
