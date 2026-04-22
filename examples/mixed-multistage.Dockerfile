# Mixed: Chainguard builder, public-registry runtime. Only the final FROM flags.

FROM cgr.dev/chainguard/go:latest AS build
WORKDIR /src
COPY . .
RUN go build -o /out/server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=build /out/server /usr/local/bin/server
ENTRYPOINT ["/usr/local/bin/server"]
