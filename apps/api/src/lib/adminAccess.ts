import type { FastifyReply, FastifyRequest } from 'fastify';

/** Same admin list the Telegram bot uses (TELEGRAM_ADMIN_IDS), plus DB ADMIN role. */
export function isAdminUser(
  user: { role: string; telegramId: string | null },
  adminIdsCsv: string | undefined,
): boolean {
  if (user.role === 'ADMIN') return true;
  if (!user.telegramId || !adminIdsCsv) return false;
  return adminIdsCsv
    .split(',')
    .map((id) => id.trim())
    .includes(user.telegramId);
}

/**
 * preHandler for admin routes. Re-reads the user on every request, so removing
 * someone from TELEGRAM_ADMIN_IDS takes effect immediately, not at token expiry.
 */
export async function requireAdminUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    await reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  const user = await req.server.prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { role: true, telegramId: true },
  });
  if (!user || !isAdminUser(user, req.server.config.TELEGRAM_ADMIN_IDS)) {
    await reply.code(403).send({ error: 'Forbidden' });
  }
}
