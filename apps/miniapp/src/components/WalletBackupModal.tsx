import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { haptics } from '../lib/telegram.js';
import { Button, Input, Modal } from './ui/index.js';
import type { WalletBackupFile } from '../lib/types.js';

export interface WalletBackupModalProps {
  walletId: string | null;
  walletLabel: string;
  onOpenChange: (open: boolean) => void;
}

function downloadBackup(backup: WalletBackupFile, label: string) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nova-wallet-backup-${label.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Real POST /wallets/:id/backup — AES-256-GCM-encrypted with a
 * user-chosen password (independent of the server's own encryption key);
 * the plaintext secret never leaves the API handler. Downloads the
 * resulting file client-side; nothing is uploaded anywhere else. */
export function WalletBackupModal({ walletId, walletLabel, onOpenChange }: WalletBackupModalProps) {
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!walletId) throw new Error('No wallet selected');
      return api.post<WalletBackupFile>(`/wallets/${walletId}/backup`, { password });
    },
    onSuccess: (backup) => {
      haptics.success();
      downloadBackup(backup, walletLabel);
      setPassword('');
      onOpenChange(false);
    },
    onError: () => haptics.error(),
  });

  const open = walletId !== null;
  const passwordTooShort = password.length > 0 && password.length < 8;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPassword('');
          mutation.reset();
        }
        onOpenChange(next);
      }}
      title={`Back up ${walletLabel}`}
      description="Choose a password to encrypt this wallet's key into a downloadable file. You'll need this exact password to restore it later — it isn't stored anywhere."
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Backup password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          error={passwordTooShort ? 'Must be at least 8 characters' : undefined}
        />
        {mutation.isError && (
          <p className="text-sm text-danger">
            {mutation.error instanceof ApiError
              ? mutation.error.message
              : 'Backup failed — check your connection and try again.'}
          </p>
        )}
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            loading={mutation.isPending}
            disabled={password.length < 8}
            onClick={() => mutation.mutate()}
          >
            Download backup
          </Button>
        </div>
      </div>
    </Modal>
  );
}
