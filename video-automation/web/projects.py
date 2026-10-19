"""'영상 만들기' 프로젝트: 저장, 자막 장면 나누기, 목소리 묶음, 타임라인 계산, AI 분석, 렌더링."""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import media, store, tts

PROJECTS = store.DATA / "projects"
PROJECTS.mkdir(parents=True, exist_ok=True)
LAYOUTS_FILE = store.DATA / "layouts.json"
PID_RE = re.compile(r"^[0-9a-f]{12}$")
W, H, FPS = 1080, 1920, 30
GAP = 0.18          # 문장(목소리 묶음) 사이 쉼
MIN_SCENE = 0.45    # 장면 최소 길이(초)
_lock = threading.Lock()


# ================================================================ 저장

def _pfile(pid: str) -> Path:
    if not PID_RE.match(pid or ""):
        raise ValueError("잘못된 작업 번호입니다.")
    return PROJECTS / f"{pid}.json"


def pdir(pid: str) -> Path:
    _pfile(pid)
    d = PROJECTS / pid
    d.mkdir(parents=True, exist_ok=True)
    return d


def default_layout() -> dict:
    return {
        "name": "기본 캔버스 레이아웃",
        "bg": "#000000",
        "layers": [  # 앞(위)에 그려지는 것이 먼저
            {"id": "sub", "type": "subtitle", "name": "기본 자막", "base": True, "visible": True,
             "x": 40, "y": 1240, "w": 1000, "h": 260, "text": "",
             "font": "Pretendard", "size": 72, "weight": 800, "color": "#ffffff", "align": "center",
             "underline": False, "lineHeight": 1.25,
             "bgColor": "#000000", "bgTransparent": True, "bgOpacity": 70, "bgPad": 18, "bgRadius": 16,
             "shadow": True, "shadowBlur": 12, "shadowOpacity": 80, "shadowDist": 3, "shadowAngle": 45,
             "shadowColor": "#000000", "stroke": 6, "strokeColor": "#000000"},
            {"id": "video", "type": "video", "name": "기본 이미지/에셋 (원본 영상)", "base": True,
             "visible": True, "x": 0, "y": 0, "w": W, "h": H, "radius": 0},
        ],
    }


def layout_presets() -> list[dict]:
    top = default_layout()
    top["name"] = "상단 제목 + 가운데 영상"
    top["bg"] = "#000000"
    top["layers"] = [
        {**top["layers"][0], "y": 1430, "h": 240},
        {"id": "title", "type": "subtitle", "name": "상단 제목", "base": False, "visible": True,
         "x": 40, "y": 150, "w": 1000, "h": 300, "text": "{제목}",
         "font": "Black Han Sans", "size": 96, "weight": 400, "color": "#ffffff", "align": "center",
         "underline": False, "lineHeight": 1.2, "bgColor": "#000000", "bgTransparent": True, "bgOpacity": 70,
         "bgPad": 18, "bgRadius": 16, "shadow": False, "shadowBlur": 10, "shadowOpacity": 80,
         "shadowDist": 3, "shadowAngle": 45, "shadowColor": "#000000", "stroke": 0, "strokeColor": "#000000"},
        {**top["layers"][1], "x": 0, "y": 480, "w": 1080, "h": 960},
    ]
    builtin = [{"id": "builtin-basic", "name": "기본 캔버스 레이아웃", "builtin": True, "layout": default_layout()},
               {"id": "builtin-top", "name": "상단 제목 + 가운데 영상", "builtin": True, "layout": top}]
    custom = store._read(LAYOUTS_FILE, [])
    return builtin + [c for c in custom if isinstance(c, dict)]


def save_layout_preset(name: str, layout: dict) -> dict:
    with _lock:
        custom = store._read(LAYOUTS_FILE, [])
        item = {"id": uuid.uuid4().hex[:10], "name": (name or "새로운 레이아웃")[:40],
                "layout": {**layout, "name": (name or "새로운 레이아웃")[:40]}}
        custom.append(item)
        store._write(LAYOUTS_FILE, custom)
    return item


def delete_layout_preset(lid: str) -> None:
    with _lock:
        custom = [c for c in store._read(LAYOUTS_FILE, []) if c.get("id") != lid]
        store._write(LAYOUTS_FILE, custom)


def new_project(name: str = "") -> dict:
    pid = uuid.uuid4().hex[:12]
    now = time.time()
    p = {
        "id": pid, "name": name or time.strftime("영상 %m월 %d일 %H:%M"), "created": now, "updated": now,
        "step": 1, "maxStep": 1, "title": "",
        "clips": [], "ad": False,
        "script": {"tab": "ai", "engine": "gemini", "presetId": "", "titlePresetId": "", "memo": "",
                   "opening": "", "outro": "자세한 사항은 프로필 링크를 확인해주세요.", "manual": "",
                   "view": "settings"},
        "tts": {"engine": "edge", "voice": "ko-KR-SunHiNeural", "style": "basic", "speed": 1.0, "pitch": 0},
        "scenes": [],
        "layout": default_layout(),
        "origVolume": 0,
        "fitVideo": "stretch",
        "render": None,
    }
    save(p)
    return p


def load(pid: str) -> dict:
    f = _pfile(pid)
    if not f.exists():
        raise FileNotFoundError("작업을 찾을 수 없습니다.")
    return json.loads(f.read_text(encoding="utf-8"))


def save(p: dict) -> dict:
    f = _pfile(p.get("id", ""))
    p["updated"] = time.time()
    with _lock:
        store._write(f, p)
    return p


def list_projects() -> list[dict]:
    out = []
    for f in sorted(PROJECTS.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            p = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not p.get("clips") and time.time() - float(p.get("updated") or 0) > 1800:
            delete(p["id"])  # 영상도 안 올린 채 30분 넘게 둔 빈 작업은 정리
            continue
        clip = (p.get("clips") or [{}])[0]
        out.append({"id": p["id"], "name": p.get("name"), "updated": p.get("updated"), "step": p.get("step", 1),
                    "clips": len(p.get("clips") or []), "scenes": len(p.get("scenes") or []),
                    "poster": clip.get("poster"), "render": (p.get("render") or {}).get("url")})
    return out


def delete(pid: str) -> None:
    _pfile(pid).unlink(missing_ok=True)
    shutil.rmtree(PROJECTS / pid, ignore_errors=True)


# ================================================================ 자막 장면 나누기 (7~12자)

SENT_END = re.compile(r"(?<=[.!?…~。！？])\s+|\n+")


def _clen(s: str) -> int:
    return len(re.sub(r"\s", "", s))


def split_subtitles(text: str, lo: int = 7, hi: int = 12) -> list[str]:
    """대본을 7~12자 정도의 자연스러운 호흡 단위로 나눈다. 문장부호와 줄바꿈을 우선 기준으로 쓴다."""
    out: list[str] = []
    for sent in SENT_END.split(text or ""):
        sent = sent.strip()
        if not sent:
            continue
        # 쉼표 뒤도 호흡 후보
        parts = [x.strip() for x in re.split(r"(?<=[,，、])\s*", sent) if x.strip()]
        for part in parts:
            words = part.split()
            cur = ""
            for w in words:
                while _clen(w) > hi + 3:  # 너무 긴 단어(띄어쓰기 없는 문장)는 글자 단위로 자른다
                    if cur:
                        out.append(cur)
                        cur = ""
                    out.append(w[:hi])
                    w = w[hi:]
                cand = (cur + " " + w).strip()
                if cur and _clen(cand) > hi:
                    out.append(cur)
                    cur = w
                else:
                    cur = cand
            if cur:
                out.append(cur)
    # 너무 짧은 조각은 앞 조각과 합친다
    merged: list[str] = []
    for c in out:
        if merged and _clen(c) < lo - 3 and _clen(merged[-1]) + _clen(c) <= hi + 3 \
                and not re.search(r"[.!?…~]$", merged[-1]):
            merged[-1] = merged[-1] + " " + c
        else:
            merged.append(c)
    return merged


def _sid() -> str:
    return uuid.uuid4().hex[:8]


def segments(p: dict) -> list[dict]:
    """1단계에서 정한 클립 사용 구간을 순서대로 나열한다."""
    segs, t = [], 0.0
    for i, c in enumerate(p.get("clips") or []):
        a = float(c.get("in", 0))
        b = float(c.get("out") or c.get("duration") or 0)
        if b - a < 0.1:
            continue
        segs.append({"clip": i, "a": a, "b": b, "len": b - a, "t0": t})
        t += b - a
    return segs


def scenes_from_lines(p: dict, lines: list[dict]) -> list[dict]:
    """[{text, original?, clip?}] → 장면 목록. clip이 없으면 글자 수 비율로 클립에 배분."""
    segs = segments(p)
    n_clips = max(1, len(p.get("clips") or []))
    total_chars = sum(max(1, _clen(l.get("text", ""))) for l in lines) or 1
    total_len = sum(s["len"] for s in segs) or 1
    acc = 0
    out = []
    for l in lines:
        clip = l.get("clip")
        if not isinstance(clip, int) or not (0 <= clip < n_clips):
            mid = (acc + max(1, _clen(l.get("text", ""))) / 2) / total_chars * total_len
            clip = 0
            for s in segs:
                if s["t0"] <= mid:
                    clip = s["clip"]
        acc += max(1, _clen(l.get("text", "")))
        out.append({"id": _sid(), "clip": clip, "text": l.get("text", "").strip(),
                    "original": (l.get("original") or "").strip(), "voice": None, "extra": {}, "hide": []})
    return out


def split_manual(p: dict, text: str, opening: str = "", outro: str = "") -> list[dict]:
    lines = [{"text": t} for t in split_subtitles(text)]
    lines = _with_ments(lines, opening, outro)
    return scenes_from_lines(p, lines)


def _with_ments(lines: list[dict], opening: str, outro: str) -> list[dict]:
    n_clips_last = None
    if lines:
        n_clips_last = lines[-1].get("clip")
    if opening and opening.strip():
        first_clip = lines[0].get("clip") if lines else 0
        lines = [{"text": t, "original": "(오프닝 멘트)", "clip": first_clip if isinstance(first_clip, int) else None}
                 for t in split_subtitles(opening)] + lines
    if outro and outro.strip():
        lines = lines + [{"text": t, "original": "(아웃트로 멘트)", "clip": n_clips_last}
                         for t in split_subtitles(outro)]
    return lines


def parse_ai_result(p: dict, raw: str, opening: str = "", outro: str = "") -> dict:
    """AI가 돌려준 JSON(또는 그냥 글)을 장면 목록으로 바꾼다."""
    raw = (raw or "").strip()
    title, lines = "", []
    m = re.search(r"\{.*\}", raw, re.S)
    data = None
    if m:
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            data = None
    if isinstance(data, dict) and isinstance(data.get("scenes"), list):
        title = str(data.get("title") or "").strip()
        n = max(1, len(p.get("clips") or []))
        for s in data["scenes"]:
            if not isinstance(s, dict):
                continue
            text = str(s.get("text") or s.get("line") or "").strip()
            if not text:
                continue
            try:
                clip = int(s.get("clip", 1)) - 1
            except (TypeError, ValueError):
                clip = None
            if clip is not None and not (0 <= clip < n):
                clip = n - 1 if clip >= n else 0
            pieces = split_subtitles(text) if _clen(text) > 15 else [text]
            for k, t in enumerate(pieces):
                lines.append({"text": t, "original": str(s.get("original") or "").strip() if k == 0 else "",
                              "clip": clip})
    else:  # 그냥 대본 글을 붙여넣은 경우
        body = re.sub(r"```.*?\n|```", "", raw)
        lines = [{"text": t} for t in split_subtitles(body)]
    if not lines:
        raise ValueError("대본을 찾지 못했어요. AI 답변 전체를 그대로 붙여넣어 주세요.")
    lines = _with_ments(lines, opening, outro)
    return {"title": title, "scenes": scenes_from_lines(p, lines)}


# ================================================================ AI 프롬프트

def ai_prompt(p: dict, preset_body: str, title_body: str, mode: str) -> str:
    segs = segments(p)
    total = sum(s["len"] for s in segs)
    clip_lines = "\n".join(
        f"- 클립 {s['clip'] + 1}: 이어 붙인 영상의 {s['t0']:.1f}초 ~ {s['t0'] + s['len']:.1f}초 ({s['len']:.1f}초)"
        for s in segs)
    memo = (p.get("script") or {}).get("memo", "").strip()
    source = ("첨부한 영상은 아래 클립들을 순서대로 이어 붙인 것이야. 화면과 말소리를 모두 참고해."
              if mode == "gemini" else
              "첨부한 이미지는 아래 클립들의 장면 캡처야. 각 칸 아래에 '#클립번호 시간'(예: #2 3.0s)이 적혀 있어.")
    original_rule = ("영상 속 원래 말소리(중국어 등)를 한국어로 옮겨 그 장면의 original에 적어. 말소리가 없으면 화면 설명을 짧게 적어."
                     if mode == "gemini" else "그 장면에 보이는 화면을 짧게 설명해 original에 적어.")
    target_chars = int(total * 4.2)
    return f"""너는 한국 쇼핑 숏츠 대본 각색 전문가야.

[영상 정보]
{source}
{clip_lines}
- 전체 길이: {total:.1f}초
{('- 상품/영상 메모: ' + memo) if memo else ''}

[각색 지시]
{preset_body.strip() or '원본 영상 내용을 바탕으로 시청자가 끝까지 보게 만드는 자연스러운 한국어 쇼핑 숏츠 대본을 써줘.'}

[작업 방법]
1. {original_rule}
2. 각색 지시에 맞춰 새 한국어 숏츠 대본을 써. 클립 순서와 화면 내용이 대사와 맞아야 해.
3. 대본을 7~12자 정도의 자연스러운 호흡 단위 자막 장면으로 나눠. 장면마다 그 내용이 화면에 나오는 클립 번호(clip)를 적어.
4. 전체 대사는 약 {target_chars}자 (읽었을 때 영상 길이와 비슷하게, 1초에 4~5글자).
5. 오프닝 멘트와 아웃트로 멘트는 프로그램이 따로 넣으니 쓰지 마.
6. 제목: {title_body.strip() or '클릭하고 싶은 20자 이내 숏츠 제목 1개'}

[출력 형식] 설명 없이 JSON만 출력해.
{{"title": "제목", "scenes": [{{"clip": 1, "original": "원본 대사 또는 화면 설명", "text": "새 자막(7~12자)"}}]}}"""


def storyboard(p: dict) -> Path:
    """ChatGPT에 올릴 장면 캡처 한 장 (클립별로 1.5초 간격 캡처)."""
    segs = segments(p)
    if not segs:
        raise ValueError("1단계에서 영상을 먼저 올려 주세요.")
    out_dir = pdir(p["id"]) / "analysis"
    out_dir.mkdir(exist_ok=True)
    frames = []
    for s in segs:
        clip = p["clips"][s["clip"]]
        src = store.UPLOADS / clip["id"]
        n = max(2, min(8, int(s["len"] / 1.5) + 1))
        for k in range(n):
            t = s["a"] + s["len"] * (k + 0.5) / n
            f = out_dir / f"f_{s['clip']}_{k}.jpg"
            subprocess.run([media.ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(src),
                            "-frames:v", "1", "-vf", "scale=-2:360", str(f)], capture_output=True)
            if f.exists():
                frames.append((f, f"#{s['clip'] + 1}  {t - s['a']:.1f}s"))
    if not frames:
        raise RuntimeError("장면 캡처를 만들지 못했습니다.")
    cols = 6 if len(frames) > 12 else 4
    cw, ch = 220, 300
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGB", (cols * cw, rows * (ch + 34)), "white")
    draw = ImageDraw.Draw(sheet)
    font = _font(22)
    for i, (f, label) in enumerate(frames):
        im = Image.open(f).convert("RGB")
        im.thumbnail((cw - 8, ch - 8))
        x, y = (i % cols) * cw, (i // cols) * (ch + 34)
        sheet.paste(im, (x + (cw - im.width) // 2, y + 4))
        draw.text((x + 8, y + ch + 4), label, fill="black", font=font)
        f.unlink(missing_ok=True)
    out = out_dir / "storyboard.jpg"
    sheet.save(out, quality=88)
    return out


def _font(size: int):
    for cand in ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
                 "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
                 "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]:
        if Path(cand).exists():
            try:
                return ImageFont.truetype(cand, size)
            except Exception:
                pass
    return ImageFont.load_default()


def analysis_video(p: dict, out: Path, progress) -> float:
    """사용 구간을 이어 붙인 분석용 저화질 영상 (소리 포함)."""
    segs = segments(p)
    if not segs:
        raise ValueError("1단계에서 영상을 먼저 올려 주세요.")
    args = [media.ffmpeg_bin(), "-y", "-v", "error"]
    parts = []
    for k, s in enumerate(segs):
        clip = p["clips"][s["clip"]]
        src = store.UPLOADS / clip["id"]
        args += ["-ss", f"{s['a']:.3f}", "-t", f"{s['len']:.3f}", "-i", str(src)]
        info = media.probe(src)
        parts.append(f"[{k}:v]setpts=PTS-STARTPTS,scale=-2:480,fps=15,setsar=1,"
                     f"pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=480:854:force_original_aspect_ratio=decrease,"
                     f"pad=480:854:(ow-iw)/2:(oh-ih)/2[v{k}]")
        if info["has_audio"]:
            parts.append(f"[{k}:a]asetpts=PTS-STARTPTS,aresample=16000,aformat=channel_layouts=mono[a{k}]")
        else:
            parts.append(f"anullsrc=r=16000:cl=mono,atrim=0:{s['len']:.3f}[a{k}]")
    n = len(segs)
    parts.append("".join(f"[v{k}][a{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=1[v][a]")
    args += ["-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]", "-c:v", "libx264",
             "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "64k", str(out)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"분석용 영상 만들기 실패: {r.stderr[-300:]}")
    return sum(s["len"] for s in segs)


def gemini_analyze(p: dict, prompt: str, key: str, model: str, progress) -> str:
    if not key:
        raise RuntimeError("설정에서 Gemini API 키(무료)를 넣거나, 'ChatGPT로 만들기'를 골라 주세요.")
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise RuntimeError("google-genai가 설치되지 않았습니다. 터미널에서 pip install -r requirements.txt 를 다시 실행해 주세요.")
    progress(0.08, "1단계: 비디오 클립 사전 통합 병합 중...")
    vid = pdir(p["id"]) / "analysis" / "merged.mp4"
    vid.parent.mkdir(exist_ok=True)
    analysis_video(p, vid, progress)
    progress(0.2, "2단계: AI 멀티모달 이해 기반 전체 대본 구성 중... (영상 올리는 중)")
    client = genai.Client(api_key=key)
    f = client.files.upload(file=str(vid))
    for _ in range(90):
        state = getattr(getattr(f, "state", None), "name", "ACTIVE")
        if state != "PROCESSING":
            break
        time.sleep(2)
        f = client.files.get(name=f.name)
    if getattr(getattr(f, "state", None), "name", "ACTIVE") == "FAILED":
        raise RuntimeError("Gemini가 영상을 처리하지 못했습니다.")
    progress(0.35, "2단계: AI 멀티모달 이해 기반 전체 대본 구성 중...")
    try:
        resp = client.models.generate_content(
            model=model or "gemini-2.5-flash", contents=[f, prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.8))
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            raise RuntimeError("Gemini 무료 사용량을 다 썼어요. 잠시 뒤 다시 하거나 'ChatGPT로 만들기'를 써 주세요.")
        raise RuntimeError(f"Gemini 오류: {msg[:300]}")
    finally:
        try:
            client.files.delete(name=f.name)
        except Exception:
            pass
    progress(0.8, "3단계: 대본을 7-12자 자연스러운 자막 장면으로 분할 정제 중...")
    return resp.text or ""


# ================================================================ 목소리 묶음과 타임라인

def _voice_of(p: dict, sc: dict) -> dict:
    base = p.get("tts") or {}
    v = sc.get("voice") or {}
    style = next((s for s in tts.STYLES if s["id"] == base.get("style")), tts.STYLES[0])
    return {"engine": v.get("engine") or base.get("engine") or "edge",
            "voice": v.get("voice") or base.get("voice") or "ko-KR-SunHiNeural",
            "speed": float(style["speed"]) * float(base.get("speed") or 1.0),
            "pitch": int(style["pitch"]) + int(base.get("pitch") or 0),
            "prompt": style.get("prompt", "")}


def voice_groups(p: dict) -> list[dict]:
    """같은 목소리로 이어지는 장면들을 문장 단위로 묶는다 (자연스러운 억양을 위해)."""
    groups: list[dict] = []
    cur = None
    for sc in p.get("scenes") or []:
        text = (sc.get("text") or "").strip()
        if not text:
            cur = None  # 빈 장면에서 문장 묶음을 끊는다
            continue
        v = _voice_of(p, sc)
        vkey = json.dumps(v, sort_keys=True)
        if cur is None or cur["vkey"] != vkey or cur["ended"] or _clen(cur["text"]) >= 45:
            cur = {"vkey": vkey, "voice": v, "scenes": [], "text": "", "ended": False}
            groups.append(cur)
        cur["scenes"].append(sc["id"])
        cur["text"] = (cur["text"] + " " + text).strip()
        cur["ended"] = bool(re.search(r"[.!?…~。！？]$", text))
    for g in groups:
        g["hash"] = hashlib.sha1((g["vkey"] + "|" + g["text"]).encode()).hexdigest()[:16]
    return groups


def _tts_index(pid: str) -> tuple[Path, dict]:
    d = pdir(pid) / "tts"
    d.mkdir(exist_ok=True)
    return d, store._read(d / "index.json", {})


def plan(p: dict) -> dict:
    """장면별 시작/길이, 목소리 파일, 영상 조각을 계산한다 (미리보기와 렌더링이 같은 계산을 쓴다)."""
    d, index = _tts_index(p["id"])
    groups = voice_groups(p)
    scenes = {sc["id"]: sc for sc in p.get("scenes") or []}
    gmap = {}
    missing = 0
    for g in groups:
        info = index.get(g["hash"])
        g["ok"] = bool(info and (d / f"{g['hash']}.mp3").exists())
        if not g["ok"]:
            missing += 1
        gd = info["dur"] if g["ok"] else max(0.8, _clen(g["text"]) / 4.5)
        g["dur"] = gd
        weights = [max(1, _clen(scenes[s]["text"])) for s in g["scenes"]]
        wsum = sum(weights)
        durs, off = [], 0.0
        for k in range(len(g["scenes"])):
            dur = max(MIN_SCENE, gd * weights[k] / wsum)
            if k == len(g["scenes"]) - 1:
                dur = max(MIN_SCENE, gd - off) + GAP
            durs.append(round(dur, 3))
            off += dur
        g["durs"] = durs
        for k, sid in enumerate(g["scenes"]):
            gmap[sid] = (g, k)
    final, groups_out, t = [], [], 0.0
    for sc in p.get("scenes") or []:
        sid = sc["id"]
        if sid in gmap:
            g, k = gmap[sid]
            if k == 0:
                g["start"] = t
                if g["ok"]:
                    groups_out.append({"hash": g["hash"], "start": round(t, 3), "dur": g["dur"],
                                       "audio": f"/files/projects/{p['id']}/tts/{g['hash']}.mp3"})
            dur = g["durs"][k]
            x = {"id": sid, "start": round(t, 3), "dur": dur, "group": g["hash"],
                 "goff": round(sum(g["durs"][:k]), 3), "gstart": round(g.get("start", t), 3), "ready": g["ok"],
                 "audio": f"/files/projects/{p['id']}/tts/{g['hash']}.mp3" if g["ok"] else None}
        else:  # 대사가 빈 장면은 화면만 1초
            dur = 1.0
            x = {"id": sid, "start": round(t, 3), "dur": dur, "group": None, "goff": 0, "gstart": round(t, 3),
                 "ready": True, "audio": None}
        x["clip"] = sc.get("clip", 0)
        final.append(x)
        t += dur
    return {"total": round(t, 3), "scenes": final, "groups": groups_out, "missing": missing,
            "pieces": video_pieces(p, final), "segments": segments(p)}


def video_pieces(p: dict, timeline: list[dict]) -> list[dict]:
    """장면 → 영상 조각. 클립마다 맡은 장면 길이에 맞춰 속도를 조절하고(0.5~2배), 모자라면 반복한다."""
    segs = {s["clip"]: s for s in segments(p)}
    if not segs:
        return []
    need: dict[int, float] = {}
    for x in timeline:
        c = x["clip"] if x["clip"] in segs else next(iter(segs))
        need[c] = need.get(c, 0) + x["dur"]
    speed = {}
    for c, dsum in need.items():
        L = segs[c]["len"]
        sp = L / dsum if dsum > 0 else 1
        speed[c] = max(0.5, min(2.0, sp)) if p.get("fitVideo", "stretch") == "stretch" else 1.0
    cursor = {c: 0.0 for c in segs}
    pieces = []
    for x in timeline:
        c = x["clip"] if x["clip"] in segs else next(iter(segs))
        s = segs[c]
        remain, t = x["dur"], x["start"]
        while remain > 1e-3:
            src_left = s["len"] - cursor[c]
            if src_left < 0.05:
                cursor[c] = 0.0
                src_left = s["len"]
            out_len = min(remain, src_left / speed[c])
            pieces.append({"clip": c, "start": round(t, 3), "dur": round(out_len, 3),
                           "src": round(s["a"] + cursor[c], 3), "speed": round(speed[c], 4), "scene": x["id"]})
            cursor[c] += out_len * speed[c]
            remain -= out_len
            t += out_len
    return pieces


def forget_voices(p: dict) -> None:
    """지금 대본의 목소리 파일을 지워 다음에 새로 만들게 한다."""
    d, index = _tts_index(p["id"])
    for g in voice_groups(p):
        index.pop(g["hash"], None)
        (d / f"{g['hash']}.mp3").unlink(missing_ok=True)
    store._write(d / "index.json", index)


def synth_missing(p: dict, settings: dict, progress) -> None:
    d, index = _tts_index(p["id"])
    groups = [g for g in voice_groups(p) if not (index.get(g["hash"]) and (d / f"{g['hash']}.mp3").exists())]
    for k, g in enumerate(groups):
        progress(k / max(1, len(groups)), f"목소리 만드는 중 ({k + 1}/{len(groups)}): {g['text'][:20]}…")
        v = g["voice"]
        dur = tts.synthesize(g["text"], v["engine"], v["voice"], v["speed"], v["pitch"], settings,
                             d / f"{g['hash']}.mp3", v.get("prompt", ""))
        index[g["hash"]] = {"dur": round(dur, 3), "text": g["text"]}
        store._write(d / "index.json", index)


# ================================================================ 렌더링

def _place(vw: int, vh: int, bw: int, bh: int, clip: dict) -> tuple[int, int, int, int]:
    """클립의 화면 맞춤 설정으로 영상이 상자 안에서 차지할 크기와 위치."""
    fit = clip.get("fit", "cover")
    zoom = float(clip.get("zoom", 1) or 1)
    ox, oy = float(clip.get("ox", 0) or 0), float(clip.get("oy", 0) or 0)
    base = min(bw / vw, bh / vh) if fit == "contain" else max(bw / vw, bh / vh)
    sw, sh = vw * base * zoom, vh * base * zoom
    if fit == "custom":
        x = (bw - sw) / 2 + ox / 100 * bw / 2
        y = (bh - sh) / 2 + oy / 100 * bh / 2
    else:
        x = (bw - sw) / 2 + ox / 100 * abs(bw - sw) / 2
        y = (bh - sh) / 2 + oy / 100 * abs(bh - sh) / 2
    ev = lambda v: int(round(v / 2) * 2)  # noqa: E731
    return max(2, ev(sw)), max(2, ev(sh)), int(round(x)), int(round(y))


def _atempo(speed: float) -> str:
    parts, s = [], speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    parts.append(f"atempo={s:.4f}")
    return ",".join(parts)


def render(p: dict, settings: dict, frames: list[dict], frame_dir: Path, progress) -> Path:
    """frames: [{scene, under, over}] - 브라우저가 그려 보낸 장면별 레이어 그림."""
    progress(0.02, "목소리 확인 중")
    synth_missing(p, settings, lambda f, m: progress(0.02 + f * 0.18, m))
    pl = plan(p)
    if not pl["scenes"]:
        raise RuntimeError("장면이 없습니다. 2단계에서 대본을 만들어 주세요.")
    work = pdir(p["id"]) / "render_tmp"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    vlayer = next((l for l in p["layout"]["layers"] if l.get("type") == "video"), None) or \
        {"x": 0, "y": 0, "w": W, "h": H, "visible": True}
    bw, bh = max(2, int(vlayer["w"]) // 2 * 2), max(2, int(vlayer["h"]) // 2 * 2)
    show_video = vlayer.get("visible", True)
    keep_audio = float(p.get("origVolume") or 0) > 0
    infos = {}
    piece_files = []
    n = len(pl["pieces"])
    for k, pc in enumerate(pl["pieces"]):
        progress(0.2 + 0.45 * k / max(1, n), f"영상 조각 만드는 중 ({k + 1}/{n})")
        clip = p["clips"][pc["clip"]]
        src = store.UPLOADS / clip["id"]
        if pc["clip"] not in infos:
            infos[pc["clip"]] = media.probe(src)
        info = infos[pc["clip"]]
        sw, sh, x, y = _place(info["width"] or 1080, info["height"] or 1920, bw, bh, clip)
        src_len = pc["dur"] * pc["speed"]
        out = work / f"p{k:04d}.mp4"
        vf = (f"color=c=black:s={bw}x{bh}:r={FPS}:d={pc['dur']:.3f}[bg];"
              f"[0:v]setpts=(PTS-STARTPTS)/{pc['speed']:.4f},scale={sw}:{sh},setsar=1[fg];"
              f"[bg][fg]overlay={x}:{y}:shortest=1,fps={FPS},format=yuv420p[v]")
        if keep_audio and info["has_audio"]:
            vf += f";[0:a]asetpts=PTS-STARTPTS,{_atempo(pc['speed'])},aresample=48000,aformat=channel_layouts=stereo,apad[a]"
        else:
            vf += ";anullsrc=r=48000:cl=stereo[a]"
        args = [media.ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{pc['src']:.3f}", "-t", f"{src_len + 0.1:.3f}",
                "-i", str(src), "-filter_complex", vf, "-map", "[v]", "-map", "[a]", "-t", f"{pc['dur']:.3f}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "128k",
                "-ar", "48000", str(out)]
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"영상 조각 만들기 실패: {r.stderr[-300:]}")
        piece_files.append(out)
    (work / "pieces.txt").write_text("".join(f"file '{f.name}'\n" for f in piece_files))

    progress(0.68, "목소리 트랙 만드는 중")
    tl = pl["scenes"]
    voice = work / "voice.wav"
    args = [media.ffmpeg_bin(), "-y", "-v", "error"]
    filt, labels = [], []
    tts_dir = pdir(p["id"]) / "tts"
    k = 0
    for g in pl["groups"]:
        args += ["-i", str(tts_dir / f"{g['hash']}.mp3")]
        ms = int(round(g["start"] * 1000))
        filt.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[g{k}]")
        labels.append(f"[g{k}]")
        k += 1
    if labels:
        filt.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:duration=longest,"
                    f"apad,atrim=0:{pl['total']:.3f}[out]")
    else:
        filt.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{pl['total']:.3f}[out]")
    args += ["-filter_complex", ";".join(filt), "-map", "[out]", str(voice)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"목소리 트랙 만들기 실패: {r.stderr[-300:]}")

    progress(0.74, "자막·레이어 합치는 중")
    fmap = {f["scene"]: f for f in frames}
    for kind in ("under", "over"):
        lines = []
        last = None
        for x in tl:
            f = fmap.get(x["id"], {}).get(kind)
            path = (frame_dir / f) if f else None
            if not path or not path.exists():
                path = work / "blank.png"
                if not path.exists():
                    Image.new("RGBA", (W, H), (0, 0, 0, 0)).save(path)
            lines.append(f"file '{path.resolve()}'\nduration {x['dur']:.3f}\n")
            last = path
        lines.append(f"file '{last.resolve()}'\n")
        (work / f"{kind}.txt").write_text("".join(lines))

    progress(0.78, "최종 영상 만드는 중 (조금 걸려요)")
    out_dir = pdir(p["id"]) / "renders"
    out_dir.mkdir(exist_ok=True)
    safe = re.sub(r"[\\/:*?\"<>|\s]+", "_", p.get("name") or "영상").strip("._")[:40] or "영상"
    final = out_dir / f"{safe}_{time.strftime('%m%d_%H%M%S')}.mp4"
    bg = (p["layout"].get("bg") or "#000000").lstrip("#")
    vx, vy = int(vlayer["x"]), int(vlayer["y"])
    ov = float(p.get("origVolume") or 0) / 100
    fc = (f"color=c=0x{bg}:s={W}x{H}:r={FPS}:d={pl['total']:.3f}[base];"
          f"[1:v]format=rgba,fps={FPS}[u];[2:v]format=rgba,fps={FPS}[o];"
          f"[base][u]overlay=0:0:eof_action=repeat[b1];")
    if show_video:
        fc += f"[0:v]setpts=PTS-STARTPTS[vid];[b1][vid]overlay={vx}:{vy}:eof_action=repeat[b2];"
    else:
        fc += "[b1]null[b2];"
    fc += f"[b2][o]overlay=0:0:eof_action=repeat,format=yuv420p[v];"
    if ov > 0:
        fc += f"[0:a]volume={ov:.2f}[oa];[3:a][oa]amix=inputs=2:normalize=0:duration=first[a]"
    else:
        fc += "[3:a]anull[a]"
    args = [media.ffmpeg_bin(), "-y", "-v", "error",
            "-f", "concat", "-safe", "0", "-i", str(work / "pieces.txt"),
            "-f", "concat", "-safe", "0", "-i", str(work / "under.txt"),
            "-f", "concat", "-safe", "0", "-i", str(work / "over.txt"),
            "-i", str(voice),
            "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", f"{pl['total']:.3f}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"최종 영상 만들기 실패: {r.stderr[-400:]}")
    shutil.rmtree(work, ignore_errors=True)
    return final
