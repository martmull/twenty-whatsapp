FROM node:24-slim AS build
WORKDIR /app
# Baileys pulls libsignal-node straight from GitHub.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
  WHATSAPP_BRIDGE_HOST=0.0.0.0 \
  WHATSAPP_BRIDGE_PORT=8765
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.WHATSAPP_BRIDGE_PORT}/healthz`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
