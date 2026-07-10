import { describe, expect, it } from 'vitest';
import { envSchema, loadEnv } from './env.js';

const REQUIRED_BASE = {
  DATABASE_URL: 'postgres://localhost/test',
  REDIS_URL: 'redis://localhost',
  JWT_SECRET: 'a'.repeat(16),
  ENCRYPTION_KEY: 'a'.repeat(32),
} as const;

const baseSchemaShape = {
  DATABASE_URL: true,
  REDIS_URL: true,
  JWT_SECRET: true,
  ENCRYPTION_KEY: true,
} as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const original = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

describe('loadEnv', () => {
  it('accepts an absent optional URL field', () => {
    withEnv({ ...REQUIRED_BASE, COMMUNITY_URL: undefined }, () => {
      const parsed = loadEnv(envSchema.pick({ ...baseSchemaShape, COMMUNITY_URL: true }));
      expect(parsed.COMMUNITY_URL).toBeUndefined();
    });
  });

  it('accepts an optional URL field left blank ("KEY=" in .env), same as if it were absent', () => {
    // This is how operators naturally spell "not configured yet" — dotenv loads
    // it as "", not undefined. Previously this failed the .url() shape check
    // instead of being treated as not-set, crashing marketing-engine at boot.
    withEnv({ ...REQUIRED_BASE, COMMUNITY_URL: '' }, () => {
      const parsed = loadEnv(envSchema.pick({ ...baseSchemaShape, COMMUNITY_URL: true }));
      expect(parsed.COMMUNITY_URL).toBeUndefined();
    });
  });

  it('still rejects a required field that is blank', () => {
    withEnv({ ...REQUIRED_BASE, DATABASE_URL: '' }, () => {
      expect(() => loadEnv(envSchema.pick(baseSchemaShape))).toThrow(
        /Invalid environment configuration/,
      );
    });
  });

  it('still rejects a genuinely malformed (non-blank) optional URL', () => {
    withEnv({ ...REQUIRED_BASE, COMMUNITY_URL: 'not-a-url' }, () => {
      expect(() => loadEnv(envSchema.pick({ ...baseSchemaShape, COMMUNITY_URL: true }))).toThrow();
    });
  });
});
