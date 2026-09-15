import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { Message, Thread } from "chat";
import { createSendblueAdapter } from "chat-adapter-sendblue";
import { chatSdkChannel } from "eve/channels/chat-sdk";
import { config, numberAllowed, optionalEnv, sendblueConfigured } from "../lib/config.ts";
import { type FeedOwner, sendblueAuth } from "../lib/owner.ts";
import { timezoneFromPhone } from "../lib/area-codes.ts";
import { controlWord, parseTapback } from "../lib/pacing.ts";
import { runtime } from "../lib/runtime.ts";
import { healStaleSession } from "../lib/session-health.ts";
import type { HeldItem } from "../lib/store.ts";
import { z } from "zod";

const rawPayloadSchema = z.looseObject({ message_type: z.string().optional(), reply_to: z.unknown().optional() });

export const SENDBLUE_ADAPTER_NAME = "sendblue";

const STOP_REPLY = "Okay, I'll stop texting. Send START whenever you want me back.";
const START_REPLY = "Welcome back. What would you like me to keep an eye on?";
const BUDGET_REPLY = "I've hit my limit with you for today. I'll be back tomorrow, and anything your feeds catch will be waiting.";

/*
 * Built at module scope because eve discovers channels by evaluating this
 * file, and the adapter rejects empty credentials. Placeholders keep
 * `eve build` and phone-less local runs working; handle() refuses inbound
 * traffic until the real values are configured.
 */
export const sendblue = createSendblueAdapter({
  apiKey: optionalEnv("SENDBLUE_API_KEY") ?? "unconfigured",
  apiSecret: optionalEnv("SENDBLUE_API_SECRET") ?? "unconfigured",
  defaultFromNumber: optionalEnv("SENDBLUE_FROM_NUMBER") ?? "+10000000000",
  webhookSecret: optionalEnv("SENDBLUE_WEBHOOK_SECRET"),
  webhookSecretHeader: "sb-signing-secret",
  allowedServices: ["iMessage", "SMS"],
});

/* Upstash on Vercel exposes a TLS URL as REDIS_URL (and KV_URL). */
const redisUrl = optionalEnv("REDIS_URL") ?? optionalEnv("KV_URL");

type SendblueOwner = Extract<FeedOwner, { kind: "sendblue" }>;

export function ownerFromThread(thread: Thread): SendblueOwner | null {
  const phone = sendblue.decodeThreadId(thread.id).contactNumber;
  return phone ? { kind: "sendblue", adapterName: SENDBLUE_ADAPTER_NAME, threadId: thread.id, phone } : null;
}

async function refreshTyping(thread: Thread | null | undefined): Promise<void> {
  if (!thread) return;
  try {
    await thread.startTyping("Working...");
  } catch {
    /* Typing is best effort; the adapter already logs the reason. */
  }
}

export async function stopTyping(threadId: string): Promise<void> {
  const { contactNumber, fromNumber } = sendblue.decodeThreadId(threadId);
  if (!contactNumber) return;
  try {
    await sendblue.getSdk().typingIndicators.send({ number: contactNumber, from_number: fromNumber, state: "stop" });
  } catch (error) {
    console.warn(`[agent] could not stop typing indicator: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const { bot, channel, send } = chatSdkChannel({
  userName: "Ambush",
  adapters: { [SENDBLUE_ADAPTER_NAME]: sendblue },
  /* Redis keeps thread subscriptions and inbound dedupe across instances and
     restarts. Memory is the local-dev fallback when no Redis URL is set. */
  state: redisUrl ? createRedisState({ url: redisUrl, keyPrefix: "imessage-agent" }) : createMemoryState(),
  /* iMessage cannot edit a sent bubble, so one message per turn. */
  streaming: false,
  turnPolicy: "queue",
  /* Overlapping webhooks for one thread wait for the lock instead of being
     dropped; iOS sends a shared link as two messages in the same instant. */
  concurrency: "queue",
  events: {
    /* Sendblue's bubble lasts up to 60s per call; refresh it as the turn
       progresses so a long multi-step answer does not go quiet. */
    async "reasoning.completed"(_eventData, channel) {
      await refreshTyping(channel.thread);
    },
    async "action.result"(_eventData, channel) {
      await refreshTyping(channel.thread);
    },
    /* Delivery happens only through the send_text tool. The model's final
       output is never posted; a turn that sends nothing is a silent turn. */
    async "message.completed"(_eventData, channel) {
      if (channel.thread) await stopTyping(channel.thread.id);
    },
    async "turn.completed"(_eventData, channel) {
      if (!channel.thread) return;
      const owner = ownerFromThread(channel.thread);
      if (owner) await runtime().store.takeStagedTurn(owner);
      await stopTyping(channel.thread.id);
    },
  },
});

function inboxNote(held: HeldItem[]): string {
  const lines = held.slice(0, 8).map((item) => `- ${item.feedName}: ${item.headline}${item.url ? ` (${item.url})` : ""}`);
  const more = held.length > 8 ? `\n…and ${held.length - 8} more.` : "";
  return `\n\n[Inbox] ${held.length} feed item${held.length === 1 ? "" : "s"} arrived since you last spoke and ${held.length === 1 ? "is" : "are"} being held. Answer what they said first; then, if it fits naturally, mention what came in as news and clear the ones you covered with clear_inbox. Ids are in read_inbox.\n${lines.join("\n")}${more}`;
}

async function handle(thread: Thread, message: Message) {
  const settings = config();
  if (!sendblueConfigured(settings)) {
    console.warn("[agent] inbound iMessage ignored: Sendblue is not fully configured");
    return;
  }
  const owner = ownerFromThread(thread);
  if (!owner || !numberAllowed(settings, owner.phone)) return;
  const text = message.text.trim();
  if (!text) return;
  const { store } = runtime();

  const raw = rawPayloadSchema.safeParse(message.raw).data ?? {};
  /* A tapback the person puts on one of our texts arrives as a message of
     its own. It is not something to answer; note it and move on. */
  const tapback = parseTapback(text);
  if (raw.message_type && raw.message_type !== "message") {
    console.info(`[agent] inbound ${raw.message_type} payload: keys=${Object.keys(raw).join(",")} tapback=${tapback ? tapback.signal : "no"}`);
  }
  if (tapback) return;

  const user = await store.touchUser(owner, true);
  if (user.created) {
    /* A new person: start their clock from their area code until they say
       otherwise, so quiet hours are roughly right on night one. */
    const timezone = timezoneFromPhone(owner.phone);
    if (timezone) await store.updatePreferences(owner, { timezone });
  }
  const control = controlWord(text);
  if (control === "stop") {
    await store.setMuted(owner, true);
    await thread.post(STOP_REPLY);
    return;
  }
  if (control === "start" && user.muted) {
    await store.setMuted(owner, false);
    await thread.post(START_REPLY);
    return;
  }
  if (user.muted) return;

  if ((await store.countTurn(owner)) > settings.DAILY_TURN_BUDGET) {
    await thread.post(BUDGET_REPLY);
    return;
  }

  const held = await store.peekHeld(owner);
  /* A turn still marked in flight after minutes is hung; retire its session
     so this text starts a fresh one. A young turn is real work, often a slow
     tool, and this text simply queues behind it. */
  await healStaleSession(owner);
  await store.stageTurn(owner, { kind: "inbound", items: [], inboundMessageId: message.id, sends: 0 });
  const session = await send(held.length > 0 ? `${text}${inboxNote(held)}` : text, {
    thread,
    auth: sendblueAuth(owner.phone, owner.threadId, owner.adapterName),
    turnPolicy: "queue",
  });
  await store.rememberSession(owner, session.id);
}

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await handle(thread, message);
});

bot.onSubscribedMessage(handle);

export default channel;
