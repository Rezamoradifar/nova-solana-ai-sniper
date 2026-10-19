FROM node:22-bookworm-slim
WORKDIR /opt/runner
# Only public tracked sources enter this independent image. No host .env or DB mounts.
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY scripts/atomic-arbitrage ./scripts/atomic-arbitrage
ARG RELEASE_SHA
ENV ARB_RELEASE_SHA=$RELEASE_SHA ARB_MODE=off ARB_STATE_DIR=/state
USER node
ENTRYPOINT ["node", "scripts/atomic-arbitrage/engine.mjs"]
CMD ["status"]
