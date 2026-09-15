# eve-imessage-agent

A reference implementation of an iMessage assistant built on
[eve](https://eve.dev) and the Vercel Chat SDK, with
[Ambush Streams](https://ambush.ai) as its source of real-world events.
Anyone who texts the line gets their own durable agent. That agent can create
Ambush streams for the person, receive their events over signed webhooks,
decide whether each event is worth a text now or later, and text like a
friend rather than a notification service.

It exists to show how Ambush Streams fit into an agent product end to end:
one API key, one webhook destination per conversation, ownership derived
from Ambush itself, and pacing rules that keep an iMessage line healthy.

## How the pieces fit

```text
iPhone ⇄ Sendblue ⇄ POST /eve/v1/sendblue           agent/channels/imessage.ts
                        │  Chat SDK thread = eve session, keyed by phone number
                        ▼
                  eve harness: instructions, tools, per-session sandbox, memory
                        │
   create_stream ───────┼──► Ambush API: one webhook destination per conversation
                        │    (URL ends in the encoded owner), POST /feeds,
                        │    route the destination to the stream
                        │              │ feed.news_items.emitted
                        │              ▼
              POST /webhooks/ambush/<owner>                agent/channels/ambush.ts
                        │  verify the Standard Webhooks signature, decode the owner,
                        │  enforce quiet hours and the daily cap in code,
                        └─► wake that person's session with a "[Stream event]" message;
                            the agent texts now (send_text) or holds it (hold_items)

              cron every minute                              agent/schedules/tick.ts
                        │  two Redis reads: who has a reminder due, whose held
                        └─► items are old enough for a digest; wake only those sessions
```

## The Ambush integration, specifically

- **Streams are created with the account's API key** (`POST /feeds`). The
  prompt is written in the person's first person, previewed first
  (`POST /prompt-preview`), and revised through `PATCH /feeds/:id`.
- **Every conversation gets its own webhook destination** (`POST /channels`
  with the app's signing secret). The destination URL ends in a base64url
  token that encodes which conversation owns it, so an incoming webhook
  identifies its recipient with no lookup table. The path is trusted only
  after the signature verifies, and Ambush is the only holder of the secret.
- **Ownership lives on Ambush.** A stream belongs to whichever conversation's
  destination is routed to it. `GET /channels` returns each destination with
  its routed streams, so listing, editing, and counting a person's streams
  never touch local state. Destinations are matched by the owner token at
  the end of the path, never by host, because a Vercel deployment can be
  reached under more than one alias and the list endpoint reports the URL as
  `label`.
- **Batching happens on Ambush.** Streams are routed with a minimum delivery
  interval, so the app receives one batch per window rather than one webhook
  per item.
- **Delivery is decided by the agent.** A batch wakes the session with the
  items and the person's pacing status. The agent texts now if it is worth
  interrupting for, or holds the items for the next time the person texts or
  the next digest window. Quiet hours, a daily cap of unprompted texts, a
  minimum gap, and mute are enforced in code before the model runs.

See `agent/lib/ambush-client.ts` for the exact requests and
`agent/lib/ambush-webhook.ts` for signature verification and the event
schema.

## Everything else in the agent

- **Delivery through a tool.** The only way words reach a phone is the
  `send_text` tool, up to four bubbles per turn. The model's final output is
  never delivered, so replies split like real texts and silence is simply not
  calling the tool.
- **Inbox.** Held items surface when the person next texts, or at a
  check-in once they are old enough and pacing allows.
- **Preferences, reminders, and standing tasks** per person, in Upstash
  Redis, with the time zone guessed from the area code until the person
  says otherwise.
- **Memory** per phone number through eve's file memory on Vercel Blob.
- **Tapback acknowledgements**, typing indicators kept alive across long
  turns, STOP and START handling, a daily turn budget, and a sandbox released
  after every turn.
- **Self-healing sessions.** A deployment that lands mid-turn can strand the
  workflow run behind a session; every wake path detects a stale turn and
  retires that session through eve's own reset route before sending.

## Setup

Requires Node 24, a Sendblue line, an Ambush API key, and a Vercel project
(the model authenticates through AI Gateway with OIDC; set `OPENAI_API_KEY`
to run locally without linking).

```sh
npm install
cp .env.example .env
npx eve link
vercel integration add upstash/upstash-kv        # Redis for state and the store
npx eve add memory/file                          # Blob-backed memory slot
```

Generate `AMBUSH_WEBHOOK_SECRET` as `whsec_` plus 32 random bytes in base64:

```sh
node -e 'console.log("whsec_" + require("node:crypto").randomBytes(32).toString("base64"))'
```

Point Sendblue's inbound webhook at `https://<your-host>/eve/v1/sendblue`
with the same shared secret as `SENDBLUE_WEBHOOK_SECRET`. Set `PUBLIC_URL` to
the canonical host of the deployment so every destination is created under
one URL. Then:

```sh
npm run typecheck && npm test
npm run deploy
```

Two Vercel settings matter: Deployment Protection must not cover
production, or Sendblue's and Ambush's posts are rejected at the edge; and
the per-minute cron for the check-in appears under the project's Cron Jobs
after the first deploy.

## Running locally without a phone

`npm run dev` starts eve with its terminal REPL over the HTTP channel. A
stream created from there is owned by that HTTP session, and the Ambush
webhook wakes it the same way. Sendblue variables can stay unset; the
iMessage channel refuses traffic until all four are configured.

## Layout

```text
agent/
  agent.ts                 model selection (gateway on Vercel, direct locally)
  instructions.md          the persona and the rules for streams, delivery, and holding
  channels/imessage.ts     Chat SDK Sendblue channel, STOP/START, budget, inbox drain
  channels/ambush.ts       signed webhook receiver, pacing gate, session wake
  schedules/tick.ts        per-minute dispatcher over global due indexes
  hooks/stop-sandbox.ts    release sandbox compute after each turn
  memory/file.ts           file memory slot, scoped per phone number
  lib/ambush-client.ts     the Ambush REST calls used
  lib/ambush-webhook.ts    Standard Webhooks verification and the event prompt
  lib/owner.ts             owner encoding in destination URLs
  lib/destinations.ts      one destination per conversation, ownership from Ambush
  lib/store.ts             Redis: inbox, preferences, reminders, pacing, sessions
  lib/pacing.ts            quiet hours, caps, tapback and control-word parsing
  lib/session-health.ts    stale-turn detection and reset
  tools/                   send_text, react, stream tools, inbox, preferences, reminders
```
