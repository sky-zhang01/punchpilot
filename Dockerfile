# =============================================================================
# Stage 1: Shared npm CLI base
# =============================================================================
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS npm-base

WORKDIR /tmp
ADD --checksum=sha256:6666b48816b39b86c3febac7b51a4ee4de6c5ca589c382ad8004b6b113f86677 \
    https://registry.npmjs.org/npm/-/npm-12.2.0.tgz /tmp/npm-12.2.0.tgz
RUN npm_archive_sha512="$(sha512sum /tmp/npm-12.2.0.tgz)" \
    && test "${npm_archive_sha512%% *}" = \
      '66c2632a94e796649738b2d7894d710c2cc2e1696893823066687f6b0d8a52e5f2b54eeaeaa32ffdc513ecca1e49ff794a5c2ec3f9515d879f1b3182b291cf35' \
    && npm install --global /tmp/npm-12.2.0.tgz \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --allow-directory=none \
      --allow-file=all \
      --allow-git=none \
      --allow-remote=none \
    && rm -f /tmp/npm-12.2.0.tgz \
    && test "$(npm --version)" = '12.2.0'

# =============================================================================
# Stage 2: Server dependencies and Chromium
# =============================================================================
FROM npm-base AS server-builder

WORKDIR /app

# Server dependencies (native addons include reviewed platform prebuilds)
COPY package*.json .npmrc ./
RUN npm ci --ignore-scripts \
    && npm prune --omit=dev --ignore-scripts

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN ./node_modules/.bin/playwright install --only-shell chromium

# =============================================================================
# Stage 3: Client build
# =============================================================================
FROM npm-base AS client-builder

WORKDIR /app/client
COPY client/package*.json client/.npmrc ./
RUN npm ci --ignore-scripts
COPY client/ ./
COPY shared/ ../shared/
RUN npm run build

# =============================================================================
# Stage 4: Runtime - slim image with only Chromium (no Firefox/WebKit)
# =============================================================================
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="PunchPilot" \
      org.opencontainers.image.description="Smart attendance automation for freee HR" \
      org.opencontainers.image.version="0.5.0" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sky-zhang01/punchpilot"

WORKDIR /app

ADD --checksum=sha256:bbf13c9326764d05e37e6590debdaa6f33af6bd822e3ca1204789d9d1dc23b11 \
    https://deb.debian.org/debian/pool/main/s/sqlite3/libsqlite3-0_3.53.4-2_amd64.deb \
    /tmp/libsqlite3-0_3.53.4-2_amd64.deb
ADD --checksum=sha256:e417fb0642502c090d84a6f5fce1a2e5961dfe18644415ddce77a1a67cd2fc89 \
    https://deb.debian.org/debian/pool/main/s/sqlite3/libsqlite3-0_3.53.4-2_arm64.deb \
    /tmp/libsqlite3-0_3.53.4-2_arm64.deb

ENV TZ=Asia/Tokyo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install current security updates and only the Debian 13 libraries required by
# Playwright's headless Chromium build. Xvfb and headed-browser tooling are
# intentionally omitted.
# perl-base remains in Debian package metadata for future security upgrades, but
# its interpreter entrypoints are removed after package operations because the
# immutable PunchPilot runtime never executes Perl.
# hadolint ignore=DL3005,DL3008
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    gosu \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    && architecture="$(dpkg --print-architecture)" \
    && dpkg --install "/tmp/libsqlite3-0_3.53.4-2_${architecture}.deb" \
    && test "$(dpkg-query --show --showformat='${Version}' libsqlite3-0)" = '3.53.4-2' \
    && rm -f /usr/bin/perl* \
    && test -z "$(find /usr/bin -maxdepth 1 -name 'perl*' -print -quit)" \
    && rm -f /tmp/libsqlite3-0_3.53.4-2_amd64.deb /tmp/libsqlite3-0_3.53.4-2_arm64.deb \
    && rm -rf /var/lib/apt/lists/*

# Copy production node_modules (with native better-sqlite3) and Chromium.
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/package*.json ./
COPY --from=server-builder /ms-playwright /ms-playwright

# Copy built client (only the dist output, not node_modules)
COPY --from=client-builder /app/client/dist ./client/dist

# Copy server source files
COPY server/ ./server/
COPY shared/ ./shared/
COPY scripts/ci/inspect-javascript-modules.mjs ./scripts/ci/
COPY docker-entrypoint.sh /docker-entrypoint.sh

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN chmod +x /docker-entrypoint.sh \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && install -d -m 0700 /app/data /app/logs /app/screenshots /app/keystore

EXPOSE 8681

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8681}/api/auth/status`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

# Root is limited to mounted-volume ownership initialization. The entrypoint
# validates non-zero IDs and always execs the application through gosu.
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/docker-entrypoint.sh"]
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["node", "server/server.js"]

# =============================================================================
# Stage 5: arm64 precondition evidence (rootless release verification only)
# =============================================================================
# The rootless source release runner's Docker engine cannot execute the
# cross-built arm64 image ("exec format error"), so a plain `docker run` cannot
# collect runtime precondition evidence. This sidecar stage is only reached via
# --target arm64-precondition-evidence: BuildKit runs the exact runtime content
# under linux/arm64 (QEMU, identical to the runtime build) as a numeric
# non-root user, and only the evidence JSON is exported through a scratch
# target. It invokes the final image's own entrypoint so the target-architecture
# gosu privilege-drop path is exercised before evidence is collected. No
# verification files are added to the final runtime image.
FROM runtime AS arm64-precondition-collector
WORKDIR /app
COPY scripts/ci/collect-container-preconditions.mjs /app/scripts/ci/collect-container-preconditions.mjs
RUN install -d -m 0700 /evidence \
    && /docker-entrypoint.sh node /app/scripts/ci/collect-container-preconditions.mjs \
      > /evidence/container-preconditions.json \
    && test -s /evidence/container-preconditions.json

FROM scratch AS arm64-precondition-evidence
COPY --from=arm64-precondition-collector /evidence/container-preconditions.json /container-preconditions.json

# Keep the default build target on the immutable runtime image so ordinary
# source, public, amd64, and arm64 builds (and --no-cache-filter runtime) are
# unaffected by the rootless-evidence sidecar stage.
FROM runtime AS release
