import { z } from "zod";

const feedStatusSchema = z.enum(["active", "paused"]);

export const feedMutationSchema = z.looseObject({
  feed_id: z.string().uuid(),
  prompt_revision_id: z.string().uuid(),
  status: z.string(),
});

export const feedDetailSchema = z.looseObject({
  feed_id: z.string().uuid(),
  name: z.string().nullish(),
  status: feedStatusSchema,
  current_prompt_revision: z
    .looseObject({ id: z.string(), revision: z.number(), prompt: z.string() })
    .nullish(),
  /** Destinations routed to this feed; `id` is the emission channel id. */
  emission_channels: z.array(z.looseObject({ id: z.string(), type: z.string() })).default([]),
});

export const feedSummarySchema = z.looseObject({
  feed_id: z.string().uuid(),
  name: z.string().nullish(),
  status: feedStatusSchema,
  emission_channel_count: z.number().optional(),
});

export const webhookChannelSchema = z.looseObject({
  id: z.string().uuid(),
  type: z.string(),
  /** Present on the creation response. */
  url: z.string().optional(),
  /** The list endpoint carries the URL here instead. */
  label: z.string().optional(),
  status: z.string(),
  /** Feeds routed to this destination, on the list endpoint. */
  feeds: z.array(z.looseObject({ feed_id: z.string(), name: z.string().nullish(), active: z.boolean().optional() })).optional(),
});
export type WebhookChannel = z.infer<typeof webhookChannelSchema>;

export const previewMatchSchema = z.looseObject({
  headline: z.string(),
  source: z.string(),
  url: z.string().nullish(),
  score: z.number(),
  published_at: z.string(),
});

export const emissionSchema = z.looseObject({
  id: z.string().optional(),
  headline: z.string().optional(),
  source: z.string().nullish(),
  url: z.string().nullish(),
  emitted_at: z.string().optional(),
});

export class AmbushApiError extends Error {
  override name = "AmbushApiError";
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Ambush API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export interface AmbushClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

/**
 * Thin REST client for the public Ambush Feeds API. Every response is parsed
 * loosely: the tools only need a handful of fields and the API adds more over
 * time.
 */
export function createAmbushClient(options: AmbushClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call<T>(
    schema: z.ZodType<T>,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new AmbushApiError(response.status, text);
    return schema.parse(text ? JSON.parse(text) : {});
  }

  return {
    createFeed: (input: { prompt: string; name?: string }) =>
      call(feedMutationSchema, "POST", "/feeds", input),

    getFeed: (feedId: string) =>
      call(feedDetailSchema, "GET", `/feeds/${encodeURIComponent(feedId)}`),

    /** Every feed on the account, following pagination. */
    listFeeds: async () => {
      const feeds: z.infer<typeof feedSummarySchema>[] = [];
      let cursor: string | null = null;
      do {
        const page: { feeds: z.infer<typeof feedSummarySchema>[]; next_cursor: string | null } = await call(
          z.object({ feeds: z.array(feedSummarySchema), next_cursor: z.string().nullable() }),
          "GET",
          `/feeds?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        feeds.push(...page.feeds);
        cursor = page.next_cursor;
      } while (cursor);
      return feeds;
    },

    /** Workspace destinations, of every type. */
    listChannels: () =>
      call(z.looseObject({ channels: z.array(webhookChannelSchema) }), "GET", "/channels").then(
        (result) => result.channels,
      ),

    /** Creates a webhook destination; Ambush pings it with the secret before activating. */
    createWebhookChannel: (input: { url: string; secret: string }) =>
      call(webhookChannelSchema, "POST", "/channels", { type: "webhook", ...input }),

    updateFeed: (
      feedId: string,
      input: { prompt?: string; name?: string; status?: "active" | "paused" },
    ) => call(feedMutationSchema, "PATCH", `/feeds/${encodeURIComponent(feedId)}`, input),

    deleteFeed: (feedId: string) =>
      call(z.unknown(), "DELETE", `/feeds/${encodeURIComponent(feedId)}`),

    /** Routes an already-approved destination to the feed. */
    attachChannel: (feedId: string, channelId: string, minimumDeliveryIntervalMinutes?: number) =>
      call(z.unknown(), "POST", `/feeds/${encodeURIComponent(feedId)}/channels`, {
        emission_channel_id: channelId,
        ...(minimumDeliveryIntervalMinutes ? { minimum_delivery_interval_minutes: minimumDeliveryIntervalMinutes } : {}),
      }),


    /** Retrieval-only look at what a prompt would have matched recently. */
    previewPrompt: (input: { prompt: string; lookback?: "7d" | "14d" | "30d"; limit?: number }) =>
      call(
        z.object({ preview: z.object({ matches: z.array(previewMatchSchema), took_ms: z.number() }) }),
        "POST",
        "/prompt-preview",
        input,
      ).then((result) => result.preview),

    listEmissions: (feedId: string, limit = 10) =>
      call(
        z.looseObject({ emissions: z.array(emissionSchema).optional(), items: z.array(emissionSchema).optional() }),
        "GET",
        `/feeds/${encodeURIComponent(feedId)}/emissions?limit=${limit}`,
      ).then((result) => result.emissions ?? result.items ?? []),
  };
}

export type AmbushClient = ReturnType<typeof createAmbushClient>;

let client: AmbushClient | undefined;

export function ambushClient(options: AmbushClientOptions): AmbushClient {
  client ??= createAmbushClient(options);
  return client;
}
