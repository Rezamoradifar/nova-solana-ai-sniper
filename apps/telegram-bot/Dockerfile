# Build context is the repo root: docker build -f apps/telegram-bot/Dockerfile .
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/telegram-bot/package.json apps/telegram-bot/package.json
COPY apps/marketing-engine/package.json apps/marketing-engine/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/telegram-bot ./apps/telegram-bot
COPY apps/api/prisma ./apps/api/prisma

RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npx tsc -b packages/shared apps/telegram-bot
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl dumb-init fontconfig font-dejavu
COPY apps/marketing-engine/assets/fonts/ /usr/share/fonts/gsp/
RUN fc-cache -f
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/apps/telegram-bot/dist ./apps/telegram-bot/dist
COPY --from=build /repo/apps/telegram-bot/package.json ./apps/telegram-bot/package.json

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/telegram-bot/dist/index.js"]
