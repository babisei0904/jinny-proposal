# 숙소 릴스 자동 생성

숙소 사진 폴더 하나 → 내레이션 + 자막 + 장면 전환이 들어간 릴스 mp4 (1080×1920).

벤치마크 릴스 5개(guide.oppa, checkin_unnie, ohayo.to_travel 등)를 실측한 구조에 맞춰져 있다.

| 항목 | 벤치마크 평균 | 이 프로그램 |
|---|---|---|
| 길이 | 20.8초 | 대본 길이에 따라 (120~140음절이면 18~21초) |
| 장면 | 18개, 장면당 1.16초 | 자막 한 줄 = 장면 하나 |
| 자막 | 덩이당 7.3자, 화면 세로 가운데 | 같음 (흰 글씨 + 검은 테두리) |
| 말 빠르기 | 초당 6.8음절 | 목소리를 만든 뒤 6.8음절에 맞춰 빠르기 보정 (음높이 유지) |

## 목소리: 영상작업실의 Fish Audio 그대로

키를 따로 넣지 않는다. 영상작업실 설정 파일
`~/Desktop/영상작업실-repo/video-automation/data/settings.json` 에서
`fish_key` 와 목소리 목록을 읽고, 이름이 **일반여성2** 인 목소리를 쓴다.
다른 목소리를 쓰려면 숙소 폴더의 `reel.json` 에 `"voice": "목소리 이름"`.

설정 파일이 다른 곳에 있으면 `--settings 경로`.

## 숙소 폴더

```
숙소이름/
  01.jpg 02.jpg ...   숙소 사진 (파일 이름 순서대로 쓰임)
  script.txt          대본
  clips/              (선택) 사진과 같은 이름의 AI 영상. 예: clips/03.mp4 가 있으면 03.jpg 대신 사용
  bgm.mp3             (선택) 배경음악
  reel.json           (선택) {"ad": true, "handle": "@내계정", "voice": "일반여성2"}
```

`script.txt` 는 한 줄이 자막 한 덩이이자 장면 하나다. 5~10자로 끊는다.
특정 사진을 쓰려면 `자막 | 사진파일이름`.

```
평일 1박 4만 9천원에
바다 앞 카라반이라고? | 03.jpg
문만 열면 바로
개인 노천탕에서
...
여기 저장해 두세요.
```

벤치마크의 순서: **훅**(질문형 "~라고?" 또는 가격) → **시설**("~인데 / ~까지 / ~하고"로 이어지는 문장)
→ **밤 장면**(60~80% 지점) → **마지막 한마디**(저장 / 다녀오세요 / 어때요?).

## 실행 (Mac)

```bash
cd ~/Desktop/영상작업실-repo
git fetch origin claude/determined-hawking-sikitz
git checkout claude/determined-hawking-sikitz
cd reels
python3 -m venv venv && source venv/bin/activate
pip install pillow
python3 make_reel.py ~/Desktop/숙소/카라반
```

결과: `숙소폴더/out/reel.mp4`, `reel.srt`(자막), `timeline.json`(장면별 시간·사진).

화면만 빨리 확인하려면 `--tts none` (소리 없음), 키 없는 임시 목소리는 `--tts edge` (`pip install edge-tts`).

## 아직 안 된 것

- 사진 → AI 영상: 지금은 줌·이동 효과. AI 영상을 `clips/` 에 넣으면 그걸 쓴다. 생성 서비스 연동은 다음 단계.
- 대본 자동 작성, 사진 자동 분류·순서 정하기.
- 인스타 업로드 (Meta 공식 API 준비 필요).
- 문장 안의 자막 덩이 시간은 음절 비율로 나눈다. 실제 말과 0.1~0.2초 어긋날 수 있다.
