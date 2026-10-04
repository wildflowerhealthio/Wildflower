#!/usr/bin/env bash
# Installs an uploaded wildflower-relay build on the relay host and restarts
# it, rolling back if the new build doesn't come up. Runs there as `deploy`,
# from .github/workflows/deploy-relay.yml:
#
#   ssh deploy@<host> bash <upload dir>/install.sh <upload dir>
#
# The upload directory holds this script, `wildflower-relay` (the binary),
# `env` (the environment file) and `wildflower-relay.service` (the unit, only
# compared with the installed one). Every root command below is one line of
# ./sudoers, character for character.
# Files are piped into `install` through /dev/stdin, so root never opens a
# path in the upload directory.
set -euo pipefail

upload="$1"

bin=/usr/local/bin/wildflower-relay
env=/etc/wildflower-relay/env
unit=/etc/systemd/system/wildflower-relay.service

healthy() {
  systemctl is-active --quiet wildflower-relay || return 1
  # :80 answers a host it has no tunnel for with a 404.
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'Host: deploy-check.invalid' http://127.0.0.1/)" || return 1
  [[ "$status" == 404 ]]
}

# Give a build that dies at startup time to fail (the unit restarts it after
# 2 s), then wait up to 15 s more for it to answer.
wait_healthy() {
  sleep 3
  local attempt
  for attempt in $(seq 15); do
    if healthy; then
      return 0
    fi
    echo "not healthy yet (attempt $attempt)"
    sleep 1
  done
  return 1
}

# The unit is installed by hand, since a unit can run anything as root. Stop
# before changing anything if the installed one is not the repository's.
if ! cmp -s "$upload/wildflower-relay.service" "$unit"; then
  echo "::error::$unit differs from apps/wildflower-relay/wildflower-relay.service; install it on the host and run 'sudo systemctl daemon-reload', then re-run this deploy"
  rm -rf "$upload"
  exit 1
fi

# Keep what is running now so a failed deploy can go back to it. There is
# nothing to keep on the first deploy.
had_prev=false
if [[ -e "$bin" ]]; then
  had_prev=true
  sudo -n /usr/bin/install -m 0755 -o root -g root /usr/local/bin/wildflower-relay /usr/local/bin/wildflower-relay.prev
  if [[ -e "$env" ]]; then
    sudo -n /usr/bin/install -m 0600 -o root -g root /etc/wildflower-relay/env /etc/wildflower-relay/env.prev
  fi
fi

sudo -n /usr/bin/install -d -m 0755 -o root -g root /etc/wildflower-relay
sudo -n /usr/bin/install -m 0600 -o root -g root /dev/stdin /etc/wildflower-relay/env < "$upload/env"
sudo -n /usr/bin/install -m 0755 -o root -g root /dev/stdin /usr/local/bin/wildflower-relay.new < "$upload/wildflower-relay"
sudo -n /usr/bin/mv -f /usr/local/bin/wildflower-relay.new /usr/local/bin/wildflower-relay

sudo -n /usr/bin/systemctl enable wildflower-relay
sudo -n /usr/bin/systemctl restart wildflower-relay

if wait_healthy; then
  echo "wildflower-relay is up"
  rm -rf "$upload"
  exit 0
fi

echo "::error::wildflower-relay did not come up after the deploy"
sudo -n /usr/bin/journalctl -u wildflower-relay -n 50 --no-pager || true

if [[ "$had_prev" == true ]]; then
  echo "rolling back to the previous build"
  sudo -n /usr/bin/install -m 0755 -o root -g root /usr/local/bin/wildflower-relay.prev /usr/local/bin/wildflower-relay
  if [[ -e "$env.prev" ]]; then
    sudo -n /usr/bin/install -m 0600 -o root -g root /etc/wildflower-relay/env.prev /etc/wildflower-relay/env
  fi
  sudo -n /usr/bin/systemctl restart wildflower-relay
  if wait_healthy; then
    echo "the previous build is back up"
  else
    echo "::error::the previous build did not come back up either"
  fi
fi
rm -rf "$upload"
exit 1
