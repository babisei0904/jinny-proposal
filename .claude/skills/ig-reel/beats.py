#!/usr/bin/env python3
"""
beats.py - turn a Reel script into a timed beat sheet before you record it.

Estimates how long each line takes to say, stacks them into timecodes, and
flags the four things that kill a Reel in the edit: a hook that runs past the
three-second mark, a beat long enough for the viewer to leave, a run of lines
with nothing concrete in them, and a total length that does not match what you
said you were making.

The timings are an estimate from word count at a words-per-minute rate. They
are close enough to plan an edit and not a substitute for recording it. Set
your own rate with --wpm once you have timed yourself reading a script out
loud: most people land between 150 and 200, and the default here is 165.

Usage
  python3 beats.py script.txt
  python3 beats.py script.txt --target 30
  python3 beats.py script.txt --wpm 185 --target 45
  pbpaste | python3 beats.py -
  python3 beats.py script.txt --json
"""

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ko  # noqa: E402  한국어 보정

WORD_RE = re.compile(r"[A-Za-z0-9$%'’-]+")
SENT_RE = re.compile(r"[^.!?]+[.!?]*")
CONCRETE_RE = re.compile(r"\$\s?\d|\b\d[\d,.]*\b|(?<!^)\b[A-Z][a-z]{2,}\b", re.MULTILINE)
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
    "with", "that", "this", "it", "is", "are", "was", "were", "be", "been",
    "you", "your", "i", "my", "me", "we", "our", "they", "them", "he", "she",
    "so", "just", "not", "no", "do", "did", "does", "have", "has", "had",
    "will", "can", "at", "as", "by", "from", "out", "up", "off", "one", "all",
}

HOOK_WINDOW = 3.0        # seconds. Past this, the thumb has already decided.
MAX_BEAT = 4.0           # seconds on one idea with no change on screen.
ABSTRACT_RUN = 3         # beats in a row with nothing checkable in them.


def words(text):
    # "$18,000" is one word when it is spoken, so it is one word here too.
    return WORD_RE.findall(re.sub(r"(?<=\d),(?=\d)", "", text))


def pretty(token):
    """Put the thousands separator back for display."""
    return re.sub(r"(\d)(?=(\d{3})+$)", r"\1,", token)


def tc(seconds):
    m, s = divmod(seconds, 60)
    return f"{int(m)}:{s:04.1f}"


def split_beats(raw, wps, count=None):
    """One line is one beat, unless a line is too long to be one."""
    count = count or (lambda t: len(words(t)))
    beats = []
    for line in [l.strip() for l in raw.splitlines()]:
        if not line:
            continue
        if count(line) / wps <= MAX_BEAT * 1.5:
            beats.append(line)
            continue
        # Long paragraph: break it at sentence ends so the timings mean
        # something, and let the report say it was split.
        parts = [p.strip() for p in SENT_RE.findall(line) if p.strip()]
        buf = ""
        for part in parts:
            candidate = (buf + " " + part).strip()
            if buf and count(candidate) / wps > MAX_BEAT:
                beats.append(buf)
                buf = part
            else:
                buf = candidate
        if buf:
            beats.append(buf)
    return beats


def analyse(raw, wpm=165, target=None, lang="auto", sps=None):
    korean = ko.is_korean(raw) if lang == "auto" else lang == "ko"
    if korean:
        # 한국어: 음절 / 초당 음절.  "words" 자리에 음절 수가 들어간다.
        wps = sps or ko.DEFAULT_SPS
        count = ko.syllables
        n_concrete = lambda t: sum(len(x) for x in ko.concrete(t))
    else:
        wps = wpm / 60.0
        count = lambda t: len(words(t))
        n_concrete = lambda t: len(CONCRETE_RE.findall(t))
    beats = split_beats(raw, wps, count)
    if not beats:
        return None

    rows, clock = [], 0.0
    for i, text in enumerate(beats):
        n = count(text)
        dur = n / wps
        rows.append({
            "n": i + 1,
            "start": round(clock, 2),
            "dur": round(dur, 2),
            "words": n,
            "text": text,
            "concrete": n_concrete(text),
            "label": "",
            "flags": [],
        })
        clock += dur
    total = clock

    # Label the structural positions a Reel is actually built around.
    for r in rows:
        if r["n"] == 1 or r["start"] + r["dur"] <= HOOK_WINDOW:
            r["label"] = "HOOK"
    rows[-1]["label"] = "CTA" if rows[-1]["label"] != "HOOK" else "HOOK/CTA"
    half = total / 2
    for r in rows:
        if not r["label"] and r["start"] <= half < r["start"] + r["dur"]:
            r["label"] = "MID"

    notes = []
    if rows[0]["dur"] > HOOK_WINDOW:
        rows[0]["flags"].append(f"훅이 {rows[0]['dur']:.1f}초, {HOOK_WINDOW:.0f}초 넘음" if korean else
                                f"hook runs {rows[0]['dur']:.1f}s, past the {HOOK_WINDOW:.0f}s mark")
        notes.append(f"1번 장면을 말하는 데 {rows[0]['dur']:.1f}초. {int(HOOK_WINDOW * wps)}음절 "
                     "이하로 줄여라. 아니면 훅이 끝나기 전에 이미 넘겨진다." if korean else
                     f"Beat 1 takes {rows[0]['dur']:.1f}s to say. Cut it to "
                     f"{int(HOOK_WINDOW * wps)} words or fewer, or the hook lands after "
                     "the decision has been made.")
    if rows[0]["concrete"] == 0:
        notes.append("1번 장면에 숫자도 지명도 없다. 확인할 게 없는 훅은 넘겨진다." if korean else
                     "Beat 1 has no number and no name in it. Hooks without something "
                     "checkable are the ones that get scrolled.")

    for r in rows:
        if r["dur"] > MAX_BEAT:
            r["flags"].append(f"한 장면에 {r['dur']:.1f}초" if korean else f"{r['dur']:.1f}s on one beat")
    long_beats = [r["n"] for r in rows if r["dur"] > MAX_BEAT]
    if long_beats:
        notes.append(f"{', '.join(map(str, long_beats))}번 장면이 {MAX_BEAT:.0f}초를 넘는다. 문장을 "
                     "쪼개거나 그 안에서 화면을 바꿔라. 멈춘 화면에서 사람들이 나간다." if korean else
                     f"Beat(s) {', '.join(map(str, long_beats))} run past {MAX_BEAT:.0f}s. "
                     "Either split the line or change what is on screen inside it. "
                     "A static frame is where people leave.")

    run, start = 0, None
    for r in rows:
        if r["concrete"] == 0:
            run += 1
            start = start if start is not None else r["n"]
            if run == ABSTRACT_RUN:
                notes.append(f"{start}~{r['n']}번 장면에 구체적인 게 없다. 숫자·지명·가격 중 "
                             "하나를 넣어라." if korean else
                             f"Beats {start}-{r['n']} have nothing concrete in them. "
                             "Put a number, a name or a price in one of them.")
        else:
            run, start = 0, None

    # Does the last line hand you back to the first one?
    if korean:
        first, last = ko.content_stems(rows[0]["text"]), ko.content_stems(rows[-1]["text"])
    else:
        first = {w.lower() for w in words(rows[0]["text"]) if w.lower() not in STOPWORDS}
        last = {w.lower() for w in words(rows[-1]["text"]) if w.lower() not in STOPWORDS}
    loop = sorted(pretty(w) for w in first & last)
    if loop and korean:
        notes.append(f"루프 있음: 마지막 장면이 훅의 \"{', '.join(loop[:3])}\"를 다시 말한다. "
                     "두 번째 재생은 공짜 도달이다.")
    elif korean:
        notes.append("루프 없음. 마지막 장면이 훅과 겹치는 말이 없어서 밋밋하게 끝난다. "
                     "1번 장면의 단어 하나를 다시 쓰는 게 가장 싼 재생이다.")
    elif loop:
        notes.append(f"Loops: the last beat repeats \"{', '.join(loop[:3])}\" from the hook. "
                     "Second watches are free reach.")
    else:
        notes.append("No loop. The last beat shares no word with the hook, so the video "
                     "ends flat. Echoing one word from beat 1 is the cheapest replay you get.")

    if target:
        delta = total - target
        if korean:
            if abs(delta) <= target * 0.1:
                notes.append(f"길이 적정 ({total:.1f}초 / 목표 {target}초).")
            elif delta > 0:
                notes.append(f"목표보다 {delta:.1f}초 김. 약 {int(delta * wps)}음절 줄여라.")
            else:
                notes.append(f"목표보다 {-delta:.1f}초 짧음. {int(-delta * wps)}음절 더 쓰거나 "
                             "짧게 찍어라. 보통은 짧은 게 맞다.")
        elif abs(delta) <= target * 0.1:
            notes.append(f"Length is on target ({total:.1f}s against {target}s).")
        elif delta > 0:
            notes.append(f"{delta:.1f}s over target. Cut about {int(delta * wps)} words.")
        else:
            notes.append(f"{-delta:.1f}s under target. Either add {int(-delta * wps)} words "
                         "or shoot it short. Short is usually right.")

    return {
        "lang": "ko" if korean else "en",
        "sps": round(wps, 2) if korean else None,
        "wpm": wpm, "target": target,
        "total_seconds": round(total, 2),
        "total_words": sum(r["words"] for r in rows),
        "beats": rows,
        "notes": notes,
    }


def render(a, out=sys.stdout):
    if a.get("lang") == "ko":
        head = (f"BEAT SHEET  ·  {a['total_words']}음절  ·  ~{a['total_seconds']:.1f}초 "
                f"(초당 {a['sps']}음절)" + (f"  ·  목표 {a['target']}초" if a["target"] else ""))
    else:
        head = (f"BEAT SHEET  ·  {a['total_words']} words  ·  ~{a['total_seconds']:.1f}s "
                f"at {a['wpm']} wpm" + (f"  ·  target {a['target']}s" if a["target"] else ""))
    print("\n" + head, file=out)
    print("=" * max(len(head), 72), file=out)
    for r in a["beats"]:
        label = f"{r['label']:<8}" if r["label"] else " " * 8
        print(f"  {tc(r['start'])}  {r['dur']:4.1f}s  {label}{r['text']}", file=out)
        for f in r["flags"]:
            print(f"  {'':>6}  {'':>5}  {'':<8}^ {f}", file=out)
    print("-" * max(len(head), 72), file=out)
    for n in a["notes"]:
        print(f"  - {n}", file=out)
    print("", file=out)


def main():
    ap = argparse.ArgumentParser(description="Time a Reel script into a beat sheet.")
    ap.add_argument("input", nargs="?", default="-", help="script file, or - for stdin")
    ap.add_argument("--wpm", type=float, default=165, help="speaking rate (default 165)")
    ap.add_argument("--target", type=float, help="target length in seconds")
    ap.add_argument("--lang", choices=["auto", "en", "ko"], default="auto",
                    help="auto: 한글이 많으면 한국어 모드")
    ap.add_argument("--sps", type=float,
                    help=f"한국어 말하기 속도, 초당 음절 (기본 {ko.DEFAULT_SPS})")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8").read()
    a = analyse(raw, wpm=args.wpm, target=args.target, lang=args.lang, sps=args.sps)
    if not a:
        print("empty script", file=sys.stderr)
        sys.exit(2)
    if args.json:
        print(json.dumps(a, indent=2, ensure_ascii=False))
    else:
        render(a)
    sys.exit(0)


if __name__ == "__main__":
    main()
