"""장면(사진 또는 AI 클립) + 자막을 1080x1920 영상으로 그린다.

장면 하나 = 자막 한 덩이. 사진은 줌·이동으로 움직이고, 같은 이름의 AI 클립이
clips/ 에 있으면 그 클립을 대신 쓴다.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H, FPS = 1080, 1920, 30
MARGIN = 1.12                     # 움직일 여유 (12%)
MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left", "pan_up", "zoom_in", "pan_down"]

FONT_CANDIDATES = [
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",            # Mac
    "/Library/Fonts/Pretendard-ExtraBold.otf",
    "/usr/share/fonts/truetype/nanum/NanumGothicExtraBold.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",          # 리눅스 테스트용
]


def font(size: int, path: str | None = None) -> ImageFont.FreeTypeFont:
    for cand in [path, *FONT_CANDIDATES]:
        if not cand:
            continue
        try:
            # AppleSDGothicNeo.ttc 는 index 가 굵기. 6 = Bold 근처.
            idx = 6 if cand.endswith("AppleSDGothicNeo.ttc") else 0
            return ImageFont.truetype(cand, size, index=idx)
        except Exception:
            continue
    raise RuntimeError("한글 글꼴을 찾지 못했습니다. reel.json 의 font 에 글꼴 파일 경로를 넣어 주세요.")


def _ease(t: float) -> float:
    return t * t * (3 - 2 * t)


def _box(motion: str, p: float, CW: int, CH: int):
    z = {"zoom_in": 1 + (MARGIN - 1) * p, "zoom_out": MARGIN - (MARGIN - 1) * p}.get(motion, MARGIN)
    bw, bh = CW / z, CH / z
    x, y = (CW - bw) / 2, (CH - bh) / 2
    if motion == "pan_right":
        x = (CW - bw) * p
    elif motion == "pan_left":
        x = (CW - bw) * (1 - p)
    elif motion == "pan_down":
        y = (CH - bh) * p
    elif motion == "pan_up":
        y = (CH - bh) * (1 - p)
    return x, y, x + bw, y + bh


def photo_frames(photo: Path, n: int, motion: str):
    img = ImageOps.exif_transpose(Image.open(photo)).convert("RGB")
    canvas = ImageOps.fit(img, (round(W * MARGIN), round(H * MARGIN)), Image.LANCZOS)
    CW, CH = canvas.size
    for i in range(n):
        p = _ease(i / (n - 1)) if n > 1 else 0
        yield canvas.resize((W, H), Image.BICUBIC, box=_box(motion, p, CW, CH))


def clip_frames(clip: Path, n: int, start: float = 0.0):
    """AI 클립을 화면 크기에 꽉 채워 n 프레임 읽는다. 짧으면 마지막 프레임을 늘린다."""
    vf = f"fps={FPS},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(clip), "-vf", vf,
                             "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                            stdout=subprocess.PIPE)
    last = None
    size = W * H * 3
    for _ in range(n):
        buf = proc.stdout.read(size)
        if len(buf) == size:
            last = Image.frombytes("RGB", (W, H), buf)
        if last is None:
            raise RuntimeError(f"클립을 읽지 못했습니다: {clip}")
        yield last
    proc.stdout.close()
    proc.wait()


def draw_caption(frame: Image.Image, text: str, style: dict) -> Image.Image:
    if not text:
        return frame
    d = ImageDraw.Draw(frame)
    f = style["_font"]
    sw = style.get("stroke", 7)
    max_w = W * 0.86
    # 너무 길면 두 줄로 (공백 기준으로 반에 가깝게)
    lines = [text]
    if d.textlength(text, font=f) > max_w and " " in text:
        words = text.split(" ")
        best = min(range(1, len(words)), key=lambda k: abs(len(" ".join(words[:k])) - len(" ".join(words[k:]))))
        lines = [" ".join(words[:best]), " ".join(words[best:])]
    lh = f.size * 1.25
    y = H * style.get("y", 0.5) - lh * len(lines) / 2
    for line in lines:
        tw = d.textlength(line, font=f)
        x = (W - tw) / 2
        d.text((x + 3, y + 5), line, font=f, fill=(0, 0, 0, 120), stroke_width=sw, stroke_fill=(0, 0, 0))
        d.text((x, y), line, font=f, fill=style.get("color", "white"), stroke_width=sw, stroke_fill="black")
        y += lh
    return frame


def draw_badges(frame: Image.Image, cfg: dict, small: ImageFont.FreeTypeFont) -> Image.Image:
    d = ImageDraw.Draw(frame)
    if cfg.get("ad"):
        label = "[광고]"
        tw = d.textlength(label, font=small)
        d.text((W - tw - 40, 150), label, font=small, fill=(255, 255, 255), stroke_width=3, stroke_fill="black")
    if cfg.get("handle"):
        h = cfg["handle"]
        tw = d.textlength(h, font=small)
        d.text(((W - tw) / 2, H * 0.80), h, font=small, fill=(255, 255, 255, 200),
               stroke_width=2, stroke_fill=(0, 0, 0))
    return frame


def render(scenes: list[dict], audio: Path | None, out: Path, cfg: dict, tail: float = 0.4) -> None:
    """scenes: [{start, end, text, photo, clip, motion}] (초)."""
    style = {"_font": font(cfg.get("font_size", 68), cfg.get("font")), "y": cfg.get("caption_y", 0.5),
             "stroke": cfg.get("stroke", 7)}
    small = font(34, cfg.get("font"))
    total = scenes[-1]["end"] + tail
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-"]
    if audio:
        cmd += ["-i", str(audio), "-af", "apad", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-t", f"{total:.3f}", str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    written = 0
    try:
        for i, sc in enumerate(scenes):
            end = total if i == len(scenes) - 1 else sc["end"]
            n = max(1, round(end * FPS) - written)
            src = clip_frames(sc["clip"], n) if sc.get("clip") else photo_frames(sc["photo"], n, sc["motion"])
            for frame in src:
                frame = draw_badges(draw_caption(frame, sc["text"], style), cfg, small)
                proc.stdin.write(frame.tobytes())
            written += n
        proc.stdin.close()
    except BrokenPipeError:
        pass
    if proc.wait() != 0:
        raise RuntimeError("영상 인코딩 실패")
