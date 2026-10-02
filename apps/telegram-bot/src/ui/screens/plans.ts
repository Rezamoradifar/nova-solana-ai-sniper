import { InlineKeyboard } from 'grammy';
import { effectivePlanKey } from '@nova/shared';
import { withNav } from '../keyboards.js';
import { fmtDate, escapeMd } from '../format.js';
import { getLocale, t } from '../../i18n/index.js';
import { ApiRequestError, purchasePlanApi } from '../../api/client.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const solStr = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ''));

export async function renderPlans(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).plans;
  const plans = await deps.prisma.subscriptionPlan.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (plans.length === 0)
    return { text: d.unavailable, keyboard: withNav(new InlineKeyboard(), 'home', lang) };

  const currentKey = effectivePlanKey(user);
  const current = plans.find((p) => p.key === currentKey);
  const until = currentKey !== 'free' && user.planExpiresAt ? fmtDate(user.planExpiresAt) : '';

  let text = `${d.title}\n\n${d.current(escapeMd(current?.name ?? currentKey), until)}\n`;
  const kb = new InlineKeyboard();
  for (const p of plans) {
    const marker = p.key === currentKey ? '✅' : '▫️';
    text += `\n${marker} *${escapeMd(p.name)}* — ${p.priceSol > 0 ? d.price(solStr(p.priceSol), p.durationDays) : d.freePrice}\n`;
    text += `• ${p.feeBps !== null ? d.fee(solStr(p.feeBps / 100)) : d.feeGlobal}\n`;
    if (p.maxBuySol !== null) text += `• ${d.maxBuy(solStr(p.maxBuySol))}\n`;
    if (p.maxOpenPositions !== null) text += `• ${d.maxOpen(p.maxOpenPositions)}\n`;
    if (p.maxBuySol === null && p.maxOpenPositions === null) text += `• ${d.unlimited}\n`;
    for (const f of p.features
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean))
      text += `• ${escapeMd(f)}\n`;
    if (p.priceSol > 0) {
      const label =
        p.key === currentKey
          ? d.renewBtn(p.name, solStr(p.priceSol))
          : d.buyBtn(p.name, solStr(p.priceSol));
      kb.text(label, `a:plans:ask:${p.key}`).row();
    }
  }
  return { text, keyboard: withNav(kb, 'home', lang) };
}

export async function renderPlanConfirm(
  deps: ScreenDeps,
  user: ScreenUser,
  planKey: string,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).plans;
  const plan = await deps.prisma.subscriptionPlan.findUnique({ where: { key: planKey } });
  if (!plan || !plan.active || plan.priceSol <= 0) return renderPlans(deps, user);
  const kb = new InlineKeyboard()
    .text(d.confirmBtn, `a:plans:buy:${plan.key}`)
    .text(d.cancelBtn, 's:plans');
  return {
    text: d.confirm(escapeMd(plan.name), solStr(plan.priceSol), plan.durationDays),
    keyboard: withNav(kb, 'plans', lang),
  };
}

export async function handlePlanPurchase(
  deps: ScreenDeps,
  user: ScreenUser,
  planKey: string,
): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).plans;
  const back = withNav(new InlineKeyboard(), 'plans', lang);
  if (!deps.api) return { text: d.unavailable, keyboard: back };
  try {
    const r = await purchasePlanApi(deps.api, user, planKey);
    const plan = await deps.prisma.subscriptionPlan.findUnique({ where: { key: r.planKey } });
    return {
      text: d.success(
        escapeMd(plan?.name ?? r.planKey),
        fmtDate(new Date(r.expiresAt)),
        r.txSignature,
      ),
      keyboard: back,
    };
  } catch (err) {
    const reason = err instanceof ApiRequestError ? err.message : 'unexpected error';
    deps.logger.warn({ err, userId: user.id, planKey }, 'plan purchase failed');
    return { text: d.failed(escapeMd(reason)), keyboard: back };
  }
}
