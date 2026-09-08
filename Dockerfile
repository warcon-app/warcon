# Warcon: Bun + SvelteKit; the database is Postgres/TimescaleDB (see docker-compose.yml).
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && rm -rf ~/.bun/install/cache
COPY --from=build /app/build ./build
COPY drizzle ./drizzle
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "./build/index.js"]
