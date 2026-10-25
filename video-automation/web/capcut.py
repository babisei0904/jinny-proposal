"""'영상 만들기' 결과를 캡컷 드래프트(프로젝트)로 내보내기 (pycapcut 사용).

트랙 (아래 → 위)
  배경   : 배경색 + 영상 아래 레이어 그림 (장면별, 같은 그림이 이어지면 하나로)
  영상   : 원본 클립 조각 (구간·속도·화면 맞춤 그대로)
  레이어 : 영상 위 그림 (도형·이미지·(광고) 표시 등, 자막 글자는 빠짐)
  자막   : 글자 레이어마다 한 줄씩, 캡컷에서 바로 고칠 수 있는 텍스트
  목소리 : 문장별 목소리 파일
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path

from PIL import Image, ImageColor

from . import media, projects, store

US = 1_000_000
DRAFT_DIRS = [  # 캡컷 맥 앱이 드래프트를 두는 곳 (설치 방식에 따라 다름)
    "~/Movies/CapCut/User Data/Projects/com.lveditor.draft",
    "~/Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Projects/com.lveditor.draft",
]


def draft_root(settings: dict) -> Path:
    cands = [settings.get("capcut_drafts") or ""] + DRAFT_DIRS
    for c in cands:
        if c and Path(os.path.expanduser(c)).is_dir():
            return Path(os.path.expanduser(c))
    raise RuntimeError("캡컷 드래프트 폴더를 찾지 못했어요. 캡컷을 한 번 실행해 새 프로젝트를 만든 뒤 다시 해 보거나, "
                       "설정 → '캡컷 드래프트 폴더'에 위치를 넣어 주세요.")


def _rgb(hex_: str, default=(1.0, 1.0, 1.0)) -> tuple:
    try:
        r, g, b = ImageColor.getrgb(hex_ or "")[:3]
        return (r / 255, g / 255, b / 255)
    except ValueError:
        return default


def _num(v, d: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _runs(items: list) -> list[tuple]:
    """[(값, 시작, 끝)] 에서 같은 값이 이어지면 하나로 합친다."""
    out = []
    for v, a, b in items:
        if out and out[-1][0] == v and abs(out[-1][2] - a) < 1:
            out[-1] = (v, out[-1][1], b)
        else:
            out.append((v, a, b))
    return out


def _text_parts(cc, L: dict, W: int, H: int) -> dict:
    """작업실 글자 레이어 → 캡컷 글자 모양 (크기·테두리·그림자는 비슷하게 맞춘 값)."""
    size_px = _num(L.get("size"), 60)
    style = cc.TextStyle(size=round(size_px / 6, 1), bold=_num(L.get("weight"), 700) >= 600,
                         underline=bool(L.get("underline")), color=_rgb(L.get("color")),
                         align={"left": 0, "right": 2}.get(L.get("align"), 1),
                         auto_wrapping=True, max_line_width=max(0.1, min(1.0, _num(L.get("w"), W) / W)))
    parts = {"style": style}
    stroke = _num(L.get("stroke"), 0)
    if stroke > 0:
        parts["border"] = cc.TextBorder(color=_rgb(L.get("strokeColor"), (0, 0, 0)),
                                        width=max(5.0, min(100.0, stroke / size_px / 0.2 * 100 * 1.6)))
    if not L.get("bgTransparent", True):
        parts["background"] = cc.TextBackground(color=L.get("bgColor") or "#000000",
                                                alpha=_num(L.get("bgOpacity"), 100) / 100,
                                                round_radius=min(1.0, _num(L.get("bgRadius"), 0) / max(1.0, size_px)))
    if L.get("shadow"):
        parts["shadow"] = cc.TextShadow(alpha=_num(L.get("shadowOpacity"), 80) / 100,
                                        color=_rgb(L.get("shadowColor"), (0, 0, 0)),
                                        diffuse=min(100.0, _num(L.get("shadowBlur"), 12)),
                                        distance=min(100.0, _num(L.get("shadowDist"), 3)),
                                        angle=-_num(L.get("shadowAngle"), 45))
    cx = _num(L.get("x"), 0) + _num(L.get("w"), W) / 2
    cy = _num(L.get("y"), 0) + _num(L.get("h"), 200) / 2
    parts["clip_settings"] = cc.ClipSettings(transform_x=(cx - W / 2) / (W / 2), transform_y=(H / 2 - cy) / (H / 2))
    return parts


def export(p: dict, settings: dict, manifest: dict, frame_dir: Path, progress) -> dict:
    """manifest: {scenes: [{scene, under, over, texts: {레이어id: 글자}}], textLayers: [레이어]}"""
    try:
        import pycapcut as cc  # 캡컷으로 보낼 때만 필요
    except ImportError:
        raise RuntimeError("pycapcut이 설치되어 있지 않아요. 터미널에서 pip install -r requirements.txt 를 실행해 주세요.")

    progress(0.02, "목소리 확인 중")
    projects.synth_missing(p, settings, lambda f, m: progress(0.02 + f * 0.3, m))
    pl = projects.plan(p)
    if not pl["scenes"]:
        raise RuntimeError("장면이 없습니다. 2단계에서 대본을 만들어 주세요.")
    root = draft_root(settings)
    W, H = projects.W, projects.H
    safe = re.sub(r"[\\/:*?\"<>|]+", "_", p.get("title") or p.get("name") or "영상").strip(" ._")[:40] or "영상"
    name = f"{safe} {time.strftime('%m%d_%H%M%S')}"
    progress(0.35, "캡컷 프로젝트 만드는 중")
    script = cc.DraftFolder(str(root)).create_draft(name, W, H, projects.FPS)
    assets = root / name / "영상작업실"
    assets.mkdir()

    def keep(src: Path, new_name: str) -> str:
        """재료를 드래프트 폴더 안에 복사해 둔다 (작업실에서 지워도 캡컷 프로젝트는 그대로)."""
        dst = assets / new_name
        if not dst.exists():
            shutil.copy2(src, dst)
        return str(dst)

    total = round(pl["total"] * US)
    starts = [round(x["start"] * US) for x in pl["scenes"]] + [total]  # 끝 = 다음 장면 시작 (반올림으로 겹치지 않게)
    span = {x["id"]: (starts[i], starts[i + 1]) for i, x in enumerate(pl["scenes"])}
    fmap = {f["scene"]: f for f in manifest.get("scenes") or []}

    # 배경: 배경색 위에 영상 아래 레이어를 합쳐 장면마다 한 장 (주 트랙은 0초부터 빈틈없이)
    bg = ImageColor.getrgb(p["layout"].get("bg") or "#000000")
    cache: dict[str, str] = {}

    def picture(fname: str | None, opaque: bool) -> str | None:
        src = frame_dir / fname if fname else None
        if not opaque and (not src or not src.exists()):
            return None
        data = src.read_bytes() if src and src.exists() else b""
        key = ("bg" if opaque else "ov") + hashlib.md5(data).hexdigest()[:12]
        if key not in cache:
            out = assets / f"{key}.png"
            if opaque:
                im = Image.new("RGB", (W, H), bg)
                if data:
                    with Image.open(src) as layer:
                        layer = layer.convert("RGBA")
                        im.paste(layer, (0, 0), layer)
                im.save(out)
            else:
                shutil.copy2(src, out)
            cache[key] = str(out)
        return cache[key]

    script.add_track(cc.TrackType.video, "배경", relative_index=0)
    for path, a, b in _runs([(picture(fmap.get(x["id"], {}).get("under"), True), *span[x["id"]]) for x in pl["scenes"]]):
        script.add_segment(cc.VideoSegment(path, cc.Timerange(a, b - a)), "배경")

    progress(0.5, "영상 조각 넣는 중")
    vlayer = next((l for l in p["layout"]["layers"] if l.get("type") == "video"), None) or \
        {"x": 0, "y": 0, "w": W, "h": H, "visible": True}
    if vlayer.get("visible", True) and pl["pieces"]:
        script.add_track(cc.TrackType.video, "영상", relative_index=1)
        bx, by = int(vlayer["x"]), int(vlayer["y"])
        bw, bh = max(2, int(vlayer["w"]) // 2 * 2), max(2, int(vlayer["h"]) // 2 * 2)
        vol = _num(p.get("origVolume"), 0) / 100
        mats: dict[int, object] = {}
        pstarts = [round(pc["start"] * US) for pc in pl["pieces"]] + [total]
        for n, pc in enumerate(pl["pieces"]):
            clip = p["clips"][pc["clip"]]
            if pc["clip"] not in mats:
                src = store.UPLOADS / clip["id"]
                info = media.probe(src)
                m = cc.VideoMaterial(keep(src, clip["id"]), material_name=clip.get("name") or clip["id"])
                m.width, m.height = int(info["width"] or m.width), int(info["height"] or m.height)  # 세로 촬영 회전 반영
                mats[pc["clip"]] = m
            m = mats[pc["clip"]]
            a, b = pstarts[n], pstarts[n + 1]
            if b - a < 1000:
                continue
            s0 = min(round(pc["src"] * US), max(0, m.duration - 1000))
            s_len = max(1000, min(round((b - a) * pc["speed"]), m.duration - s0))
            # 상자 안 배치(_place)를 캡컷 위치·크기로: 크기 1.0 = 화면에 꽉 차게 맞춘 크기
            sw, sh, x, y = projects._place(m.width, m.height, bw, bh, clip)
            fit = min(W / m.width, H / m.height)
            cx, cy = bx + x + sw / 2, by + y + sh / 2
            seg = cc.VideoSegment(m, cc.Timerange(a, b - a), source_timerange=cc.Timerange(s0, s_len), volume=vol,
                                  clip_settings=cc.ClipSettings(scale_x=sw / (m.width * fit), scale_y=sh / (m.height * fit),
                                                                transform_x=(cx - W / 2) / (W / 2),
                                                                transform_y=(H / 2 - cy) / (H / 2)))
            # 영상이 상자 밖으로 나가면 상자 모양으로 가린다 (상자가 화면 전체면 필요 없음)
            vx0, vy0 = max(bx, bx + x), max(by, by + y)
            vx1, vy1 = min(bx + bw, bx + x + sw, W), min(by + bh, by + y + sh, H)
            full = vx0 <= 0 and vy0 <= 0 and vx1 >= W and vy1 >= H
            if not full and vx1 > vx0 and vy1 > vy0 and (vx0 > max(0, bx + x) or vy0 > max(0, by + y) or
                                                         vx1 < min(W, bx + x + sw) or vy1 < min(H, by + y + sh)):
                k = m.width / sw
                seg.add_mask(cc.MaskType.矩形, center_x=((vx0 + vx1) / 2 - cx) * k, center_y=((vy0 + vy1) / 2 - cy) * k,
                             size=(vy1 - vy0) / sh, rect_width=(vx1 - vx0) / sw)
            script.add_segment(seg, "영상")

    progress(0.7, "레이어·자막 넣는 중")
    over = [x for x in _runs([(picture(fmap.get(x["id"], {}).get("over"), False), *span[x["id"]]) for x in pl["scenes"]]) if x[0]]
    if over:
        script.add_track(cc.TrackType.video, "레이어", relative_index=2)
        for path, a, b in over:
            script.add_segment(cc.VideoSegment(path, cc.Timerange(a, b - a)), "레이어")

    layers = manifest.get("textLayers") or []
    for k, L in enumerate(reversed(layers)):  # 레이어 목록은 위에 있는 것이 먼저
        tname = f"자막 {k + 1}" if len(layers) > 1 else "자막"
        rows = _runs([((fmap.get(x["id"], {}).get("texts") or {}).get(L["id"]) or "", *span[x["id"]]) for x in pl["scenes"]])
        rows = [r for r in rows if r[0].strip()]
        if not rows:
            continue
        script.add_track(cc.TrackType.text, tname, relative_index=k)
        parts = _text_parts(cc, L, W, H)
        for text, a, b in rows:
            script.add_segment(cc.TextSegment(text, cc.Timerange(a, b - a), **parts), tname)

    progress(0.85, "목소리 넣는 중")
    if pl["groups"]:
        script.add_track(cc.TrackType.audio, "목소리")
        tts_dir = projects.pdir(p["id"]) / "tts"
        groups = pl["groups"]
        for i, g in enumerate(groups):
            mat = cc.AudioMaterial(keep(tts_dir / f"{g['hash']}.mp3", f"voice_{i + 1:02d}.mp3"))
            a = round(g["start"] * US)
            nxt = round(groups[i + 1]["start"] * US) if i + 1 < len(groups) else total
            dur = max(1000, min(mat.duration, nxt - a, total - a))
            script.add_segment(cc.AudioSegment(mat, cc.Timerange(a, dur)), "목소리")

    script.save()
    _finish(root / name, name, root)
    progress(1.0, "완료")
    return {"name": name, "folder": str(root / name)}


def _finish(folder: Path, name: str, root: Path) -> None:
    """pycapcut 기본 틀은 모든 드래프트가 같은 id를 쓰고 윈도우용이라, 맥 캡컷이 목록에만 보이고 열지 못한다.
    드래프트마다 새 id를 주고, 맥 캡컷이 읽는 draft_info.json과 목록 정보(길이·재료)를 채운다."""
    now = int(time.time())
    content_path = folder / "draft_content.json"
    c = json.loads(content_path.read_text(encoding="utf-8"))
    c["id"] = str(uuid.uuid4()).upper()
    c["name"] = name
    c["create_time"] = c["update_time"] = now
    if sys.platform == "darwin":
        for k in ("platform", "last_modified_platform"):
            c.setdefault(k, {})["os"] = "mac"
    text = json.dumps(c, ensure_ascii=False, indent=4)
    content_path.write_text(text, encoding="utf-8")
    (folder / "draft_info.json").write_text(text, encoding="utf-8")  # 맥 캡컷은 이 파일을 읽는다

    us = now * 1_000_000
    mats = []
    for kind, items in (("video", c["materials"].get("videos", [])), ("music", c["materials"].get("audios", []))):
        for m in items:
            mats.append({"create_time": now, "duration": m.get("duration", 0), "extra_info": Path(m["path"]).name,
                         "file_Path": m["path"], "height": m.get("height", 0), "id": str(uuid.uuid4()).upper(),
                         "import_time": now, "import_time_ms": us, "item_source": 1, "md5": "",
                         "metetype": "photo" if m.get("type") == "photo" else kind,
                         "roughcut_time_range": {"duration": m.get("duration", 0), "start": 0},
                         "sub_time_range": {"duration": -1, "start": -1}, "type": 0, "width": m.get("width", 0)})
    meta_path = folder / "draft_meta_info.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update({"draft_id": str(uuid.uuid4()).upper(), "draft_name": name, "draft_fold_path": str(folder),
                 "draft_root_path": str(root), "tm_duration": c.get("duration", 0),
                 "tm_draft_create": us, "tm_draft_modified": us, "draft_new_version": c.get("new_version", ""),
                 "draft_timeline_materials_size_": sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())})
    for group in meta.get("draft_materials", []):
        if group.get("type") == 0:
            group["value"] = mats
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
