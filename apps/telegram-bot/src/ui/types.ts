import type { PrismaClient, User } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { InlineKeyboard } from 'grammy';

export type ScreenId =
  | 'home'
  | 'sniper_start'
  | 'sniper_stop'
  | 'wallet'
  | 'dashboard'
  | 'positions'
  | 'trades'
  | 'leaderboard'
  | 'alerts'
  | 'settings'
  | 'profile'
  | 'portfolio'
  | 'referrals'
  | 'help';

export interface ScreenDeps {
  prisma: PrismaClient;
  encryptionKey: string;
  logger: Logger;
  botUsername?: string;
}

export interface ScreenResult {
  text: string;
  keyboard: InlineKeyboard;
}

export type ScreenUser = User;
