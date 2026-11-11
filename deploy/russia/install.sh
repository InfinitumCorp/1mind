#!/usr/bin/env bash
# Installs or updates 1MIND on a Yandex Cloud VM (Ubuntu 24.04, nginx + certbot webroot).
# Run as root from a checkout:  sudo bash deploy/russia/install.sh [branch]
# Idempotent: re-run to update to the branch's latest commit.
set -euo pipefail

BRANCH="${1:-main}"
REPO="https://github.com/InfinitumCorp/1mind.git"
APP=/opt/1mind
HOME_DIR=/var/lib/1mind
HOST=1mind-ru.infinitumcorporation.ai
PREVIEW=1mind-ru-preview.infinitumcorporation.ai
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== user"
id onemind >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin onemind
install -d -o onemind -g onemind -m 750 "$HOME_DIR"

echo "== packages (git, GitHub CLI, python3)"
if ! command -v gh >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git gh python3 >/dev/null

echo "== code ($BRANCH)"
if [ ! -d "$APP/.git" ]; then
  install -d -o onemind -g onemind "$APP"
  sudo -u onemind git clone -q --branch "$BRANCH" "$REPO" "$APP"
else
  sudo -u onemind git -C "$APP" fetch -q origin "$BRANCH"
  sudo -u onemind git -C "$APP" checkout -q -B "$BRANCH" "origin/$BRANCH"
fi
(cd "$APP" && sudo -u onemind HOME="$HOME_DIR" npm ci --omit=dev --no-audit --no-fund --silent)

echo "== env"
install -d -m 750 -g onemind /etc/1mind
if [ ! -f /etc/1mind/env ]; then
  install -m 640 -g onemind "$HERE/env.example" /etc/1mind/env
  sed -i "s|^ONEMIND_TOKEN=.*|ONEMIND_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')|" /etc/1mind/env
  echo "   created /etc/1mind/env: set CID_OWNERS before anyone can sign in"
fi

echo "== service"
install -m 644 "$HERE/1mind.service" /etc/systemd/system/1mind.service
systemctl daemon-reload
systemctl enable -q 1mind
systemctl restart 1mind

echo "== nginx + certificate"
install -m 644 "$HERE/1mind-proxy.conf" /etc/nginx/snippets/1mind-proxy.conf
install -d -m 755 /var/www/acme
if [ ! -f "/etc/letsencrypt/live/$HOST/fullchain.pem" ]; then
  # Port 80 only, so Let's Encrypt can reach the webroot before the 443 blocks exist.
  cat > /etc/nginx/sites-enabled/1mind <<EOF
server { listen 80; listen [::]:80; server_name $HOST $PREVIEW; server_tokens off;
  location /.well-known/acme-challenge/ { root /var/www/acme; }
  location / { return 404; } }
EOF
  nginx -t -q && systemctl reload nginx
  certbot certonly -n --webroot -w /var/www/acme -d "$HOST" -d "$PREVIEW" --agree-tos --register-unsafely-without-email --keep-until-expiring
fi
install -m 644 "$HERE/nginx-1mind.conf" /etc/nginx/sites-enabled/1mind
nginx -t -q && systemctl reload nginx

echo "== check"
sleep 2
systemctl is-active 1mind
curl -s -o /dev/null -w "local 4400: %{http_code}\n" http://127.0.0.1:4400/login
echo "done. GitHub: sign in once with  sudo -u onemind -H gh auth login  (then restart: systemctl restart 1mind)"
