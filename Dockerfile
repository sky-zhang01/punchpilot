# =============================================================================
# Stage 1: Builder — compile native addons (better-sqlite3) and build client
# =============================================================================
FROM node:24-slim AS builder

WORKDIR /app

# Install build tools needed for better-sqlite3 native compilation
# hadolint ignore=DL3008
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Server dependencies (with native addons compiled here)
COPY package*.json ./
RUN npm ci

# Client dependencies
COPY client/package*.json ./client/
WORKDIR /app/client
RUN npm ci

# Copy source and build client
WORKDIR /app
COPY . .
WORKDIR /app/client
RUN npm run build

WORKDIR /app

# =============================================================================
# Stage 2: Runtime — slim image with only Chromium (no Firefox/WebKit)
# =============================================================================
FROM node:24-slim

LABEL org.opencontainers.image.title="PunchPilot" \
      org.opencontainers.image.description="Smart attendance automation for freee HR" \
      org.opencontainers.image.version="0.4.14" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sky-zhang01/punchpilot"

WORKDIR /app

ENV TZ=Asia/Tokyo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install gosu (privilege dropping) + CJK fonts
# hadolint ignore=DL3008
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    gosu \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled node_modules (with native better-sqlite3) from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy built client (only the dist output, not node_modules)
COPY --from=builder /app/client/dist ./client/dist

# Copy server source files
COPY server/ ./server/
COPY docker-entrypoint.sh /docker-entrypoint.sh

# Install Chromium + its system dependencies in one step
# --with-deps lets Playwright install the correct packages for the current distro
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN chmod +x /docker-entrypoint.sh \
    && npx playwright install --with-deps chromium \
    && mkdir -p /app/data /app/logs /app/screenshots /app/keystore

EXPOSE 8681

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
