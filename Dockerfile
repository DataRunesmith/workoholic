# Self-hosted copy: the Worker runs in wrangler's local runtime and keeps its
# data in /data. No Cloudflare account is needed. The libraries are what the
# bundled Chrome needs to start.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
    libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN mkdir -p /data && chown node:node /data /srv
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
