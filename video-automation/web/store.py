"""설정과 프롬프트를 data/ 폴더의 JSON 파일로 보관한다."""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
OUTPUTS = DATA / "outputs"
for d in (DATA, UPLOADS, OUTPUTS):
    d.mkdir(parents=True, exist_ok=True)

PROMPTS_FILE = DATA / "prompts.json"
SETTINGS_FILE = DATA / "settings.json"
DEFAULT_PROMPTS = Path(__file__).resolve().parent / "defaults" / "prompts.json"

DEFAULT_SETTINGS = {
    "links": {
        "shorttube": "https://short.agczero.com/",
        "shorttube_shopping": "https://short.agczero.com/make/shorts-maker/shorts-adaptation",
        "shorttube_subtitle": "https://short.agczero.com/",
        "shorttube_cut": "https://short.agczero.com/",
        "shorttube_thumbnail": "https://short.agczero.com/",
        "compress": "https://www.freeconvert.com/ko/video-compressor",
        "chatgpt": "https://chatgpt.com/",
        "gemini": "https://gemini.google.com/app",
        "flow": "https://labs.google/fx/tools/flow",
        "fishaudio": "https://fish.audio/",
        "vrew_web": "https://vrew.ai/ko/",
        "taobao": "http://127.0.0.1:8420",
    },
    "gemini_key": "",
    "gemini_model": "gemini-2.5-flash",
    "gemini_tts_model": "gemini-2.5-flash-preview-tts",
    "typecast_key": "",
    "typecast_model": "ssfm-v30",
    "fish_key": "",
    "fish_model": "s2.1-pro-free",
    "fish_voices": [],
    "opening_presets": [
        "요즘 난리 난 이 제품, 과연 소문대로 좋을까요?",
        "이거 모르면 진짜 손해예요.",
        "살림 고수들은 이미 다 쓰고 있대요.",
    ],
    "outro_presets": [
        "자세한 사항은 프로필 링크를 확인해주세요.",
        "구매 링크는 고정 댓글에 있어요.",
        "저장해두고 필요할 때 꺼내보세요.",
    ],
}
SETTING_KEYS = ["gemini_key", "gemini_model", "gemini_tts_model", "typecast_key", "typecast_model",
                "fish_key", "fish_model"]
LIST_KEYS = ["opening_presets", "outro_presets"]

_lock = threading.Lock()


def _read(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------- 설정

def get_settings() -> dict:
    saved = _read(SETTINGS_FILE, {})
    links = {**DEFAULT_SETTINGS["links"], **saved.get("links", {})}
    return {**DEFAULT_SETTINGS, **saved, "links": links}


def save_settings(data: dict) -> dict:
    with _lock:
        cur = get_settings()
        links = {k: str(v).strip() for k, v in (data.get("links") or {}).items() if isinstance(v, str)}
        cur["links"].update(links)
        for k in SETTING_KEYS:
            if isinstance(data.get(k), str):
                cur[k] = data[k].strip()
        for k in LIST_KEYS:
            if isinstance(data.get(k), list):
                cur[k] = [str(x).strip() for x in data[k] if str(x).strip()][:30]
        if isinstance(data.get("fish_voices"), list):
            cur["fish_voices"] = [
                {"name": str(v.get("name", "")).strip()[:30] or "내 목소리", "id": str(v.get("id", "")).strip()[:80],
                 "gender": "male" if v.get("gender") == "male" else "female"}
                for v in data["fish_voices"] if isinstance(v, dict) and str(v.get("id", "")).strip()][:30]
        _write(SETTINGS_FILE, cur)
    return cur


# ---------------------------------------------------------------- 프롬프트

def _clean(p: dict) -> dict:
    return {
        "title": str(p.get("title", "")).strip()[:120] or "제목 없음",
        "category": str(p.get("category", "")).strip()[:30] or "기타",
        "target": str(p.get("target", "none")).strip()[:20] or "none",
        "body": str(p.get("body", "")),
        "pinned": bool(p.get("pinned", False)),
    }


SEEDED_FILE = DATA / "seeded.json"


def list_prompts() -> list[dict]:
    """처음에는 기본 프롬프트를 넣고, 나중에 추가된 기본 프롬프트도 한 번씩만 채워 넣는다."""
    with _lock:
        seed = _read(DEFAULT_PROMPTS, [])
        items = _read(PROMPTS_FILE, []) if PROMPTS_FILE.exists() else []
        seeded = set(_read(SEEDED_FILE, []))
        if not PROMPTS_FILE.exists():
            seeded = set()
        now = time.time()
        changed = not PROMPTS_FILE.exists()
        for p in seed:
            key = p.get("key") or p.get("title")
            if key in seeded:
                continue
            if PROMPTS_FILE.exists() and not p.get("key"):
                seeded.add(key)  # 예전 버전에서 이미 넣었던 기본 프롬프트
                continue
            items.append({"id": uuid.uuid4().hex[:12], **_clean(p), "updated": now})
            seeded.add(key)
            changed = True
        if changed:
            _write(PROMPTS_FILE, items)
        _write(SEEDED_FILE, sorted(seeded))
        return items


def add_prompt(p: dict) -> dict:
    items = list_prompts()
    item = {"id": uuid.uuid4().hex[:12], **_clean(p), "updated": time.time()}
    with _lock:
        items.append(item)
        _write(PROMPTS_FILE, items)
    return item


def update_prompt(pid: str, p: dict) -> dict | None:
    items = list_prompts()
    with _lock:
        for i, it in enumerate(items):
            if it["id"] == pid:
                items[i] = {"id": pid, **_clean({**it, **p}), "updated": time.time()}
                _write(PROMPTS_FILE, items)
                return items[i]
    return None


def delete_prompt(pid: str) -> bool:
    items = list_prompts()
    with _lock:
        rest = [it for it in items if it["id"] != pid]
        if len(rest) == len(items):
            return False
        _write(PROMPTS_FILE, rest)
    return True


def import_prompts(data: list, replace: bool) -> int:
    if not isinstance(data, list):
        raise ValueError("프롬프트 백업 파일 형식이 아닙니다.")
    items = [] if replace else list_prompts()
    now = time.time()
    added = [{"id": uuid.uuid4().hex[:12], **_clean(p), "updated": now} for p in data if isinstance(p, dict)]
    with _lock:
        _write(PROMPTS_FILE, items + added)
    return len(added)
