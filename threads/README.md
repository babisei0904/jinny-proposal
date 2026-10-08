# 핫딜 → 쓰레드 자동발행

카톡 핫딜방 글을 붙여넣으면 아래 작업을 한 번에 처리합니다.

1. **후킹 문구**: AI(Claude)가 지니 말투로 3개 써줌 → 하나 고르거나 직접 수정
2. **사진 0~2장**: 앨범 사진이나 캡처를 올리거나, 상품 대표 이미지를 자동으로 가져옴
3. **댓글**: 맨 위에 광고 안내 문구, 그 아래 **내** 쉐어링크. 방장 링크는 토스·쿠팡 API로 자동 교체돼요. 본문에도 문구를 넣고 싶으면 체크박스를 켜요.
4. **발행**: 본문과 사진을 올린 뒤 그 글에 댓글을 자동으로 닮

- 폰 앱 주소: `https://babisei0904.github.io/jinny-proposal/threads/`
- 사파리나 크롬에서 열고 **공유 → 홈 화면에 추가**를 하면 앱처럼 쓸 수 있어요.
- 안드로이드는 홈 화면에 추가한 뒤 카톡 메시지를 길게 눌러 **공유 → 핫딜발행**을 고르면 내용이 바로 들어가요.

---

## 구조

```
폰 (GitHub Pages의 threads/)  ──►  Cloudflare Worker (worker/)  ──►  Threads API
                                         ├─ Claude API (후킹 문구)
                                         ├─ 쿠팡 파트너스 API (링크 변환)
                                         └─ toss-proxy (고정 IP) ──► 토스 쉐어링크 Open API (링크 발급)
```

토큰이나 API 키 같은 비밀값은 **Worker에만** 저장됩니다. 폰에는 서버 주소와 앱 비밀번호만 저장돼요.

---

## 처음 한 번만 하는 설정 (약 20분)

### 1) 쓰레드 액세스 토큰 발급

1. https://developers.facebook.com → **앱 만들기** → 사용 사례에서 **"Threads API 액세스"**를 선택해요.
2. 사용 사례 → 맞춤 설정에서 권한 `threads_basic`, `threads_content_publish`, `threads_manage_replies`를 추가해요.
3. **앱 역할 → 역할 → Threads 테스터**에 내 쓰레드 계정(2_jinny_22)을 추가해요.
   그다음 쓰레드 앱의 **설정 → 계정 → 웹사이트 권한 → 초대**에서 수락해요.
4. 사용 사례 → **Threads API 테스트** 화면의 "User Token Generator"에서 토큰을 생성해요.
5. 장기 토큰(60일짜리)으로 교환해요. 앱 시크릿은 "앱 설정 → 기본 설정 → Threads 앱 시크릿"에 있어요.
   ```
   curl "https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=앱시크릿&access_token=짧은토큰"
   ```
   결과로 나온 `access_token`이 장기 토큰이에요. 만료되지 않도록 Worker가 매주 자동으로 갱신해요.

### 2) Worker 배포 (Cloudflare 무료 플랜으로 충분)

PC 터미널에서 실행해요.

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create IMAGES     # 나온 id를 wrangler.toml의 REPLACE_WITH_KV_NAMESPACE_ID 자리에 붙여넣기
npx wrangler secret put APP_PASSWORD        # 폰에서 입력할 비밀번호 (길게 아무거나)
npx wrangler secret put THREADS_ACCESS_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY   # (선택) AI 후킹 문구. 없으면 기본 템플릿 문구를 써요
npx wrangler secret put COUPANG_ACCESS_KEY  # (선택) 쿠팡 파트너스 → 추가기능 → 오픈API
npx wrangler secret put COUPANG_SECRET_KEY  # (선택)
npx wrangler deploy
```

토스 쉐어링크 자동 발급까지 쓰려면 아래 3)을 마친 뒤 이렇게 등록해요.

```bash
npx wrangler secret put TOSS_ACCESS_KEY
npx wrangler secret put TOSS_SECRET_KEY
npx wrangler secret put TOSS_PUBLISHER_ID   # 어드민 API 연동 화면의 "회원 연동 ID"
npx wrangler secret put TOSS_PROXY_URL      # 예: http://고정IP:8080
npx wrangler secret put TOSS_PROXY_KEY
npx wrangler deploy
```

배포가 끝나면 `https://threads-autopost.<계정>.workers.dev` 형태의 주소가 나와요.

### 3) (선택) 토스 쉐어링크 자동 발급

[토스 쉐어링크 Open API](https://sharelink-docs.toss.im/developers/open-api.md)를 쓰면 방장 링크를 붙여넣는 순간 **내 쉐어링크가 자동으로 발급**돼요.
스레드 게시 자동화는 공식적으로 허용되는 용도예요. 단, 조건이 두 가지 있어요.

1. **사업자 승인이 필요해요.** 개인사업자(간이·일반)나 법인만 승인받을 수 있고, 비사업자 개인은 안 돼요.
   - 신청: sharelink.toss.im 크리에이터 어드민 → **연동 → API 키 발급**
   - 서비스 유형은 "웹사이트"나 SNS, 용도는 "스레드 게시 자동화"로 적어요.
   - 검수는 영업일 5일 이내예요.
2. **고정 IP 서버가 필요해요.** 토스는 등록한 IP에서 오는 호출만 받는데, Cloudflare Worker는 IP가 계속 바뀌어요.
   그래서 고정 IP가 있는 작은 서버에서 `toss-proxy/server.js`를 돌려서 중계해요. Node 18 이상만 있으면 되고 외부 패키지는 없어요.
   - 서버 후보: Oracle Cloud 무료 VM, 월 몇천 원짜리 VPS(Vultr·Lightsail 등)
   - 실행: `PROXY_KEY=긴비밀값 PORT=8080 node server.js`
   - 그 서버의 공인 IP를 토스 어드민의 **출발지 IP**에 등록해요.

같은 상품의 링크는 30일 동안 저장해 두고 다시 써요. 토스 문서가 그렇게 권장해요.
방장 링크에서는 상품 그룹 번호만 알 수 있어서, 대표 옵션으로 링크가 발급돼요.
발급되면 앱에 `✅ 내 링크 발급: 상품명 · 가격`이 떠요. 원문 옵션(예: 40병)과 맞는지 확인하세요.

### 4) 폰에서 연결

앱을 열고 오른쪽 위 ⚙︎을 눌러 **서버 주소**와 **앱 비밀번호**를 입력해요. **연결 확인**을 눌러 `✅ 쓰레드 @2_jinny_22`가 뜨면 끝이에요.
안내 문구(토스/쿠팡)도 여기서 바꿀 수 있어요.

---

## 매번 쓰는 법 (30초)

1. 카톡 글 전체를 복사해요 → 앱에서 **📋 붙여넣기**를 눌러요. 문구 후보가 자동으로 만들어져요.
2. 마음에 드는 문구를 누르고 필요하면 고쳐요.
3. 사진: 상품 이미지가 자동으로 들어가요. 캡처 사진은 **앨범에서 추가**로 넣어요(최대 2장).
4. 내 링크
   - **토스**: API를 연결했다면 자동으로 바뀌어요. 아니라면 **원본 상품 열기** → 토스 앱에서 공유 → 링크 복사 → 돌아와서 📋를 눌러요.
   - **쿠팡**: **쿠팡 내 링크로 변환**을 누르면 자동으로 바뀌어요(파트너스 API 키를 넣었을 때).
5. **🚀 쓰레드에 발행**을 누르면 본문과 사진이 올라가고 댓글까지 달려요.

> 서버를 연결하기 전에는 **앱으로 열기(텍스트만)**를 쓰면 돼요. 쓰레드 앱이 본문이 채워진 채로 열리고, 댓글 문구는 클립보드에 복사돼요.

## 참고

- 쓰레드 글은 본문과 댓글 각각 500자까지예요. 앱이 글자 수를 세서 보여줘요.
- 토스 API 승인 전에는 토스 앱에서 직접 복사해야 해요. 앱이 방장 링크를 그대로 올리려고 하면 경고해줘요.
- 대가성 문구는 기본으로 댓글 맨 위(링크 바로 위)에 들어가요. 본문에도 넣으려면 "본문 끝에도 대가성 문구 넣기"를 켜요.
- 쓰레드 API는 24시간에 글 250개까지 올릴 수 있어요.
