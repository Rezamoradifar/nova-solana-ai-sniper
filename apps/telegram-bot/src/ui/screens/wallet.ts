import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import {
  generateWallet,
  importWalletFromSecretKey,
  decryptSecret,
  createWalletBackup,
  restoreWalletBackup,
  type WalletBackup,
} from '@nova/shared';
import { withNav } from '../keyboards.js';
import { shortKey, escapeMd } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const SEED_PHRASE_AUTO_DELETE_MS = 60_000;

export async function renderWallet(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const wallets = await deps.prisma.wallet.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  let text = '👛 *Wallet*\n\n';
  const keyboard = new InlineKeyboard();

  if (wallets.length === 0) {
    text += 'You have no wallets yet.';
  } else {
    text += wallets
      .map((w) => `${w.isActive ? '🟢' : '⚪️'} ${escapeMd(w.label)}\n\`${shortKey(w.publicKey)}\``)
      .join('\n\n');

    for (const w of wallets.filter((w) => w.isActive)) {
      keyboard
        .text(`💾 Backup ${w.label}`, `a:wallet:backup:${w.id}`)
        .text(`🗑 Deactivate ${w.label}`, `a:wallet:deactivate:${w.id}`)
        .row();
    }
  }

  keyboard
    .text('➕ Create Wallet', 'a:wallet:create')
    .text('📥 Import Wallet', 'a:wallet:import')
    .row()
    .text('♻️ Restore Wallet', 'a:wallet:restore');

  return { text, keyboard: withNav(keyboard, 'home') };
}

/**
 * Sends the freshly-generated seed phrase as its own message, separate from the
 * wallet screen, with a strong one-time warning. Auto-deletes after a minute as
 * a bonus safety net — best-effort only, since the timer is in-memory and won't
 * survive a bot restart.
 */
async function sendSeedPhraseOnce(ctx: Context, mnemonic: string): Promise<void> {
  const text =
    '🔐 *Save this seed phrase now — it will not be shown again*\n\n' +
    `\`${mnemonic}\`\n\n` +
    'Write it down somewhere offline. Anyone with these words can take everything in this wallet. ' +
    'This message deletes itself in 60 seconds.';
  const sent = await ctx.reply(text, { parse_mode: 'Markdown' });
  setTimeout(() => {
    ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => {});
  }, SEED_PHRASE_AUTO_DELETE_MS);
}

export async function handleCreateWallet(
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
): Promise<ScreenResult> {
  const sealed = generateWallet(deps.encryptionKey);
  const label = `Wallet ${(await deps.prisma.wallet.count({ where: { userId: user.id } })) + 1}`;
  await deps.prisma.wallet.create({
    data: {
      userId: user.id,
      label,
      publicKey: sealed.publicKey,
      encryptedSecret: sealed.encryptedSecret,
    },
  });
  await deps.prisma.auditLog.create({
    data: { userId: user.id, action: 'wallet.create', metadata: { source: 'telegram' } },
  });

  await sendSeedPhraseOnce(ctx, sealed.mnemonic);

  return renderWallet(deps, user);
}

export async function handleDeactivateWallet(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
): Promise<ScreenResult> {
  const wallet = await deps.prisma.wallet.findUnique({ where: { id: walletId } });
  if (wallet && wallet.userId === user.id) {
    await deps.prisma.wallet.update({ where: { id: walletId }, data: { isActive: false } });
  }
  return renderWallet(deps, user);
}

export function importPrompt(): ScreenResult {
  return {
    text:
      '📥 *Import Wallet*\n\nSend the secret key (base58-encoded) of the wallet you want to import.\n\n' +
      '⚠️ Delete your message right after sending it — Telegram keeps chat history, and anyone with this key controls the wallet.',
    keyboard: withNav(new InlineKeyboard(), 'wallet'),
  };
}

export async function applyImportWallet(
  deps: ScreenDeps,
  user: ScreenUser,
  secretKeyBase58: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  let sealed: ReturnType<typeof importWalletFromSecretKey>;
  try {
    sealed = importWalletFromSecretKey(secretKeyBase58.trim(), deps.encryptionKey);
  } catch {
    return {
      ok: false,
      message:
        '⚠️ That secret key is invalid. Send a valid base58 secret key, or ⬅️ Back to cancel.',
    };
  }

  const label = `Wallet ${(await deps.prisma.wallet.count({ where: { userId: user.id } })) + 1}`;
  await deps.prisma.wallet.create({
    data: {
      userId: user.id,
      label,
      publicKey: sealed.publicKey,
      encryptedSecret: sealed.encryptedSecret,
    },
  });
  await deps.prisma.auditLog.create({
    data: { userId: user.id, action: 'wallet.import', metadata: { source: 'telegram' } },
  });

  return { ok: true, result: await renderWallet(deps, user) };
}

export function backupPasswordPrompt(): ScreenResult {
  return {
    text:
      "💾 *Backup Wallet*\n\nSend a password to encrypt this wallet's key (min 8 characters). " +
      "You'll need this exact password to restore it later — it is never saved anywhere.",
    keyboard: withNav(new InlineKeyboard(), 'wallet'),
  };
}

export async function applyBackup(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
  password: string,
): Promise<{ ok: true; filename: string; buffer: Buffer } | { ok: false; message: string }> {
  if (password.length < 8) {
    return { ok: false, message: 'Password must be at least 8 characters. Send a new one.' };
  }
  const wallet = await deps.prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.userId !== user.id) {
    return { ok: false, message: 'That wallet no longer exists.' };
  }

  const secretKeyBase58 = decryptSecret(wallet.encryptedSecret, deps.encryptionKey);
  const backup = createWalletBackup(secretKeyBase58, wallet.publicKey, password);
  await deps.prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'wallet.backup_exported',
      metadata: { walletId: wallet.id, source: 'telegram' },
    },
  });

  return {
    ok: true,
    filename: `nova-wallet-${wallet.label}-backup.json`,
    buffer: Buffer.from(JSON.stringify(backup, null, 2), 'utf8'),
  };
}

export function restoreFilePrompt(): ScreenResult {
  return {
    text: '♻️ *Restore Wallet*\n\nSend the backup file (.json) you exported earlier, as a Telegram document.',
    keyboard: withNav(new InlineKeyboard(), 'wallet'),
  };
}

export function restorePasswordPrompt(): ScreenResult {
  return {
    text: '♻️ *Restore Wallet*\n\nGot the file. Now send the password you used when creating this backup.',
    keyboard: withNav(new InlineKeyboard(), 'wallet'),
  };
}

export async function applyRestore(
  deps: ScreenDeps,
  user: ScreenUser,
  backup: WalletBackup,
  password: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  let secretKeyBase58: string;
  try {
    secretKeyBase58 = restoreWalletBackup(backup, password);
  } catch {
    return {
      ok: false,
      message:
        '⚠️ Incorrect password or corrupted backup file. Send the password again, or ⬅️ Back to cancel.',
    };
  }

  let sealed: ReturnType<typeof importWalletFromSecretKey>;
  try {
    sealed = importWalletFromSecretKey(secretKeyBase58, deps.encryptionKey);
  } catch {
    return { ok: false, message: '⚠️ That backup did not contain a valid wallet key.' };
  }

  // Wallets are soft-deleted (isActive: false), so restoring one you previously
  // removed should reactivate it rather than fail on the unique publicKey constraint.
  const existing = await deps.prisma.wallet.findUnique({ where: { publicKey: sealed.publicKey } });
  if (existing) {
    if (existing.userId !== user.id) {
      return { ok: false, message: 'This wallet has already been added.' };
    }
    if (existing.isActive) {
      return { ok: false, message: 'This wallet is already active.' };
    }
    await deps.prisma.wallet.update({ where: { id: existing.id }, data: { isActive: true } });
    await deps.prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'wallet.restore',
        metadata: { walletId: existing.id, source: 'telegram' },
      },
    });
    return { ok: true, result: await renderWallet(deps, user) };
  }

  const label = `Restored ${(await deps.prisma.wallet.count({ where: { userId: user.id } })) + 1}`;
  const wallet = await deps.prisma.wallet.create({
    data: {
      userId: user.id,
      label,
      publicKey: sealed.publicKey,
      encryptedSecret: sealed.encryptedSecret,
    },
  });
  await deps.prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'wallet.restore',
      metadata: { walletId: wallet.id, source: 'telegram' },
    },
  });

  return { ok: true, result: await renderWallet(deps, user) };
}
