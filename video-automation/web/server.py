"""영상 작업실 로컬 서버.  실행:  python -m web.server   →  http://127.0.0.1:8421"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from pathlib import Path

import hashlib
import json

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import capcut, media, projects, store, thumbs, tts

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8421"))
STATIC = Path(__file__).resolve().parent / "static"
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
ID_RE = re.compile(r"^[0-9a-f]{32}\.(jpg|png|mp4|mov|m4v|webm|mkv|avi)$")

app = FastAPI(title="영상 작업실")


# ---------------------------------------------------------------- 공통

def _upload_path(fid: str) -> Path:
    if not ID_RE.match(fid or ""):
        raise HTTPException(400, "잘못된 파일입니다.")
    p = store.UPLOADS / fid
    if not p.exists():
        raise HTTPException(404, "업로드한 파일을 찾을 수 없습니다. 다시 올려 주세요.")
    return p


def _span(word: str, idx: list[int]) -> str:
    return f"{word} {idx[0] + 1}" if len(idx) == 1 else f"{word} {idx[0] + 1}~{idx[-1] + 1}"


def _safe_name(name: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|\s]+", "_", name).strip("._")
    return name[:40] or "영상"


@app.exception_handler(Exception)
async def _err(_, exc: Exception):
    return JSONResponse({"detail": str(exc)}, status_code=500)


# ---------------------------------------------------------------- 설정 / 프롬프트

@app.get("/api/settings")
def get_settings():
    return store.get_settings()


@app.put("/api/settings")
def put_settings(data: dict):
    before = store.get_settings()
    after = store.save_settings(data)
    if (before.get("typecast_key"), before.get("typecast_model")) != (after.get("typecast_key"), after.get("typecast_model")):
        tts.TYPECAST_CACHE.unlink(missing_ok=True)  # 키나 모델이 바뀌면 목소리 목록을 새로 받는다
    return after


@app.get("/api/prompts")
def prompts():
    return store.list_prompts()


@app.post("/api/prompts")
def prompt_add(data: dict):
    return store.add_prompt(data)


@app.put("/api/prompts/{pid}")
def prompt_update(pid: str, data: dict):
    item = store.update_prompt(pid, data)
    if not item:
        raise HTTPException(404, "프롬프트를 찾을 수 없습니다.")
    return item


@app.delete("/api/prompts/{pid}")
def prompt_delete(pid: str):
    if not store.delete_prompt(pid):
        raise HTTPException(404, "프롬프트를 찾을 수 없습니다.")
    return {"ok": True}


@app.post("/api/prompts/import")
def prompt_import(data: dict):
    n = store.import_prompts(data.get("items"), bool(data.get("replace")))
    return {"added": n}


# ---------------------------------------------------------------- 업로드

@app.post("/api/upload")
async def upload(request: Request, files: list[UploadFile] = File(...)):
    asset = request.query_params.get("asset") == "1"
    result = []
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in IMAGE_EXT | VIDEO_EXT:
            raise HTTPException(400, f"지원하지 않는 파일입니다: {f.filename}")
        fid = uuid.uuid4().hex
        raw = store.UPLOADS / f"{fid}.raw{ext}"
        with raw.open("wb") as out:
            shutil.copyfileobj(f.file, out)
        item = {"name": f.filename}
        if ext in IMAGE_EXT:
            dst = store.UPLOADS / (f"{fid}.png" if asset else f"{fid}.jpg")
            try:
                if asset:
                    media.normalize_asset(raw, dst)
                else:
                    media.normalize_photo(raw, dst)
            finally:
                raw.unlink(missing_ok=True)
            item.update(id=dst.name, kind="image", url=f"/files/uploads/{dst.name}")
        else:
            dst = store.UPLOADS / f"{fid}{ext}"
            raw.rename(dst)
            info = media.probe(dst)
            thumb = store.UPLOADS / f"{fid}_poster.jpg"
            media.poster(dst, thumb)
            item.update(id=dst.name, kind="video", url=f"/files/uploads/{dst.name}",
                        poster=f"/files/uploads/{thumb.name}" if thumb.exists() else None,
                        duration=round(info["duration"], 2), width=info["width"], height=info["height"],
                        size_mb=round(dst.stat().st_size / 1_048_576, 1))
        result.append(item)
    return result


# ---------------------------------------------------------------- 작업 (백그라운드)

JOBS: dict[str, dict] = {}


def _start(kind: str, fn) -> dict:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "status": "running", "progress": 0.0,
           "message": "준비 중", "outputs": [], "result": None, "error": None, "started": time.time()}
    JOBS[jid] = job

    def progress(p: float, msg: str):
        job["progress"], job["message"] = round(p, 3), msg

    def run():
        try:
            fn(job, progress)
            job.update(status="done", progress=1.0, message="완료")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="error", error=str(e), message="실패")

    threading.Thread(target=run, daemon=True).start()
    return job


def _output(job: dict, path: Path, label: str) -> None:
    info = media.probe(path)
    thumb = path.with_suffix(".jpg")
    media.poster(path, thumb)
    job["outputs"].append({
        "file": path.name, "label": label, "url": f"/files/outputs/{path.name}",
        "poster": f"/files/outputs/{thumb.name}" if thumb.exists() else None,
        "duration": round(info["duration"], 2),
        "size_mb": round(path.stat().st_size / 1_048_576, 1),
    })


class PhotoItem(BaseModel):
    id: str
    motion: str = "auto"


class PhotoJob(BaseModel):
    name: str = "사진영상"
    photos: list[PhotoItem]
    ratio: str = "9:16"
    fit: str = "cover"
    seconds: float = 3.0
    output: str = "one"          # each | one | three
    transition: bool = True


@app.post("/api/jobs/photo-video")
def job_photo_video(req: PhotoJob):
    if not req.photos:
        raise HTTPException(400, "사진을 올려 주세요.")
    if req.ratio not in media.RATIOS:
        raise HTTPException(400, "화면 비율을 다시 골라 주세요.")
    paths = [_upload_path(p.id) for p in req.photos]
    seconds = max(1.0, min(15.0, req.seconds))
    stamp = time.strftime("%m%d_%H%M%S")
    base = _safe_name(req.name)

    def work(job, progress):
        clips = []
        n = len(paths)
        for i, (p, item) in enumerate(zip(paths, req.photos)):
            motion = item.motion
            if motion not in media.MOTIONS:
                motion = media.AUTO_ORDER[i % len(media.AUTO_ORDER)]
            progress(i / (n + 1), f"사진 {i + 1}/{n} 움직이는 영상으로 만드는 중")
            out = store.OUTPUTS / f"{base}_{stamp}_{i + 1:02d}.mp4"
            media.photo_to_clip(p, out, req.ratio, req.fit, seconds, motion)
            clips.append(out)
        if req.output == "each":
            for i, c in enumerate(clips):
                _output(job, c, f"{i + 1}번 사진")
            return
        groups = media.split_groups([seconds] * n, 3 if req.output == "three" else 1)
        progress(n / (n + 1), "하나로 합치는 중")
        for g, idx in enumerate(groups):
            label = f"{g + 1}번 묶음 ({_span('사진', idx)})" if len(groups) > 1 else "합친 영상"
            out = store.OUTPUTS / (f"{base}_{stamp}_합본{g + 1 if len(groups) > 1 else ''}.mp4")
            media.merge_clips([clips[k] for k in idx], out, req.ratio, "cover", 0, False, req.transition)
            _output(job, out, label)
        for c in clips:
            c.unlink(missing_ok=True)

    return _start("photo-video", work)


class MergeJob(BaseModel):
    name: str = "합친영상"
    videos: list[str]
    groups: int = 1
    ratio: str = "9:16"
    fit: str = "cover"
    max_seconds: float = 0
    keep_audio: bool = False
    transition: bool = False


def _resolve_video(fid: str) -> Path:
    if fid.startswith("out:"):  # 이 프로그램이 만든 결과물
        name = fid[4:]
        p = store.OUTPUTS / name
        if "/" in name or "\\" in name or not p.exists():
            raise HTTPException(404, "결과 파일을 찾을 수 없습니다.")
        return p
    return _upload_path(fid)


@app.post("/api/jobs/merge")
def job_merge(req: MergeJob):
    if not req.videos:
        raise HTTPException(400, "영상을 올려 주세요.")
    if req.ratio not in media.RATIOS:
        raise HTTPException(400, "화면 비율을 다시 골라 주세요.")
    paths = [_resolve_video(v) for v in req.videos]
    stamp = time.strftime("%m%d_%H%M%S")
    base = _safe_name(req.name)

    def work(job, progress):
        durs = []
        for p in paths:
            d = media.probe(p)["duration"]
            durs.append(min(d, req.max_seconds) if req.max_seconds > 0 else d)
        groups = media.split_groups(durs, max(1, min(3, req.groups)))
        for g, idx in enumerate(groups):
            progress(g / len(groups), f"{g + 1}/{len(groups)}번째 영상 합치는 중")
            label = f"{g + 1}번 묶음 ({_span('영상', idx)})" if len(groups) > 1 else "합친 영상"
            out = store.OUTPUTS / (f"{base}_{stamp}{'_' + str(g + 1) if len(groups) > 1 else ''}.mp4")
            media.merge_clips([paths[k] for k in idx], out, req.ratio, req.fit,
                              req.max_seconds, req.keep_audio, req.transition)
            _output(job, out, label)

    return _start("merge", work)


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다. 서버를 다시 켰다면 다시 실행해 주세요.")
    return job


# ---------------------------------------------------------------- 영상 만들기 (프로젝트)

def _project(pid: str) -> dict:
    try:
        return projects.load(pid)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(404, str(e))


@app.get("/api/projects")
def projects_list():
    return projects.list_projects()


@app.post("/api/projects")
def projects_new(data: dict = Body(default={})):
    return projects.new_project((data or {}).get("name", ""))


@app.get("/api/projects/{pid}")
def project_get(pid: str):
    return _project(pid)


@app.put("/api/projects/{pid}")
def project_put(pid: str, data: dict):
    _project(pid)
    data["id"] = pid
    return {"ok": True, "updated": projects.save(data)["updated"]}


@app.delete("/api/projects/{pid}")
def project_delete(pid: str):
    _project(pid)
    projects.delete(pid)
    return {"ok": True}


def _preset_body(pid_prompt: str, memo: str) -> str:
    p = next((x for x in store.list_prompts() if x["id"] == pid_prompt), None)
    if not p:
        return ""
    return re.sub(r"\{([^{}\n]{1,24})\}", lambda m: memo.strip() or "(없음)", p["body"])


@app.get("/api/projects/{pid}/prompt")
def project_prompt(pid: str, mode: str = "chatgpt"):
    p = _project(pid)
    sc = p.get("script") or {}
    return {"prompt": projects.ai_prompt(p, _preset_body(sc.get("presetId", ""), sc.get("memo", "")),
                                         _preset_body(sc.get("titlePresetId", ""), sc.get("memo", "")),
                                         "gemini" if mode == "gemini" else "chatgpt")}


@app.post("/api/projects/{pid}/storyboard")
def project_storyboard(pid: str):
    p = _project(pid)
    try:
        f = projects.storyboard(p)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"url": f"/files/projects/{pid}/analysis/{f.name}?t={int(time.time())}"}


@app.post("/api/projects/{pid}/split")
def project_split(pid: str, data: dict):
    p = _project(pid)
    if not (data.get("text") or "").strip():
        raise HTTPException(400, "대본을 입력해 주세요.")
    return {"scenes": projects.split_manual(p, data["text"], data.get("opening", ""), data.get("outro", ""))}


@app.post("/api/projects/{pid}/apply")
def project_apply(pid: str, data: dict):
    p = _project(pid)
    try:
        return projects.parse_ai_result(p, data.get("text", ""), data.get("opening", ""), data.get("outro", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/projects/{pid}/analyze")
def project_analyze(pid: str):
    p = _project(pid)
    if not projects.segments(p):
        raise HTTPException(400, "1단계에서 영상을 먼저 올려 주세요.")
    settings = store.get_settings()
    sc = p.get("script") or {}
    prompt = projects.ai_prompt(p, _preset_body(sc.get("presetId", ""), sc.get("memo", "")),
                                _preset_body(sc.get("titlePresetId", ""), sc.get("memo", "")), "gemini")

    def work(job, progress):
        raw = projects.gemini_analyze(p, prompt, settings.get("gemini_key", ""),
                                      settings.get("gemini_model", "gemini-2.5-flash"), progress)
        progress(0.9, "3단계: 대본을 7-12자 자연스러운 자막 장면으로 분할 정제 중...")
        try:
            job["result"] = projects.parse_ai_result(p, raw, sc.get("opening", ""), sc.get("outro", ""))
        except ValueError as e:
            raise RuntimeError(str(e))

    return _start("analyze", work)


@app.get("/api/projects/{pid}/plan")
def project_plan(pid: str):
    return projects.plan(_project(pid))


@app.get("/api/projects/{pid}/srt")
def project_srt(pid: str):
    return projects.srt(_project(pid))


@app.post("/api/projects/{pid}/voice")
def project_voice(pid: str, force: int = 0):
    p = _project(pid)
    settings = store.get_settings()
    if force:
        projects.forget_voices(p)

    def work(job, progress):
        projects.synth_missing(p, settings, progress)
        job["result"] = {"ok": True}

    return _start("voice", work)


@app.get("/api/voices")
def voices():
    return {"voices": tts.voices(store.get_settings()), "styles": tts.STYLES}


@app.post("/api/typecast/refresh")
def typecast_refresh():
    try:
        n = tts.typecast_refresh(store.get_settings())
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"count": n}


@app.post("/api/tts/preview")
def tts_preview(data: dict):
    settings = store.get_settings()
    style = next((x for x in tts.STYLES if x["id"] == data.get("style")), tts.STYLES[0])
    speed = float(style["speed"]) * float(data.get("speed") or 1)
    pitch = int(style["pitch"]) + int(data.get("pitch") or 0)
    text = (data.get("text") or "안녕하세요, 오늘 소개할 제품은 정말 신기한 아이템이에요.").strip()[:200]
    key = hashlib.sha1(json.dumps([data.get("engine"), data.get("voice"), speed, pitch, text,
                                   style.get("prompt")], ensure_ascii=False).encode()).hexdigest()[:16]
    d = store.DATA / "tts_preview"
    d.mkdir(exist_ok=True)
    out = d / f"{key}.mp3"
    if not out.exists():
        try:
            tts.synthesize(text, data.get("engine", "edge"), data.get("voice", ""), speed, pitch, settings, out,
                           style.get("prompt", ""), style.get("emotion", ""), float(style.get("intensity", 1.0)))
        except RuntimeError as e:
            raise HTTPException(400, str(e))
    return {"url": f"/files/tts_preview/{out.name}"}


@app.get("/api/layouts")
def layouts():
    return projects.layout_presets()


@app.post("/api/layouts")
def layout_save(data: dict):
    if not isinstance(data.get("layout"), dict):
        raise HTTPException(400, "레이아웃이 없습니다.")
    return projects.save_layout_preset(data.get("name", ""), data["layout"])


@app.delete("/api/layouts/{lid}")
def layout_delete(lid: str):
    projects.delete_layout_preset(lid)
    return {"ok": True}


@app.post("/api/projects/{pid}/render")
async def project_render(pid: str, manifest: str = Form(...), files: list[UploadFile] = File(default=[])):
    p = _project(pid)
    try:
        frames = json.loads(manifest)
    except json.JSONDecodeError:
        raise HTTPException(400, "렌더링 정보가 올바르지 않습니다.")
    fdir = projects.pdir(pid) / "frames"
    shutil.rmtree(fdir, ignore_errors=True)
    fdir.mkdir()
    for f in files:
        name = Path(f.filename or "").name
        if not re.match(r"^[a-z]+_[0-9a-zA-Z]+\.png$", name):
            continue
        with (fdir / name).open("wb") as out:
            shutil.copyfileobj(f.file, out)
    settings = store.get_settings()

    def work(job, progress):
        final = projects.render(p, settings, frames, fdir, progress)
        info = media.probe(final)
        thumb = final.with_suffix(".jpg")
        media.poster(final, thumb)
        url = f"/files/projects/{pid}/renders/{final.name}"
        result = {"url": url, "file": final.name, "duration": round(info["duration"], 2),
                  "size_mb": round(final.stat().st_size / 1_048_576, 1),
                  "poster": f"/files/projects/{pid}/renders/{thumb.name}" if thumb.exists() else None}
        cur = projects.load(pid)
        cur["render"] = result
        projects.save(cur)
        job["result"] = result

    return _start("render", work)


@app.post("/api/projects/{pid}/capcut")
async def project_capcut(pid: str, manifest: str = Form(...), files: list[UploadFile] = File(default=[])):
    """장면·자막·목소리를 캡컷 프로젝트로 만들고 캡컷을 연다."""
    p = _project(pid)
    try:
        man = json.loads(manifest)
    except json.JSONDecodeError:
        raise HTTPException(400, "내보내기 정보가 올바르지 않습니다.")
    fdir = projects.pdir(pid) / "capcut_frames"
    shutil.rmtree(fdir, ignore_errors=True)
    fdir.mkdir()
    for f in files:
        name = Path(f.filename or "").name
        if not re.match(r"^[a-z]+_[0-9a-zA-Z]+\.png$", name):
            continue
        with (fdir / name).open("wb") as out:
            shutil.copyfileobj(f.file, out)
    settings = store.get_settings()

    def work(job, progress):
        try:
            result = capcut.export(p, settings, man, fdir, progress)
        finally:
            shutil.rmtree(fdir, ignore_errors=True)
        if sys.platform == "darwin":
            result["opened"] = subprocess.run(["open", "-a", "CapCut"], capture_output=True).returncode == 0
        job["result"] = result

    return _start("capcut", work)


# ---------------------------------------------------------------- 썸네일 제작

@app.get("/api/thumb/sources")
def thumb_sources():
    return thumbs.sources()


@app.get("/api/thumb/clean")
def thumb_clean(src: str):
    try:
        return thumbs.clean_status(src)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/thumb/frame")
def thumb_frame(data: dict):
    try:
        return thumbs.frame(str(data.get("src", "")), float(data.get("t", 0)), bool(data.get("clean")))
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/thumb/save")
async def thumb_save(meta: str = Form(...), image: UploadFile = File(...)):
    try:
        m = json.loads(meta)
    except json.JSONDecodeError:
        raise HTTPException(400, "저장 정보가 올바르지 않습니다.")
    png = thumbs.new_png_path(m.get("name", ""))
    with png.open("wb") as out:
        shutil.copyfileobj(image.file, out)
    result = {"png": f"/files/thumbs/{png.name}", "png_file": png.name}
    src = str(m.get("src", ""))
    if not m.get("insert") or not src:
        job = _start("thumb", lambda job, progress: job.update(result=result))
        return job

    def work(job, progress):
        progress(0.1, "썸네일을 영상에 넣는 중")
        out = png.with_suffix(".mp4")
        try:
            dur = thumbs.with_cover(src, png, m.get("position", "start"), float(m.get("seconds", 0.1)), out)
        except (ValueError, FileNotFoundError) as e:
            raise RuntimeError(str(e))
        result.update(mp4=f"/files/thumbs/{out.name}", mp4_file=out.name, duration=round(dur, 2),
                      size_mb=round(out.stat().st_size / 1_048_576, 1))
        job["result"] = result

    return _start("thumb", work)


# ---------------------------------------------------------------- Mac 연동

class OpenApp(BaseModel):
    app: str


@app.post("/api/open-app")
def open_app(req: OpenApp):
    allowed = {"Vrew": "Vrew", "CapCut": "CapCut"}
    name = allowed.get(req.app)
    if not name:
        raise HTTPException(400, "열 수 없는 앱입니다.")
    if sys.platform != "darwin":
        raise HTTPException(400, "앱 바로 열기는 Mac에서만 됩니다.")
    r = subprocess.run(["open", "-a", name], capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(400, f"{name} 앱을 찾지 못했습니다. 설치되어 있는지 확인해 주세요.")
    return {"ok": True}


class Reveal(BaseModel):
    file: str = ""
    project: str = ""


@app.post("/api/reveal")
def reveal(req: Reveal):
    if "/" in req.file or "\\" in req.file:
        raise HTTPException(400, "잘못된 파일입니다.")
    root = store.OUTPUTS
    if req.project == "thumbs":
        root = thumbs.THUMBS
    elif req.project:
        root = projects.pdir(req.project) / "renders"
    target = root / req.file if req.file else root
    if not target.exists():
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    if sys.platform != "darwin":
        raise HTTPException(400, f"Finder 열기는 Mac에서만 됩니다. 저장 위치: {target}")
    subprocess.run(["open", "-R", str(target)] if req.file else ["open", str(target)])
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ffmpeg": bool(shutil.which("ffmpeg")), "outputs": str(store.OUTPUTS),
            "platform": sys.platform, "features": ["capcut"]}


# ---------------------------------------------------------------- 정적 파일

app.mount("/files/uploads", StaticFiles(directory=store.UPLOADS), name="uploads")
app.mount("/files/outputs", StaticFiles(directory=store.OUTPUTS), name="outputs")
(store.DATA / "tts_preview").mkdir(exist_ok=True)
app.mount("/files/tts_preview", StaticFiles(directory=store.DATA / "tts_preview"), name="tts_preview")
app.mount("/files/projects", StaticFiles(directory=projects.PROJECTS), name="projects")
app.mount("/files/thumbs", StaticFiles(directory=thumbs.THUMBS), name="thumbs")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


def _port_busy() -> bool:
    import socket

    with socket.socket() as sk:
        sk.settimeout(0.5)
        return sk.connect_ex((HOST, PORT)) == 0


def _stop_old_server() -> bool:
    """같은 포트에 예전 영상 작업실이 켜져 있으면 끈다. 다른 프로그램이면 건드리지 않는다."""
    import signal
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/api/health", timeout=2) as r:
            ours = "outputs" in json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        ours = False
    if not ours:
        return False
    r = subprocess.run(["lsof", "-ti", f"tcp:{PORT}", "-sTCP:LISTEN"], capture_output=True, text=True)
    for pid in {int(x) for x in r.stdout.split() if x.isdigit()} - {os.getpid()}:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    for _ in range(25):
        if not _port_busy():
            return True
        time.sleep(0.2)
    return False


def main():
    import uvicorn

    url = f"http://{HOST}:{PORT}"
    if _port_busy():
        print("\n  예전에 켠 영상 작업실이 아직 켜져 있어서 끄고 새로 켤게요…")
        if not _stop_old_server():
            print(f"\n  {PORT}번 포트를 다른 프로그램이 쓰고 있어서 켤 수 없어요.\n"
                  f"  터미널에서  kill $(lsof -ti tcp:{PORT})  를 실행한 뒤 다시 켜 주세요.\n")
            sys.exit(1)
    print(f"\n  영상 작업실이 켜졌어요 →  {url}\n  끄려면 이 창에서 Ctrl+C\n")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
