"""내레이션 만들기.

- fish : Fish Audio. 키와 목소리는 영상작업실 설정(settings.json)에서 그대로 읽는다.
- edge : 키 없이 쓰는 Microsoft Edge 목소리 (pip install edge-tts 필요). 테스트용.
- none : 소리 없이, 말하는 시간만 음절 수로 어림잡는다. 화면 확인용.
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

SETTINGS_CANDIDATES = [
    "~/Desktop/영상작업실-repo/video-automation/data/settings.json",
    "~/Desktop/*/video-automation/data/settings.json",
    "~/*/video-automation/data/settings.json",
]


def find_settings(explicit: str | None = None) -> Path | None:
    """영상작업실 settings.json 위치를 찾는다."""
    for cand in [explicit, os.environ.get("REELS_SETTINGS"), *SETTINGS_CANDIDATES]:
        if not cand:
            continue
        for p in sorted(glob.glob(os.path.expanduser(cand))):
            if Path(p).is_file():
                return Path(p)
    return None


def load_fish(settings_path: Path, voice_name: str) -> tuple[str, str, str]:
    """(키, 모델, 목소리 reference_id) 를 돌려준다."""
    s = json.loads(settings_path.read_text(encoding="utf-8"))
    key = (s.get("fish_key") or "").strip()
    if not key:
        raise RuntimeError(f"영상작업실 설정에 Fish Audio 키가 없습니다: {settings_path}")
    voices = [v for v in s.get("fish_voices", []) if v.get("id")]
    match = [v for v in voices if v.get("name", "").strip() == voice_name.strip()]
    if not match:
        names = ", ".join(v.get("name", "?") for v in voices) or "(없음)"
        raise RuntimeError(f"Fish 목소리 '{voice_name}'를 찾지 못했습니다. 설정에 있는 목소리: {names}")
    return key, s.get("fish_model") or "s2.1-pro-free", match[0]["id"]


def duration(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                        str(path)], capture_output=True, text=True)
    return float(r.stdout.strip())


def fish(text: str, out: Path, key: str, model: str, voice_id: str, speed: float = 1.0) -> None:
    """영상작업실 web/tts.py 의 _fish 와 같은 호출."""
    body = {"text": text, "format": "mp3", "mp3_bitrate": 128, "latency": "normal",
            "prosody": {"speed": max(0.5, min(2.0, speed)), "volume": 0}, "reference_id": voice_id}
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "model": model})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, out.open("wb") as f:
            shutil.copyfileobj(r, f)
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="ignore")[:300]
        hint = {401: "Fish Audio API 키가 올바르지 않습니다.",
                402: "Fish Audio에서 결제가 필요하다고 응답했어요. 설정의 모델이 s2.1-pro-free 인지 확인해 주세요."}
        raise RuntimeError(hint.get(e.code, f"Fish Audio 오류 {e.code}: {msg}"))
    except urllib.error.URLError as e:
        raise RuntimeError(f"Fish Audio에 연결하지 못했습니다: {e.reason}")


def edge(text: str, out: Path, voice: str = "ko-KR-SunHiNeural", speed: float = 1.0) -> None:
    cafile = os.environ.get("SSL_CERT_FILE")
    if cafile and Path(cafile).exists():   # 회사망·프록시처럼 인증서를 따로 쓰는 환경
        try:
            import certifi
            certifi.where = lambda: cafile
        except ImportError:
            pass
    try:
        import edge_tts
    except ImportError:
        raise RuntimeError("edge-tts 가 없습니다: pip install edge-tts")

    async def run():
        await edge_tts.Communicate(text, voice, rate=f"{round((speed - 1) * 100):+d}%").save(str(out))
    asyncio.run(run())


def silence(seconds: float, out: Path) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                    "-t", f"{seconds:.3f}", "-b:a", "128k", str(out)], check=True)


def trim_silence(src: Path, out: Path) -> None:
    """앞뒤 무음을 잘라 장면 전환이 말에 딱 붙게 한다."""
    f = ("silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,"
         "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", f, "-ar", "44100", "-ac", "1",
                    "-b:a", "160k", str(out)], check=True)


def tempo(src: Path, out: Path, factor: float) -> None:
    """음높이는 그대로 두고 빠르기만 바꾼다."""
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af", f"atempo={factor:.4f}",
                    "-b:a", "160k", str(out)], check=True)
