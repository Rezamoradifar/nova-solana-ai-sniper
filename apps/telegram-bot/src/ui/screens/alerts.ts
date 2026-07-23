import { navOnly } from '../keyboards.js';
import { fmtDate, escapeMd } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const MAX_SHOWN = 10;

export async function renderAlerts(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).alerts;
  const entries = await deps.prisma.auditLog.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_SHOWN,
  });

  let text = d.title;

  if (entries.length === 0) {
    text += d.empty;
  } else {
    text += entries
      .map(
        // Unmapped audit-log actions (e.g. "admin.snipe_paused_for_safety") are raw
        // internal identifiers containing "_" — unescaped, that reads as an
        // unterminated italic marker to Telegram's legacy Markdown parser and made
        // the whole Alerts screen fail to render (confirmed live, same bug class as
        // captions.ts's buildShareCaption).
        (e) =>
          `${d.actionLabels[e.action] ?? d.unmapped(escapeMd(e.action))}\n${fmtDate(e.createdAt)}`,
      )
      .join('\n\n');
  }

  return { text, keyboard: navOnly('home', lang) };
}
