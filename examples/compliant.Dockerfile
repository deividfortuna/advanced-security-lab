# Compliant: Chainguard bases, scratch, and stage alias reuse.

FROM --platform=$BUILDPLATFORM cgr.dev/chainguard/go:latest AS build
WORKDIR /src
COPY . .
RUN go build -o /out/app ./cmd/app

FROM cgr.dev/chainguard/static:latest AS runtime
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]

FROM scratch AS empty
COPY --from=runtime /app /app
