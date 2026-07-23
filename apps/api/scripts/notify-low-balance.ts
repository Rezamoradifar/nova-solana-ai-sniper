/**
 * One-off: notify the users whose active auto-buy config is currently
 * blocked purely by insufficient wallet balance (see NotificationService.
 * notifyLowWalletBalance in @nova/telegram-bot). Data below was pulled live
 * (RPC balance reads + current SnipeConfig state) on 2026-07-18 — re-verify
 * before reusing this list on a later date.
 *
 * Usage: npm run notify-low-balance --workspace apps/api
 */
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@nova/shared';
import { createBot, NotificationService } from '@nova/telegram-bot';
import { loadApiEnv } from '../src/config/env.js';

const RECIPIENTS: Array<{ userId: string; balanceSol: number; requiredSol: number }> = [
  { userId: 'cmrezdoim0005hc9kzl23qbw4', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrezvc5n0000ln14cdj37g3j', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrf0d0b90000r19yg991k7r7', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrf0oen4000046kqzq0p26d2', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrf13eyi00084o9q7r1468bk', balanceSol: 0.036644, requiredSol: 0.04 },
  { userId: 'cmrf5i3iq004cq8wki2dgg9lo', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrf5pk49004rq8wkw0siybjp', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrf677150054q8wku6cpx2mi', balanceSol: 0.016861874, requiredSol: 0.03 },
  { userId: 'cmrfka21z000021vzwjrbjmbf', balanceSol: 0.092884488, requiredSol: 0.11 },
  { userId: 'cmrfzlrgg0000tx8cdvadyf0o', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrg3f6dg0003tx8cem6eezlv', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrgrcr7p0019tx8cxzc2kxvo', balanceSol: 0.039197037, requiredSol: 0.26 },
  { userId: 'cmrhjzi5s0009115rsw9z5dlm', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrhpm0gs000dj2bx4bw5p5l6', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrhre1oc000uj2bxf8tea8yk', balanceSol: 0.0, requiredSol: 0.06 },
  { userId: 'cmrhxcaci000vj2bx4ka9iq4o', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrkw8jts000w1098njmly8ix', balanceSol: 0.0, requiredSol: 0.11 },
  { userId: 'cmrmevl2x002510987fwzk8bz', balanceSol: 0.0, requiredSol: 0.11 },
];

async function main() {
  const env = loadApiEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — cannot send.');
    process.exit(1);
  }

  const logger = createLogger('notify-low-balance-script');
  const prisma = new PrismaClient();
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, logger as never);
  const notifier = new NotificationService(bot, env.TELEGRAM_CHAT_ID, prisma, logger as never);

  let sent = 0;
  let failed = 0;
  for (const r of RECIPIENTS) {
    const ok = await notifier.notifyLowWalletBalance(r.userId, {
      balanceSol: r.balanceSol,
      requiredSol: r.requiredSol,
    });
    console.log(`${ok ? 'sent' : 'FAILED'}: ${r.userId}`);
    if (ok) sent++;
    else failed++;
  }
  console.log(`Done. ${sent} sent, ${failed} failed.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
