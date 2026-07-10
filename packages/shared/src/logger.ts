import pino from 'pino';

const SECRET_KEY_PATTERN = /(key|token|secret|password|seed|private)/i;

function redactUnknownKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redactUnknownKeys);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redactUnknownKeys(v);
    }
    return out;
  }
  return obj;
}

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        '*.privateKey',
        '*.private_key',
        '*.seedPhrase',
        '*.seed_phrase',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.api_key',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    hooks: {
      logMethod(inputArgs, method) {
        const sanitized = inputArgs.map((arg) =>
          typeof arg === 'object' && arg !== null ? redactUnknownKeys(arg) : arg,
        );
        return method.apply(this, sanitized as Parameters<typeof method>);
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
