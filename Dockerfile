# syntax=docker/dockerfile:1
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/payroll.sqlite
COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/demo ./demo
COPY --from=build /app/config ./config
RUN mkdir -p /data
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
