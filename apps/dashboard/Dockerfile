# Build context is the repo root: docker build -f apps/dashboard/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/telegram-bot/package.json apps/telegram-bot/package.json
COPY apps/marketing-engine/package.json apps/marketing-engine/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/miniapp/package.json apps/miniapp/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN npm ci

COPY apps/dashboard ./apps/dashboard
COPY apps/miniapp ./apps/miniapp

# Relative path: nginx proxies /api/ to the api service and strips the prefix,
# so the browser calls same-origin /api/... regardless of the public domain.
ENV VITE_API_BASE_URL=/api
# Must run as the workspace script (not a bare `npx vite`/`npx tsc` from /repo):
# npm sets cwd to apps/dashboard for `--workspace` scripts, which is what makes
# both the nested vite@6 (root node_modules has an unrelated vite@5 from
# vitest) and the local tailwind.config.js content globs resolve correctly.
RUN npm run build --workspace apps/dashboard
# Telegram Mini App, served under /app/ (its vite base).
RUN npm run build --workspace apps/miniapp

# ---- runtime: nginx serving the static build + reverse-proxying /api ----
FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
COPY --from=build /repo/apps/miniapp/dist /usr/share/nginx/html/app
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80 443
