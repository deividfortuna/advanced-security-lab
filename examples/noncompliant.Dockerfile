# Non-compliant: uses public registry images (should raise warnings).

FROM node:21 AS builder
WORKDIR /app
COPY . .
RUN npm run build

FROM ubuntu:22.04
COPY --from=builder /app/dist /opt/app
CMD ["/opt/app/server"]
