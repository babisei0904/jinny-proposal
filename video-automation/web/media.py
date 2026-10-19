"""사진/영상 처리 (무료, 로컬). ffmpeg와 Pillow만 사용한다."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

try:  # 아이폰 HEIC 사진 지원 (없어도 동작, Mac에서는 sips로 대체)
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # pragma: no cover
    pass

RATIOS = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
    "4:5": (1080, 1350),
}
FPS = 30
MARGIN = 1.18  # 움직임을 위한 여유 (확대 최대치)

MOTIONS = ["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]
AUTO_ORDER = ["zoom_in", "pan_right", "zoom_out", "pan_left", "zoom_in", "pan_up", "zoom_out", "pan_down"]

Progress = Callable[[float, str], None]


def ffmpeg_bin() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise RuntimeError("ffmpeg가 없습니다. 터미널에서 `brew install ffmpeg` 를 실행해 주세요.")
    return path


def ffprobe_bin() -> str:
    path = shutil.which("ffprobe")
    if not path:
        raise RuntimeError("ffprobe가 없습니다. 터미널에서 `brew install ffmpeg` 를 실행해 주세요.")
    return path


def probe(path: Path) -> dict:
    out = subprocess.run(
        [ffprobe_bin(), "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,width,height", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"영상 정보를 읽지 못했습니다: {path.name}")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    return {
        "duration": float(data.get("format", {}).get("duration") or 0),
        "width": video.get("width"),
        "height": video.get("height"),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
    }


# ---------------------------------------------------------------- 사진

def normalize_photo(src: Path, dst: Path) -> None:
    """HEIC/PNG 등 어떤 사진이든 회전을 바로잡은 JPG로 저장한다."""
    try:
        img = Image.open(src)
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.save(dst, "JPEG", quality=95)
        return
    except Exception:
        if sys.platform == "darwin":  # Mac 기본 변환기
            r = subprocess.run(["sips", "-s", "format", "jpeg", str(src), "--out", str(dst)],
                               capture_output=True)
            if r.returncode == 0:
                return
        raise RuntimeError(f"사진을 열 수 없습니다: {src.name}")


def _cover(img: Image.Image, w: int, h: int) -> Image.Image:
    return ImageOps.fit(img, (w, h), Image.LANCZOS, centering=(0.5, 0.5))


def build_canvas(photo: Path, W: int, H: int, fit: str) -> Image.Image:
    """움직임 여유를 포함한 큰 캔버스를 만든다.
    fit=cover: 화면을 꽉 채움 / fit=contain: 사진 전체가 보이고 뒤는 흐린 배경."""
    img = ImageOps.exif_transpose(Image.open(photo)).convert("RGB")
    CW, CH = round(W * MARGIN), round(H * MARGIN)
    if fit == "contain":
        bg = _cover(img, CW // 4, CH // 4).filter(ImageFilter.GaussianBlur(12))
        bg = ImageEnhance.Brightness(bg).enhance(0.7).resize((CW, CH), Image.BICUBIC)
        fg = img.copy()
        fg.thumbnail((CW, CH), Image.LANCZOS)
        bg.paste(fg, ((CW - fg.width) // 2, (CH - fg.height) // 2))
        return bg
    return _cover(img, CW, CH)


def _ease(t: float) -> float:
    return t * t * (3 - 2 * t)  # 부드럽게 시작하고 멈춤


def _box(motion: str, p: float, CW: int, CH: int) -> tuple[float, float, float, float]:
    zmax = MARGIN
    if motion == "zoom_in":
        z = 1 + (zmax - 1) * p
    elif motion == "zoom_out":
        z = zmax - (zmax - 1) * p
    else:
        z = zmax
    bw, bh = CW / z, CH / z
    x, y = (CW - bw) / 2, (CH - bh) / 2
    # 방향은 카메라 기준 (pan_right = 카메라가 오른쪽으로 이동)
    if motion == "pan_right":
        x = (CW - bw) * p
    elif motion == "pan_left":
        x = (CW - bw) * (1 - p)
    elif motion == "pan_down":
        y = (CH - bh) * p
    elif motion == "pan_up":
        y = (CH - bh) * (1 - p)
    return x, y, x + bw, y + bh


def photo_to_clip(photo: Path, out: Path, ratio: str, fit: str, seconds: float, motion: str) -> None:
    """사진 1장을 줌/패닝 효과가 있는 무음 영상으로 만든다 (AI 없음, 무료)."""
    W, H = RATIOS[ratio]
    canvas = build_canvas(photo, W, H, fit)
    CW, CH = canvas.size
    frames = max(1, round(seconds * FPS))
    cmd = [ffmpeg_bin(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for i in range(frames):
            p = _ease(i / (frames - 1)) if frames > 1 else 0
            frame = canvas.resize((W, H), Image.BICUBIC, box=_box(motion, p, CW, CH))
            proc.stdin.write(frame.tobytes())
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read().decode(errors="ignore")
    if proc.wait() != 0:
        raise RuntimeError(f"영상 만들기 실패: {err[-400:]}")


# ---------------------------------------------------------------- 합치기

def split_groups(durations: list[float], groups: int) -> list[list[int]]:
    """순서를 유지한 채 길이가 비슷하도록 groups개 묶음으로 나눈다."""
    n = len(durations)
    groups = max(1, min(groups, n))
    total = sum(durations)
    result: list[list[int]] = []
    cur: list[int] = []
    acc = 0.0
    for i, d in enumerate(durations):
        remaining_items = n - i
        remaining_groups = groups - len(result)
        if cur and (remaining_items < remaining_groups or
                    (acc + d / 2 > total * (len(result) + 1) / groups and remaining_groups > 1)):
            result.append(cur)
            cur = []
        cur.append(i)
        acc += d
    result.append(cur)
    return result


def merge_clips(clips: list[Path], out: Path, ratio: str, fit: str, max_seconds: float,
                keep_audio: bool, transition: bool) -> float:
    """여러 클립을 한 영상으로 합친다. 반환값은 결과 길이(초)."""
    W, H = RATIOS[ratio]
    infos = [probe(c) for c in clips]
    durs = [min(i["duration"], max_seconds) if max_seconds > 0 else i["duration"] for i in infos]
    td = 0.4 if (transition and len(clips) > 1) else 0.0
    if td:
        durs = [max(d, td * 2 + 0.1) for d in durs]
    args = [ffmpeg_bin(), "-y", "-v", "error"]
    for c in clips:
        args += ["-i", str(c)]
    parts = []
    for k, d in enumerate(durs):
        base = f"[{k}:v]trim=0:{d:.3f},setpts=PTS-STARTPTS,fps={FPS}"
        if fit == "contain":
            parts.append(
                f"{base},split[a{k}][b{k}];"
                f"[a{k}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                f"boxblur=25:2,eq=brightness=-0.08[bg{k}];"
                f"[b{k}]scale={W}:{H}:force_original_aspect_ratio=decrease[fg{k}];"
                f"[bg{k}][fg{k}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v{k}]")
        else:
            parts.append(
                f"{base},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                f"setsar=1,format=yuv420p[v{k}]")
        if keep_audio:
            if infos[k]["has_audio"]:
                parts.append(f"[{k}:a]atrim=0:{d:.3f},asetpts=PTS-STARTPTS,"
                             f"aresample=48000,aformat=channel_layouts=stereo[x{k}]")
            else:
                parts.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{d:.3f}[x{k}]")
    n = len(clips)
    if td:
        prev, offset = "v0", 0.0
        for k in range(1, n):
            offset += durs[k - 1] - td
            parts.append(f"[{prev}][v{k}]xfade=transition=fade:duration={td}:offset={offset:.3f}[t{k}]")
            prev = f"t{k}"
        vout = prev
        if keep_audio:
            aprev = "x0"
            for k in range(1, n):
                parts.append(f"[{aprev}][x{k}]acrossfade=d={td}[ax{k}]")
                aprev = f"ax{k}"
            aout = aprev
    else:
        if keep_audio:
            parts.append("".join(f"[v{k}][x{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=1[vo][ao]")
            aout = "ao"
        else:
            parts.append("".join(f"[v{k}]" for k in range(n)) + f"concat=n={n}:v=1:a=0[vo]")
        vout = "vo"
    args += ["-filter_complex", ";".join(parts), "-map", f"[{vout}]"]
    if keep_audio:
        args += ["-map", f"[{aout}]", "-c:a", "aac", "-b:a", "160k"]
    else:
        args += ["-an"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", str(out)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"합치기 실패: {r.stderr[-500:]}")
    return sum(durs) - td * (n - 1)


def poster(video: Path, out: Path) -> None:
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-ss", "0.3", "-i", str(video),
                    "-frames:v", "1", "-vf", "scale=360:-2", str(out)], capture_output=True)
