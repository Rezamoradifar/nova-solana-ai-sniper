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
import { getLocale, t, type Locale } from '../../i18n/index.js';
import type { ScreenDeps, ScreenResult, ScreenUser } from '../types.js';

const HISTORY_PAGE_SIZE = 10;

const SEED_PHRASE_AUTO_DELETE_MS = 60_000;

export async function renderWallet(deps: ScreenDeps, user: ScreenUser): Promise<ScreenResult> {
  const lang = getLocale(user);
  const d = t(lang).wallet;
  const wallets = await deps.prisma.wallet.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  let text = d.title;
  const keyboard = new InlineKeyboard();

  if (wallets.length === 0) {
    text += d.noWallets;
  } else {
    text += wallets
      .map((w) => d.walletRow(w.isActive ? '🟢' : '⚪️', escapeMd(w.label), shortKey(w.publicKey)))
      .join('\n\n');

    for (const w of wallets.filter((w) => w.isActive)) {
      keyboard
        .text(d.depositBtn(w.label), `a:wallet:deposit:${w.id}`)
        .text(d.backupBtn(w.label), `a:wallet:backup:${w.id}`)
        .row()
        .text(d.deactivateBtn(w.label), `a:wallet:deactivate:${w.id}`)
        .row();
    }
  }

  keyboard
    .text(d.createWalletBtn, 'a:wallet:create')
    .text(d.importWalletBtn, 'a:wallet:import')
    .row()
    .text(d.restoreWalletBtn, 'a:wallet:restore');

  return { text, keyboard: withNav(keyboard, 'home', lang) };
}

/**
 * Sends the freshly-generated seed phrase as its own message, separate from the
 * wallet screen, with a strong one-time warning. Auto-deletes after a minute as
 * a bonus safety net — best-effort only, since the timer is in-memory and won't
 * survive a bot restart.
 */
async function sendSeedPhraseOnce(ctx: Context, mnemonic: string, lang: Locale): Promise<void> {
  const text = t(lang).wallet.seedPhraseWarning(mnemonic);
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

  await sendSeedPhraseOnce(ctx, sealed.mnemonic, getLocale(user));

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

export function importPrompt(lang: Locale): ScreenResult {
  return {
    text: t(lang).wallet.importPromptText,
    keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
  };
}

export async function applyImportWallet(
  deps: ScreenDeps,
  user: ScreenUser,
  secretKeyBase58: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const lang = getLocale(user);
  const d = t(lang).wallet;
  let sealed: ReturnType<typeof importWalletFromSecretKey>;
  try {
    sealed = importWalletFromSecretKey(secretKeyBase58.trim(), deps.encryptionKey);
  } catch {
    return { ok: false, message: d.invalidSecretKey };
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

export function backupPasswordPrompt(lang: Locale): ScreenResult {
  return {
    text: t(lang).wallet.backupPasswordPromptText,
    keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
  };
}

export async function applyBackup(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
  password: string,
): Promise<{ ok: true; filename: string; buffer: Buffer } | { ok: false; message: string }> {
  const lang = getLocale(user);
  const d = t(lang).wallet;
  if (password.length < 8) {
    return { ok: false, message: d.passwordTooShort };
  }
  const wallet = await deps.prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.userId !== user.id) {
    return { ok: false, message: d.walletGoneNoEmoji };
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

export function restoreFilePrompt(lang: Locale): ScreenResult {
  return {
    text: t(lang).wallet.restoreFilePromptText,
    keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
  };
}

export function restorePasswordPrompt(lang: Locale): ScreenResult {
  return {
    text: t(lang).wallet.restorePasswordPromptText,
    keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
  };
}

export async function applyRestore(
  deps: ScreenDeps,
  user: ScreenUser,
  backup: WalletBackup,
  password: string,
): Promise<{ ok: true; result: ScreenResult } | { ok: false; message: string }> {
  const lang = getLocale(user);
  const d = t(lang).wallet;
  let secretKeyBase58: string;
  try {
    secretKeyBase58 = restoreWalletBackup(backup, password);
  } catch {
    return { ok: false, message: d.incorrectPasswordOrCorrupted };
  }

  let sealed: ReturnType<typeof importWalletFromSecretKey>;
  try {
    sealed = importWalletFromSecretKey(secretKeyBase58, deps.encryptionKey);
  } catch {
    return { ok: false, message: d.invalidBackupKey };
  }

  // Wallets are soft-deleted (isActive: false), so restoring one you previously
  // removed should reactivate it rather than fail on the unique publicKey constraint.
  const existing = await deps.prisma.wallet.findUnique({ where: { publicKey: sealed.publicKey } });
  if (existing) {
    if (existing.userId !== user.id) {
      return { ok: false, message: d.alreadyAdded };
    }
    if (existing.isActive) {
      return { ok: false, message: d.alreadyActive };
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
  const lang = getLocale(user);
  const d = t(lang).wallet;
  const c = t(lang).common;
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: c.walletGone,
      keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
    };
  }

  const text =
    d.depositTitle(escapeMd(wallet.label)) +
    d.depositBody(
      wallet.publicKey,
      d.network,
      sol(lamportsToSol(wallet.lastKnownBalanceLamports)),
      fmtAgo(wallet.balanceUpdatedAt),
    );

  const keyboard = new InlineKeyboard()
    .text(d.refreshBalanceBtn, `a:wallet:refreshbalance:${wallet.id}`)
    .text(d.showQrBtn, `a:wallet:qr:${wallet.id}`)
    .row()
    .text(d.transactionHistoryBtn, `a:wallet:transactions:${wallet.id}:0`)
    .text(d.walletHistoryBtn, `a:wallet:history:${wallet.id}:0`);

  return { text, keyboard: withNav(keyboard, 'wallet', lang) };
}

export async function handleRefreshBalance(
  deps: ScreenDeps,
  user: ScreenUser,
  walletId: string,
): Promise<ScreenResult> {
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: t(getLocale(user)).common.walletGone,
      keyboard: withNav(new InlineKeyboard(), 'wallet', getLocale(user)),
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
  const lang = getLocale(user);
  const d = t(lang).wallet;
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    await ctx.reply(t(lang).common.walletGone);
    return;
  }
  // Validate before generating — a malformed key would otherwise still
  // produce a "valid" QR code encoding garbage.
  void new PublicKey(wallet.publicKey);
  const png = await QRCode.toBuffer(wallet.publicKey, { type: 'png', width: 512, margin: 2 });
  await ctx.replyWithPhoto(new InputFile(png, `${wallet.label}-deposit-qr.png`), {
    caption: d.qrCaption(escapeMd(wallet.label), wallet.publicKey),
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
  const lang = getLocale(user);
  const d = t(lang).wallet;
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: t(lang).common.walletGone,
      keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
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
    d.walletHistoryTitle(escapeMd(wallet.label)) +
    (page.length === 0
      ? d.noHistoryYet
      : page
          .map((e) => d.historyRow(fmtDate(e.createdAt), escapeMd(e.action), e.status))
          .join('\n'));

  const keyboard = new InlineKeyboard()
    .text(d.depositScreenBtn, `a:wallet:deposit:${wallet.id}`)
    .row();
  if (offset > 0) {
    keyboard.text(
      d.newerBtn,
      `a:wallet:history:${wallet.id}:${Math.max(0, offset - HISTORY_PAGE_SIZE)}`,
    );
  }
  if (hasMore) {
    keyboard.text(d.olderBtn, `a:wallet:history:${wallet.id}:${offset + HISTORY_PAGE_SIZE}`);
  }

  return { text, keyboard: withNav(keyboard, 'wallet', lang) };
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
  const lang = getLocale(user);
  const d = t(lang).wallet;
  const wallet = await loadOwnedWallet(deps, user, walletId);
  if (!wallet) {
    return {
      text: t(lang).common.walletGone,
      keyboard: withNav(new InlineKeyboard(), 'wallet', lang),
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
    d.transactionHistoryTitle(escapeMd(wallet.label)) +
    (page.length === 0
      ? d.noTransactionsYet
      : page
          .map((e) => {
            const sign = e.direction === 'CREDIT' ? '+' : '-';
            const amount =
              e.asset === 'SOL'
                ? sol(lamportsToSol(e.amountLamports))
                : `$${(e.amountUsd ?? 0).toFixed(2)}`;
            return d.transactionRow(fmtDate(e.createdAt), e.type, sign, amount);
          })
          .join('\n'));

  const keyboard = new InlineKeyboard()
    .text(d.depositScreenBtn, `a:wallet:deposit:${wallet.id}`)
    .row();
  if (offset > 0) {
    keyboard.text(
      d.newerBtn,
      `a:wallet:transactions:${wallet.id}:${Math.max(0, offset - HISTORY_PAGE_SIZE)}`,
    );
  }
  if (hasMore) {
    keyboard.text(d.olderBtn, `a:wallet:transactions:${wallet.id}:${offset + HISTORY_PAGE_SIZE}`);
  }

  return { text, keyboard: withNav(keyboard, 'wallet', lang) };
}
