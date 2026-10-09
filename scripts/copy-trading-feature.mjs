import process from 'node:process';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const key = 'COPY_TRADING_EXECUTION_ENABLED';
try {
  const action = process.argv[2];
  if (action === 'status') {
    const row = await db.adminFeatureOverride.findUnique({ where: { key } });
    process.stdout.write(
      JSON.stringify(row ? { enabled: row.enabled, updatedByUserId: row.updatedByUserId } : null),
    );
  } else if (action === 'enable') {
    await db.$transaction([
      db.adminFeatureOverride.upsert({
        where: { key },
        create: { key, enabled: true },
        update: { enabled: true },
      }),
      db.auditLog.create({
        data: {
          action: 'operator.copy_trading_enabled',
          metadata: { source: 'enable-copy-trading.sh' },
        },
      }),
    ]);
  } else if (action === 'restore') {
    const prior = JSON.parse(process.argv[3]);
    if (prior === null) await db.adminFeatureOverride.deleteMany({ where: { key } });
    else {
      if (typeof prior.enabled !== 'boolean') throw new Error('Invalid feature backup');
      await db.adminFeatureOverride.upsert({
        where: { key },
        create: { key, ...prior },
        update: prior,
      });
    }
  } else throw new Error('Expected status, enable, or restore');
} finally {
  await db.$disconnect();
}
