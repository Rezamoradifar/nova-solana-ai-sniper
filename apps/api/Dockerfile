# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++ libc6-compat openssl
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/telegram-bot/package.json apps/telegram-bot/package.json
COPY apps/marketing-engine/package.json apps/marketing-engine/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN npm ci

# ---- build (still has devDependencies — this is the stage docker-compose's
# `migrate` service targets, since it needs the `prisma` CLI) ----
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/telegram-bot ./apps/telegram-bot

RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npx tsc -b packages/shared packages/ai apps/telegram-bot apps/api

# ---- prod-deps (prune devDependencies for the slim runtime image) ----
FROM build AS prod-deps
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl dumb-init fontconfig font-dejavu
COPY apps/marketing-engine/assets/fonts/ /usr/share/fonts/gsp/
RUN fc-cache -f
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/ai/dist ./packages/ai/dist
COPY --from=build /repo/packages/ai/package.json ./packages/ai/package.json
COPY --from=build /repo/apps/telegram-bot/dist ./apps/telegram-bot/dist
COPY --from=build /repo/apps/telegram-bot/package.json ./apps/telegram-bot/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
