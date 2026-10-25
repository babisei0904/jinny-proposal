"""썸네일 제작: 장면 캡처, PNG 저장, 썸네일을 영상 맨 앞/뒤에 넣은 MP4 만들기."""
from __future__ import annotations

import json
import re
import subprocess
import time
import uuid
from pathlib import Path

from PIL import Image, ImageColor

from . import media, projects, store

THUMBS = store.DATA / "thumbs"
THUMBS.mkdir(parents=True, exist_ok=True)
UPLOAD_RE = re.compile(r"^[0-9a-f]{32}\.(mp4|mov|m4v|webm|mkv|avi)$")


def resolve(src: str) -> Path:
    """영상 위치: 업로드한 파일 id 또는 'proj:<작업번호>:<파일이름>'(영상 만들기 결과)."""
    if src.startswith("proj:"):
        try:
            _, pid, name = src.split(":", 2)
        except ValueError:
            raise ValueError("잘못된 영상입니다.")
        if "/" in name or "\\" in name:
            raise ValueError("잘못된 영상입니다.")
        p = projects.pdir(pid) / "renders" / name
    elif UPLOAD_RE.match(src or ""):
        p = store.UPLOADS / src
    else:
        raise ValueError("잘못된 영상입니다.")
    if not p.exists():
        raise FileNotFoundError("영상을 찾을 수 없습니다. 다시 올려 주세요.")
    return p


def sources() -> list[dict]:
    """'영상 만들기'에서 완성한 영상 목록."""
    out = []
    for item in projects.list_projects():
        r = item.get("render")
        if not r:
            continue
        name = r.rsplit("/", 1)[-1]
        out.append({"src": f"proj:{item['id']}:{name}", "name": item.get("name"), "url": r,
                    "poster": r.rsplit(".", 1)[0] + ".jpg"})
    return out


def frame(src: str, t: float, clean: bool = False) -> dict:
    """미리보기에서 멈춘 바로 그 시각의 장면을 캡처한다.
    clean=True 이고 '영상 만들기' 결과면 자막·문구 없이 원본 클립에서 같은 순간을 꺼낸다."""
    video = resolve(src)
    info = media.probe(video)
    t = max(0.0, min(float(t), max(0.0, info["duration"] - 0.05)))
    out = THUMBS / f"frame_{uuid.uuid4().hex[:10]}.png"
    note = ""
    if clean and src.startswith("proj:"):
        try:
            res = _clean_frame(src, video, info, t, out)
            if res:
                return res
            note = "이 영상은 만든 뒤에 내용이 바뀌어 원본 장면을 정확히 찾을 수 없어 보이는 그대로 캡처했어요."
        except Exception:  # noqa: BLE001 - 원본을 못 쓰면 완성 영상에서 그대로 캡처
            note = "원본 클립을 찾을 수 없어 보이는 그대로 캡처했어요."
    r = subprocess.run([media.ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(video),
                        "-frames:v", "1", str(out)], capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError("장면을 캡처하지 못했습니다.")
    return {"url": f"/files/thumbs/{out.name}", "width": info["width"], "height": info["height"], "t": round(t, 2),
            "clean": False, "note": note}


def clean_status(src: str) -> dict:
    """자막 없는 원본 장면으로 캡처할 수 있는지 미리 알려 준다."""
    if not src.startswith("proj:"):
        return {"ok": False, "reason": "upload"}
    video = resolve(src)
    pid = src.split(":", 2)[1]
    try:
        m = _scene_map(src, video, media.probe(video))
    except Exception:  # noqa: BLE001
        m = None
    if not m:
        return {"ok": False, "reason": "old", "pid": pid}
    if not all((store.UPLOADS / pc["id"]).exists() for pc in m["pieces"]):
        return {"ok": False, "reason": "missing", "pid": pid}
    return {"ok": True, "pid": pid}


def _scene_map(src: str, video: Path, info: dict) -> dict | None:
    """렌더링 때 남긴 시간표. 예전 영상은 지금 프로젝트로 다시 계산하되, 길이가 같을 때만 믿는다."""
    side = video.with_suffix(".json")
    if side.exists():
        return json.loads(side.read_text())
    pid = src.split(":", 2)[1]
    m = projects.scene_map(projects.load(pid))
    return m if abs(m["total"] - info["duration"]) < 0.15 else None


def _clean_frame(src: str, video: Path, info: dict, t: float, out: Path) -> dict | None:
    m = _scene_map(src, video, info)
    if not m or not m["visible"] or not m["pieces"]:
        return None
    pc = next((x for x in m["pieces"] if x["start"] <= t < x["start"] + x["dur"]), m["pieces"][-1])
    clip = store.UPLOADS / pc["id"]
    if not clip.exists():
        return None
    cinfo = media.probe(clip)
    at = pc["src"] + max(0.0, min(t - pc["start"], pc["dur"])) * pc["speed"]
    at = max(0.0, min(at, max(0.0, cinfo["duration"] - 0.05)))
    W, H = int(m["w"]), int(m["h"])
    b = m["box"]
    bw, bh = max(2, int(b["w"]) // 2 * 2), max(2, int(b["h"]) // 2 * 2)
    sw, sh, x, y = projects._place(cinfo["width"] or 1080, cinfo["height"] or 1920, bw, bh, pc)
    raw = out.with_name(out.stem + "_src.png")
    r = subprocess.run([media.ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{at:.3f}", "-i", str(clip),
                        "-frames:v", "1", str(raw)], capture_output=True, text=True)
    if r.returncode != 0 or not raw.exists():
        return None
    # 렌더링과 똑같이: 상자(검정) 안에 영상을 맞춰 넣고, 그 상자를 배경색 화면의 제자리에 놓는다
    with Image.open(raw) as im:
        fg = im.convert("RGB").resize((sw, sh), Image.LANCZOS)
    raw.unlink(missing_ok=True)
    boxed = Image.new("RGB", (bw, bh), (0, 0, 0))
    boxed.paste(fg, (x, y))
    canvas = Image.new("RGB", (W, H), ImageColor.getrgb(m.get("bg") or "#000000"))
    canvas.paste(boxed, (int(b["x"]), int(b["y"])))
    canvas.save(out)
    return {"url": f"/files/thumbs/{out.name}", "width": W, "height": H, "t": round(t, 2), "clean": True, "note": ""}


def with_cover(src: str, png: Path, position: str, seconds: float, out: Path) -> float:
    """썸네일 이미지를 영상 맨 앞(또는 맨 뒤)에 짧게 넣는다. 쇼츠 커버로 고르기 좋게."""
    video = resolve(src)
    info = media.probe(video)
    w, h = int(info["width"] or 1080) // 2 * 2, int(info["height"] or 1920) // 2 * 2
    d = max(0.04, min(3.0, float(seconds)))
    vid_a = "[1:a]aresample=48000,aformat=channel_layouts=stereo[va]" if info["has_audio"] else \
        f"anullsrc=r=48000:cl=stereo,atrim=0:{info['duration']:.3f}[va]"
    order = "[v][va][t][ta]" if position == "end" else "[t][ta][v][va]"
    # 썸네일 비율이 영상과 달라도 문구가 잘리지 않게 전체를 맞추고 남는 곳은 검게 채운다
    fc = (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,"
          f"setsar=1,fps=30,format=yuv420p[t];"
          f"[1:v]fps=30,scale={w}:{h},setsar=1,format=yuv420p[v];"
          f"anullsrc=r=48000:cl=stereo,atrim=0:{d:.3f}[ta];{vid_a};"
          f"{order}concat=n=2:v=1:a=1[ov][oa]")
    r = subprocess.run([media.ffmpeg_bin(), "-y", "-v", "error", "-loop", "1", "-t", f"{d:.3f}", "-i", str(png),
                        "-i", str(video), "-filter_complex", fc, "-map", "[ov]", "-map", "[oa]",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"썸네일 영상 만들기 실패: {r.stderr[-300:]}")
    return media.probe(out)["duration"]


def new_png_path(name: str) -> Path:
    safe = re.sub(r"[\\/:*?\"<>|\s]+", "_", name or "썸네일").strip("._")[:40] or "썸네일"
    return THUMBS / f"{safe}_{time.strftime('%m%d_%H%M%S')}.png"
