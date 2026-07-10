import type { MarketingCategory } from '@nova/shared';

export interface ButtonSpec {
  text: string;
  url: string;
}

export interface ButtonContext {
  dashboardUrl: string;
  communityUrl?: string;
  referralUrl?: string;
}

/** Category-appropriate call-to-action buttons attached to every published post. */
export function buildButtons(category: MarketingCategory, ctx: ButtonContext): ButtonSpec[] {
  const buttons: ButtonSpec[] = [{ text: '🚀 Open Dashboard', url: ctx.dashboardUrl }];

  if (category === 'referral' && ctx.referralUrl) {
    buttons.push({ text: '🎁 Get Your Referral Link', url: ctx.referralUrl });
  }
  if (ctx.communityUrl) {
    buttons.push({ text: '💬 Join Community', url: ctx.communityUrl });
  }

  return buttons;
}
