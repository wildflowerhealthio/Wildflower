#!/usr/bin/env bash
# Installs an uploaded wildflowerhealthio-relay-server build on the relay
# host and restarts it, rolling back if the new build doesn't come up. Runs there as `deploy`,
# from .github/workflows/deploy-relay.yml:
#
#   ssh deploy@<host> bash <upload dir>/install.sh <upload dir>
#
# The upload directory holds this script, `wildflowerhealthio-relay-server`
# (the binary), `env` (the environment file) and
# `wildflowerhealthio-relay-server.service` (the unit, only compared with the
# installed one). It is removed on exit, however the script
# ends. Every root command below is one line of ./sudoers, character for
# character.
# Files are piped into `install` and `cmp` through /dev/stdin, so root never
# opens a path in the upload directory.
#
# The binary goes in /opt/wildflower-relay, off root's PATH: `deploy` decides
# its contents, so nothing should run it as root by name.
set -euo pipefail

upload="$1"
trap 'rm -rf "$upload"' EXIT

bin=/opt/wildflower-relay/wildflowerhealthio-relay-server
env=/etc/wildflower-relay/env
unit=/etc/systemd/system/wildflowerhealthio-relay-server.service
# The unit and binary the relay ran as before it took its crate's name. A
# host that still has them is migrated below.
old_unit=/etc/systemd/system/wildflower-relay.service
old_bin=/opt/wildflower-relay/wildflower-relay

# The host and port a listen-address setting in the new environment file
# names, or its default. An unspecified address is probed on loopback.
probe_addr() {
  local value host
  value="$(sed -n "s/^$1=//p" "$upload/env")"
  value="${value:-$2}"
  host="${value%:*}"
  case "$host" in
    0.0.0.0) host=127.0.0.1 ;;
    "[::]") host=::1 ;;
  esac
  host="${host#[}"
  host="${host%]}"
  printf '%s %s\n' "$host" "${value##*:}"
}
read -r http_host http_port < <(probe_addr WILDFLOWER_RELAY_HTTP_ADDR 0.0.0.0:80)
read -r https_host https_port < <(probe_addr WILDFLOWER_RELAY_HTTPS_ADDR 0.0.0.0:443)
read -r control_host control_port < <(probe_addr WILDFLOWER_RELAY_CONTROL_ADDR 0.0.0.0:2333)
http_url_host="$http_host"
if [[ "$http_host" == *:* ]]; then
  http_url_host="[$http_host]"
fi
https_url_host="$https_host"
if [[ "$https_host" == *:* ]]; then
  https_url_host="[$https_host]"
fi

# The relay's own hostname, which it serves /health on. A certificate from
# Let's Encrypt's staging directory is not one curl trusts.
domain="$(sed -n 's/^WILDFLOWER_RELAY_DOMAIN=//p' "$upload/env")"
curl_tls=()
if [[ "$(sed -n 's/^WILDFLOWER_RELAY_ACME_STAGING=//p' "$upload/env")" == true ]]; then
  curl_tls=(--insecure)
fi

listening() {
  timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null
}

healthy() {
  systemctl is-active --quiet wildflowerhealthio-relay-server || return 1
  # :80 answers a host it has no tunnel for with a 404.
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'Host: deploy-check.invalid' "http://$http_url_host:$http_port/")" || return 1
  [[ "$status" == 404 ]] || return 1
  # The TLS front and the tunnels' control port take connections.
  listening "$https_host" "$https_port" || return 1
  listening "$control_host" "$control_port" || return 1
  # The relay's own site answers https://<domain>/health, reached at the
  # front's address with a certificate valid for the domain.
  curl -fs -o /dev/null --max-time 5 "${curl_tls[@]}" \
    --resolve "$domain:$https_port:$https_url_host" "https://$domain:$https_port/health"
}

# Give a build that dies at startup time to fail (the unit restarts it after
# 2 s), then wait up to 2 minutes more for it to answer. The first start on a
# host orders the certificate for the relay's own hostname, and /health only
# answers once it is issued; later starts load it from the state directory.
wait_healthy() {
  sleep 3
  local attempt=1 deadline=$((SECONDS + 120))
  until healthy; do
    if ((SECONDS >= deadline)); then
      return 1
    fi
    echo "not healthy yet (attempt $attempt)"
    attempt=$((attempt + 1))
    sleep 2
  done
}

# A build that crash-looped leaves the unit at its start limit, which a plain
# restart would hit too.
restart() {
  sudo -n /usr/bin/systemctl reset-failed wildflowerhealthio-relay-server || true
  sudo -n /usr/bin/systemctl restart wildflowerhealthio-relay-server
}

install_new() {
  sudo -n /usr/bin/install -d -m 0755 -o root -g root /etc/wildflower-relay &&
    sudo -n /usr/bin/install -m 0600 -o root -g root /dev/stdin /etc/wildflower-relay/env < "$upload/env" &&
    sudo -n /usr/bin/install -d -m 0755 -o root -g root /opt/wildflower-relay &&
    sudo -n /usr/bin/install -m 0755 -o root -g root /dev/stdin /opt/wildflower-relay/wildflowerhealthio-relay-server.new < "$upload/wildflowerhealthio-relay-server" &&
    sudo -n /usr/bin/mv -f /opt/wildflower-relay/wildflowerhealthio-relay-server.new /opt/wildflower-relay/wildflowerhealthio-relay-server
}

# The unit is installed by hand, since a unit can run anything as root. Stop
# before changing anything if the installed one is not the repository's.
if ! cmp -s "$upload/wildflowerhealthio-relay-server.service" "$unit"; then
  echo "::error::$unit differs from apps/relay/relay-server/wildflowerhealthio-relay-server.service; install it on the host and run 'sudo systemctl daemon-reload', then re-run this deploy"
  exit 1
fi

# Retire the earlier unit before the new one starts, so two relays never
# contend for the same ports. Its binary is kept until the new build is up:
# it is what a failed first deploy rolls back to.
if [[ -e "$old_unit" ]]; then
  echo "retiring wildflower-relay.service"
  sudo -n /usr/bin/systemctl disable --now wildflower-relay
  sudo -n /usr/bin/rm -f /etc/systemd/system/wildflower-relay.service
  sudo -n /usr/bin/systemctl daemon-reload
fi

# A push that changes nothing the relay is built from (another crate's
# Cargo.lock bump, say) builds the same binary; don't drop every tunnel for it.
if systemctl is-active --quiet wildflowerhealthio-relay-server &&
  cmp -s "$upload/wildflowerhealthio-relay-server" "$bin" &&
  sudo -n /usr/bin/cmp -s /dev/stdin /etc/wildflower-relay/env < "$upload/env"; then
  echo "binary and environment file unchanged, not restarting"
  exit 0
fi

# Keep what is running now so a failed deploy can go back to it: the current
# binary, or on a host being migrated the earlier unit's. There is nothing to
# keep on the first deploy.
had_prev=false
if [[ -e "$bin" ]]; then
  had_prev=true
  sudo -n /usr/bin/install -m 0755 -o root -g root /opt/wildflower-relay/wildflowerhealthio-relay-server /opt/wildflower-relay/wildflowerhealthio-relay-server.prev
elif [[ -e "$old_bin" ]]; then
  had_prev=true
  sudo -n /usr/bin/install -m 0755 -o root -g root /opt/wildflower-relay/wildflower-relay /opt/wildflower-relay/wildflowerhealthio-relay-server.prev
fi
if [[ "$had_prev" == true && -e "$env" ]]; then
  sudo -n /usr/bin/install -m 0600 -o root -g root /etc/wildflower-relay/env /etc/wildflower-relay/env.prev
fi

if install_new && sudo -n /usr/bin/systemctl enable wildflowerhealthio-relay-server && restart && wait_healthy; then
  echo "wildflowerhealthio-relay-server is up"
  if [[ -e "$old_bin" || -e "$old_bin.prev" ]]; then
    echo "removing the earlier unit's binaries"
    sudo -n /usr/bin/rm -f /opt/wildflower-relay/wildflower-relay /opt/wildflower-relay/wildflower-relay.prev || true
  fi
  exit 0
fi

echo "::error::wildflowerhealthio-relay-server did not come up after the deploy"
# From here every step is best effort: a failure must not skip the rest of
# the rollback.
set +e
sudo -n /usr/bin/journalctl -u wildflowerhealthio-relay-server -n 50 --no-pager

if [[ "$had_prev" == true ]]; then
  echo "rolling back to the previous build"
  sudo -n /usr/bin/install -m 0755 -o root -g root /opt/wildflower-relay/wildflowerhealthio-relay-server.prev /opt/wildflower-relay/wildflowerhealthio-relay-server
  if [[ -e "$env.prev" ]]; then
    sudo -n /usr/bin/install -m 0600 -o root -g root /etc/wildflower-relay/env.prev /etc/wildflower-relay/env
  fi
  # The checks probe the new environment file's addresses and domain, and
  # /health, so a rollback across a change of listen address or domain, or to
  # a build that does not serve /health, reports failure either way.
  if restart && wait_healthy; then
    echo "the previous build is back up"
  else
    echo "::error::the previous build did not come back up either"
  fi
fi
exit 1
