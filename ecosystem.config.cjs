// PM2 process manager config for bare-metal/VPS deployments (no Docker).
// Usage: npm run build && pm2 start ecosystem.config.cjs
// For Docker deployments, use docker-compose.yml instead — Compose's restart
// policy + healthchecks cover the same "restart on crash" requirement there,
// so PM2 is not run a second time inside containers.
module.exports = {
  apps: [
    {
      name: 'nova-api',
      cwd: __dirname,
      script: 'apps/api/dist/server.js',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
      out_file: 'logs/api.out.log',
      error_file: 'logs/api.error.log',
    },
    {
      name: 'nova-telegram-bot',
      cwd: __dirname,
      script: 'apps/telegram-bot/dist/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production' },
      out_file: 'logs/telegram-bot.out.log',
      error_file: 'logs/telegram-bot.error.log',
    },
    {
      name: 'nova-marketing-engine',
      cwd: __dirname,
      script: 'apps/marketing-engine/dist/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production' },
      out_file: 'logs/marketing-engine.out.log',
      error_file: 'logs/marketing-engine.error.log',
    },
  ],
};
