# Lumin-Rust — minimal container image
# Multi-stage build: build on full image, run on scratch-like alpine
# Target: < 50MB total image size (vs 9.6GB for Lumin-TS C3)

FROM rust:1.82-alpine AS builder
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconf
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY crates/ crates/
# Static linking for fully portable binary
ENV RUSTFLAGS="-C target-feature=+crt-static"
RUN cargo build --release --target x86_64-unknown-linux-musl 2>/dev/null || cargo build --release

FROM alpine:3.20
RUN apk add --no-cache bash ca-certificates
COPY --from=builder /build/target/release/lumin-server /usr/local/bin/lumin-server
RUN mkdir -p /workspace
WORKDIR /workspace

ENV LUMIN_LOOP_MODE=single
EXPOSE 3001

ENTRYPOINT ["lumin-server"]
CMD ["serve", "--port", "3001"]
