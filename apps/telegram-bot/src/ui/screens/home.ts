import { homeGrid } from '../keyboards.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

export async function renderHome(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).home;
  const [walletCount, activeSnipes, openPositions] = await Promise.all([
    deps.prisma.wallet.count({ where: { userId: user.id, isActive: true } }),
    deps.prisma.snipeConfig.count({ where: { userId: user.id, isActive: true } }),
    deps.prisma.position.count({
      where: { status: 'OPEN', wallet: { userId: user.id } },
    }),
  ]);

  const text =
    `${d.title}\n\n` +
    `${d.freeNote}\n\n` +
    `${d.wallets(walletCount)}\n` +
    `${d.activeSnipes(activeSnipes)}\n` +
    `${d.openPositions(openPositions)}\n\n` +
    `${d.pickSection}`;

  return { text, keyboard: homeGrid(lang) };
}
