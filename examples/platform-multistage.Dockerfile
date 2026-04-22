# Multi-stage build using --platform flag with non-Chainguard images.
# Both FROM instructions should be flagged by dockerfile-platform-non-chainguard.

FROM --platform=linux/amd64 node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM --platform=linux/amd64 cgr.dev/chainguard/node:latest
WORKDIR /app
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
