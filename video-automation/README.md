# 영상 작업실

1~4번 영상은 **숏튜브 쇼핑숏츠**로 만들고, 그 재료를 준비하는 내 컴퓨터용 대시보드입니다.
로그인 없음, 유료 API 없음. 사진·영상은 내 Mac 안에서만 처리됩니다.

## 할 수 있는 것

| 메뉴 | 하는 일 |
|---|---|
| 대시보드 | 1~4번 영상 바로가기, 숏튜브 편집 도구(자막 제거·자르기·썸네일·용량), ChatGPT·구글 플로우·Fish Audio·브루 바로가기 |
| 사진 → 영상 | **방법 A** 사진마다 구글 플로우 프롬프트를 자동으로 만들어 복사 / **방법 B** 무료로 바로 줌·이동 효과 영상 만들기 |
| 클립 합치기 | 여러 영상을 1~3개로 이어 붙이기 (숏튜브 쇼핑숏츠는 영상 3개, 합계 180초까지 받음) |
| 프롬프트 보관함 | 자주 쓰는 프롬프트 저장·복사. `{상품명}`처럼 쓰면 쓸 때마다 빈칸으로 물어봄 |
| 설정 | 바로가기 주소 바꾸기 |

## 처음 한 번만 (터미널)

```bash
# 1) ffmpeg 설치 (이미 있으면 건너뛰기)
brew install ffmpeg

# 2) 코드 받기
cd ~/Desktop
git clone -b claude/video-automation-program-review-5ali00 https://github.com/babisei0904/jinny-proposal.git 영상작업실-repo
cd 영상작업실-repo/video-automation

# 3) 파이썬 환경 만들기
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 매번 실행

```bash
cd ~/Desktop/영상작업실-repo/video-automation
source venv/bin/activate
python -m web.server
```

크롬이 자동으로 열립니다. 안 열리면 **http://127.0.0.1:8421** 로 접속하세요.
타오바오 자동화(8420)와 포트가 달라서 둘 다 켜 둘 수 있어요. 끌 때는 터미널에서 `Ctrl + C`.

## 숏튜브 버튼을 정확한 화면으로 연결하기

숏튜브의 자막 제거·영상 자르기·썸네일·용량 줄이기 버튼은 처음에 숏튜브 첫 화면으로 열립니다.
숏튜브에서 각 기능 화면을 연 뒤 주소창 주소를 복사해 **설정**에 붙여넣으면, 다음부터 그 화면으로 바로 열립니다.

## 파일 위치

- 만든 영상: `video-automation/data/outputs/` (결과 화면의 **Finder에서 보기**로 열 수 있음)
- 프롬프트·설정: `video-automation/data/prompts.json`, `settings.json`
- 프롬프트는 **프롬프트 보관함 → 백업 받기**로 파일로 보관해 두세요.
