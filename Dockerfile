FROM mcr.microsoft.com/playwright:v1.54.2-jammy

LABEL org.opencontainers.image.title="PunchPilot" \
      org.opencontainers.image.description="Smart attendance automation for freee HR" \
      org.opencontainers.image.version="0.3.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sky-zhang/punchpilot"

WORKDIR /app

ENV TZ=Asia/Tokyo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install tzdata
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y tzdata && apt-get clean && rm -rf /var/lib/apt/lists/*

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

# Run as non-root user for container security
RUN groupadd -r ppuser && useradd -r -g ppuser -d /app ppuser \
    && chown -R ppuser:ppuser /app
USER ppuser

EXPOSE 8681

CMD ["node", "server/server.js"]
