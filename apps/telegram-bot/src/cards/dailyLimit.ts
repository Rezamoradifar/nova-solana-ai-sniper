import type { Redis } from 'ioredis';

export interface DailyTradeCardLimiter {
  reserve(positionId: string): Promise<boolean>;
}

/** One atomic daily quota shared by worker instances, retained across restarts. */
export const RESERVE_DAILY_CARD = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 0 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], 172800) end
return 1
`;

export function tehranDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export class RedisDailyTradeCardLimiter implements DailyTradeCardLimiter {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reserve(positionId: string): Promise<boolean> {
    const result = await this.redis.eval(
      RESERVE_DAILY_CARD,
      1,
      `nova:telegram:daily-trade-cards:${tehranDay(this.now())}`,
      positionId,
      this.limit,
    );
    return Number(result) === 1;
  }
}
