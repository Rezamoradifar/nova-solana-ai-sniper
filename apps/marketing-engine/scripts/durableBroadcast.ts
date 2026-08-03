/**
 * Enqueues a one-off announcement into the durable admin-broadcast queue
 * (src/adminBroadcast/) for every registered, telegramActive user. This only
 * writes the AdminBroadcast/AdminBroadcastDelivery rows — the actual sends
 * happen on the running marketing-engine process's AdminBroadcastWorker tick
 * (durable, retried, blocked-user-aware, rate-limited — see
 * adminBroadcastWorker.ts). Reads the message from a file rather than argv so
 * multi-line/non-ASCII text never hits shell-quoting issues.
 *
 * Usage: npm run durable-broadcast -w apps/marketing-engine -- path/to/message.txt
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { loadMarketingEnv } from '../src/config/env.js';
import { enqueueAdminBroadcast } from '../src/adminBroadcast/broadcastQueue.js';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: durableBroadcast.ts path/to/message.txt');
    process.exit(1);
  }

  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) {
    console.error(`${filePath} is empty — refusing to enqueue an empty broadcast.`);
    process.exit(1);
  }

  loadMarketingEnv(); // validates DATABASE_URL is set before touching the DB
  const prisma = new PrismaClient();

  const { broadcastId, recipientCount } = await enqueueAdminBroadcast(prisma, text);
  console.log(`Enqueued broadcast ${broadcastId} for ${recipientCount} recipients.`);
  console.log("Sends will drain via the running marketing-engine process's AdminBroadcastWorker.");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
