FROM cgr.dev/chainguard/node:latest
WORKDIR /app
COPY . .
CMD ["node", "index.js"]
