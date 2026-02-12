FROM mcr.microsoft.com/playwright:v1.58.2-jammy

LABEL org.opencontainers.image.title="PunchPilot" \
      org.opencontainers.image.description="Smart attendance automation for freee HR" \
      org.opencontainers.image.version="0.4.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sky-zhang01/punchpilot"

WORKDIR /app

ENV TZ=Asia/Tokyo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install tzdata and build tools (required for better-sqlite3 native compilation)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    tzdata \
    build-essential \
    python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy server package files and install
COPY package*.json ./
RUN npm install

# Copy client package files and install
COPY client/package*.json ./client/
RUN cd client && npm install

# Copy all source files
COPY . .

# Build React client
RUN cd client && npm run build

# Install Playwright browsers
RUN npm run install-browsers

# Create directories (keystore is a Docker named volume for encryption key isolation)
RUN mkdir -p /app/data /app/logs /app/screenshots /app/keystore

# Ensure Playwright browser path
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Run as non-root user for container security (UID/GID 568 = TrueNAS "apps" convention)
RUN groupadd -g 568 apps 2>/dev/null || true \
    && useradd -u 568 -g 568 -d /app -s /bin/false apps 2>/dev/null || true \
    && chown -R 568:568 /app
USER 568

EXPOSE 8681

CMD ["node", "server/server.js"]
