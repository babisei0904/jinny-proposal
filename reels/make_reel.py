#!/usr/bin/env python3
"""숙소 폴더 하나 -> 릴스 mp4.

    python3 make_reel.py 숙소폴더
    python3 make_reel.py 숙소폴더 --tts none      # 소리 없이 화면만 확인
    python3 make_reel.py 숙소폴더 --tts edge      # 키 없는 임시 목소리

숙소폴더/
    script.txt     한 줄 = 자막 한 덩이 = 장면 하나.  "자막 | 사진파일" 로 사진 지정 가능.
                   빈 줄이나 문장 끝(. ? ! 요 다 까 죠)에서 내레이션을 끊어 만든다.
    *.jpg *.png    숙소 사진. 사진을 지정하지 않은 줄은 파일 이름 순서대로 쓴다.
    clips/         (선택) 사진과 같은 이름의 AI 영상(mp4). 있으면 사진 대신 쓴다.
    bgm.mp3        (선택) 배경음악. 내레이션 아래 작게 깔린다.
    reel.json      (선택) 설정. 아래 DEFAULTS 참고.

결과는 숙소폴더/out/ 에 reel.mp4, reel.srt, timeline.json.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / ".claude" / "skills" / "ig-reel"))

from reel import render, tts  # noqa: E402

try:
    import ko                      # 음절 세기 (ig-reel 한국어 보정)
    from hookscore import run as hook_score
except ImportError:                # 스킬 폴더가 없어도 돌아가게
    ko, hook_score = None, None

DEFAULTS = {
    "voice": "일반여성2",          # 영상작업실 설정의 Fish 목소리 이름
    "speed": 1.0,                  # Fish 에 요청하는 빠르기
    "target_sps": 6.8,             # 벤치마크 5개 평균 초당 음절. 0 이면 보정 안 함
    "gap": 0.06,                   # 문장 사이 쉼(초)
    "ad": False,                   # [광고] 표시
    "handle": "",                  # 워터마크 (@계정)
    "font": None, "font_size": 68, "caption_y": 0.5, "stroke": 7,
    "bgm_volume": 0.12,
    "clip_start": 0.3,             # AI 클립은 첫 프레임이 거의 정지라 0.3초부터 쓴다
}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
SENT_END = re.compile(r"(?:[.?!~]|[요다까죠])\s*$")


def syllables(text: str) -> int:
    if ko:
        return max(1, ko.syllables(text))
    return max(1, len(re.sub(r"\s", "", text)))


def parse_script(path: Path) -> tuple[list[dict], list[list[int]]]:
    """줄 -> 덩이 목록, 그리고 문장(덩이 번호 묶음) 목록."""
    chunks, sentences, cur = [], [], []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            if cur:
                sentences.append(cur)
                cur = []
            continue
        text, _, photo = (p.strip() for p in line.partition("|"))
        chunks.append({"text": text, "photo_hint": photo})
        cur.append(len(chunks) - 1)
        if SENT_END.search(text):
            sentences.append(cur)
            cur = []
    if cur:
        sentences.append(cur)
    if not chunks:
        raise SystemExit("script.txt 가 비어 있습니다.")
    return chunks, sentences


def assign_media(folder: Path, chunks: list[dict]) -> None:
    photos = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXT)
    if not photos:
        raise SystemExit(f"사진이 없습니다: {folder}")
    by_name = {p.name: p for p in photos} | {p.stem: p for p in photos}
    clips = {c.stem: c for c in (folder / "clips").glob("*.mp4")} if (folder / "clips").is_dir() else {}
    nxt = 0
    for i, c in enumerate(chunks):
        if c["photo_hint"]:
            if c["photo_hint"] not in by_name:
                raise SystemExit(f"{i + 1}번째 줄의 사진 '{c['photo_hint']}' 이 폴더에 없습니다.")
            c["photo"] = by_name[c["photo_hint"]]
        else:
            c["photo"] = photos[nxt % len(photos)]
            nxt += 1
        c["clip"] = clips.get(c["photo"].stem)
        c["motion"] = render.MOTIONS[i % len(render.MOTIONS)]


def narrate(chunks, sentences, cfg, engine, settings, work: Path, out_audio: Path) -> list[tuple[float, float]]:
    """문장마다 목소리를 만들고 이어 붙인다. 각 덩이의 (시작, 끝) 초를 돌려준다."""
    fish_conf = None
    if engine == "fish":
        sp = tts.find_settings(settings)
        if not sp:
            raise SystemExit("영상작업실 설정(settings.json)을 찾지 못했습니다. --settings 로 경로를 알려 주세요.")
        fish_conf = tts.load_fish(sp, cfg["voice"])
        print(f"  목소리: Fish '{cfg['voice']}' ({sp})")

    parts, spans, clock = [], [], 0.0
    for si, idx in enumerate(sentences):
        text = " ".join(chunks[i]["text"] for i in idx)
        syl = [syllables(chunks[i]["text"]) for i in idx]
        if engine == "none":
            dur = sum(syl) / (cfg["target_sps"] or 6.8)
            seg = work / f"s{si:02d}.mp3"
            tts.silence(dur, seg)
        else:
            raw = work / f"s{si:02d}.raw.mp3"
            if engine == "fish":
                key, model, vid = fish_conf
                tts.fish(text, raw, key, model, vid, cfg["speed"])
            else:
                tts.edge(text, raw, speed=cfg["speed"])
            seg = work / f"s{si:02d}.mp3"
            tts.trim_silence(raw, seg)
        dur = tts.duration(seg)
        # 문장 안에서는 음절 수 비율로 덩이 시간을 나눈다
        t = clock
        for i, s in zip(idx, syl):
            d = dur * s / sum(syl)
            spans.append((i, t, t + d))
            t += d
        parts.append(seg)
        clock += dur
        if si < len(sentences) - 1 and cfg["gap"] > 0:
            g = work / f"g{si:02d}.mp3"
            tts.silence(cfg["gap"], g)
            parts.append(g)
            clock += cfg["gap"]

    lst = work / "list.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
    joined = work / "voice.mp3"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-ar", "44100", "-ac", "1", "-b:a", "160k", str(joined)], check=True)

    # 벤치마크 말 빠르기에 맞추기 (음높이 유지)
    total_syl = sum(syllables(c["text"]) for c in chunks)
    real = tts.duration(joined)
    factor = 1.0
    if engine != "none" and cfg["target_sps"]:
        factor = max(0.85, min(1.25, cfg["target_sps"] / (total_syl / real)))
        if abs(factor - 1) > 0.02:
            tts.tempo(joined, out_audio, factor)
        else:
            factor = 1.0
    if factor == 1.0:
        joined.replace(out_audio)
    final = tts.duration(out_audio)
    print(f"  내레이션: {final:.1f}초, {total_syl}음절, 초당 {total_syl / final:.1f}음절"
          + (f" (빠르기 x{factor:.2f} 보정)" if factor != 1.0 else ""))
    scale = final / clock
    spans.sort()
    return [(s * scale, e * scale) for _, s, e in spans]


def mix_bgm(voice: Path, bgm: Path, out: Path, volume: float) -> None:
    """배경음악을 깔고, 목소리가 나올 때 음악을 더 낮춘다."""
    fc = (f"[1:a]volume={volume},aloop=loop=-1:size=2e9[m];"
          f"[m][0:a]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[ducked];"
          f"[0:a][ducked]amix=inputs=2:duration=first:normalize=0[a]")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(voice), "-i", str(bgm), "-filter_complex", fc,
                    "-map", "[a]", "-b:a", "192k", str(out)], check=True)


def srt(scenes: list[dict], path: Path) -> None:
    def ts(t):
        ms = round(t * 1000)
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    path.write_text("".join(f"{i + 1}\n{ts(s['start'])} --> {ts(s['end'])}\n{s['text']}\n\n"
                            for i, s in enumerate(scenes)), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="숙소 사진 폴더로 릴스 만들기")
    ap.add_argument("folder")
    ap.add_argument("--tts", choices=["fish", "edge", "none"], default="fish")
    ap.add_argument("--settings", help="영상작업실 settings.json 경로 (자동으로 찾음)")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser().resolve()
    cfg = dict(DEFAULTS)
    if (folder / "reel.json").exists():
        cfg.update(json.loads((folder / "reel.json").read_text(encoding="utf-8")))
    out = folder / "out"
    out.mkdir(exist_ok=True)

    chunks, sentences = parse_script(folder / "script.txt")
    assign_media(folder, chunks)
    print(f"[1/4] 대본: 자막 {len(chunks)}덩이, 문장 {len(sentences)}개, "
          f"사진 {len({c['photo'] for c in chunks})}장, AI 클립 {sum(1 for c in chunks if c['clip'])}개")
    if hook_score:
        first = " ".join(chunks[i]["text"] for i in sentences[0])
        _, score, verdict, flags = hook_score(first)
        print(f"  훅 점수: {score:.0f} {verdict}  \"{first}\"" + "".join(f"\n  ! {f}" for f in flags))

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        print("[2/4] 내레이션")
        voice = work / "narration.mp3"
        spans = narrate(chunks, sentences, cfg, args.tts, args.settings, work, voice)
        audio = voice
        if (folder / "bgm.mp3").exists():
            audio = work / "mixed.mp3"
            mix_bgm(voice, folder / "bgm.mp3", audio, cfg["bgm_volume"])
            print("  배경음악 섞음")

        scenes = [{**c, "start": s, "end": e} for c, (s, e) in zip(chunks, spans)]
        lens = [s["end"] - s["start"] for s in scenes]
        print(f"[3/4] 장면 {len(scenes)}개, 평균 {sum(lens) / len(lens):.2f}초 "
              f"(최소 {min(lens):.2f}, 최대 {max(lens):.2f})  · 벤치마크 평균 1.16초")
        print("[4/4] 영상 만들기 (1080x1920, 30fps)")
        render.render(scenes, audio if args.tts != "none" else None, out / "reel.mp4", cfg)

    srt(scenes, out / "reel.srt")
    (out / "timeline.json").write_text(json.dumps(
        [{"n": i + 1, "start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"],
          "photo": s["photo"].name, "clip": s["clip"].name if s["clip"] else None, "motion": s["motion"]}
         for i, s in enumerate(scenes)], ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"완료: {out / 'reel.mp4'}")


if __name__ == "__main__":
    main()
