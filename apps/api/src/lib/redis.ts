import { Redis } from 'ioredis';

let redis: Redis | undefined;

export function getRedis(url: string): Redis {
  redis ??= new Redis(url, { maxRetriesPerRequest: 3 });
  return redis;
}
