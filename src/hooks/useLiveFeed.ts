"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLiveFeeds, type LiveFeedData } from "@/lib/feeds";

export const LIVE_FEED_REFRESH_MS = 60_000;

export interface LiveFeedState {
  /** Normalized live feed payload, or `null` while loading / when unavailable. */
  data: LiveFeedData | null;
  /** True on the very first fetch (before any data has arrived). */
  loading: boolean;
  /** Set when the feed request fails. Never thrown into render. */
  error: unknown;
}

/**
 * Fetches the live market/news feeds on mount and refreshes every ~60s.
 * Returns `{ data, loading, error }`. Each individual feed inside `data` is
 * independently null-safe (see src/lib/feeds.ts), so the UI can fall back to
 * static demo data per-panel without ever breaking.
 */
export function useLiveFeed(): LiveFeedState {
  const query = useQuery<LiveFeedData>({
    queryKey: ["live-feed"],
    queryFn: fetchLiveFeeds,
    refetchInterval: LIVE_FEED_REFRESH_MS,
    staleTime: 30_000,
    // Never cache a null/empty stable result as success silently — react-query
    // already leaves `data` undefined until the first successful fetch.
  });

  return {
    data: (query.data ?? null) as LiveFeedData | null,
    loading: query.isLoading,
    error: query.error ?? null,
  };
}
