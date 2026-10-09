#!/usr/bin/env bash
# 토스 중계 서버 원클릭 설치 (Ubuntu 22.04 / 24.04)
# 사용법: sudo bash setup.sh 내도메인.duckdns.org
#  - Node 20, Caddy(HTTPS 자동 발급), systemd 서비스, 방화벽 80/443 개방
#  - 끝나면 Worker에 넣을 TOSS_PROXY_URL / TOSS_PROXY_KEY 와 토스에 등록할 IP를 출력
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "사용법: sudo bash setup.sh 내도메인.duckdns.org" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "sudo로 실행해주세요" >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "▶ 패키지 설치"
apt-get update -y
apt-get install -y curl gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent openssl

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "▶ 중계 서버 설치"
mkdir -p /opt/toss-proxy
cp "$HERE/server.js" "$HERE/package.json" /opt/toss-proxy/
if [[ -f /opt/toss-proxy/.env ]]; then
  source /opt/toss-proxy/.env
else
  PROXY_KEY="$(openssl rand -hex 24)"
  echo "PROXY_KEY=$PROXY_KEY" > /opt/toss-proxy/.env
  chmod 600 /opt/toss-proxy/.env
fi

cat > /etc/systemd/system/toss-proxy.service <<UNIT
[Unit]
Description=Toss sharelink API relay
After=network-online.target

[Service]
EnvironmentFile=/opt/toss-proxy/.env
Environment=PORT=8080
Environment=HOST=127.0.0.1
ExecStart=$(command -v node) /opt/toss-proxy/server.js
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy 127.0.0.1:8080
}
CADDY

echo "▶ 방화벽 80/443 개방"
for port in 80 443; do
  iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $port -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable --now toss-proxy
systemctl restart caddy

IP="$(curl -4 -s https://api.ipify.org || true)"
sleep 3
echo
echo "================ 완료 ================"
echo "토스 어드민 '출발지 IP'에 등록할 IP : $IP"
echo "Worker 비밀값 TOSS_PROXY_URL        : https://$DOMAIN"
echo "Worker 비밀값 TOSS_PROXY_KEY        : $PROXY_KEY"
echo
echo "확인: curl https://$DOMAIN/healthz   → ok 가 나오면 정상"
echo "(HTTPS 인증서 발급에 1분 정도 걸릴 수 있어요)"
