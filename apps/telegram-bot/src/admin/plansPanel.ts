import { InlineKeyboard } from 'grammy';
import type { PrismaClient } from '@prisma/client';

export type PlanField = 'price' | 'fee' | 'maxbuy' | 'maxopen' | 'days';

export const PLAN_FIELD_PROMPTS: Record<PlanField, string> = {
  price: '💰 Send the new price in SOL (e.g. 1.5).',
  fee: '💸 Send the fee for this package as % of net profit (e.g. 15). Send "default" to use the global fee.',
  maxbuy: '🧮 Send the max SOL per buy (e.g. 2). Send "none" for no limit.',
  maxopen: '📈 Send the max number of open positions (e.g. 5). Send "none" for no limit.',
  days: '📅 Send the package length in days (e.g. 30).',
};

const sol = (n: number) => `${Number(n.toFixed(4))} SOL`;
const DAY_MS = 86_400_000;

/** Owner view of every package: subscribers, sales and revenue, with edit buttons. */
export async function renderPlansPanel(
  prisma: PrismaClient,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  const [plans, activeByPlan, revenueAll, revenue30d, users] = await Promise.all([
    prisma.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.user.groupBy({
      by: ['planKey'],
      _count: { _all: true },
      where: { planKey: { not: 'free' }, planExpiresAt: { gt: now } },
    }),
    prisma.subscription.groupBy({
      by: ['planKey'],
      _sum: { amountSol: true },
      _count: { _all: true },
    }),
    prisma.subscription.groupBy({
      by: ['planKey'],
      _sum: { amountSol: true },
      where: { createdAt: { gte: since30d } },
    }),
    prisma.user.count({ where: { telegramId: { not: null } } }),
  ]);
  const active = new Map(activeByPlan.map((r) => [r.planKey, r._count._all]));
  const all = new Map(revenueAll.map((r) => [r.planKey, r]));
  const last30 = new Map(revenue30d.map((r) => [r.planKey, r._sum.amountSol ?? 0]));
  const paid = activeByPlan.reduce((n, r) => n + r._count._all, 0);
  const totalRevenue = revenueAll.reduce((s, r) => s + (r._sum.amountSol ?? 0), 0);
  const total30 = revenue30d.reduce((s, r) => s + (r._sum.amountSol ?? 0), 0);

  let text =
    `💎 *Packages & Revenue*\n\n` +
    `👥 Users: *${users}* · paid: *${paid}* · free: *${Math.max(0, users - paid)}*\n` +
    `💰 Package revenue: *${sol(totalRevenue)}* (30d: ${sol(total30)})\n`;
  const kb = new InlineKeyboard();
  for (const p of plans) {
    const subs = p.key === 'free' ? Math.max(0, users - paid) : (active.get(p.key) ?? 0);
    text +=
      `\n${p.active ? '🟢' : '⚪️'} *${p.name}* (\`${p.key}\`)\n` +
      `Price: ${p.priceSol > 0 ? `${sol(p.priceSol)} / ${p.durationDays}d` : 'free'}\n` +
      `Fee: ${p.feeBps !== null ? `${p.feeBps / 100}%` : 'global'} · Max buy: ${p.maxBuySol ?? '∞'} · Max open: ${p.maxOpenPositions ?? '∞'}\n` +
      `Subscribers: *${subs}* · Sales: ${all.get(p.key)?._count._all ?? 0} · Revenue: ${sol(all.get(p.key)?._sum.amountSol ?? 0)} (30d ${sol(last30.get(p.key) ?? 0)})\n`;
    kb.text(`✏️ ${p.name}`, `admp:open:${p.key}`).row();
  }
  kb.text('⬅️ Admin panel', 'adm:refresh').text('🔄 Refresh', 'admp:list');
  return { text, keyboard: kb };
}

export async function renderPlanEditor(
  prisma: PrismaClient,
  key: string,
): Promise<{ text: string; keyboard: InlineKeyboard } | undefined> {
  const p = await prisma.subscriptionPlan.findUnique({ where: { key } });
  if (!p) return undefined;
  const text =
    `✏️ *${p.name}* (\`${p.key}\`)\n\n` +
    `Price: ${p.priceSol} SOL · ${p.durationDays} days\n` +
    `Fee: ${p.feeBps !== null ? `${p.feeBps / 100}%` : 'global'}\n` +
    `Max buy: ${p.maxBuySol ?? 'no limit'} · Max open: ${p.maxOpenPositions ?? 'no limit'}\n` +
    `Status: ${p.active ? 'on sale' : 'hidden'}`;
  const kb = new InlineKeyboard()
    .text('💰 Price', `admp:edit:${key}:price`)
    .text('📅 Days', `admp:edit:${key}:days`)
    .row()
    .text('💸 Fee %', `admp:edit:${key}:fee`)
    .row()
    .text('🧮 Max buy', `admp:edit:${key}:maxbuy`)
    .text('📈 Max open', `admp:edit:${key}:maxopen`)
    .row()
    .text(p.active ? '🙈 Hide package' : '👁 Put on sale', `admp:toggle:${key}`)
    .row()
    .text('⬅️ Packages', 'admp:list');
  return { text, keyboard: kb };
}

/** Validates and saves one package edit. Returns an error message, or undefined on success. */
export async function applyPlanEdit(
  prisma: PrismaClient,
  key: string,
  field: PlanField,
  raw: string,
): Promise<string | undefined> {
  const v = raw.trim().toLowerCase();
  const num = Number(v.replace('%', ''));
  const none = v === 'none' || v === 'default';
  let data: Record<string, number | null>;
  switch (field) {
    case 'price':
      if (!Number.isFinite(num) || num < 0 || num > 1000)
        return 'Price must be a number of SOL between 0 and 1000.';
      data = { priceSol: num };
      break;
    case 'days':
      if (!Number.isInteger(num) || num < 1 || num > 3650)
        return 'Days must be a whole number between 1 and 3650.';
      data = { durationDays: num };
      break;
    case 'fee':
      if (!none && (!Number.isFinite(num) || num < 0 || num > 100))
        return 'Fee must be 0-100, or "default".';
      data = { feeBps: none ? null : Math.round(num * 100) };
      break;
    case 'maxbuy':
      if (!none && (!Number.isFinite(num) || num <= 0 || num > 1000))
        return 'Max buy must be a positive SOL amount, or "none".';
      data = { maxBuySol: none ? null : num };
      break;
    case 'maxopen':
      if (!none && (!Number.isInteger(num) || num < 1 || num > 1000))
        return 'Max open must be a whole number, or "none".';
      data = { maxOpenPositions: none ? null : num };
      break;
  }
  await prisma.subscriptionPlan.update({ where: { key }, data });
  return undefined;
}
