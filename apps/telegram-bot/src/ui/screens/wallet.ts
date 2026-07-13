import { InlineKeyboard, InputFile } from 'grammy';
import type { Context } from 'grammy';
import QRCode from 'qrcode';
import { PublicKey } from '@solana/web3.js';
import {
  generateWallet,
  importWalletFromSecretKey,
  decryptSecret,
  createWalletBackup,
  restoreWalletBackup,
  refreshWalletBalance,
  type WalletBackup,
} from '@nova/shared';
import { withNav } from '../keyboards.js';
import { shortKey, escapeMd, sol, lamportsToSol, fmtAgo, fmtDate } from '../format.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const HISTORY_PAGE_SIZE = 10;

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
        .text(`🧾 Deposit ${w.label}`, `a:wallet:deposit:${w.id}`)
        .text(`💾 Backup ${w.label}`, `a:wallet:backup:${w.id}`)
        .row()
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
      walletId: wallet.id,
      action: 'wallet.create',
      metadata: { walletId: wallet.id, source: 'telegram' },
    },
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
    await deps.prisma.auditLog.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        action: 'wallet.deactivate',
        metadata: { walletId: wallet.id, source: 'telegram' },
      },
    });
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
      walletId: wallet.id,
      action: 'wallet.import',
      metadata: { walletId: wallet.id, source: 'telegram' },
    },
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
      walletId: wallet.id,
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
        walletId: existing.id,
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
      walletId: wallet.id,
      action: 'wallet.restore',
      metadata: { walletId: wallet.id, source: 'telegram' },
    },
  });

  return { ok: true, result: await renderWallet(deps, user) };
}

async function loadOwnedWallet(deps: ScreenDeps, user: ScreenUser, walletId: string) {
  const wallet = await deps.prisma.wallet.findUnique({ where: { id: walletId } });
  return wallet && wallet.userId === user.id ? wallet : undefined;
}

/**
 * The Deposit screen — full address in a Markdown code block (Telegram's
 * mobile/desktop clients all offer tap-to-copy on a code span natively, so
 * no custom "Copy Address" button/code is needed here, unlike the
 * dashboard). Balance/last-updated come from Wallet.lastKnownBalanceLamports/
 * balanceUpdatedAt, populated by apps/api's DepositMonitor or by tapping
 * Refresh Balance below (both go through the same @nova/shared
 * refreshWalletBalance helper).
 */
export async function renderDeposit(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
): Promise<ScreenResult> {
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: '⚠️ That wallet no longer exists.',
      keyboard: withNav(new InlineKeyboard(), 'wallet'),
    };
  }

  const text =
    `🧾 *Deposit — ${escapeMd(wallet.label)}*\n\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `Network: Solana Mainnet\n` +
    `Balance: ${sol(lamportsToSol(wallet.lastKnownBalanceLamports))}\n` +
    `Last Updated: ${fmtAgo(wallet.balanceUpdatedAt)}\n\n` +
    `Send only SOL or SPL tokens on Solana to this address. Tap the address above to copy it.`;

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh Balance', `a:wallet:refreshbalance:${wallet.id}`)
    .text('🖼 Show QR', `a:wallet:qr:${wallet.id}`)
    .row()
    .text('🧾 Transaction History', `a:wallet:transactions:${wallet.id}:0`)
    .text('📜 Wallet History', `a:wallet:history:${wallet.id}:0`);

  return { text, keyboard: withNav(keyboard, 'wallet') };
}

export async function handleRefreshBalance(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
): Promise<ScreenResult> {
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: '⚠️ That wallet no longer exists.',
      keyboard: withNav(new InlineKeyboard(), 'wallet'),
    };
  }
  if (!deps.solanaConnection) {
    deps.logger.warn(
      { walletId },
      'refresh balance tapped but no Solana RPC connection is configured',
    );
    return renderDeposit(deps, user, walletId);
  }
  await refreshWalletBalance(
    { prisma: deps.prisma, connection: deps.solanaConnection, logger: deps.logger },
    walletId,
    { source: 'telegram' },
  ).catch((err) => {
    deps.logger.error({ err, walletId }, 'telegram refresh balance failed');
  });
  return renderDeposit(deps, user, walletId);
}

/** Generates and sends the deposit address as a scannable QR photo — a photo
 * message, so this is sent as a fresh reply rather than an inline keyboard
 * edit (see router.ts's handleCardAction for the identical reasoning). */
export async function handleShowQr(
  deps: ScreenDeps,
  user: ScreenUser,
  ctx: Context,
  walletId: string,
): Promise<void> {
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    await ctx.reply('⚠️ That wallet no longer exists.');
    return;
  }
  // Validate before generating — a malformed key would otherwise still
  // produce a "valid" QR code encoding garbage.
  void new PublicKey(wallet.publicKey);
  const png = await QRCode.toBuffer(wallet.publicKey, { type: 'png', width: 512, margin: 2 });
  await ctx.replyWithPhoto(new InputFile(png, `${wallet.label}-deposit-qr.png`), {
    caption: `🖼 *${escapeMd(wallet.label)}* deposit address\n\`${wallet.publicKey}\``,
    parse_mode: 'Markdown',
  });
}

/** "Wallet History" — the compliance/security audit trail for this wallet
 * (create/import/backup/restore/deactivate plus every financial event's
 * paired AuditLog row — see writeLedgerAndAudit in @nova/shared). */
export async function renderWalletHistory(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
  offset: number,
): Promise<ScreenResult> {
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: '⚠️ That wallet no longer exists.',
      keyboard: withNav(new InlineKeyboard(), 'wallet'),
    };
  }
  const entries = await deps.prisma.auditLog.findMany({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    skip: offset,
    take: HISTORY_PAGE_SIZE + 1,
  });
  const hasMore = entries.length > HISTORY_PAGE_SIZE;
  const page = entries.slice(0, HISTORY_PAGE_SIZE);

  const text =
    `📜 *Wallet History — ${escapeMd(wallet.label)}*\n\n` +
    (page.length === 0
      ? 'No history yet.'
      : page
          .map((e) => `${fmtDate(e.createdAt)} — ${escapeMd(e.action)} (${e.status})`)
          .join('\n'));

  const keyboard = new InlineKeyboard()
    .text('🧾 Deposit Screen', `a:wallet:deposit:${wallet.id}`)
    .row();
  if (offset > 0) {
    keyboard.text(
      '⬅️ Newer',
      `a:wallet:history:${wallet.id}:${Math.max(0, offset - HISTORY_PAGE_SIZE)}`,
    );
  }
  if (hasMore) {
    keyboard.text('➡️ Older', `a:wallet:history:${wallet.id}:${offset + HISTORY_PAGE_SIZE}`);
  }

  return { text, keyboard: withNav(keyboard, 'wallet') };
}

/** "Transaction History" — the financial ledger for this wallet (deposits,
 * admin-recorded withdrawals). Profit/referral/owner-fee entries are
 * user-scoped rather than wallet-scoped (see registerFeeSystem.ts) and
 * don't appear here. */
export async function renderTransactionHistory(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
  offset: number,
): Promise<ScreenResult> {
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: '⚠️ That wallet no longer exists.',
      keyboard: withNav(new InlineKeyboard(), 'wallet'),
    };
  }
  const entries = await deps.prisma.ledgerEntry.findMany({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    skip: offset,
    take: HISTORY_PAGE_SIZE + 1,
  });
  const hasMore = entries.length > HISTORY_PAGE_SIZE;
  const page = entries.slice(0, HISTORY_PAGE_SIZE);

  const text =
    `🧾 *Transaction History — ${escapeMd(wallet.label)}*\n\n` +
    (page.length === 0
      ? 'No transactions yet.'
      : page
          .map((e) => {
            const sign = e.direction === 'CREDIT' ? '+' : '-';
            const amount =
              e.asset === 'SOL'
                ? sol(lamportsToSol(e.amountLamports))
                : `$${(e.amountUsd ?? 0).toFixed(2)}`;
            return `${fmtDate(e.createdAt)} — ${e.type} ${sign}${amount}`;
          })
          .join('\n'));

  const keyboard = new InlineKeyboard()
    .text('🧾 Deposit Screen', `a:wallet:deposit:${wallet.id}`)
    .row();
  if (offset > 0) {
    keyboard.text(
      '⬅️ Newer',
      `a:wallet:transactions:${wallet.id}:${Math.max(0, offset - HISTORY_PAGE_SIZE)}`,
    );
  }
  if (hasMore) {
    keyboard.text('➡️ Older', `a:wallet:transactions:${wallet.id}:${offset + HISTORY_PAGE_SIZE}`);
  }

  return { text, keyboard: withNav(keyboard, 'wallet') };
}
