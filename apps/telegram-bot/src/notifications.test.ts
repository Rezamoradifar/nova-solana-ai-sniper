import { describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import type { Logger } from '@nova/shared';
import { formatNewTokenMessage, sendNewTokenAlertToUsers } from './notifications.js';

const fakeLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;

describe('formatNewTokenMessage', () => {
  it('includes liquidity and score lines when present', () => {
    const text = formatNewTokenMessage({
      mint: 'MintABC',
      dex: 'PUMPFUN',
      liquidityUsd: 12345,
      aiScore: 82,
      isHoneypotSuspected: false,
    });
    expect(text).toContain('New PUMPFUN launch');
    expect(text).toContain('MintABC');
    expect(text).toContain('Liquidity: $12345');
    expect(text).toContain('Score: 82/100');
    expect(text).not.toContain('Honeypot');
  });

  it('flags honeypot risk and omits liquidity/score lines when unknown', () => {
    const text = formatNewTokenMessage({
      mint: 'MintXYZ',
      dex: 'RAYDIUM',
      isHoneypotSuspected: true,
    });
    expect(text).toContain('🚨');
    expect(text).toContain('Honeypot/rug risk flagged');
    expect(text).not.toContain('Liquidity:');
    expect(text).not.toContain('Score:');
  });
});

describe('sendNewTokenAlertToUsers', () => {
  it('does nothing and makes no API calls for an empty recipient list', async () => {
    const api = { sendMessage: vi.fn() } as unknown as Api;
    await sendNewTokenAlertToUsers(api, [], { mint: 'M', dex: 'PUMPFUN' }, fakeLogger);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the identical formatted alert to every recipient chat', async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as Api;
    const token = { mint: 'MintABC', dex: 'PUMPFUN', liquidityUsd: 5000, aiScore: 70 };

    await sendNewTokenAlertToUsers(api, ['111', '222', '333'], token, fakeLogger);

    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    const expectedText = formatNewTokenMessage(token);
    for (const chatId of ['111', '222', '333']) {
      expect(api.sendMessage).toHaveBeenCalledWith(chatId, expectedText, {
        parse_mode: 'Markdown',
      });
    }
  });

  it('logs a failure for one recipient without throwing or skipping the rest', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('bot was blocked by the user'))
      .mockResolvedValueOnce(undefined);
    const api = { sendMessage } as unknown as Api;

    await expect(
      sendNewTokenAlertToUsers(
        api,
        ['111', '222', '333'],
        { mint: 'M', dex: 'PUMPFUN' },
        fakeLogger,
      ),
    ).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(fakeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '222' }),
      'failed to send per-user new-token alert',
    );
  });
});
