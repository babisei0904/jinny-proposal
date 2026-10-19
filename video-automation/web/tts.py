"""무료 목소리(TTS) 엔진.
- edge   : Microsoft Edge 읽어주기 (키 필요 없음, 한국어 3명)
- gemini : Gemini 무료 키로 쓰는 AI 성우 (말투 지시가 반영됨, 무료 사용량이 적음)
- typecast : 타입캐스트 AI 성우 (API 키 필요, 무료 플랜은 매달 글자 수 한도)
- fish   : Fish Audio 무료 모델 s2.1-pro-free (무료 API 키 필요, 내 목소리 모델 사용 가능)
- say    : Mac 기본 음성 (인터넷 없이 동작)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from . import store

TYPECAST_CACHE = store.DATA / "typecast_voices.json"
TYPECAST_API = os.environ.get("TYPECAST_API_BASE", "https://api.typecast.ai")

EDGE_VOICES = [
    {"engine": "edge", "id": "ko-KR-SunHiNeural", "name": "선희", "gender": "female", "desc": "밝고 또렷한 여성"},
    {"engine": "edge", "id": "ko-KR-InJoonNeural", "name": "인준", "gender": "male", "desc": "부드러운 남성"},
    {"engine": "edge", "id": "ko-KR-HyunsuMultilingualNeural", "name": "현수", "gender": "male", "desc": "자연스러운 남성"},
]
GEMINI_VOICES = [
    {"engine": "gemini", "id": "Kore", "name": "코레", "gender": "female", "desc": "단단하고 또렷한"},
    {"engine": "gemini", "id": "Aoede", "name": "아오이데", "gender": "female", "desc": "가볍고 산뜻한"},
    {"engine": "gemini", "id": "Leda", "name": "레다", "gender": "female", "desc": "젊고 발랄한"},
    {"engine": "gemini", "id": "Zephyr", "name": "제퍼", "gender": "female", "desc": "밝은"},
    {"engine": "gemini", "id": "Sulafat", "name": "술라파트", "gender": "female", "desc": "따뜻한"},
    {"engine": "gemini", "id": "Puck", "name": "퍽", "gender": "male", "desc": "경쾌한"},
    {"engine": "gemini", "id": "Charon", "name": "카론", "gender": "male", "desc": "정보 전달형"},
    {"engine": "gemini", "id": "Fenrir", "name": "펜리르", "gender": "male", "desc": "들뜬"},
    {"engine": "gemini", "id": "Orus", "name": "오루스", "gender": "male", "desc": "묵직한"},
    {"engine": "gemini", "id": "Iapetus", "name": "이아페투스", "gender": "male", "desc": "깨끗한"},
]
SAY_VOICES = [
    {"engine": "say", "id": "Yuna", "name": "유나 (Mac)", "gender": "female", "desc": "인터넷 없이 동작"},
]

STYLES = [
    {"id": "basic", "name": "기본 (문맥에 맞춰 자동 감정)", "speed": 1.0, "pitch": 0,
     "prompt": "Read this Korean text naturally and clearly", "emotion": "smart", "intensity": 1.0},
    {"id": "fast", "name": "빠르고 신나게 (쇼핑 숏츠)", "speed": 1.15, "pitch": 3,
     "prompt": "Read this Korean text fast, upbeat and excited, like a viral shopping short",
     "emotion": "happy", "intensity": 1.3},
    {"id": "info", "name": "또박또박 정보 전달 (아나운서)", "speed": 1.05, "pitch": 0,
     "prompt": "Read this Korean text like a confident news announcer, crisp and clear",
     "emotion": "toneup", "intensity": 1.0},
    {"id": "docu", "name": "내셔널지오그래픽 다큐 내레이터", "speed": 0.95, "pitch": -4,
     "prompt": "Read this Korean text like a calm, deep National Geographic documentary narrator",
     "emotion": "tonedown", "intensity": 1.2},
    {"id": "friend", "name": "친구에게 수다 떨듯", "speed": 1.08, "pitch": 2,
     "prompt": "Read this Korean text casually, like chatting with a close friend, warm and playful",
     "emotion": "happy", "intensity": 0.9},
    {"id": "slow", "name": "천천히 감성적으로", "speed": 0.88, "pitch": -2,
     "prompt": "Read this Korean text slowly and emotionally, soft and warm", "emotion": "sad", "intensity": 0.7},
    {"id": "whisper", "name": "속삭이듯 (ASMR)", "speed": 0.95, "pitch": 0,
     "prompt": "Whisper this Korean text softly and intimately, like ASMR", "emotion": "whisper", "intensity": 1.0},
]


def _tc_request(method: str, path: str, key: str, body: dict | None = None, timeout: int = 120):
    req = urllib.request.Request(TYPECAST_API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-API-KEY": key, "Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="ignore")[:300]
        friendly = {
            401: "타입캐스트 API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.",
            402: "타입캐스트 크레딧이 부족해요. 무료 플랜은 매달 정해진 글자 수만 쓸 수 있어요 (1글자 = 1크레딧).",
            404: "타입캐스트에서 이 목소리를 찾지 못했어요. 설정에서 목소리 목록을 새로고침해 주세요.",
            422: "타입캐스트가 읽을 수 없는 글자가 있어요. 특수문자를 빼고 다시 해 주세요.",
            429: "타입캐스트 요청이 너무 많아요. 잠시 뒤 다시 해 주세요.",
        }
        raise RuntimeError(friendly.get(e.code, f"타입캐스트 오류 {e.code}: {msg}"))
    except urllib.error.URLError as e:
        raise RuntimeError(f"타입캐스트에 연결하지 못했습니다: {e.reason}")


def typecast_refresh(settings: dict) -> int:
    """타입캐스트 목소리 목록을 받아 저장한다. 저장한 개수를 돌려준다."""
    key = settings.get("typecast_key", "")
    if not key:
        raise RuntimeError("설정에서 타입캐스트 API 키를 먼저 넣어 주세요.")
    model = settings.get("typecast_model") or "ssfm-v30"
    with _tc_request("GET", f"/v3/voices?model={model}", key, timeout=60) as r:
        data = json.loads(r.read().decode())
    if isinstance(data, dict):
        data = data.get("voices") or data.get("items") or data.get("data") or []
    out = []
    for v in data if isinstance(data, list) else []:
        vid = v.get("voice_id")
        if not vid:
            continue
        name = v.get("voice_name")
        if isinstance(name, dict):
            kor = name.get("kor") or name.get("ko") or ""
            eng = name.get("eng") or name.get("en") or ""
            name = f"{kor} ({eng})" if kor and eng and kor != eng else (kor or eng)
        uses = v.get("use_cases") or []
        age = {"child": "어린이", "teenager": "10대", "young_adult": "청년", "middle_age": "중년",
               "elder": "노년"}.get(str(v.get("age", "")), str(v.get("age") or ""))
        desc = " / ".join([x for x in [age, ", ".join(str(u) for u in uses[:2])] if x])
        out.append({"engine": "typecast", "id": vid, "name": str(name or vid),
                    "gender": "male" if str(v.get("gender", "")).lower().startswith("m") else "female",
                    "desc": desc or "타입캐스트", "preview": v.get("preview_url") or "",
                    "korean": bool(isinstance(v.get("voice_name"), dict) and v["voice_name"].get("kor"))})
    out.sort(key=lambda x: (not x["korean"], x["name"]))
    store._write(TYPECAST_CACHE, out)
    return len(out)


def typecast_voices(settings: dict) -> list[dict]:
    if not settings.get("typecast_key"):
        return []
    cached = store._read(TYPECAST_CACHE, None)
    if cached is None:
        try:
            typecast_refresh(settings)
        except Exception:
            return []
        cached = store._read(TYPECAST_CACHE, [])
    return cached


def voices(settings: dict) -> list[dict]:
    typecast = typecast_voices(settings)
    fish = [{"engine": "fish", "id": v.get("id", ""), "name": v.get("name", "Fish 목소리"),
             "gender": v.get("gender", "female"), "desc": "Fish Audio"}
            for v in settings.get("fish_voices", []) if v.get("id")]
    out = typecast + fish + EDGE_VOICES
    if settings.get("gemini_key"):
        out += GEMINI_VOICES
    if sys.platform == "darwin":
        out += SAY_VOICES
    return out


def _duration(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                        "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        raise RuntimeError("만든 음성 파일을 읽지 못했습니다.")


def _edge(text: str, voice: str, speed: float, pitch: int, out: Path) -> None:
    cafile = os.environ.get("SSL_CERT_FILE")
    if cafile and Path(cafile).exists() and "edge_tts" not in sys.modules:  # 회사망 등 인증서를 따로 쓰는 환경
        try:
            import certifi
            certifi.where = lambda: cafile
        except ImportError:
            pass
    try:
        import edge_tts
    except ImportError:
        raise RuntimeError("edge-tts가 설치되지 않았습니다. 터미널에서 pip install -r requirements.txt 를 다시 실행해 주세요.")
    rate = f"{round((speed - 1) * 100):+d}%"
    pitch_s = f"{int(pitch):+d}Hz"

    async def run():
        com = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch_s)
        await com.save(str(out))

    try:
        asyncio.run(run())
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Edge 목소리 생성 실패 (인터넷 연결을 확인해 주세요): {e}")
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("Edge 목소리 생성 결과가 비어 있습니다.")


def _fish(text: str, voice: str, speed: float, key: str, model: str, out: Path) -> None:
    if not key:
        raise RuntimeError("설정에서 Fish Audio API 키를 넣어 주세요 (무료 모델 사용).")
    body = {"text": text, "format": "mp3", "mp3_bitrate": 128, "latency": "normal",
            "prosody": {"speed": max(0.5, min(2.0, speed)), "volume": 0}}
    if voice:
        body["reference_id"] = voice
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "model": model or "s2.1-pro-free"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, out.open("wb") as f:
            shutil.copyfileobj(r, f)
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="ignore")[:300]
        if e.code == 402:
            raise RuntimeError("Fish Audio에서 결제가 필요하다고 응답했어요. 설정의 모델이 s2.1-pro-free 인지 확인해 주세요.")
        if e.code == 401:
            raise RuntimeError("Fish Audio API 키가 올바르지 않습니다.")
        raise RuntimeError(f"Fish Audio 오류 {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Fish Audio에 연결하지 못했습니다: {e.reason}")


def _typecast(text: str, voice: str, speed: float, pitch: int, emotion: str, intensity: float,
              settings: dict, out: Path) -> None:
    key = settings.get("typecast_key", "")
    if not key:
        raise RuntimeError("설정에서 타입캐스트 API 키를 넣어 주세요.")
    model = settings.get("typecast_model") or "ssfm-v30"
    emotion = emotion or "smart"
    if model == "ssfm-v21":  # 예전 모델은 감정 4가지만 지원
        prompt = {"emotion_preset": emotion if emotion in ("normal", "happy", "sad", "angry") else "normal",
                  "emotion_intensity": max(0.0, min(2.0, intensity))}
    elif emotion == "smart":
        prompt = {"emotion_type": "smart"}
    else:
        prompt = {"emotion_type": "preset", "emotion_preset": emotion,
                  "emotion_intensity": max(0.0, min(2.0, intensity))}
    body = {"voice_id": voice, "text": text, "model": model, "language": "kor", "prompt": prompt,
            "output": {"audio_format": "mp3", "audio_tempo": max(0.5, min(2.0, round(speed, 2))),
                       "audio_pitch": max(-12, min(12, int(round(pitch / 2)))), "volume": 100}}
    with _tc_request("POST", "/v1/text-to-speech", key, body) as r, out.open("wb") as f:
        shutil.copyfileobj(r, f)


def _gemini(text: str, voice: str, speed: float, style_prompt: str, key: str, model: str, out: Path) -> None:
    if not key:
        raise RuntimeError("설정에서 Gemini API 키(무료)를 넣어 주세요.")
    body = {"contents": [{"parts": [{"text": f"{style_prompt or 'Read this Korean text naturally'}: {text}"}]}],
            "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice or "Kore"}}}}}
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/{model or 'gemini-2.5-flash-preview-tts'}"
           f":generateContent?key={key}")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="ignore")[:300]
        if e.code == 429:
            raise RuntimeError("Gemini 목소리 무료 사용량을 다 썼어요. 다른 목소리(Edge)로 바꾸거나 잠시 뒤 다시 해 주세요.")
        raise RuntimeError(f"Gemini 목소리 오류 {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Gemini에 연결하지 못했습니다: {e.reason}")
    try:
        part = data["candidates"][0]["content"]["parts"][0]["inlineData"]
        pcm = base64.b64decode(part["data"])
        rate = 24000
        m = (part.get("mimeType") or "")
        if "rate=" in m:
            rate = int(m.split("rate=")[1].split(";")[0])
    except (KeyError, IndexError, ValueError):
        raise RuntimeError("Gemini가 음성을 돌려주지 않았습니다. 대사를 조금 바꿔 다시 해 주세요.")
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "a.pcm"
        raw.write_bytes(pcm)
        af = [] if abs(speed - 1) < 0.01 else ["-af", f"atempo={max(0.5, min(2.0, speed)):.3f}"]
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", str(raw),
                        *af, "-b:a", "160k", str(out)], check=True)


def _say(text: str, voice: str, speed: float, out: Path) -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Mac 기본 음성은 Mac에서만 쓸 수 있습니다.")
    with tempfile.TemporaryDirectory() as td:
        aiff = Path(td) / "v.aiff"
        rate = str(int(180 * speed))
        r = subprocess.run(["say", "-v", voice or "Yuna", "-r", rate, "-o", str(aiff), text], capture_output=True)
        if r.returncode != 0:
            raise RuntimeError("Mac 음성 생성 실패. 시스템 설정 > 손쉬운 사용 > 음성 콘텐츠에서 '유나' 음성을 내려받아 주세요.")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(aiff), "-b:a", "160k", str(out)], check=True)


def synthesize(text: str, engine: str, voice: str, speed: float, pitch: int, settings: dict, out: Path,
               style_prompt: str = "", emotion: str = "", intensity: float = 1.0) -> float:
    """text를 음성 파일(mp3)로 만들고 길이(초)를 돌려준다."""
    text = (text or "").strip()
    if not text:
        raise RuntimeError("읽을 대사가 비어 있습니다.")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.mp3")
    if engine == "typecast":
        _typecast(text, voice, speed, pitch, emotion, intensity, settings, tmp)
    elif engine == "fish":
        _fish(text, voice, speed, settings.get("fish_key", ""), settings.get("fish_model", "s2.1-pro-free"), tmp)
    elif engine == "gemini":
        _gemini(text, voice, speed, style_prompt, settings.get("gemini_key", ""),
                settings.get("gemini_tts_model", "gemini-2.5-flash-preview-tts"), tmp)
    elif engine == "say":
        _say(text, voice, speed, tmp)
    else:
        _edge(text, voice or "ko-KR-SunHiNeural", speed, pitch, tmp)
    tmp.replace(out)
    return _duration(out)
