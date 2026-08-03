import { QueryClient } from '@tanstack/react-query';

/**
 * Shared TanStack Query client — staleTime/gcTime tuned for a trading UI:
 * data goes stale fast (prices/positions move in real time, backed up by the
 * WS layer built in a later increment) but isn't refetched blindly on every
 * focus, since Telegram's WebView backgrounds/foregrounds far more often
 * than a normal browser tab as the user switches between chats.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
