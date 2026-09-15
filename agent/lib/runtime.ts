import { ambushClient } from "./ambush-client.ts";
import { config, publicBaseUrl } from "./config.ts";
import { countOwnedFeeds, ensureDestination, ownsFeed } from "./destinations.ts";
import type { FeedOwner } from "./owner.ts";
import { tapStore } from "./store.ts";

/** Everything a tool needs, resolved from env once per process. */
export function runtime() {
  const settings = config();
  const ambush = ambushClient({ baseUrl: settings.AMBUSH_API_URL, apiKey: settings.AMBUSH_API_KEY });
  const origin = publicBaseUrl(settings);
  return {
    settings,
    ambush,
    store: tapStore(),
    destinationFor: (owner: FeedOwner) => ensureDestination(ambush, origin, settings.AMBUSH_WEBHOOK_SECRET, owner),
    owns: (owner: FeedOwner, feedId: string) => ownsFeed(ambush, origin, owner, feedId),
    countFeeds: (owner: FeedOwner) => countOwnedFeeds(ambush, origin, owner),
  };
}
