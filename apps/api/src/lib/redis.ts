import { Redis } from 'ioredis';

let redis: Redis | undefined;

export function getRedis(url: string): Redis {
  if (!redis) {
    redis = new Redis(url, { maxRetriesPerRequest: 3 });
    // ioredis emits 'error' on every connection failure; with zero listeners
    // that's an unhandled EventEmitter error and crashes the process.
    redis.on('error', (err) => console.error('redis client error', err));
  }
  return redis;
}
