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
        "shorttube_compress": "https://short.agczero.com/",
        "chatgpt": "https://chatgpt.com/",
        "gemini": "https://gemini.google.com/app",
        "flow": "https://labs.google/fx/tools/flow",
        "fishaudio": "https://fish.audio/",
        "vrew_web": "https://vrew.ai/ko/",
        "taobao": "http://127.0.0.1:8420",
    },
}

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


def list_prompts() -> list[dict]:
    with _lock:
        if not PROMPTS_FILE.exists():
            seed = _read(DEFAULT_PROMPTS, [])
            now = time.time()
            items = [{"id": uuid.uuid4().hex[:12], **_clean(p), "updated": now} for p in seed]
            _write(PROMPTS_FILE, items)
        return _read(PROMPTS_FILE, [])


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
