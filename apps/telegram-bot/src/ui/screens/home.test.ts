import { describe, expect, it, vi } from 'vitest';
import { renderHome } from './home.js';
import type { ScreenDeps, ScreenUser } from '../types.js';

const count = vi.fn().mockResolvedValue(0);
const baseDeps = {
  prisma: { wallet: { count }, snipeConfig: { count }, position: { count } },
} as unknown as ScreenDeps;
const user = { id: 'u1', language: 'en' } as unknown as ScreenUser;

describe('renderHome', () => {
  it('puts an Open App web-app button first when MINIAPP_URL is set', async () => {
    const { keyboard } = await renderHome(
      { ...baseDeps, miniappUrl: 'https://example.com/app/' },
      user,
    );
    const first = keyboard!.inline_keyboard[0]![0] as { text: string; web_app?: { url: string } };
    expect(first.text).toContain('Open GSP App');
    expect(first.web_app).toEqual({ url: 'https://example.com/app/' });
  });

  it('shows no web-app button when MINIAPP_URL is not set', async () => {
    const { keyboard } = await renderHome(baseDeps, user);
    const hasWebApp = keyboard!.inline_keyboard.flat().some((b) => 'web_app' in b);
    expect(hasWebApp).toBe(false);
  });
});
