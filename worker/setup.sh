#!/usr/bin/env bash
# Worker 첫 배포 + 비밀값 등록 도우미 (맥/리눅스)
# 사용법: bash setup.sh   — 다시 실행하면 비밀값만 추가/변경할 수 있어요
set -euo pipefail
cd "$(dirname "$0")"

echo "▶ 패키지 설치"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
# 최신 npm은 설치 스크립트를 기본 차단한다 — 배포 도구(esbuild, workerd)에 필요한 것만 허용 후 다시 설치
if npm help install-scripts >/dev/null 2>&1; then
  npm install-scripts approve esbuild workerd >/dev/null 2>&1 || true
fi
npm rebuild esbuild workerd >/dev/null 2>&1 || true

if npx wrangler whoami 2>&1 | grep -qi "not authenticated"; then
  echo "▶ Cloudflare 로그인 (브라우저가 열려요)"
  npx wrangler login
fi

if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  echo "▶ 저장소(KV) 만들기"
  out="$(npx wrangler kv namespace create IMAGES 2>&1)"
  id="$(printf '%s' "$out" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  if [[ -z "$id" ]]; then
    printf '%s\n' "$out"
    echo "KV id를 찾지 못했어요. 위 메시지를 보내주세요." >&2
    exit 1
  fi
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$id/" wrangler.toml && rm -f wrangler.toml.bak
fi

echo "▶ 배포"
if ! deploy_out="$(npx wrangler deploy 2>&1)"; then
  printf '%s\n' "$deploy_out"
  echo
  echo "❌ 배포에 실패했어요. 위 메시지를 그대로 복사해서 보내주세요." >&2
  exit 1
fi
printf '%s\n' "$deploy_out" | tail -5
URL="$(printf '%s' "$deploy_out" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  ✅ $1 등록"; }
ask() {
  local v _
  # 이전 단계 진행 중에 미리 붙여넣은 입력이 다음 질문의 답으로 들어가지 않게 비운다
  while read -r -s -t 0.1 _; do :; done
  read -r -s -p "  $2 (없으면 그냥 Enter): " v; echo
  if [[ -n "$v" ]]; then put "$1" "$v"; fi
}

echo
echo "▶ 비밀값 등록 — 붙여넣어도 화면에 안 보이는 게 정상이에요"
if ! npx wrangler secret list 2>/dev/null | grep -q APP_PASSWORD; then
  PW="$(openssl rand -hex 8)"
  put APP_PASSWORD "$PW"
  echo "  📱 폰 앱에 넣을 비밀번호: $PW   ← 메모해 두세요"
fi
echo "  (하나 붙여넣고 Enter → '✅ 등록'이 뜬 뒤에 다음 값을 붙여넣으세요)"
ask COUPANG_ACCESS_KEY  "쿠팡 Access Key"
ask COUPANG_SECRET_KEY  "쿠팡 Secret Key"
ask THREADS_ACCESS_TOKEN "쓰레드 장기 토큰"
ask ANTHROPIC_API_KEY   "Claude API 키 (AI 후킹 문구)"
ask TOSS_ACCESS_KEY     "토스 Access Key"
ask TOSS_SECRET_KEY     "토스 Secret Key"
ask TOSS_PUBLISHER_ID   "토스 회원 연동 ID"
ask TOSS_PROXY_URL      "토스 중계 서버 주소 (https://...duckdns.org)"
ask TOSS_PROXY_KEY      "토스 중계 서버 키"

echo
echo "================ 완료 ================"
echo "📱 폰 앱 ⚙︎ 설정 → 서버 주소: ${URL:-(위 배포 결과의 workers.dev 주소)}"
echo "   나중에 키를 추가하려면 이 스크립트를 다시 실행하세요."
