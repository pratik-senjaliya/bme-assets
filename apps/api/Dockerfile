# API image for the hospital server. Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t bme-api .
# (docker-compose.yml does this for you.)

# ---- build: compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api -w packages/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api

# ---- run: production dependencies only ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
# `postinstall` generates the Prisma client for this platform.
RUN npm ci --omit=dev -w apps/api -w packages/shared
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
RUN mkdir -p /data/uploads && chown -R node:node /data
WORKDIR /app/apps/api
USER node
# npm hoists binaries (prisma) to the workspace root.
ENV PORT=4000 STORAGE_PATH=/data/uploads PATH=/app/node_modules/.bin:$PATH
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Applies database migrations (safe to repeat), then starts the API and its daily reminder job.
CMD ["sh", "-c", "prisma migrate deploy && node dist/index.js"]
