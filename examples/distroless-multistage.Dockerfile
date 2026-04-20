# Google distroless runtime — minimal, but still not Chainguard (1 violation on final FROM).

FROM cgr.dev/chainguard/go:latest AS build
WORKDIR /src
COPY . .
RUN go build -o /out/app ./cmd/app

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]
