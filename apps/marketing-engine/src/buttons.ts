import type { MarketingCategory } from '@nova/shared';

export interface ButtonSpec {
  text: string;
  url: string;
}

export interface ButtonContext {
  dashboardUrl?: string;
  communityUrl?: string;
  referralUrl?: string;
}

/** Telegram rejects an inline keyboard button whose URL isn't a real public
 * https:// address — verified live (2026-07-23): a localhost URL (the dev
 * default for DASHBOARD_URL) fails the whole sendMessage call with "Wrong
 * HTTP URL", not just that one button. A decorative call-to-action button is
 * never worth failing an entire scheduled post over, so an invalid/local URL
 * is silently dropped rather than attached. */
function isPublicHttpsUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

/** Category-appropriate call-to-action buttons attached to every published
 * post — omits any button whose configured URL isn't currently a valid
 * public https address (see isPublicHttpsUrl), rather than posting nothing
 * or crashing the publish. */
export function buildButtons(category: MarketingCategory, ctx: ButtonContext): ButtonSpec[] {
  const buttons: ButtonSpec[] = [];

  if (isPublicHttpsUrl(ctx.dashboardUrl)) {
    buttons.push({ text: '🚀 Open Dashboard', url: ctx.dashboardUrl });
  }
  if (category === 'referral' && isPublicHttpsUrl(ctx.referralUrl)) {
    buttons.push({ text: '🎁 Get Your Referral Link', url: ctx.referralUrl });
  }
  if (isPublicHttpsUrl(ctx.communityUrl)) {
    buttons.push({ text: '💬 Join Community', url: ctx.communityUrl });
  }

  return buttons;
}
