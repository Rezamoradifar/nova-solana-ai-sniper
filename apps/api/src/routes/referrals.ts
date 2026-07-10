import type { FastifyInstance } from 'fastify';

export default async function referralRoutes(fastify: FastifyInstance) {
  fastify.get('/referrals', { preHandler: fastify.authenticate }, async (req) => {
    const user = await fastify.prisma.user.findUniqueOrThrow({
      where: { id: req.user.userId },
      select: { referralCode: true, subscriptionTier: true },
    });

    const referredCount = user.referralCode
      ? await fastify.prisma.user.count({ where: { referredByCode: user.referralCode } })
      : 0;

    return {
      referralCode: user.referralCode,
      subscriptionTier: user.subscriptionTier,
      referredCount,
    };
  });
}
