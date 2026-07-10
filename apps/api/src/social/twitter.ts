const TWITTER_API_BASE = 'https://api.twitter.com/2';

export interface Tweet {
  id: string;
  text: string;
  authorId?: string;
  createdAt?: string;
}

interface RawTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
}

interface RecentSearchResponse {
  data?: RawTweet[];
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number };
  errors?: Array<{ message: string }>;
}

export interface TwitterClientConfig {
  bearerToken: string;
}

/**
 * Thin wrapper over the X (Twitter) API v2 "recent search" endpoint using
 * App-only (Bearer token) auth — no user-context OAuth1 flow needed for
 * read-only search. Requires at least the Basic API tier; the free tier
 * does not include search access.
 */
export class TwitterClient {
  constructor(private readonly config: TwitterClientConfig) {}

  async searchRecent(
    query: string,
    sinceId?: string,
  ): Promise<{ tweets: Tweet[]; newestId?: string }> {
    const url = new URL(`${TWITTER_API_BASE}/tweets/search/recent`);
    url.searchParams.set('query', query);
    url.searchParams.set('tweet.fields', 'created_at,author_id');
    url.searchParams.set('max_results', '25');
    if (sinceId) url.searchParams.set('since_id', sinceId);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.bearerToken}` },
    });

    if (res.status === 429) {
      throw new Error('Twitter API rate limit exceeded');
    }
    if (!res.ok) {
      throw new Error(`Twitter search failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as RecentSearchResponse;
    if (body.errors?.length) {
      throw new Error(`Twitter search error: ${body.errors.map((e) => e.message).join('; ')}`);
    }

    const tweets: Tweet[] = (body.data ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      createdAt: t.created_at,
    }));

    return { tweets, newestId: body.meta?.newest_id };
  }
}
