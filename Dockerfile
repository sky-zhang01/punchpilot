FROM mcr.microsoft.com/playwright:v1.58.2-jammy

LABEL org.opencontainers.image.title="PunchPilot" \
      org.opencontainers.image.description="Smart attendance automation for freee HR" \
      org.opencontainers.image.version="0.4.2" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sky-zhang01/punchpilot"

WORKDIR /app

ENV TZ=Asia/Tokyo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install tzdata, build tools, and gosu (for runtime UID/GID switching)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    tzdata \
    build-essential \
    python3 \
    gosu \
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

# Entrypoint handles runtime UID/GID switch via PUID/PGID env vars
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8681

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
