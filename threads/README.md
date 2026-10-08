# 핫딜 → 쓰레드 자동발행

카톡 핫딜방 글을 붙여넣으면 아래 작업을 한 번에 처리합니다.

1. **후킹 문구**: AI(Claude)가 지니 말투로 3개 써줌 → 하나 고르거나 직접 수정
2. **사진 0~2장**: 앨범 사진이나 캡처를 올리거나, 상품 대표 이미지를 자동으로 가져옴
3. **댓글**: 광고 안내 문구와 **내** 쉐어링크(방장 링크를 교체한 것)
4. **발행**: 본문(+사진)을 올린 뒤 그 글에 댓글을 자동으로 닮

- 폰 앱 주소: `https://babisei0904.github.io/jinny-proposal/threads/`
- 사파리나 크롬에서 열고 **공유 → 홈 화면에 추가**를 하면 앱처럼 쓸 수 있어요.
- 안드로이드는 홈 화면에 추가한 뒤 카톡 메시지를 길게 눌러 **공유 → 핫딜발행**을 고르면 내용이 바로 들어가요.

---

## 구조

```
폰 (GitHub Pages의 threads/)  ──►  Cloudflare Worker (worker/)  ──►  Threads API
                                         ├─ Claude API (후킹 문구)
                                         └─ 쿠팡 파트너스 API (링크 변환)
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

배포가 끝나면 `https://threads-autopost.<계정>.workers.dev` 형태의 주소가 나와요.

### 3) 폰에서 연결

앱을 열고 오른쪽 위 ⚙︎을 눌러 **서버 주소**와 **앱 비밀번호**를 입력해요. **연결 확인**을 눌러 `✅ 쓰레드 @2_jinny_22`가 뜨면 끝이에요.
안내 문구(토스/쿠팡)도 여기서 바꿀 수 있어요.

---

## 매번 쓰는 법 (30초)

1. 카톡 글 전체를 복사해요 → 앱에서 **📋 붙여넣기**를 눌러요. 문구 후보가 자동으로 만들어져요.
2. 마음에 드는 문구를 누르고 필요하면 고쳐요.
3. 사진: 상품 이미지가 자동으로 들어가요. 캡처 사진은 **앨범에서 추가**로 넣어요(최대 2장).
4. 내 링크
   - **토스**: **원본 상품 열기** → 토스 앱에서 공유 → 링크 복사 → 돌아와서 📋를 눌러요.
   - **쿠팡**: **쿠팡 내 링크로 변환**을 누르면 자동으로 바뀌어요(파트너스 API 키를 넣었을 때).
5. **🚀 쓰레드에 발행**을 누르면 본문과 사진이 올라가고 댓글까지 달려요.

> 서버를 연결하기 전에는 **앱으로 열기(텍스트만)**를 쓰면 돼요. 쓰레드 앱이 본문이 채워진 채로 열리고, 댓글 문구는 클립보드에 복사돼요.

## 참고

- 쓰레드 글은 본문과 댓글 각각 500자까지예요. 앱이 글자 수를 세서 보여줘요.
- 토스쇼핑 쉐어링크는 공개 API가 없어서 토스 앱에서 직접 복사해야 해요.
  대신 앱이 방장 링크를 그대로 올리려고 하면 경고해줘요.
- 쓰레드 API는 24시간에 글 250개까지 올릴 수 있어요.
