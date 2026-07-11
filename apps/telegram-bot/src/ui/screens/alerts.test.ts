import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient, User } from '@prisma/client';
import { renderAlerts } from './alerts.js';
import type { ScreenDeps } from '../types.js';

function fakeDeps(entries: { action: string; createdAt: Date }[]): ScreenDeps {
  const prisma = {
    auditLog: { findMany: vi.fn().mockResolvedValue(entries) },
  } as unknown as PrismaClient;
  return { prisma, encryptionKey: 'key', logger: { error: vi.fn() } as never };
}

const user = { id: 'user-1' } as User;

describe('renderAlerts', () => {
  it('regression: escapes an unmapped audit-log action so a "_" never breaks Telegram Markdown parsing', async () => {
    // Live-verified failure: "admin.snipe_paused_for_safety" is not in
    // ACTION_LABELS, so its raw action string (containing "_") was embedded
    // directly into parse_mode:'Markdown' text — Telegram rejected the whole
    // Alerts screen with "can't parse entities".
    const result = await renderAlerts(
      fakeDeps([
        { action: 'admin.snipe_paused_for_safety', createdAt: new Date('2026-07-10T14:46:00Z') },
      ]),
      user,
    );
    expect(result.text).toContain('admin.snipe\\_paused\\_for\\_safety');
    expect(result.text).not.toContain('admin.snipe_paused_for_safety');
  });

  it('uses the friendly label (already safe, no special chars) for a mapped action', async () => {
    const result = await renderAlerts(
      fakeDeps([{ action: 'wallet.create', createdAt: new Date('2026-07-10T20:12:00Z') }]),
      user,
    );
    expect(result.text).toContain('👛 Wallet created');
  });

  it('shows an empty-state message when there is no activity yet', async () => {
    const result = await renderAlerts(fakeDeps([]), user);
    expect(result.text).toContain('Nothing yet');
  });
});
