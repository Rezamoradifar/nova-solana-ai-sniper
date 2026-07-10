import { homeGrid } from '../keyboards.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderHome(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const [walletCount, activeSnipes, openPositions] = await Promise.all([
    deps.prisma.wallet.count({ where: { userId: user.id, isActive: true } }),
    deps.prisma.snipeConfig.count({ where: { userId: user.id, isActive: true } }),
    deps.prisma.position.count({
      where: { status: 'OPEN', wallet: { userId: user.id } },
    }),
  ]);

  const text =
    `👋 *Nova Solana AI Sniper*\n\n` +
    `Every feature below is free — no tiers, no limits.\n\n` +
    `👛 Wallets: *${walletCount}*\n` +
    `🎯 Active snipe configs: *${activeSnipes}*\n` +
    `📈 Open positions: *${openPositions}*\n\n` +
    `Pick a section below or use the menu at the bottom of the chat.`;

  return { text, keyboard: homeGrid() };
}
