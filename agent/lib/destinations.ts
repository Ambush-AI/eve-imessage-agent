import type { AmbushClient, WebhookChannel } from "./ambush-client.ts";
import { destinationBelongsTo, destinationUrl, type FeedOwner } from "./owner.ts";

/** This conversation's destinations, of which there may be more than one. */
export async function ownedDestinations(ambush: AmbushClient, owner: FeedOwner): Promise<WebhookChannel[]> {
  return (await ambush.listChannels()).filter((channel) => channel.status !== "deleted" && destinationBelongsTo(channel, owner));
}

/**
 * One Ambush webhook destination per conversation, found by the owner token
 * in its URL. Ambush is the only store: there is nothing to lose on a cold
 * start, and a second process finds the same destination instead of creating
 * a duplicate.
 */
export async function ensureDestination(ambush: AmbushClient, publicBaseUrl: string, secret: string, owner: FeedOwner): Promise<string> {
  const [existing] = await ownedDestinations(ambush, owner);
  if (existing) return existing.id;
  const created = await ambush.createWebhookChannel({ url: destinationUrl(publicBaseUrl, owner), secret });
  return created.id;
}

/** Ids of every stream routed to one of this conversation's destinations. */
export async function ownedStreamIds(ambush: AmbushClient, owner: FeedOwner): Promise<string[]> {
  const mine = await ownedDestinations(ambush, owner);
  return [...new Set(mine.flatMap((channel) => (channel.feeds ?? []).map((feed) => feed.feed_id)))];
}

export async function ownsFeed(ambush: AmbushClient, _publicBaseUrl: string, owner: FeedOwner, feedId: string): Promise<boolean> {
  return (await ownedStreamIds(ambush, owner)).includes(feedId);
}

export async function countOwnedFeeds(ambush: AmbushClient, _publicBaseUrl: string, owner: FeedOwner): Promise<number> {
  return (await ownedStreamIds(ambush, owner)).length;
}
