#!/usr/bin/env python3
"""벤치마킹 릴스 1개 분석: 장면 전환 시점, 장면 길이, 장면별 시작·끝 프레임 시트.

    python3 analyze_bench.py 영상.mp4 --out 숙소폴더/bench

결과
    scenes.json   장면별 시작·끝·길이 + 요약 숫자
    pairs.jpg     장면마다 [시작 프레임 | 끝 프레임]  -> 카메라·사물 움직임 판단용
    captions.jpg  화면 가운데 자막 띠를 0.5초마다 크게 잘라 모은 것 -> 자막 받아 적기용

자막 글자와 움직임 종류는 이 스크립트가 아니라 Claude 가 두 이미지를 보고 적는다.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics as st
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]


def _font(size):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def probe(path: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:format=duration", "-of", "json", str(path)],
                       capture_output=True, text=True, check=True)
    d = json.loads(r.stdout)
    return {"duration": float(d["format"]["duration"]), "width": d["streams"][0]["width"],
            "height": d["streams"][0]["height"]}


def detect_cuts(path: Path, threshold: float, min_gap: float) -> list[float]:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf",
                        f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"],
                       capture_output=True, text=True)
    times = [float(t) for t in re.findall(r"pts_time:([0-9.]+)", r.stderr)]
    cuts: list[float] = []
    for t in times:
        if t < min_gap:                       # 맨 앞 0초 근처는 전환이 아님
            continue
        if cuts and t - cuts[-1] < min_gap:   # 0.03초 차이로 두 번 잡힌 것 합치기
            continue
        cuts.append(round(t, 2))
    return cuts


def grab(path: Path, t: float, w: int, h: int, crop: str | None = None) -> Image.Image:
    vf = (crop + "," if crop else "") + f"scale={w}:{h}"
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                        "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    if len(r.stdout) < w * h * 3:
        return Image.new("RGB", (w, h), "black")
    return Image.frombytes("RGB", (w, h), r.stdout[: w * h * 3])


def pairs_sheet(path: Path, bounds: list[float], dur: float, out: Path) -> None:
    W, H, cols = 150, 266, 6
    n = len(bounds) - 1
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (2 * W + 12), rows * (H + 20)), "white")
    d, f = ImageDraw.Draw(sheet), _font(16)
    for i in range(n):
        s, e = bounds[i] + 0.08, min(bounds[i + 1] - 0.08, dur - 0.25)
        x, y = (i % cols) * (2 * W + 12), (i // cols) * (H + 20)
        sheet.paste(grab(path, s, W, H), (x, y + 20))
        sheet.paste(grab(path, e, W, H), (x + W + 2, y + 20))
        d.text((x + 2, y + 1), f"#{i + 1} {bounds[i]:.1f}-{bounds[i + 1]:.1f}s", fill="red", font=f)
    sheet.save(out, quality=85)


def captions_sheet(path: Path, info: dict, out: Path, step: float = 0.5) -> None:
    """자막이 보통 있는 화면 세로 20~75% 구간을 크게 잘라 0.5초마다 모은다."""
    vw, vh = info["width"], info["height"]
    y0, y1 = int(vh * 0.20), int(vh * 0.75)
    cw, ch = 540, int(540 * (y1 - y0) / vw)
    crop = f"crop={vw}:{y1 - y0}:0:{y0}"
    ts = [i * step for i in range(int(info["duration"] / step))]
    cols = 3
    rows = (len(ts) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cw + 70), rows * (ch + 6)), "white")
    d, f = ImageDraw.Draw(sheet), _font(22)
    for i, t in enumerate(ts):
        x, y = (i % cols) * (cw + 70), (i // cols) * (ch + 6)
        sheet.paste(grab(path, t, cw, ch, crop), (x + 66, y))
        d.text((x + 2, y + ch // 2 - 11), f"{t:.1f}", fill="red", font=f)
    sheet.save(out, quality=88)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--threshold", type=float, default=0.22)
    ap.add_argument("--min-gap", type=float, default=0.15)
    a = ap.parse_args()

    video, out = Path(a.video).expanduser(), Path(a.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    info = probe(video)
    cuts = detect_cuts(video, a.threshold, a.min_gap)
    bounds = [0.0] + cuts + [round(info["duration"], 2)]
    lens = [round(bounds[i + 1] - bounds[i], 2) for i in range(len(bounds) - 1)]
    summary = {
        "video": str(video), **info,
        "scene_count": len(lens),
        "scene_avg": round(st.mean(lens), 2), "scene_median": round(st.median(lens), 2),
        "scene_min": min(lens), "scene_max": max(lens), "first_scene": lens[0],
        "scenes": [{"n": i + 1, "start": bounds[i], "end": bounds[i + 1], "dur": lens[i]}
                   for i in range(len(lens))],
        "_todo_for_claude": "pairs.jpg 를 보고 scenes[].type(장면 종류 프리셋)·motion 을, "
                            "captions.jpg 를 보고 자막 덩이와 시간을 채운다. 자동 검출은 AI 움직임을 "
                            "전환으로 오인할 수 있으니 pairs.jpg 로 확인한다.",
    }
    stem = video.stem
    (out / f"{stem}.scenes.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    pairs_sheet(video, bounds, info["duration"], out / f"{stem}.pairs.jpg")
    captions_sheet(video, info, out / f"{stem}.captions.jpg")
    print(f"{video.name}: {info['duration']:.1f}초, {info['width']}x{info['height']}, 장면 {len(lens)}개, "
          f"평균 {summary['scene_avg']}초 (최소 {summary['scene_min']}, 최대 {summary['scene_max']}), "
          f"첫 장면 {lens[0]}초")
    print(f"  -> {out / (stem + '.scenes.json')}, .pairs.jpg, .captions.jpg")


if __name__ == "__main__":
    main()
