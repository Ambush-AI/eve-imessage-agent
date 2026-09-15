import { defineSchedule } from "eve/schedules";
import imessage from "../channels/imessage.ts";
import { type FeedOwner, ownerKey, sendblueAuth } from "../lib/owner.ts";
import { canSendUnprompted } from "../lib/pacing.ts";
import { runtime } from "../lib/runtime.ts";
import { healStaleSession } from "../lib/session-health.ts";
import type { HeldItem, Reminder } from "../lib/store.ts";

const LEASE_SECONDS = 60;
/** How long to wait before re-checking a person pacing said no to. */
const DEFER_MS = 10 * 60_000;

function heldSection(held: HeldItem[]): string {
  const lines = held.slice(0, 12).map((item) => `- [${item.id}] ${item.feedName}: ${item.headline}${item.url ? ` (${item.url})` : ""}`);
  const more = held.length > 12 ? `\n…and ${held.length - 12} more (see read_inbox).` : "";
  return `Held feed items (${held.length}):\n${lines.join("\n")}${more}\nIf you send a digest, keep it to one text, group related items, and call clear_inbox with the ids you covered. If none of it is worth a text yet, leave it and send nothing.`;
}

function remindersSection(due: Reminder[]): string {
  return `Reminders due now:\n${due.map((reminder) => `- ${reminder.what}`).join("\n")}\nSend what the person asked for. A reminder is theirs, so it always goes out.`;
}

async function attend(
  owner: FeedOwner,
  reasons: { reminders: boolean; held: boolean },
  to: Parameters<NonNullable<Parameters<typeof defineSchedule>[0]["run"]>>[0]["to"],
): Promise<void> {
  if (owner.kind !== "sendblue") return;
  const { store } = runtime();
  const [user, prefs, unpromptedToday] = await Promise.all([
    store.getUser(owner),
    store.getPreferences(owner),
    store.unpromptedInLastDay(owner),
  ]);
  const pacing = canSendUnprompted({ prefs, user, unpromptedInLastDay: unpromptedToday });
  const later = Date.now() + DEFER_MS;

  const sections: string[] = [];
  let kind: "reminder" | "tick" | null = null;
  let due: Reminder[] = [];
  let held: HeldItem[] = [];

  /* Reminders are the person's own request: they fire even while muted or
     in quiet hours, because they chose the time. */
  if (reasons.reminders) {
    due = await store.dueReminders(owner);
    if (due.length > 0) {
      sections.push(remindersSection(due));
      kind = "reminder";
    }
  }
  if (reasons.held) {
    if (!pacing.ok) await store.deferHeld(owner, later);
    else {
      held = await store.peekHeld(owner);
      if (held.length > 0) {
        sections.push(heldSection(held));
        kind ??= "tick";
      } else await store.clearHeld(owner);
    }
  }
  if (!kind) return;
  if (!(await store.claimTick(owner, LEASE_SECONDS))) return;
  await healStaleSession(owner);

  await Promise.all(due.map((reminder) => store.settleReminder(owner, reminder)));
  /* The turn now owns these; they come back into the index if it holds them again. */
  if (held.length > 0) await store.deferHeld(owner, later);
  await store.stageTurn(owner, {
    kind,
    items: held.map((item) => ({ feedId: item.feedId, feedName: item.feedName, headline: item.headline, emissionId: item.emissionId })),
    sends: 0,
  });
  const prompt = [
    `[Check-in] It is ${new Date().toLocaleString("en-US", { timeZone: prefs.timezone, hour: "numeric", minute: "2-digit", weekday: "short" })} for this person. Nothing was typed by them; this is your own check-in.`,
    ...sections,
    `You have sent ${unpromptedToday} of ${prefs.maxUnpromptedPerDay} unprompted texts in the last day. Only send_text reaches them; to stay quiet, call nothing.`,
  ].join("\n\n");

  const session = await to(imessage, { adapterName: owner.adapterName, threadId: owner.threadId }).send(prompt, {
    auth: sendblueAuth(owner.phone, owner.threadId, owner.adapterName),
    turnPolicy: "queue",
  });
  await store.rememberSession(owner, session.id);
}

/**
 * One dispatcher for everything the agent does on its own clock. Every
 * minute it reads two global indexes (who has a reminder due, held items
 * old enough for a digest) and touches only the people those name. An idle
 * minute is two Redis commands.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      (async () => {
        const { store } = runtime();
        const due = await store.dueOwners();
        const keys = [...new Set([...due.reminders, ...due.held])];
        if (keys.length === 0) return;
        const owners = await store.ownersByKey(keys);
        await Promise.all(
          owners.map((owner) =>
            attend(
              owner,
              {
                reminders: due.reminders.includes(ownerKey(owner)),
                held: due.held.includes(ownerKey(owner)),
              },
              to,
            ).catch((error) => console.error(`[agent] tick failed for a user: ${error instanceof Error ? error.message : String(error)}`)),
          ),
        );
      })(),
    );
  },
});
