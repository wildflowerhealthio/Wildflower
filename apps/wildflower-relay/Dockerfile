# syntax=docker/dockerfile:1
#
# wildflower-relay image. The crate is a workspace member, so the build context
# is the repository root (Cargo reads every member's manifest and the shared
# Cargo.lock); `Dockerfile.dockerignore` trims it to the Rust sources. From the
# repository root:
#
#   docker build -f apps/wildflower-relay/Dockerfile -t wildflower-relay .
#
# or `docker compose up -d --build` from this directory.
#
# The container is configured entirely by `WILDFLOWER_RELAY_*` environment
# variables (see src/settings.rs and compose.yaml). At startup the relay writes
# the rathole TOML at WILDFLOWER_RELAY_CONFIG from them, keeping the enrolled
# `[server.services.*]` tables (each with its own `token`; there is no shared
# token), so mount a volume at /etc/wildflower-relay for those to persist, or
# list the devices in WILDFLOWER_RELAY_SERVICES when the disk does not. Mount the directory rather than the single file: the relay
# replaces the file by rename.

# Keep in step with rust-toolchain.toml (left out of the context so rustup
# does not install the lint components here).
FROM rust:1.95.0-slim-trixie AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p wildflower-relay \
 && install -D target/release/wildflower-relay /out/wildflower-relay

FROM debian:trixie-slim
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin relay \
 && install -d -o relay -g relay -m 0700 /etc/wildflower-relay
COPY --from=build /out/wildflower-relay /usr/local/bin/wildflower-relay
USER relay
ENV WILDFLOWER_RELAY_CONFIG=/etc/wildflower-relay/relay.toml
VOLUME ["/etc/wildflower-relay"]
# 443: TLS front (routes by SNI), 80: redirect to https, 2333: rathole control.
EXPOSE 443 80 2333
ENTRYPOINT ["wildflower-relay"]
