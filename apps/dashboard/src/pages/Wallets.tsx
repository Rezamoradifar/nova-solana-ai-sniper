import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { CopyButton } from '../components/CopyButton.js';
import type { Wallet, WalletCreateResult, WalletBackupFile } from '../lib/types.js';
import { useLanguage } from '../lib/LanguageContext.js';
import { safeReturnPath } from '../lib/returnPath.js';

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Full-screen overlay so a freshly-generated seed phrase can't be missed or skimmed past. */
function SeedPhraseModal({
  mnemonic,
  onAcknowledge,
}: {
  mnemonic: string;
  onAcknowledge: () => void;
}) {
  const { t: localize } = useLanguage();
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="card max-w-lg space-y-4">
        <h2 className="text-lg font-semibold text-white">{localize('Save your seed phrase')}</h2>
        <p className="text-sm text-slate-400">
          {localize('This is the') + ' '}
          <strong>{localize('only time')}</strong>
          {' ' +
            localize(
              'this seed phrase will ever be shown. Anyone with it can take everything in this wallet. Write it down and store it offline — it is never saved on this server.',
            )}
        </p>
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-surface-border bg-surface p-4 font-mono text-sm text-slate-100">
          {mnemonic.split(' ').map((word, i) => (
            <div key={i}>
              <span className="mr-1 text-slate-500">{i + 1}.</span>
              {word}
            </div>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="h-4 w-4"
          />
          {localize("I've saved this seed phrase somewhere safe")}
        </label>
        <button disabled={!confirmed} onClick={onAcknowledge} className="btn-primary w-full">
          {localize('Done')}
        </button>
      </div>
    </div>
  );
}

function BackupModal({
  wallet,
  onClose,
  onDone,
}: {
  wallet: Wallet;
  onClose: () => void;
  onDone: (backup: WalletBackupFile) => void;
}) {
  const { t: localize } = useLanguage();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const backup = await api.post<WalletBackupFile>(`/wallets/${wallet.id}/backup`, { password });
      onDone(backup);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="card w-full max-w-sm space-y-4">
        <h2 className="text-lg font-semibold text-white">
          {localize('Backup "')}
          {wallet.label}"
        </h2>
        <p className="text-sm text-slate-400">
          {localize(
            "Choose a password to encrypt this wallet's key (AES-256-GCM). You'll need the same password to restore it later — it is not saved anywhere.",
          )}
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label">{localize('Backup password')}</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              type="password"
              className="input-field"
              placeholder={localize('At least 8 characters')}
            />
          </div>
          {error && <div className="text-sm text-loss">{error}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              {localize('Cancel')}
            </button>
            <button type="submit" disabled={submitting} className="btn-primary flex-1">
              {localize('Download backup')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Wallets() {
  const { t: localize } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state?.returnTo);
  const { data: wallets, error: pollError } = usePolling(
    () => api.get<Wallet[]>('/wallets'),
    10000,
  );
  const [label, setLabel] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [revealMnemonic, setRevealMnemonic] = useState<string | undefined>();
  const [backupTarget, setBackupTarget] = useState<Wallet | undefined>();

  const [restoreLabel, setRestoreLabel] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | undefined>();
  const [restoreError, setRestoreError] = useState<string | undefined>();
  const [restoreNotice, setRestoreNotice] = useState<string | undefined>();
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (mode === 'create') {
        const created = await api.post<WalletCreateResult>('/wallets', { label });
        if (created.mnemonic) setRevealMnemonic(created.mnemonic);
        setNotice('Wallet created. Its private key is encrypted at rest and never shown here.');
      } else {
        await api.post('/wallets/import', { label, secretKeyBase58: secretKey });
        setNotice('Wallet imported and encrypted at rest.');
      }
      setLabel('');
      setSecretKey('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(id: string) {
    await api.del(`/wallets/${id}`);
  }

  async function onRestoreSubmit(e: FormEvent) {
    e.preventDefault();
    if (!restoreFile) return;
    setRestoreSubmitting(true);
    setRestoreError(undefined);
    setRestoreNotice(undefined);
    try {
      const text = await restoreFile.text();
      const backup = JSON.parse(text) as WalletBackupFile;
      await api.post('/wallets/restore', {
        label: restoreLabel,
        password: restorePassword,
        backup,
      });
      setRestoreNotice('Wallet restored and encrypted at rest.');
      setRestoreLabel('');
      setRestorePassword('');
      setRestoreFile(undefined);
    } catch (err) {
      setRestoreError(
        err instanceof ApiError ? err.message : 'Invalid backup file or unexpected error',
      );
    } finally {
      setRestoreSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">{localize('Wallets')}</h1>
      {returnTo.startsWith('/copy-trading') && (
        <Link className="text-accent text-sm" to={returnTo}>
          {localize('Return to copy setup', 'بازگشت به تنظیم کپی')} ↗
        </Link>
      )}

      {revealMnemonic && (
        <SeedPhraseModal
          mnemonic={revealMnemonic}
          onAcknowledge={() => setRevealMnemonic(undefined)}
        />
      )}

      {backupTarget && (
        <BackupModal
          wallet={backupTarget}
          onClose={() => setBackupTarget(undefined)}
          onDone={(backup) => {
            downloadJson(`nova-wallet-${backupTarget.label}-backup.json`, backup);
            setBackupTarget(undefined);
          }}
        />
      )}

      <div className="flex flex-wrap gap-6">
        <div className="card max-w-lg flex-1">
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setMode('create')}
              className={mode === 'create' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            >
              {localize('Generate new')}
            </button>
            <button
              onClick={() => setMode('import')}
              className={mode === 'import' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            >
              {localize('Import existing')}
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="label">{localize('Label')}</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                className="input-field"
                placeholder={localize('Main trading wallet')}
              />
            </div>
            {mode === 'import' && (
              <div>
                <label className="label">{localize('Private key (base58)')}</label>
                <input
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  required
                  type="password"
                  className="input-field"
                  placeholder={localize('Never shared or logged — encrypted at rest immediately')}
                />
              </div>
            )}
            {error && <div className="text-sm text-loss">{error}</div>}
            {notice && <div className="text-sm text-profit">{notice}</div>}
            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {mode === 'create' ? localize('Generate wallet') : localize('Import wallet')}
            </button>
          </form>
        </div>

        <div className="card max-w-lg flex-1">
          <h2 className="mb-4 text-sm font-semibold text-white">
            {localize('Restore from backup')}
          </h2>
          <form onSubmit={onRestoreSubmit} className="space-y-3">
            <div>
              <label className="label">{localize('Label')}</label>
              <input
                value={restoreLabel}
                onChange={(e) => setRestoreLabel(e.target.value)}
                required
                className="input-field"
                placeholder={localize('Restored wallet')}
              />
            </div>
            <div>
              <label className="label">{localize('Backup file')}</label>
              <input
                type="file"
                accept="application/json"
                onChange={(e) => setRestoreFile(e.target.files?.[0])}
                required
                className="input-field"
              />
            </div>
            <div>
              <label className="label">{localize('Backup password')}</label>
              <input
                value={restorePassword}
                onChange={(e) => setRestorePassword(e.target.value)}
                required
                type="password"
                className="input-field"
                placeholder={localize('The password used to create this backup')}
              />
            </div>
            {restoreError && <div className="text-sm text-loss">{restoreError}</div>}
            {restoreNotice && <div className="text-sm text-profit">{restoreNotice}</div>}
            <button type="submit" disabled={restoreSubmitting} className="btn-primary w-full">
              {localize('Restore wallet')}
            </button>
          </form>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>{localize('Label')}</th>
              <th>{localize('Public Key')}</th>
              <th>{localize('Status')}</th>
              <th>{localize('Created')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(wallets ?? []).map((wallet) => (
              <tr
                key={wallet.id}
                onClick={() => navigate(`/dashboard/wallets/${wallet.id}`)}
                className="cursor-pointer hover:bg-surface-hover"
              >
                <td>{wallet.label}</td>
                <td className="font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <span>{wallet.publicKey}</span>
                    <span onClick={(e) => e.stopPropagation()}>
                      <CopyButton text={wallet.publicKey} />
                    </span>
                  </div>
                </td>
                <td>{wallet.isActive ? localize('Active') : localize('Disabled')}</td>
                <td>{new Date(wallet.createdAt).toLocaleDateString()}</td>
                <td className="space-x-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => setBackupTarget(wallet)}
                    className="text-xs text-accent hover:underline"
                  >
                    {localize('Backup')}
                  </button>
                  <button
                    onClick={() => onRemove(wallet.id)}
                    className="text-xs text-loss hover:underline"
                  >
                    {localize('Remove')}
                  </button>
                </td>
              </tr>
            ))}
            {wallets?.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-500">
                  {localize('No wallets yet.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pollError && <div className="mt-2 text-xs text-loss">{pollError.message}</div>}
      </div>
    </div>
  );
}
