FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY playwright.config.ts ./
COPY scripts/build-runtime.mjs ./scripts/build-runtime.mjs
COPY public ./public
RUN npm run build && node scripts/build-runtime.mjs

FROM node:24.19.0-bookworm-slim
WORKDIR /opt/tradiative
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /var/lib/tradiative && chown node:node /var/lib/tradiative
COPY --from=build /app/runtime/server ./server
COPY --from=build /app/dist ./dist
USER node
ENV NODE_ENV=production PORT=3000 TRADIATIVE_CHATGPT_MODE=personal-vm TRADIATIVE_AUTH_DIR=/var/lib/tradiative TRADIATIVE_BIND_ADDRESS=0.0.0.0 TRADIATIVE_ALLOW_SEPARATE_API=false
CMD ["node","server/index.mjs"]
