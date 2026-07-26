
// PM2 process manager config for bare-metal/VPS deployments (no Docker).
// Usage: npm run build && pm2 start ecosystem.config.cjs
// For Docker deployments, use docker-compose.yml instead — Compose's restart
// policy + healthchecks cover the same "restart on crash" requirement there,
// so PM2 is not run a second time inside containers.
const path = require('path');

// PM2 spawns each script's process directly (no npm/shell in between), so
// nothing here sources the repo-root .env the way `npm run dev:*` does (via
// dotenv-cli) or docker-compose does (via `env_file`) — same gap as the one
// already fixed for local dev in the "local dev scripts never loaded .env"
// commit, just never ported to this third path. `-r dotenv/config` preloads
// it before each app's own entrypoint runs.
const DOTENV_PATH = path.join(__dirname, '.env');

module.exports = {
  apps: [
    {
      name: 'nova-api',
      exec_mode: 'fork',
      cwd: __dirname,
      script: 'apps/api/dist/server.js',
      node_args: '-r dotenv/config',
      instances: 1,
      autorestart: true,
      // nova-telegram-bot/nova-marketing-engine deliberately exit 0 (not crash)
      // when their required credentials aren't configured — "exit cleanly rather
      // than crash-loop" per their own source comments. Without this, PM2 can't
      // tell a clean intentional exit from a real crash and burns through
      // max_restarts on every boot, which reads as flapping in `pm2 list` even
      // though nothing is actually wrong.
      stop_exit_codes: [0],
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production', DOTENV_CONFIG_PATH: DOTENV_PATH },
      out_file: 'logs/api.out.log',
      error_file: 'logs/api.error.log',
    },
    {
      name: 'nova-telegram-bot',
      exec_mode: 'fork',
      cwd: __dirname,
      script: 'apps/telegram-bot/dist/index.js',
      node_args: '-r dotenv/config',
      instances: 1,
      autorestart: true,
      // nova-telegram-bot/nova-marketing-engine deliberately exit 0 (not crash)
      // when their required credentials aren't configured — "exit cleanly rather
      // than crash-loop" per their own source comments. Without this, PM2 can't
      // tell a clean intentional exit from a real crash and burns through
      // max_restarts on every boot, which reads as flapping in `pm2 list` even
      // though nothing is actually wrong.
      stop_exit_codes: [0],
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production', DOTENV_CONFIG_PATH: DOTENV_PATH },
      out_file: 'logs/telegram-bot.out.log',
      error_file: 'logs/telegram-bot.error.log',
    },
    {
      name: 'nova-marketing-engine',
      exec_mode: 'fork',
      cwd: __dirname,
      script: 'apps/marketing-engine/dist/index.js',
      node_args: '-r dotenv/config',
      instances: 1,
      autorestart: true,
      // nova-telegram-bot/nova-marketing-engine deliberately exit 0 (not crash)
      // when their required credentials aren't configured — "exit cleanly rather
      // than crash-loop" per their own source comments. Without this, PM2 can't
      // tell a clean intentional exit from a real crash and burns through
      // max_restarts on every boot, which reads as flapping in `pm2 list` even
      // though nothing is actually wrong.
      stop_exit_codes: [0],
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production', DOTENV_CONFIG_PATH: DOTENV_PATH },
      out_file: 'logs/marketing-engine.out.log',
      error_file: 'logs/marketing-engine.error.log',
    },
  ],
};
