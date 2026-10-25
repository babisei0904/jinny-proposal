/* 영상 만들기: 숏튜브 쇼핑숏츠와 같은 5단계 흐름 */
const MK = { p: null, saveTimer: null, voices: [], styles: [], layouts: [], plan: null, sel: 0, player: null, layoutBase: "", s3sel: "sub", busy: false };
const CW = 1080, CH = 1920;
const MAX_CLIPS = 10, LIMIT_SEC = 180;
const STEPS = ["원본 입력", "대본 각색", "레이아웃 세팅", "세부 편집", "완료"];
const FONTS = [
  ["Pretendard", "프리텐다드"], ["Noto Sans KR", "노토 산스"], ["Black Han Sans", "검은고딕 (굵은 제목)"],
  ["Do Hyeon", "도현"], ["Jua", "주아"], ["Gowun Dodum", "고운돋움"], ["Nanum Gothic", "나눔고딕"],
  ["Nanum Myeongjo", "나눔명조"], ["Gaegu", "개구 (손글씨)"], ["Sunflower", "해바라기"], ["IBM Plex Sans KR", "IBM 플렉스"],
];
const deep = (o) => JSON.parse(JSON.stringify(o));
const fmtT = (s) => { s = Math.max(0, +s || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`; };
const sec = (s) => (+s || 0).toFixed(1) + "초";
const clipLen = (c) => Math.max(0, (+c.out || +c.duration || 0) - (+c.in || 0));
const totalUsed = (p) => p.clips.reduce((a, c) => a + clipLen(c), 0);
const nv = (v, d) => (v === undefined || v === null || v === "" || isNaN(+v) ? d : +v);
const charLen = (t) => (t || "").replace(/\s/g, "").length;

/* ---------------------------------------------------------------- 저장 */
function mkSave(now = false) {
  clearTimeout(MK.saveTimer);
  const run = () => api("PUT", `/api/projects/${MK.p.id}`, MK.p).catch(fail);
  if (now) return run();
  MK.saveTimer = setTimeout(run, 600);
}
const touch = () => mkSave();

/* ---------------------------------------------------------------- 화면 맞춤 계산 (서버 _place 와 같은 식) */
function placeVideo(vw, vh, bw, bh, c) {
  const fit = c.fit || "cover", zoom = +c.zoom || 1, ox = +c.ox || 0, oy = +c.oy || 0;
  const base = fit === "contain" ? Math.min(bw / vw, bh / vh) : Math.max(bw / vw, bh / vh);
  const w = vw * base * zoom, h = vh * base * zoom;
  let x, y;
  if (fit === "custom") { x = (bw - w) / 2 + ox / 100 * bw / 2; y = (bh - h) / 2 + oy / 100 * bh / 2; }
  else { x = (bw - w) / 2 + ox / 100 * Math.abs(bw - w) / 2; y = (bh - h) / 2 + oy / 100 * Math.abs(bh - h) / 2; }
  return { w, h, x, y };
}
function applyPlacement(video, boxW, boxH, clip) {
  const vw = video.videoWidth || 1080, vh = video.videoHeight || 1920;
  const r = placeVideo(vw, vh, boxW, boxH, clip);
  Object.assign(video.style, { position: "absolute", left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px", maxWidth: "none" });
}

/* ---------------------------------------------------------------- 레이어 그리기 (미리보기와 최종 영상이 같은 함수) */
const IMG = {};
function getImg(url, onload) {
  if (!url) return null;
  if (IMG[url]?.complete && IMG[url].naturalWidth) return IMG[url];
  if (!IMG[url]) { const im = new Image(); im.onload = () => onload?.(); im.src = url; IMG[url] = im; }
  else if (onload) IMG[url].addEventListener("load", onload, { once: true });
  return null;
}
function hexA(hex, a) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function layerText(L, p, scene) {
  let t;
  if (L.base && L.type === "subtitle") t = scene ? scene.text : (p.scenes[0]?.text || "자막 미리보기");
  else { t = scene ? (scene.extra || {})[L.id] : ""; if (!t) t = L.text || ""; if (!scene && !t) t = L.name; }
  return (t || "").replaceAll("{제목}", p.title || "제목을 입력하세요");
}
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    const tokens = para.includes(" ") ? para.split(/(\s+)/) : [...para];
    for (const tk of tokens) {
      const cand = line + tk;
      if (line && ctx.measureText(cand.trim()).width > maxW) {
        if (ctx.measureText(tk.trim()).width > maxW) { for (const ch of tk) { if (ctx.measureText(line + ch).width > maxW && line) { out.push(line.trim()); line = ""; } line += ch; } }
        else { out.push(line.trim()); line = tk.trimStart(); }
      } else line = cand;
    }
    out.push(line.trim());
  }
  return out.filter((x, i, a) => x || a.length === 1);
}
function drawTextLayer(ctx, L, text) {
  if (!text) return false;
  const size = +L.size || 60;
  ctx.font = `${L.weight || 700} ${size}px "${L.font || "Pretendard"}", "Apple SD Gothic Neo", sans-serif`;
  ctx.textBaseline = "middle";
  const pad = +L.bgPad || 0;
  const lines = wrapLines(ctx, text, Math.max(20, L.w - pad * 2 - (+L.stroke || 0) * 2));
  const lh = size * (+L.lineHeight || 1.25);
  const blockH = lines.length * lh;
  let y0 = L.y + (L.h - blockH) / 2 + lh / 2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const ax = L.align === "left" ? L.x + pad : L.align === "right" ? L.x + L.w - pad : L.x + L.w / 2;
  ctx.textAlign = L.align === "left" ? "left" : L.align === "right" ? "right" : "center";
  if (!L.bgTransparent) {
    const maxW = Math.max(...widths);
    const bx = L.align === "left" ? L.x : L.align === "right" ? L.x + L.w - maxW - pad * 2 : L.x + (L.w - maxW) / 2 - pad;
    ctx.save(); ctx.fillStyle = hexA(L.bgColor, nv(L.bgOpacity, 100) / 100);
    ctx.beginPath(); ctx.roundRect(bx, y0 - lh / 2 - pad, maxW + pad * 2, blockH + pad * 2, +L.bgRadius || 0); ctx.fill(); ctx.restore();
  }
  lines.forEach((ln, i) => {
    const y = y0 + i * lh;
    ctx.save();
    if (L.shadow) {
      const ang = ((+L.shadowAngle || 0) * Math.PI) / 180, d = +L.shadowDist || 0;
      ctx.shadowColor = hexA(L.shadowColor, nv(L.shadowOpacity, 80) / 100);
      ctx.shadowBlur = +L.shadowBlur || 0; ctx.shadowOffsetX = Math.cos(ang) * d; ctx.shadowOffsetY = Math.sin(ang) * d;
    }
    if (+L.stroke > 0) {
      ctx.lineJoin = "round"; ctx.miterLimit = 2; ctx.lineWidth = +L.stroke * 2; ctx.strokeStyle = L.strokeColor || "#000";
      ctx.strokeText(ln, ax, y); ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = L.color || "#fff"; ctx.fillText(ln, ax, y);
    ctx.restore();
    if (L.underline) {
      const w = widths[i], sx = ctx.textAlign === "left" ? ax : ctx.textAlign === "right" ? ax - w : ax - w / 2;
      ctx.fillStyle = L.color || "#fff"; ctx.fillRect(sx, y + size * 0.55, w, Math.max(2, size / 14));
    }
  });
  return true;
}
function drawShape(ctx, L) {
  ctx.save();
  ctx.globalAlpha = nv(L.opacity, 100) / 100;
  ctx.beginPath(); ctx.roundRect(L.x, L.y, L.w, L.h, +L.radius || 0);
  if (nv(L.fillOpacity, 100) > 0) { ctx.fillStyle = hexA(L.fill || "#000", nv(L.fillOpacity, 100) / 100); ctx.fill(); }
  if (+L.borderWidth > 0) { ctx.lineWidth = +L.borderWidth; ctx.strokeStyle = L.borderColor || "#fff"; ctx.stroke(); }
  ctx.restore();
  return true;
}
function drawImageLayer(ctx, L, redraw) {
  const im = getImg(L.src, redraw);
  if (!im) return false;
  ctx.save(); ctx.globalAlpha = nv(L.opacity, 100) / 100;
  ctx.beginPath(); ctx.roundRect(L.x, L.y, L.w, L.h, +L.radius || 0); ctx.clip();
  const s = (L.fit === "cover" ? Math.max : Math.min)(L.w / im.naturalWidth, L.h / im.naturalHeight);
  const w = im.naturalWidth * s, h = im.naturalHeight * s;
  ctx.drawImage(im, L.x + (L.w - w) / 2, L.y + (L.h - h) / 2, w, h);
  ctx.restore();
  return true;
}
function drawAd(ctx) {
  ctx.save(); ctx.font = `800 44px "Pretendard", sans-serif`; ctx.textAlign = "right"; ctx.textBaseline = "top";
  ctx.lineWidth = 8; ctx.lineJoin = "round"; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.strokeText("(광고)", CW - 36, 40);
  ctx.fillStyle = "#fff"; ctx.fillText("(광고)", CW - 36, 40); ctx.restore();
}
/** part: 'under' = 영상 아래 레이어, 'over' = 영상 위 레이어. 그린 것이 있으면 true */
function drawLayers(ctx, p, scene, part, redraw, noText = false) {
  ctx.clearRect(0, 0, CW, CH);
  const layers = p.layout.layers;
  const vi = layers.findIndex((l) => l.type === "video");
  let drew = false;
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (L.type === "video" || !L.visible) continue;
    if (scene && (scene.hide || []).includes(L.id)) continue;
    const isUnder = vi >= 0 && i > vi;
    if ((part === "under") !== isUnder) continue;
    if (L.type === "subtitle") { if (!(noText && !isUnder)) drew = drawTextLayer(ctx, L, layerText(L, p, scene)) || drew; }
    else if (L.type === "shape") drew = drawShape(ctx, L) || drew;
    else if (L.type === "image") drew = drawImageLayer(ctx, L, redraw) || drew;
  }
  if (part === "over" && p.ad) { drawAd(ctx); drew = true; }
  return drew;
}
async function ensureFonts(p) {
  const fams = new Set(p.layout.layers.filter((l) => l.type === "subtitle").map((l) => `${l.weight || 700} 40px "${l.font || "Pretendard"}"`));
  fams.add(`800 44px "Pretendard"`);
  await Promise.all([...fams].map((f) => document.fonts.load(f).catch(() => {})));
}
async function ensureImages(p) {
  await Promise.all(p.layout.layers.filter((l) => l.type === "image" && l.src).map((l) => new Promise((res) => {
    const im = getImg(l.src, res); if (im) res(); setTimeout(res, 5000);
  })));
}

/* ---------------------------------------------------------------- 9:16 무대 (영상 + 레이어 그림) */
function stageHTML(id, width) {
  const h = Math.round(width * CH / CW);
  return `<div class="stage" id="${id}" style="width:${width}px;height:${h}px">
    <canvas class="cv-under" width="${CW}" height="${CH}"></canvas>
    <div class="vbox"><video muted playsinline preload="auto"></video></div>
    <canvas class="cv-over" width="${CW}" height="${CH}"></canvas>
  </div>`;
}
function stageApi(el, p) {
  const scale = el.clientWidth / CW;
  const vbox = el.querySelector(".vbox"), video = el.querySelector("video");
  const cu = el.querySelector(".cv-under").getContext("2d"), co = el.querySelector(".cv-over").getContext("2d");
  const api_ = {
    el, video, scale, clipIdx: -1,
    layout() {
      el.style.background = p.layout.bg || "#000";
      const V = p.layout.layers.find((l) => l.type === "video") || { x: 0, y: 0, w: CW, h: CH, visible: true };
      Object.assign(vbox.style, { left: V.x * scale + "px", top: V.y * scale + "px", width: V.w * scale + "px", height: V.h * scale + "px",
        borderRadius: (+V.radius || 0) * scale + "px", display: V.visible === false ? "none" : "block" });
      const c = p.clips[api_.clipIdx];
      if (c) applyPlacement(video, V.w * scale, V.h * scale, c);
    },
    setClip(i, time) {
      const c = p.clips[i];
      if (!c) return;
      if (api_.clipIdx !== i || !video.src.endsWith(c.url)) {
        api_.clipIdx = i; video.src = c.url;
        video.onloadedmetadata = () => { api_.layout(); if (api_.pending != null) { video.currentTime = api_.pending; api_.pending = null; } };
        api_.pending = time ?? c.in ?? 0;
      } else if (time != null) {
        if (video.readyState >= 1) video.currentTime = time; else api_.pending = time;
      }
      api_.layout();
    },
    draw(scene) {
      const redraw = () => api_.draw(scene);
      drawLayers(cu, p, scene, "under", redraw);
      drawLayers(co, p, scene, "over", redraw);
    },
  };
  api_.layout();
  return api_;
}
document.fonts?.addEventListener?.("loadingdone", () => MK.redraw?.());

/* ---------------------------------------------------------------- 진입 / 공통 틀 */
async function viewMaker(v, query) {
  const id = query.get("id");
  if (!id) {
    v.innerHTML = `<div class="notice">새 작업을 만드는 중…</div>`;
    const p = await api("POST", "/api/projects", {});
    location.replace("#/make?id=" + p.id);
    return;
  }
  v.innerHTML = `<div class="notice">불러오는 중…</div>`;
  const [p, vs, lays] = await Promise.all([api("GET", `/api/projects/${id}`), api("GET", "/api/voices"), api("GET", "/api/layouts")]);
  MK.p = p; MK.voices = vs.voices; MK.styles = vs.styles; MK.layouts = lays; MK.sel = 0; MK.plan = null; MK.layoutBase = "";
  window.__leave = () => { MK.player?.stop(); mkSave(true); MK.redraw = null; };
  // 썸네일 제작에서 '다시 만들고 돌아오기': 5단계에서 바로 다시 만들고 끝나면 썸네일 제작으로 돌아간다
  MK.afterRender = query.get("rerender") === "thumb" && p.scenes.length ? "thumb" : null;
  if (MK.afterRender) { p.step = 5; p.maxStep = 5; history.replaceState(null, "", "#/make?id=" + p.id); }
  renderMaker();
  if (MK.afterRender) $("#doRender")?.click();
}
function renderMaker() {
  const v = $("#view"), p = MK.p;
  MK.player?.stop(); MK.redraw = null;
  v.innerHTML = `
    <a class="back" href="#/">← 메뉴로 돌아가기</a>
    <div class="row between mk-head">
      <div class="stack" style="gap:4px;min-width:0;flex:1">
        <h1 style="margin:0">영상 만들기</h1>
        <input class="name-input" id="pName" value="${esc(p.name)}" title="작업 이름">
      </div>
      <div class="row"><button class="btn primary" id="pSave">💾 저장하기</button><button class="btn ghost" id="pReset">초기화</button></div>
    </div>
    <div class="stepper">${STEPS.map((s, i) => `<button data-step="${i + 1}" class="${p.step === i + 1 ? "on" : ""}" ${i + 1 > p.maxStep ? "disabled" : ""}>${i + 1}. ${s}</button>${i < 4 ? '<span class="sep">›</span>' : ""}`).join("")}</div>
    <div id="mkBody" style="margin-top:18px"></div>`;
  $("#pName").oninput = (e) => { p.name = e.target.value; touch(); };
  $("#pSave").onclick = async () => { await mkSave(true); toast("저장했어요. 대시보드의 '내 작업'에서 이어서 할 수 있어요"); };
  $("#pReset").onclick = async () => {
    if (!confirm("이 작업을 처음 상태로 되돌릴까요? 올린 영상과 대본이 모두 지워져요.")) return;
    const np = await api("POST", "/api/projects", { name: p.name });
    await api("DELETE", `/api/projects/${p.id}`).catch(() => {});
    location.replace("#/make?id=" + np.id);
  };
  v.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => goStep(+b.dataset.step)));
  const body = $("#mkBody");
  [step1, step2, step3, step4, step5][p.step - 1](body);
}
function goStep(n) {
  const p = MK.p;
  p.step = n; p.maxStep = Math.max(p.maxStep || 1, n);
  mkSave(true); renderMaker(); window.scrollTo(0, 0);
}
function footer(prevLabel, nextLabel, opts = {}) {
  return `<div class="mk-foot"><button class="btn ghost" id="fPrev" ${opts.noPrev ? "disabled" : ""}>${prevLabel}</button>
    <button class="btn primary big" id="fNext" ${opts.disableNext ? "disabled" : ""}>${nextLabel}</button></div>`;
}

/* ---------------------------------------------------------------- 1단계: 원본 입력 */
function remapScenes(p, mapping) { // mapping[oldIdx] = newIdx | -1
  p.scenes.forEach((s) => { const n = mapping[s.clip]; s.clip = n >= 0 ? n : Math.max(0, Math.min(p.clips.length - 1, s.clip - 1)); });
}
function moveClip(i, d) {
  const p = MK.p, j = i + d;
  if (j < 0 || j >= p.clips.length) return;
  [p.clips[i], p.clips[j]] = [p.clips[j], p.clips[i]];
  const map = p.clips.map((_, k) => k); map[i] = j; map[j] = i; remapScenes(p, map);
}
function step1(body) {
  const p = MK.p, tot = totalUsed(p);
  body.innerHTML = `<div class="card mk-card">
    <h2 class="mk-h">🎬 원본 영상 업로드</h2>
    <p class="muted mk-sub">만들 영상(최대 ${MAX_CLIPS}개)을 업로드하고 재생 순서 및 구간을 설정하세요.</p>
    <div class="drop" id="drop"><div class="up-ico">⇪</div><b>마우스로 영상 파일을 끌어서 놓거나 클릭하여 선택하세요</b><br><span class="faint">MP4, MOV (합산 ${LIMIT_SEC}초 권장, 최대 ${MAX_CLIPS}개)</span></div>
    ${p.clips.length ? `<div class="banner ${tot > LIMIT_SEC ? "warn" : ""}"><span>✓ 영상 ${p.clips.length}개 등록 (총 ${tot.toFixed(1)}초 / ${LIMIT_SEC}초 ${tot > LIMIT_SEC ? "권장 초과" : "한도"})</span><span class="faint">순서 정렬 후 [다음 단계]를 누르세요</span></div>` : ""}
    <div class="mk-label">영상 재생 순서 지정 (${p.clips.length}/${MAX_CLIPS})</div>
    <div class="list" id="clipList">${p.clips.length ? p.clips.map((c, i) => `
      <div class="clip-row" draggable="true" data-i="${i}">
        <span class="grip" title="끌어서 순서 바꾸기">⠿</span><span class="idx-badge">${i + 1}</span>
        <button class="thumb" data-edit="${i}" title="구간 편집">${c.poster ? `<img src="${c.poster}" alt="">` : ""}<span class="play">▶</span><span class="dur">${Math.round(c.duration)}s</span></button>
        <div class="meta"><div class="row" style="gap:8px;flex-wrap:nowrap"><b class="n">${esc(c.name)}</b><span class="badge brand">사용: ${clipLen(c).toFixed(1)}초</span></div>
          <div class="faint">전체: ${(+c.duration).toFixed(1)}초 | 용량: ${c.size_mb ?? "-"}MB · ${({ cover: "꽉 채우기", contain: "전체 맞추기", custom: "직접 커스텀" })[c.fit || "cover"]} ${(+c.zoom || 1).toFixed(2)}x</div></div>
        <button class="btn sm" data-edit="${i}">✂ 구간 편집</button><button class="btn sm green" data-edit="${i}">⧉ 9:16 크롭</button>
        <button class="btn sm ghost" data-up="${i}" ${i ? "" : "disabled"}>↑</button><button class="btn sm ghost" data-down="${i}" ${i < p.clips.length - 1 ? "" : "disabled"}>↓</button>
        <button class="btn sm ghost danger" data-del="${i}">🗑</button>
      </div>`).join("") : `<div class="empty"><div style="font-size:28px">🎞</div>업로드된 영상이 없습니다<br><span class="faint">상단 영역에서 영상을 먼저 추가해주세요.</span></div>`}</div>
    <div class="toggle-row"><span class="ad-ico">AD</span><div style="flex:1"><b>광고 표시 넣기</b> <span class="badge">광고</span><div class="faint">체크 시 영상 우측 상단에 (광고) 표기가 들어갑니다.</div></div>
      <label class="switch"><input type="checkbox" id="ad" ${p.ad ? "checked" : ""}><span></span></label></div>
    ${footer("이전", "다음 단계", { noPrev: true, disableNext: !p.clips.length })}
  </div>`;
  dropZone($("#drop"), "video/*,.mov,.mp4,.m4v", async (files) => {
    const vids = files.filter((f) => /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name));
    if (p.clips.length + vids.length > MAX_CLIPS) return toast(`영상은 최대 ${MAX_CLIPS}개까지 올릴 수 있어요`);
    try {
      const res = await uploadFiles(vids);
      res.forEach((r) => p.clips.push({ id: r.id, name: r.name, url: r.url, poster: r.poster, duration: r.duration, width: r.width, height: r.height, size_mb: r.size_mb, in: 0, out: r.duration, fit: "cover", zoom: 1, ox: 0, oy: 0 }));
      touch(); step1(body);
    } catch (e) { fail(e); }
  });
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openClipEditor(+b.dataset.edit, () => step1(body))));
  body.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => { moveClip(+b.dataset.up, -1); touch(); step1(body); }));
  body.querySelectorAll("[data-down]").forEach((b) => (b.onclick = () => { moveClip(+b.dataset.down, 1); touch(); step1(body); }));
  body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
    const i = +b.dataset.del;
    if (!confirm(`${i + 1}번 영상을 뺄까요?`)) return;
    p.clips.splice(i, 1);
    const map = []; for (let k = 0; k <= p.clips.length; k++) map[k] = k < i ? k : k === i ? -1 : k - 1;
    remapScenes(p, map); touch(); step1(body);
  }));
  // 끌어서 순서 바꾸기
  let dragFrom = null;
  body.querySelectorAll(".clip-row").forEach((row) => {
    row.ondragstart = () => { dragFrom = +row.dataset.i; row.classList.add("dragging"); };
    row.ondragend = () => row.classList.remove("dragging");
    row.ondragover = (e) => e.preventDefault();
    row.ondrop = (e) => {
      e.preventDefault(); const to = +row.dataset.i;
      if (dragFrom == null || dragFrom === to) return;
      const order = p.clips.map((_, k) => k); const [m] = order.splice(dragFrom, 1); order.splice(to, 0, m);
      const map = []; order.forEach((old, nw) => (map[old] = nw));
      p.clips = order.map((k) => p.clips[k]); remapScenes(p, map); touch(); step1(body);
    };
  });
  $("#ad").onchange = (e) => { p.ad = e.target.checked; touch(); };
  $("#fNext").onclick = () => goStep(2);
}

/* ---------------------------------------------------------------- 구간 자르기 & 9:16 크롭 통합 편집 */
function openClipEditor(i, after) {
  const p = MK.p, orig = p.clips[i], c = deep(orig);
  const SW = 270, SH = 480, sc = SW / CW;
  const sub = p.layout.layers.find((l) => l.base && l.type === "subtitle");
  const fitName = { cover: "꽉 채우기", contain: "전체 맞추기", custom: "직접 커스텀" };
  const close = modal(`
    <div class="row between"><div class="row" style="gap:10px"><span class="ico-box">⧉</span><div><h3 style="margin:0">영상 구간 자르기 & 9:16 화면 크롭 통합 편집 <span class="badge ok">실시간 연동</span></h3>
      <div class="faint">9:16 쇼츠 화면을 드래그해 구도를 잡고, 하단 타임라인에서 재생 구간을 실시간으로 설정하세요.</div></div></div><button class="btn ghost" data-close>✕</button></div>
    <div class="row"><span class="chip-i" id="ceRange"></span><span class="chip-i ok" id="ceZoomChip"></span></div>
    <div class="ce-grid">
      <div class="stack" style="align-items:center">
        <div class="faint" style="font-weight:700">⧉ 9:16 세로 쇼츠 실시간 캔버스</div>
        <div class="faint" style="font-size:12px">화면을 마우스로 잡고 드래그하여 원하는 위치로 이동하세요</div>
        <div class="ce-stage" id="ceStage" style="width:${SW}px;height:${SH}px">
          <video id="ceV" src="${c.url}" playsinline preload="auto"></video>
          ${sub ? `<div class="guide" style="left:${sub.x * sc}px;top:${sub.y * sc}px;width:${sub.w * sc}px;height:${sub.h * sc}px">자막 표시 영역</div>` : ""}
          <span class="ce-time" id="ceTime">0:00.00</span><span class="ce-z" id="ceZ"></span>
          <button class="ce-mute" id="ceMute">🔇</button><span class="ce-drag">✥ 드래그 위치 이동</span>
        </div>
        <div class="row"><button class="btn sm" data-act="play">▶ 재생</button><button class="btn sm green" data-act="range">↻ 구간 미리보기</button></div>
      </div>
      <div class="card tight stack">
        <b>⚙ 화면 맞춤 방식 (Fit Mode)</b>
        <div class="fit3">${["cover", "contain", "custom"].map((f) => `<button data-fit="${f}" class="${c.fit === f ? "on" : ""}"><b>${({ cover: "꽉 채우기 (Cover)", contain: "전체 맞추기", custom: "직접 커스텀" })[f]}</b><span>${({ cover: "여백 없이 가득", contain: "상하 레터박스", custom: "자유 확대/이동" })[f]}</span></button>`).join("")}</div>
        <div class="row between"><b>🔍 화면 확대 / 축소 (Zoom)</b><span class="chip-i ok" id="zoomLbl"></span></div>
        <input type="range" id="zoom" step="0.01" max="3">
        <div class="seg4">${[1, 1.25, 1.5, 2].map((z) => `<button data-z="${z}">${z.toFixed(2)}x</button>`).join("")}</div>
        <div class="row between"><b>✥ 가로 위치 (X 오프셋)</b><span class="faint" id="oxLbl"></span></div>
        <input type="range" id="ox" min="-100" max="100" step="1">
        <div class="seg4"><button data-ox="-100">◀ 좌측 배치</button><button data-ox="0">● 중앙 배치</button><button data-ox="100">▶ 우측 배치</button></div>
        <div class="row between"><b>✥ 세로 위치 (Y 오프셋)</b><span class="faint" id="oyLbl"></span></div>
        <input type="range" id="oy" min="-100" max="100" step="1">
        <div class="seg4"><button data-oy="-100">▲ 상단 배치</button><button data-oy="0">● 중앙 배치</button><button data-oy="100">▼ 하단 배치</button><button data-reset>↺ 초기화</button></div>
      </div>
    </div>
    <div class="ce-ctrl row between">
      <div class="row"><button class="btn sm" data-act="play">▶ 재생</button><button class="btn sm" data-act="range">↻ 구간 미리보기</button><label class="row" style="font-size:13px"><input type="checkbox" id="ceLoop" checked> 구간 반복 재생</label></div>
      <div class="row"><span class="mono" id="ceClock"></span>${[-1, -0.1, 0.1, 1].map((d) => `<button class="btn sm ghost" data-step="${d}">${d > 0 ? "+" : ""}${d}s</button>`).join("")}</div>
    </div>
    <div class="grid g2"><button class="btn soft" id="setIn">📍 현재 재생 위치를 [시작]으로 설정</button><button class="btn soft" id="setOut">📍 현재 재생 위치를 [종료]로 설정</button></div>
    <div class="row between faint" style="font-size:13px"><span>✂ 타임라인 구간 조절 (핸들 드래그 & 클릭 탐색)</span><span id="ceInfo"></span></div>
    <div class="tl" id="tl"><div class="tl-sel" id="tlSel"><span class="tl-h l" data-h="in"></span><span class="tl-mid" id="tlMid"></span><span class="tl-h r" data-h="out"></span></div><div class="tl-head" id="tlHead"></div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary" id="ceSave"></button></div>`,
  (m, closeFn) => {
    m.querySelector(".box").classList.add("wide");
    const v = $("#ceV", m), stage = $("#ceStage", m), tl = $("#tl", m);
    let playing = false, rangeMode = false, raf;
    const D = () => +c.duration || v.duration || 1;
    const upd = () => {
      if (v.videoWidth) applyPlacement(v, SW, SH, c);
      const zmin = c.fit === "custom" ? 0.5 : 1;
      $("#zoom", m).min = zmin; c.zoom = Math.max(zmin, +c.zoom || 1);
      $("#zoom", m).value = c.zoom; $("#ox", m).value = c.ox; $("#oy", m).value = c.oy;
      const range = c.fit === "custom" ? 200 : 100; $("#ox", m).min = $("#oy", m).min = -range; $("#ox", m).max = $("#oy", m).max = range;
      $("#zoomLbl", m).textContent = `${(+c.zoom).toFixed(2)}x (${Math.round(c.zoom * 100)}%)`;
      $("#ceZ", m).textContent = `${(+c.zoom).toFixed(2)}x`;
      $("#oxLbl", m).textContent = `${Math.round(c.ox)}% ${c.ox == 0 ? "(중앙)" : ""}`; $("#oyLbl", m).textContent = `${Math.round(c.oy)}% ${c.oy == 0 ? "(중앙)" : ""}`;
      $("#ceZoomChip", m).textContent = `🔍 ${(+c.zoom).toFixed(2)}x (${fitName[c.fit]})`;
      $("#ceRange", m).textContent = `⏱ 구간: ${(+c.in).toFixed(2)}s - ${(+c.out).toFixed(2)}s (총 ${(c.out - c.in).toFixed(2)}s)`;
      $("#ceInfo", m).textContent = `설정 구간: ${(+c.in).toFixed(2)}s - ${(+c.out).toFixed(2)}s (총 ${(c.out - c.in).toFixed(2)}초) / 전체: ${D().toFixed(2)}s`;
      const tw = tl.clientWidth; Object.assign($("#tlSel", m).style, { left: (c.in / D()) * tw + "px", width: ((c.out - c.in) / D()) * tw + "px" });
      $("#tlMid", m).textContent = `↔ 구간 이동 (${(c.out - c.in).toFixed(2)}s)`;
      $("#ceSave", m).textContent = `설정 저장하기 (9:16 크롭, ${(+c.zoom).toFixed(1)}x)`;
      m.querySelectorAll("[data-fit]").forEach((b) => b.classList.toggle("on", b.dataset.fit === c.fit));
      m.querySelectorAll("[data-z]").forEach((b) => b.classList.toggle("on", Math.abs(b.dataset.z - c.zoom) < 0.001));
    };
    const tick = () => {
      if (!v.isConnected) return;
      const t = v.currentTime;
      $("#ceTime", m).textContent = `${fmtT(t)} / ${fmtT(D())}`; $("#ceClock", m).textContent = `${fmtT(t)} / ${fmtT(D())}`;
      $("#tlHead", m).style.left = (t / D()) * tl.clientWidth + "px";
      $("#setIn", m).textContent = `📍 현재 재생 위치를 [시작]으로 설정 (${fmtT(t)})`; $("#setOut", m).textContent = `📍 현재 재생 위치를 [종료]로 설정 (${fmtT(t)})`;
      if (playing && rangeMode && t >= c.out - 0.03) { if ($("#ceLoop", m).checked) v.currentTime = c.in; else { v.pause(); playing = false; } }
      raf = requestAnimationFrame(tick);
    };
    v.onloadedmetadata = () => { if (!c.duration) c.duration = v.duration; if (!c.out) c.out = v.duration; v.currentTime = c.in || 0; upd(); };
    v.onpause = () => { playing = false; m.querySelectorAll('[data-act="play"]').forEach((b) => (b.textContent = "▶ 재생")); };
    v.onplay = () => { playing = true; m.querySelectorAll('[data-act="play"]').forEach((b) => (b.textContent = "⏸ 일시정지")); };
    raf = requestAnimationFrame(tick);
    m.querySelectorAll('[data-act="play"]').forEach((b) => (b.onclick = () => { rangeMode = false; v.paused ? v.play() : v.pause(); }));
    m.querySelectorAll('[data-act="range"]').forEach((b) => (b.onclick = () => { rangeMode = true; v.currentTime = c.in; v.play(); }));
    $("#ceMute", m).onclick = () => { v.muted = !v.muted; $("#ceMute", m).textContent = v.muted ? "🔇" : "🔊"; };
    v.muted = true;
    m.querySelectorAll("[data-fit]").forEach((b) => (b.onclick = () => { c.fit = b.dataset.fit; if (c.fit !== "custom") { c.ox = Math.max(-100, Math.min(100, c.ox)); c.oy = Math.max(-100, Math.min(100, c.oy)); } upd(); }));
    $("#zoom", m).oninput = (e) => { c.zoom = +e.target.value; upd(); };
    m.querySelectorAll("[data-z]").forEach((b) => (b.onclick = () => { c.zoom = +b.dataset.z; upd(); }));
    $("#ox", m).oninput = (e) => { c.ox = +e.target.value; upd(); };
    $("#oy", m).oninput = (e) => { c.oy = +e.target.value; upd(); };
    m.querySelectorAll("[data-ox]").forEach((b) => (b.onclick = () => { c.ox = +b.dataset.ox; upd(); }));
    m.querySelectorAll("[data-oy]").forEach((b) => (b.onclick = () => { c.oy = +b.dataset.oy; upd(); }));
    $("[data-reset]", m).onclick = () => { Object.assign(c, { zoom: 1, ox: 0, oy: 0 }); upd(); };
    m.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => { v.currentTime = Math.max(0, Math.min(D(), v.currentTime + +b.dataset.step)); }));
    $("#setIn", m).onclick = () => { c.in = Math.min(v.currentTime, c.out - 0.2); upd(); };
    $("#setOut", m).onclick = () => { c.out = Math.max(v.currentTime, c.in + 0.2); upd(); };
    // 화면 드래그로 위치 이동
    stage.onpointerdown = (e) => {
      if (e.target.closest("button")) return;
      const sx = e.clientX, sy = e.clientY, ox0 = +c.ox, oy0 = +c.oy;
      const r = placeVideo(v.videoWidth || 1080, v.videoHeight || 1920, SW, SH, c);
      const lim = c.fit === "custom" ? 200 : 100;
      const dx2o = c.fit === "custom" ? 100 / (SW / 2) : Math.abs(SW - r.w) > 1 ? 100 / (Math.abs(SW - r.w) / 2) : 0;
      const dy2o = c.fit === "custom" ? 100 / (SH / 2) : Math.abs(SH - r.h) > 1 ? 100 / (Math.abs(SH - r.h) / 2) : 0;
      stage.setPointerCapture(e.pointerId);
      stage.onpointermove = (ev) => {
        c.ox = Math.max(-lim, Math.min(lim, ox0 + (ev.clientX - sx) * dx2o));
        c.oy = Math.max(-lim, Math.min(lim, oy0 + (ev.clientY - sy) * dy2o)); upd();
      };
      stage.onpointerup = () => { stage.onpointermove = null; };
    };
    // 타임라인 핸들
    tl.onpointerdown = (e) => {
      const rect = tl.getBoundingClientRect(), toT = (x) => Math.max(0, Math.min(D(), ((x - rect.left) / rect.width) * D()));
      const h = e.target.dataset.h, mid = e.target.id === "tlMid";
      tl.setPointerCapture(e.pointerId);
      if (!h && !mid) { v.currentTime = toT(e.clientX); return; }
      const t0 = toT(e.clientX), in0 = +c.in, out0 = +c.out;
      tl.onpointermove = (ev) => {
        const t = toT(ev.clientX);
        if (h === "in") c.in = Math.min(t, c.out - 0.2);
        else if (h === "out") c.out = Math.max(t, c.in + 0.2);
        else { const d = Math.max(-in0, Math.min(D() - out0, t - t0)); c.in = in0 + d; c.out = out0 + d; }
        v.currentTime = h === "out" ? c.out : c.in; upd();
      };
      tl.onpointerup = () => { tl.onpointermove = null; };
    };
    $("#ceSave", m).onclick = () => {
      Object.assign(orig, { in: +(+c.in).toFixed(2), out: +(+c.out).toFixed(2), fit: c.fit, zoom: +(+c.zoom).toFixed(3), ox: Math.round(c.ox), oy: Math.round(c.oy), duration: c.duration });
      touch(); cancelAnimationFrame(raf); v.pause(); closeFn(); after?.();
    };
    m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { cancelAnimationFrame(raf); v.pause(); }));
    setTimeout(upd, 50);
  });
}

/* ---------------------------------------------------------------- 목소리 선택 상자 (2단계/4단계 공용) */
const ENGINE_LABEL = { typecast: "타입캐스트 (API 키, 무료 플랜 월 한도)", edge: "무료 · Edge (키 없음)", gemini: "Gemini 무료 키 (말투 지시 반영)", fish: "Fish Audio (내 목소리)", say: "Mac 기본 (인터넷 없이)" };
function voiceOptions(sel, gender = "all", withDefault = false) {
  const list = MK.voices.filter((v) => gender === "all" || v.gender === gender);
  const groups = {};
  list.forEach((v) => (groups[v.engine] = groups[v.engine] || []).push(v));
  const key = (v) => `${v.engine}|${v.id}`;
  return (withDefault ? `<option value="">기본 목소리 사용</option>` : "") +
    Object.entries(groups).map(([eng, vs]) => `<optgroup label="${ENGINE_LABEL[eng] || eng}">${vs.map((v) =>
      `<option value="${esc(key(v))}" ${sel === key(v) ? "selected" : ""}>${v.gender === "male" ? "👨" : "👩"} ${esc(v.name)} (${v.gender === "male" ? "남성" : "여성"} / ${esc(v.desc)})</option>`).join("")}</optgroup>`).join("");
}
function ttsBox(p) {
  const t = p.tts, g = MK.ttsGender || "all";
  return `<div class="card tight stack tts-box">
    <div class="row between"><b>🎙 전체 기본 목소리 종류 (TTS)</b><button class="btn sm ghost" id="ttsPrev">▶ 미리듣기</button></div>
    <div class="row between"><span class="mk-label" style="margin:0">AI 성우 선택</span>
      <div class="chips">${[["all", "전체"], ["female", "여성"], ["male", "남성"]].map(([k, l]) => `<button class="chip ${g === k ? "on red" : ""}" data-g="${k}">${l}</button>`).join("")}</div></div>
    <select id="ttsVoice">${voiceOptions(`${t.engine}|${t.voice}`, g)}</select>
    <span class="mk-label" style="margin:0">TTS 스타일 & 프롬프트 프리셋</span>
    <select id="ttsStyle">${MK.styles.map((s) => `<option value="${s.id}" ${t.style === s.id ? "selected" : ""}>🎭 ${esc(s.name)}</option>`).join("")}</select>
    <div class="row faint" style="font-size:12.5px;gap:14px">
      <label class="row" style="gap:6px">속도 <input type="range" id="ttsSpeed" min="0.8" max="1.3" step="0.05" value="${t.speed || 1}" style="width:110px"> <span id="ttsSpeedL">${(+t.speed || 1).toFixed(2)}x</span></label>
      <span>${t.engine === "gemini" ? "Gemini는 스타일 문장(말투 지시)이 그대로 반영돼요" : t.engine === "edge" ? "Edge는 스타일의 속도·톤만 반영돼요" : t.engine === "typecast" ? "타입캐스트는 스타일의 감정(기쁨·차분함·속삭임 등)과 속도가 반영돼요. 1글자 = 1크레딧" : ""}</span></div>
  </div>`;
}
function bindTtsBox(root, rerender) {
  const p = MK.p;
  root.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => { MK.ttsGender = b.dataset.g; rerender(); }));
  $("#ttsVoice", root).onchange = (e) => { const [eng, id] = e.target.value.split("|"); p.tts.engine = eng; p.tts.voice = id; touch(); rerender(); };
  $("#ttsStyle", root).onchange = (e) => { p.tts.style = e.target.value; touch(); };
  $("#ttsSpeed", root).oninput = (e) => { p.tts.speed = +e.target.value; $("#ttsSpeedL", root).textContent = p.tts.speed.toFixed(2) + "x"; touch(); };
  $("#ttsPrev", root).onclick = async (e) => {
    const b = e.target;
    const vv = MK.voices.find((x) => x.engine === p.tts.engine && x.id === p.tts.voice);
    if (vv?.preview) { MK.audio?.pause(); MK.audio = new Audio(vv.preview); MK.audio.play(); toast("타입캐스트 샘플 음성이에요 (크레딧 안 씀)"); return; }
    b.disabled = true; b.textContent = "만드는 중…";
    try {
      const r = await api("POST", "/api/tts/preview", { engine: p.tts.engine, voice: p.tts.voice, style: p.tts.style, speed: p.tts.speed, text: p.scenes.slice(0, 4).map((s) => s.text).join(" ") || undefined });
      MK.audio?.pause(); MK.audio = new Audio(r.url); MK.audio.play();
    } catch (err) { fail(err); }
    b.disabled = false; b.textContent = "▶ 미리듣기";
  };
}

/* ---------------------------------------------------------------- 진행 상황 화면 (분석·목소리) */
function waitJob(jobId, onTick) {
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        const j = await api("GET", `/api/jobs/${jobId}`);
        onTick?.(j);
        if (j.status === "running") return setTimeout(tick, 700);
        if (j.status === "error") return rej(new Error(j.error));
        res(j);
      } catch (e) { rej(e); }
    };
    tick();
  });
}
function progressScreen(body, title, desc) {
  body.innerHTML = `<div class="card mk-card" style="text-align:center">
    <div class="spinner"></div><h2 style="margin:14px 0 6px">${title}</h2><p class="muted">${desc}</p>
    <div class="prog-card"><div class="row between"><b id="pgMsg" class="brand-t">준비 중…</b><b id="pgPct" class="brand-t">0%</b></div>
      <div class="bar"><i id="pgBar" style="width:3%"></i></div><div class="pg-log" id="pgLog">작업을 시작했어요</div></div>
    ${footer("이전", "작업 중…", { disableNext: true })}</div>`;
  $("#fPrev").disabled = true;
  const log = [];
  return (j) => {
    $("#pgMsg").textContent = j.message; $("#pgPct").textContent = Math.round(j.progress * 100) + "%";
    $("#pgBar").style.width = Math.max(3, j.progress * 100) + "%";
    if (log[log.length - 1] !== j.message) { log.push(j.message); $("#pgLog").textContent = "✔ " + (log[log.length - 2] || "시작") + " 완료 → " + j.message; }
  };
}
async function runVoiceJob(body, after, force = false) {
  await mkSave(true);
  const upd = progressScreen(body, "🎙 AI 목소리 생성 및 자막 동기화 중…", "확정한 대본으로 장면별 목소리를 만들고 자막 시간을 맞추고 있어요.");
  try {
    const j = await api("POST", `/api/projects/${MK.p.id}/voice${force ? "?force=1" : ""}`);
    await waitJob(j.id, upd);
    MK.plan = null; after();
  } catch (e) {
    body.innerHTML = `<div class="card mk-card"><div class="notice bad"><b>목소리를 만들지 못했어요.</b><br>${esc(e.message)}</div>
      <p class="muted">목소리를 다른 엔진(예: 무료 · Edge)으로 바꾸거나 인터넷 연결을 확인한 뒤 다시 시도해 주세요.</p>
      <div class="row"><button class="btn" id="eBack">대본으로 돌아가기</button><button class="btn primary" id="eRetry">다시 시도</button></div></div>`;
    $("#eBack").onclick = () => renderMaker();
    $("#eRetry").onclick = () => runVoiceJob(body, after, force);
  }
}

/* ---------------------------------------------------------------- 2단계: 대본 각색 */
function step2(body) {
  const p = MK.p;
  if (p.scenes.length && p.script.view === "scenes") return step2Scenes(body);
  step2Settings(body);
}
function clipPreview(id, width) {
  return `<div class="phone" style="width:${width}px">${stageHTML(id, width - 16)}<div class="ph-label" id="${id}L"></div>
    <div class="ph-ctrl"><button class="btn sm" id="${id}P">▶</button><div class="ph-bar" id="${id}B"><i></i></div><span class="mono" id="${id}T">0.0s</span></div></div>`;
}
function bindClipPreview(id, clipIdx, opts = {}) {
  const p = MK.p, el = $("#" + id);
  const st = stageApi(el, p);
  const c = p.clips[clipIdx];
  if (!c) return st;
  st.setClip(clipIdx, +c.in);
  st.draw(opts.scene || null);
  const v = st.video, btn = $("#" + id + "P"), bar = $("#" + id + "B");
  $("#" + id + "L").textContent = opts.label || `현재 재생 클립: ${c.name}`;
  let raf;
  const tick = () => {
    if (!el.isConnected) { v.pause(); return; }
    const t = v.currentTime - c.in, L = clipLen(c);
    if (v.currentTime >= c.out - 0.03 && !v.paused) v.currentTime = c.in;
    bar.firstElementChild.style.width = Math.min(100, (t / L) * 100) + "%";
    $("#" + id + "T").textContent = `${Math.max(0, t).toFixed(1)}s / ${L.toFixed(1)}s`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  btn.onclick = () => { if (v.paused) { v.play(); btn.textContent = "⏸"; } else { v.pause(); btn.textContent = "▶"; } };
  bar.onclick = (e) => { const r = bar.getBoundingClientRect(); v.currentTime = c.in + ((e.clientX - r.left) / r.width) * clipLen(c); };
  return st;
}
function step2Settings(body) {
  const p = MK.p, sc = p.script;
  const adapt = S.prompts.filter((x) => x.category === "대본 각색");
  const titles = S.prompts.filter((x) => x.category === "제목 생성");
  if (!sc.presetId && adapt[0]) sc.presetId = adapt[0].id;
  if (!sc.titlePresetId && titles[0]) sc.titlePresetId = titles[0].id;
  const hasGemini = !!S.settings.gemini_key;
  if (!hasGemini && sc.engine === "gemini") sc.engine = "chatgpt";
  MK.prevClip = Math.min(MK.prevClip || 0, p.clips.length - 1);
  const ments = `<div class="card tight stack">
      <div class="row between"><b>🎬 고정 오프닝 & 아웃트로 멘트 설정</b><span class="badge brand">대본 앞/뒤 자동 삽입</span></div>
      <div class="row between"><span class="mk-label" style="margin:0">오프닝 멘트 (Opening Ment)</span>
        <select class="mini" id="opPre"><option value="">프리셋 선택 (직접 입력)</option>${(S.settings.opening_presets || []).map((x) => `<option>${esc(x)}</option>`).join("")}</select></div>
      <input type="text" id="opening" value="${esc(sc.opening)}" placeholder="영상 시작 시 첫 대사로 들어갈 오프닝 멘트 (기본값: 없음)">
      <span class="faint" style="font-size:12px">※ 입력 시 대본의 첫 번째 씬 대사로 포함됩니다. (비워두면 오프닝 없이 바로 시작)</span>
      <div class="row between"><span class="mk-label" style="margin:0">아웃트로 멘트 (Outro Ment)</span>
        <select class="mini" id="otPre"><option value="">기본 멘트 적용</option>${(S.settings.outro_presets || []).map((x) => `<option>${esc(x)}</option>`).join("")}</select></div>
      <input type="text" id="outro" value="${esc(sc.outro)}" placeholder="영상 마지막 대사 (비워두면 없음)">
    </div>`;
  body.innerHTML = `<div class="card mk-card">
    <h2 class="mk-h">✨ 임시 편집 구성 및 대본 설정</h2>
    <p class="muted mk-sub">설정한 사용 구간과 재생 배치를 확인하고, 쇼츠 대본 생성을 위한 AI 프리셋을 세팅하세요.</p>
    <div class="s2-grid">
      <div class="stack" style="align-items:center;position:sticky;top:12px;align-self:start">
        ${clipPreview("s2Prev", 300)}
        <div class="chips">${p.clips.map((c, i) => `<button class="chip ${i === MK.prevClip ? "on brand" : ""}" data-pc="${i}">클립 #${i + 1}</button>`).join("")}</div>
      </div>
      <div class="stack">
        <div class="card tight stack"><div class="row between"><b>🗂 총 타임라인 배치 정보</b><span class="badge brand">총 사용 시간: ${totalUsed(p).toFixed(2)}초</span></div>
          ${p.clips.map((c, i) => `<div class="tl-row"><span class="faint">⠿</span><b>${i + 1}</b><div style="min-width:0"><div class="n">${esc(c.name)}</div><div class="faint" style="font-size:12px">구간: ${(+c.in).toFixed(1)}초 - ${(+c.out).toFixed(1)}초 (${clipLen(c).toFixed(1)}초 사용)</div></div></div>`).join("")}
        </div>
        <div class="tabs2"><button class="${sc.tab === "ai" ? "on" : ""}" data-tab="ai">✨ AI 대본생성</button><button class="${sc.tab === "manual" ? "on" : ""}" data-tab="manual">📄 수동 대본 입력</button></div>
        ${sc.tab === "ai" ? `
        <div class="card tight stack">
          <b>⚡ 분석 방법</b>
          <div class="seg"><button data-eng="gemini" class="${sc.engine === "gemini" ? "on" : ""}" ${hasGemini ? "" : "disabled"}>Gemini 무료 키 (자동 영상 분석)</button><button data-eng="chatgpt" class="${sc.engine === "chatgpt" ? "on" : ""}">ChatGPT로 만들기 (복사·붙여넣기)</button></div>
          <span class="faint" style="font-size:12.5px">${hasGemini ? (sc.engine === "gemini" ? "영상의 화면과 말소리를 Gemini가 직접 보고 대본을 써요 (무료 사용량 안에서)." : "장면 캡처 이미지와 프롬프트를 ChatGPT에 붙여넣고, 답을 다시 붙여넣어요.") : `Gemini 키가 없어서 ChatGPT 방식으로 해요. <a href="#/settings" class="link">설정에서 무료 키 넣기 →</a>`}</span>
        </div>
        <div class="card tight stack">
          <b>✨ 대본 각색 및 제목 생성 프리셋</b>
          <span class="mk-label" style="margin:0">대본 각색 프롬프트 프리셋</span>
          <select id="preset">${adapt.map((x) => `<option value="${x.id}" ${x.id === sc.presetId ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select>
          <span class="mk-label" style="margin:0">제목 생성 프롬프트 프리셋</span>
          <select id="tpreset">${titles.map((x) => `<option value="${x.id}" ${x.id === sc.titlePresetId ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select>
          <span class="mk-label" style="margin:0">상품·영상 메모 <span class="faint" style="font-weight:400">(프리셋의 {빈칸}에 들어가요)</span></span>
          <textarea id="memo" rows="2" style="min-height:60px" placeholder="예: 회전식 계란 정리함, 냉장고 문 수납, 30구">${esc(sc.memo)}</textarea>
          <a href="#/prompts" class="link faint" style="font-size:12.5px">프리셋 프롬프트 수정·추가하기 →</a>
        </div>
        ${ments}
        ${ttsBox(p)}
        <button class="btn primary big" id="doAI">✂ 대본 각색하기</button>` : `
        <div class="card tight stack">
          <div class="row between"><b>📄 쇼츠 대본 직접 입력</b><span class="badge brand" id="mCount">총 ${charLen(sc.manual)}자</span></div>
          <span class="faint" style="font-size:12.5px">준비된 대본 텍스트를 입력하시면 7~12자의 자연스러운 호흡에 맞춰 씬별 자막으로 자동 분할합니다.</span>
          <textarea id="manual" rows="9" placeholder="쇼츠 영상에 들어갈 전체 대본을 자유롭게 입력하세요.\n\n예시:\n많은 분들이 기다리시던 신제품이 드디어 출시되었습니다.\n작아 보이지만 내부에는 5개의 포켓이 있어서 외출할 때 필요한 물건들을 깔끔하게 정리할 수 있거든요.">${esc(sc.manual)}</textarea>
          <span class="faint" style="font-size:12px">💡 문장부호(. ! ?)나 줄바꿈(엔터)이 호흡 기준점으로 반영됩니다.</span>
        </div>
        ${ments}
        ${ttsBox(p)}
        <button class="btn primary big" id="doSplit">✂ 대본 장면 분할하기</button>`}
        ${p.scenes.length ? `<button class="btn" id="toScenes">← 지금 만들어 둔 장면 ${p.scenes.length}개로 돌아가기</button>` : ""}
      </div>
    </div>
    ${footer("이전", "다음 단계", { disableNext: !p.scenes.length })}
  </div>`;
  bindClipPreview("s2Prev", MK.prevClip);
  body.querySelectorAll("[data-pc]").forEach((b) => (b.onclick = () => { MK.prevClip = +b.dataset.pc; step2Settings(body); }));
  body.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { sc.tab = b.dataset.tab; touch(); step2Settings(body); }));
  body.querySelectorAll("[data-eng]").forEach((b) => (b.onclick = () => { sc.engine = b.dataset.eng; touch(); step2Settings(body); }));
  $("#preset")?.addEventListener("change", (e) => { sc.presetId = e.target.value; touch(); });
  $("#tpreset")?.addEventListener("change", (e) => { sc.titlePresetId = e.target.value; touch(); });
  $("#memo")?.addEventListener("input", (e) => { sc.memo = e.target.value; touch(); });
  $("#manual")?.addEventListener("input", (e) => { sc.manual = e.target.value; $("#mCount").textContent = `총 ${charLen(sc.manual)}자`; touch(); });
  $("#opening").oninput = (e) => { sc.opening = e.target.value; touch(); };
  $("#outro").oninput = (e) => { sc.outro = e.target.value; touch(); };
  $("#opPre").onchange = (e) => { if (e.target.value) { sc.opening = e.target.value; $("#opening").value = sc.opening; touch(); } };
  $("#otPre").onchange = (e) => { if (e.target.value) { sc.outro = e.target.value; $("#outro").value = sc.outro; touch(); } };
  bindTtsBox(body, () => step2Settings(body));
  $("#toScenes")?.addEventListener("click", () => { sc.view = "scenes"; touch(); step2(body); });
  const replaceOk = () => !p.scenes.length || confirm(`지금 있는 장면 ${p.scenes.length}개를 새 대본으로 바꿀까요?`);
  const applyScenes = (scenes, title) => {
    p.scenes = scenes; if (title) p.title = title; sc.view = "scenes"; MK.sel = 0; touch(); step2(body);
    toast(`장면 ${scenes.length}개로 나눴어요`);
  };
  $("#doSplit")?.addEventListener("click", async () => {
    if (!sc.manual.trim()) return toast("대본을 입력해 주세요");
    if (!replaceOk()) return;
    try { await mkSave(true); const r = await api("POST", `/api/projects/${p.id}/split`, { text: sc.manual, opening: sc.opening, outro: sc.outro }); applyScenes(r.scenes); } catch (e) { fail(e); }
  });
  $("#doAI")?.addEventListener("click", async () => {
    if (!p.clips.length) return toast("1단계에서 영상을 먼저 올려 주세요");
    if (!replaceOk()) return;
    await mkSave(true);
    if (sc.engine === "gemini") return runGemini(body, applyScenes);
    openChatGPTFlow(applyScenes);
  });
  $("#fPrev").onclick = () => goStep(1);
  $("#fNext").onclick = () => { sc.view = "scenes"; touch(); step2(body); };
}
async function runGemini(body, applyScenes) {
  const upd = progressScreen(body, "동영상 AI 분석 및 쇼츠 대본 추출 중...", "업로드된 영상의 화면과 말소리를 입체적으로 이해하여 최적의 각색 대본을 추출하고 있습니다.");
  try {
    const j = await api("POST", `/api/projects/${MK.p.id}/analyze`);
    const done = await waitJob(j.id, upd);
    applyScenes(done.result.scenes, done.result.title);
  } catch (e) {
    body.innerHTML = `<div class="card mk-card"><div class="notice bad"><b>AI 분석에 실패했어요.</b><br>${esc(e.message)}</div>
      <div class="row" style="margin-top:12px"><button class="btn" id="eBack">설정으로 돌아가기</button><button class="btn primary" id="eGpt">ChatGPT로 만들기</button></div></div>`;
    $("#eBack").onclick = () => step2Settings(body);
    $("#eGpt").onclick = () => { step2Settings(body); openChatGPTFlow(applyScenes); };
  }
}
function openChatGPTFlow(applyScenes) {
  const p = MK.p;
  modal(`
    <h3>ChatGPT로 대본 만들기 <span class="badge">무료</span></h3>
    <p class="faint" style="margin:0">ChatGPT는 영상을 직접 못 보니까, 장면 캡처 이미지와 프롬프트를 함께 붙여넣어요.</p>
    <div class="gpt-step"><b>① 장면 캡처 이미지 만들기</b>
      <div class="row"><button class="btn" id="gSb">이미지 만들기</button><a class="btn" id="gDl" hidden download="장면캡처.jpg">이미지 다운로드</a><button class="btn" id="gCopyImg" hidden>이미지 복사</button></div>
      <img id="gImg" hidden style="max-width:100%;border-radius:8px;border:1px solid var(--line)"></div>
    <div class="gpt-step"><b>② 프롬프트 복사하고 ChatGPT 열기</b>
      <span class="faint">ChatGPT 입력창에 이미지를 붙여넣고(⌘V 또는 끌어놓기), 프롬프트도 붙여넣은 뒤 보내세요.</span>
      <div class="row"><button class="btn primary" id="gOpen">프롬프트 복사하고 ChatGPT 열기</button><button class="btn ghost" id="gCopy">프롬프트만 복사</button></div></div>
    <div class="gpt-step"><b>③ ChatGPT 답변을 그대로 붙여넣기</b>
      <textarea id="gAns" rows="7" placeholder='{"title": "...", "scenes": [ ... ]}  형식의 답변을 통째로 붙여넣으세요. 그냥 대본 글을 붙여넣어도 자동으로 나눠요.'></textarea></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary" id="gApply">장면으로 나누기</button></div>`,
  (m, close) => {
    let promptText = "";
    const getPrompt = async () => promptText || (promptText = (await api("GET", `/api/projects/${p.id}/prompt?mode=chatgpt`)).prompt);
    $("#gSb", m).onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "만드는 중…";
      try {
        const r = await api("POST", `/api/projects/${p.id}/storyboard`);
        $("#gImg", m).src = r.url; $("#gImg", m).hidden = false; $("#gDl", m).href = r.url; $("#gDl", m).hidden = false; $("#gCopyImg", m).hidden = false;
        e.target.textContent = "다시 만들기";
      } catch (err) { fail(err); e.target.textContent = "이미지 만들기"; }
      e.target.disabled = false;
    };
    $("#gCopyImg", m).onclick = async () => {
      try {
        const img = $("#gImg", m), cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext("2d").drawImage(img, 0, 0);
        const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast("이미지를 복사했어요. ChatGPT에 ⌘V 하세요");
      } catch { toast("이미지 복사가 안 되면 다운로드해서 끌어다 놓아 주세요", 3500); }
    };
    const win = { ref: null };
    $("#gOpen", m).onclick = async () => {
      win.ref = window.open(linkUrl("chatgpt"), "_blank");
      try { await copyText(await getPrompt()); toast("프롬프트를 복사했어요. ChatGPT에 붙여넣으세요", 3500); } catch (e) { fail(e); }
    };
    $("#gCopy", m).onclick = async () => { try { await copyText(await getPrompt()); toast("프롬프트를 복사했어요"); } catch (e) { fail(e); } };
    $("#gApply", m).onclick = async () => {
      const text = $("#gAns", m).value.trim();
      if (!text) return toast("ChatGPT 답변을 붙여넣어 주세요");
      try { const r = await api("POST", `/api/projects/${p.id}/apply`, { text, opening: p.script.opening, outro: p.script.outro }); close(); applyScenes(r.scenes, r.title); }
      catch (e) { fail(e); }
    };
  });
  $("#modal .box").classList.add("wide");
}
function step2Scenes(body) {
  const p = MK.p;
  const groups = [];
  p.scenes.forEach((s, i) => { const g = groups[groups.length - 1]; if (g && g.clip === s.clip) g.items.push(i); else groups.push({ clip: s.clip, items: [i] }); });
  body.innerHTML = `<div class="card mk-card">
    <div class="row between"><div><h2 class="mk-h">장면별 각색 대본 및 문장 분할</h2>
      <p class="muted mk-sub">동영상에서 인식된 장면 단위의 문장 구조입니다. 쇼츠 대본 텍스트를 편집해 주세요.</p></div>
      <div class="row"><button class="btn" id="srtDl">⬇ 자막 SRT</button><button class="btn" id="reAI">✨ AI 대본 재각색</button><button class="btn" id="addScene">+ 장면 추가</button></div></div>
    <div class="row" style="margin:6px 0 14px"><span class="mk-label" style="margin:0">영상 제목</span><input type="text" id="ptitle" value="${esc(p.title)}" placeholder="제목 (레이어의 {제목} 자리에 들어가요)" style="max-width:420px"></div>
    ${groups.map((g, gi) => { const c = p.clips[g.clip] || {}; return `
    <div class="card clip-group">
      <div class="row"><b>🎬 클립 #${g.clip + 1}</b><span class="badge warn">📍 편집 구간: ${(+c.in || 0).toFixed(2)}s - ${(+c.out || 0).toFixed(2)}s (${clipLen(c).toFixed(2)}초 사용)</span></div>
      <div class="cg-grid">
        <div style="position:sticky;top:12px;align-self:start">${clipPreview("cg" + gi, 240)}</div>
        <div class="stack">${g.items.map((i) => sceneCard(p.scenes[i], i)).join("")}
          <button class="btn ghost sm" data-addclip="${g.clip}" data-after="${g.items[g.items.length - 1]}">+ 이 클립에 장면 추가</button></div>
      </div>
    </div>`; }).join("")}
    <div class="row faint" style="font-size:13px">총 ${p.scenes.length}개 장면 · ${p.scenes.reduce((a, s) => a + charLen(s.text), 0)}자 · 예상 길이 약 ${Math.round(p.scenes.reduce((a, s) => a + charLen(s.text), 0) / 4.5)}초</div>
    ${footer("이전", "다음 단계")}
  </div>`;
  groups.forEach((g, gi) => bindClipPreview("cg" + gi, g.clip, { scene: p.scenes[g.items[0]], label: `클립 #${g.clip + 1} (${(+p.clips[g.clip]?.in || 0).toFixed(1)}s-${(+p.clips[g.clip]?.out || 0).toFixed(1)}s)` }));
  $("#ptitle").oninput = (e) => { p.title = e.target.value; touch(); };
  $("#srtDl").onclick = downloadSrt;
  $("#reAI").onclick = () => { p.script.view = "settings"; touch(); step2(body); };
  const addAfter = (i, clip) => { p.scenes.splice(i + 1, 0, { id: Math.random().toString(16).slice(2, 10), clip, text: "", original: "", voice: null, extra: {}, hide: [] }); touch(); step2Scenes(body); };
  $("#addScene").onclick = () => addAfter(p.scenes.length - 1, p.scenes.length ? p.scenes[p.scenes.length - 1].clip : 0);
  body.querySelectorAll("[data-addclip]").forEach((b) => (b.onclick = () => addAfter(+b.dataset.after, +b.dataset.addclip)));
  bindSceneCards(body, () => step2Scenes(body));
  $("#fPrev").onclick = () => { p.script.view = "settings"; touch(); step2(body); };
  $("#fNext").onclick = () => {
    const empty = p.scenes.filter((s) => !s.text.trim()).length;
    modal(`<h3>대본 확정 및 음성 생성 동의</h3>
      <p>최종 대본으로 확정하고 목소리를 생성합니다.</p>
      <p class="faint">나중에 대본을 바꾸면 바뀐 문장만 목소리를 다시 만들어요. 무료 엔진이라 비용은 들지 않아요.${empty ? `<br>대사가 빈 장면 ${empty}개는 1초 동안 화면만 나와요.` : ""}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary dark" id="okVoice">확인</button></div>`,
    (m, close) => { $("#okVoice", m).onclick = () => { close(); p.maxStep = Math.max(p.maxStep, 3); runVoiceJob(body, () => goStep(3)); }; });
  };
}
async function downloadSrt() {
  const p = MK.p;
  await mkSave(true);
  const r = await api("GET", `/api/projects/${p.id}/srt`).catch(fail);
  if (!r) return;
  if (!r.count) return toast("자막이 없어요. 먼저 장면 대사를 입력해 주세요");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + r.srt], { type: "application/x-subrip;charset=utf-8" }));
  a.download = `${(p.title || p.name || "자막").replace(/[\\/:*?"<>|]+/g, "_").trim() || "자막"}.srt`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(r.missing ? `자막 ${r.count}개를 받았어요. 아직 목소리를 안 만든 문장은 예상 시간으로 넣었어요` : `자막 ${r.count}개를 SRT로 받았어요`);
}
function sceneCard(s, i) {
  const p = MK.p, n = p.scenes.length;
  const vsel = s.voice ? `${s.voice.engine}|${s.voice.voice}` : "";
  return `<div class="scene-card" data-si="${i}">
    <div class="row between"><span class="badge brand">장면 #${i + 1}</span>
      <div class="row" style="gap:2px"><span class="faint" style="font-size:12px;margin-right:6px">${charLen(s.text)}자</span>
        <button class="btn sm ghost" data-sup="${i}" ${i ? "" : "disabled"}>↑</button><button class="btn sm ghost" data-sdown="${i}" ${i < n - 1 ? "" : "disabled"}>↓</button><button class="btn sm ghost danger" data-sdel="${i}">🗑</button></div></div>
    <div class="sc-grid">
      <div class="orig"><span class="faint" style="font-size:12px">동영상 원본 대사 / 화면</span><div>${s.original ? `“${esc(s.original)}”` : '<span class="faint">—</span>'}</div></div>
      <div class="stack" style="gap:6px"><span class="brand-t" style="font-size:12px;font-weight:700">각색할 새로운 숏츠 텍스트 (자막)</span>
        <input type="text" data-stext="${i}" value="${esc(s.text)}" placeholder="이 장면의 자막 (비우면 화면만)">
        <select class="mini" data-svoice="${i}"><option value="">🎙 이 장면만 목소리 변경 (개별 지정)</option>${voiceOptions(vsel, "all")}</select></div>
    </div></div>`;
}
function bindSceneCards(root, rerender) {
  const p = MK.p;
  root.querySelectorAll("[data-stext]").forEach((el) => (el.oninput = () => { p.scenes[+el.dataset.stext].text = el.value; touch(); }));
  root.querySelectorAll("[data-svoice]").forEach((el) => (el.onchange = () => {
    const s = p.scenes[+el.dataset.svoice];
    if (!el.value) s.voice = null; else { const [engine, voice] = el.value.split("|"); s.voice = { engine, voice }; }
    touch();
  }));
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= p.scenes.length) return;
    if (p.scenes[j].clip !== p.scenes[i].clip) p.scenes[i].clip = p.scenes[j].clip; // 클립 경계를 넘으면 그 클립으로 옮김
    else [p.scenes[i], p.scenes[j]] = [p.scenes[j], p.scenes[i]];
    touch(); rerender();
  };
  root.querySelectorAll("[data-sup]").forEach((b) => (b.onclick = () => move(+b.dataset.sup, -1)));
  root.querySelectorAll("[data-sdown]").forEach((b) => (b.onclick = () => move(+b.dataset.sdown, 1)));
  root.querySelectorAll("[data-sdel]").forEach((b) => (b.onclick = () => { p.scenes.splice(+b.dataset.sdel, 1); touch(); rerender(); }));
}

/* ---------------------------------------------------------------- 3단계: 레이아웃 세팅 */
const TYPE_BADGE = { subtitle: ["자막", "yellow"], video: ["에셋", "green"], image: ["에셋", "green"], shape: ["도형", "blue"] };
function newLayer(type) {
  const id = Math.random().toString(16).slice(2, 8);
  const subs = MK.p.layout.layers.filter((l) => l.type === "subtitle").length;
  if (type === "subtitle") return { id, type, name: `추가 자막 ${subs + 1}`, visible: true, x: 90, y: 300, w: 900, h: 200, text: "",
    font: "Black Han Sans", size: 80, weight: 400, color: "#ffe14d", align: "center", underline: false, lineHeight: 1.2,
    bgColor: "#000000", bgTransparent: true, bgOpacity: 70, bgPad: 18, bgRadius: 16, shadow: true, shadowBlur: 10, shadowOpacity: 80,
    shadowDist: 3, shadowAngle: 45, shadowColor: "#000000", stroke: 6, strokeColor: "#000000" };
  if (type === "image") return { id, type, name: "에셋 이미지", visible: true, x: 390, y: 150, w: 300, h: 300, src: "", opacity: 100, fit: "contain", radius: 0 };
  if (type === "border") return { id, type: "shape", name: "테두리 박스", visible: true, x: 30, y: 30, w: 1020, h: 1860, fill: "#000000", fillOpacity: 0, opacity: 100, radius: 30, borderWidth: 12, borderColor: "#ffffff" };
  return { id, type: "shape", name: "배경 도형", visible: true, x: 0, y: 0, w: 1080, h: 420, fill: "#000000", fillOpacity: 100, opacity: 100, radius: 0, borderWidth: 0, borderColor: "#ffffff" };
}
function step3(body) {
  const p = MK.p;
  if (!MK.layoutBase) MK.layoutBase = JSON.stringify(p.layout);
  const L = () => p.layout.layers;
  if (!L().find((l) => l.id === MK.s3sel)) MK.s3sel = L()[0]?.id;
  const presetOpts = MK.layouts.map((x) => `<option value="${x.id}" ${x.name === p.layout.name ? "selected" : ""}>${esc(x.name)}${x.builtin ? "" : " (내 레이아웃)"}</option>`).join("");
  body.innerHTML = `<div class="card mk-card">
    <div class="row between"><div><h2 class="mk-h">▣ 레이아웃 배치 에디터 (Z-Index 제어)</h2>
      <p class="muted mk-sub">화면 내부의 요소들을 드래그하여 배치하고 상세 속성을 편집하세요.</p></div>
      <div class="row"><span class="faint">레이아웃 템플릿:</span><select id="preset" class="mini" style="width:auto">${presetOpts}</select><button class="btn sm ghost danger" id="delPreset" title="내 레이아웃 삭제">🗑</button></div></div>
    <div class="addbar"><span>+ 신규 레이어 추가</span>
      <button data-add="subtitle">≡ + 자막 레이어</button><button data-add="image">🖼 + 에셋 레이어</button><button data-add="shape">▢ + 배경 도형</button><button data-add="border">⬚ + 테두리 박스</button></div>
    <div class="s3-grid">
      <div class="stack" style="align-items:center">
        <div class="phone" style="width:376px"><div id="s3wrap" style="position:relative">${stageHTML("s3Stage", 360)}<div class="hit" id="hit"></div></div></div>
        <div class="row"><button class="btn sm" id="s3Play">▶ 영상 재생</button><span class="faint" style="font-size:12px">미리보기 자막: 1번 장면</span></div>
      </div>
      <div class="card tight props" id="props"></div>
    </div>
    <div class="card tight" style="margin-top:16px">
      <div class="row between"><div><b>◎ 레이어 순서 관리 및 편집 (Layer Management)</b>
        <div class="faint" style="font-size:12.5px">목록 상단에 있을수록 캔버스의 가장 위(앞)에 그려집니다. 끌어서 순서를 바꾸고, 더블클릭하면 이름을 바꿀 수 있어요.</div></div>
        <div class="row"><button class="btn sm soft" data-add="subtitle">+ 자막 추가</button><button class="btn sm soft red" data-add="image">+ 에셋 추가</button><button class="btn sm soft blue" data-add="shape">+ 도형 추가</button></div></div>
      <div class="layer-list" id="llist"></div>
      <div class="layer-row fixed"><span class="tb gray">배경</span><span style="flex:1">배경 (Canvas Background) <span class="faint">(하단 고정 · 수정 불가)</span></span>
        <input type="color" id="bgc" value="${p.layout.bg || "#000000"}"><span class="faint">고정</span></div>
    </div>
    ${footer("이전 단계", "다음 단계 (세부 편집)")}
  </div>`;
  const st = stageApi($("#s3Stage"), p);
  st.setClip(0, p.clips[0] ? +p.clips[0].in : 0);
  const scene0 = p.scenes[0] || null;
  const sc = st.scale;
  const redraw = () => { st.layout(); st.draw(scene0); drawHits(); };
  MK.redraw = redraw;
  const changed = () => { touch(); redraw(); };
  function drawHits() {
    const hit = $("#hit");
    hit.innerHTML = L().filter((l) => l.visible !== false || l.id === MK.s3sel).map((l) => `<div class="hb ${l.id === MK.s3sel ? "sel" : ""}" data-id="${l.id}"
      style="left:${l.x * sc}px;top:${l.y * sc}px;width:${l.w * sc}px;height:${l.h * sc}px;z-index:${100 - L().indexOf(l)}">
      ${l.id === MK.s3sel ? '<i data-c="nw"></i><i data-c="ne"></i><i data-c="sw"></i><i data-c="se"></i>' : ""}</div>`).join("");
    hit.querySelectorAll(".hb").forEach((el) => (el.onpointerdown = (e) => {
      const l = L().find((x) => x.id === el.dataset.id);
      if (MK.s3sel !== l.id) { MK.s3sel = l.id; renderProps(); renderList(); drawHits(); }
      const corner = e.target.dataset.c, sx = e.clientX, sy = e.clientY, o = { x: l.x, y: l.y, w: l.w, h: l.h };
      const hb = hit.querySelector(`.hb[data-id="${l.id}"]`);
      hb.setPointerCapture(e.pointerId);
      hb.onpointermove = (ev) => {
        const dx = (ev.clientX - sx) / sc, dy = (ev.clientY - sy) / sc;
        if (!corner) { l.x = Math.round(o.x + dx); l.y = Math.round(o.y + dy); }
        else {
          if (corner.includes("w")) { l.x = Math.round(o.x + dx); l.w = Math.max(20, Math.round(o.w - dx)); }
          if (corner.includes("e")) l.w = Math.max(20, Math.round(o.w + dx));
          if (corner.includes("n")) { l.y = Math.round(o.y + dy); l.h = Math.max(20, Math.round(o.h - dy)); }
          if (corner.includes("s")) l.h = Math.max(20, Math.round(o.h + dy));
        }
        st.layout(); st.draw(scene0);
        Object.assign(hb.style, { left: l.x * sc + "px", top: l.y * sc + "px", width: l.w * sc + "px", height: l.h * sc + "px" });
      };
      hb.onpointerup = () => { hb.onpointermove = null; touch(); renderProps(); };
    }));
  }
  const num = (k, label, l, extra = "") => `<label class="f">${label}<input type="number" data-k="${k}" value="${l[k] ?? 0}" ${extra}></label>`;
  const rng = (k, label, l, min, max, unit = "") => `<label class="f">${label} <span class="faint">(${l[k] ?? 0}${unit})</span><input type="range" data-k="${k}" min="${min}" max="${max}" value="${l[k] ?? 0}"></label>`;
  const col = (k, label, l) => `<label class="f">${label}<input type="color" data-k="${k}" value="${l[k] || "#000000"}"></label>`;
  function renderProps() {
    const l = L().find((x) => x.id === MK.s3sel), box = $("#props");
    if (!l) { box.innerHTML = '<p class="muted">레이어를 선택하세요.</p>'; return; }
    const [bn] = TYPE_BADGE[l.type] || ["?"];
    let h = `<div class="row between"><b>⚙ 속성 편집</b>${l.base ? '<span class="faint">기본 레이어</span>' : '<button class="btn sm ghost danger" id="pDel">🗑 삭제</button>'}</div>
      <div class="row"><span class="badge brand">${esc(l.name)}</span><span class="badge">${bn}</span><label class="row" style="font-size:13px;margin-left:auto"><input type="checkbox" data-k="visible" ${l.visible !== false ? "checked" : ""}> 보이기</label></div>
      <div class="grid g2">${num("w", "너비", l)}${num("h", "높이", l)}
        <label class="f"><span class="row between">가로 위치 (X)<button class="link-s" data-center="x">↔ 가운데정렬</button></span><input type="number" data-k="x" value="${l.x}"></label>
        <label class="f"><span class="row between">세로 위치 (Y)<button class="link-s" data-center="y">↕ 가운데정렬</button></span><input type="number" data-k="y" value="${l.y}"></label></div>`;
    if (l.type === "subtitle") {
      h += `${l.base ? '<div class="notice" style="font-size:12.5px">기본 자막에는 각 장면의 대사가 자동으로 들어가요.</div>' :
        `<label class="f">모든 장면 공통 문구 <span class="faint" style="font-weight:400">(비우면 4단계에서 장면마다 입력, {제목} 사용 가능)</span><input type="text" data-k="text" value="${esc(l.text || "")}"></label>`}
        <div class="grid g2"><label class="f">폰트 패밀리<select data-k="font">${FONTS.map(([f, n]) => `<option value="${f}" ${l.font === f ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="f">정렬<select data-k="align">${[["left", "왼쪽 정렬"], ["center", "가운데 정렬"], ["right", "오른쪽 정렬"]].map(([k, n]) => `<option value="${k}" ${l.align === k ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
        <div class="grid g3">${num("size", "글자 크기 (px)", l)}<label class="f">굵기<select data-k="weight">${[400, 500, 700, 800, 900].map((w) => `<option ${+l.weight === w ? "selected" : ""}>${w}</option>`).join("")}</select></label>
          <label class="f">꾸미기<label class="row" style="font-size:13px;color:var(--text)"><input type="checkbox" data-k="underline" ${l.underline ? "checked" : ""}> <u>U</u> Underline</label></label></div>
        <div class="grid g3">${col("color", "글자 색상", l)}${col("bgColor", "배경 박스 색상", l)}<label class="f">배경 박스<label class="row" style="font-size:13px;color:var(--text)"><input type="checkbox" data-k="bgTransparent" ${l.bgTransparent ? "checked" : ""}> 투명</label></label></div>
        ${!l.bgTransparent ? `<div class="grid g3">${rng("bgOpacity", "박스 불투명도", l, 0, 100, "%")}${rng("bgPad", "박스 여백", l, 0, 60, "px")}${rng("bgRadius", "박스 둥글기", l, 0, 60, "px")}</div>` : ""}
        ${rng("lineHeight100", "줄 간격", { lineHeight100: Math.round((l.lineHeight || 1.25) * 100) }, 90, 200, "%")}
        <div class="sub-card"><div class="row between"><b>◎ 그림자 효과 (Text Shadow)</b><input type="checkbox" data-k="shadow" ${l.shadow ? "checked" : ""}></div>
          ${l.shadow ? `<div class="grid g2">${rng("shadowBlur", "강도/번짐", l, 0, 60, "px")}${rng("shadowOpacity", "불투명도", l, 0, 100, "%")}${rng("shadowDist", "거리", l, 0, 40, "px")}${rng("shadowAngle", "각도", l, 0, 360, "°")}</div>${col("shadowColor", "그림자 색상", l)}` : ""}</div>
        <div class="sub-card"><b>T 글자 테두리</b><div class="grid g2">${num("stroke", "두께", l, 'min="0" max="30"')}${col("strokeColor", "테두리 색상", l)}</div></div>`;
    } else if (l.type === "video") {
      h += `<div class="notice" style="font-size:12.5px">원본 영상이 들어가는 자리예요. 상자를 줄이면 위아래에 배경색이나 도형·제목을 넣을 수 있어요. 영상 안의 구도는 1단계 '9:16 크롭'에서 정해요.</div>
        ${rng("radius", "모서리 둥글기", l, 0, 120, "px")}
        <div class="row"><button class="btn sm" data-vpreset="full">전체 화면</button><button class="btn sm" data-vpreset="mid">가운데 정사각형</button><button class="btn sm" data-vpreset="mid45">가운데 4:5</button></div>`;
    } else if (l.type === "image") {
      h += `<label class="f">이미지 파일 <span class="faint" style="font-weight:400">(PNG 투명 배경 유지)</span><div class="row"><button class="btn sm" id="imgUp">${l.src ? "이미지 바꾸기" : "이미지 올리기"}</button>${l.src ? `<img src="${l.src}" style="height:36px;border-radius:6px">` : ""}</div></label>
        <div class="grid g3">${rng("opacity", "불투명도", l, 0, 100, "%")}${rng("radius", "둥글기", l, 0, 200, "px")}<label class="f">맞춤<select data-k="fit"><option value="contain" ${l.fit !== "cover" ? "selected" : ""}>전체 보이기</option><option value="cover" ${l.fit === "cover" ? "selected" : ""}>꽉 채우기</option></select></label></div>`;
    } else if (l.type === "shape") {
      h += `<div class="grid g2">${col("fill", "채우기 색상", l)}${rng("fillOpacity", "채우기 불투명도", l, 0, 100, "%")}${rng("radius", "둥글기", l, 0, 200, "px")}${rng("opacity", "전체 불투명도", l, 0, 100, "%")}${num("borderWidth", "테두리 두께", l, 'min="0" max="80"')}${col("borderColor", "테두리 색상", l)}</div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll("[data-k]").forEach((el) => (el.oninput = el.onchange = () => {
      const k = el.dataset.k;
      let val = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? +el.value : el.value;
      if (k === "lineHeight100") { l.lineHeight = val / 100; }
      else if (k === "weight") l.weight = +val;
      else l[k] = val;
      if (el.type === "range") { const s = el.previousElementSibling; if (s?.classList.contains("faint")) s.textContent = `(${el.value}${s.textContent.replace(/^\(-?[\d.]+/, "").replace(/\)$/, "")})`; }
      changed();
      if (el.type === "checkbox" && ["bgTransparent", "shadow"].includes(k)) renderProps();
      if (k === "visible") renderList();
    }));
    box.querySelectorAll("[data-center]").forEach((b) => (b.onclick = () => { if (b.dataset.center === "x") l.x = Math.round((CW - l.w) / 2); else l.y = Math.round((CH - l.h) / 2); changed(); renderProps(); }));
    box.querySelectorAll("[data-vpreset]").forEach((b) => (b.onclick = () => {
      Object.assign(l, b.dataset.vpreset === "full" ? { x: 0, y: 0, w: CW, h: CH } : b.dataset.vpreset === "mid" ? { x: 0, y: 420, w: 1080, h: 1080 } : { x: 0, y: 285, w: 1080, h: 1350 });
      changed(); renderProps();
    }));
    $("#pDel", box)?.addEventListener("click", () => { p.layout.layers = L().filter((x) => x.id !== l.id); MK.s3sel = L()[0]?.id; changed(); renderProps(); renderList(); });
    $("#imgUp", box)?.addEventListener("click", () => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
      inp.onchange = async () => {
        const fd = new FormData(); fd.append("files", inp.files[0]);
        try { const r = await api("POST", "/api/upload?asset=1", fd); l.src = r[0].url; l.name = l.name === "에셋 이미지" ? inp.files[0].name.slice(0, 20) : l.name; changed(); renderProps(); renderList(); } catch (e) { fail(e); }
      };
      inp.click();
    });
  }
  function renderList() {
    const box = $("#llist");
    box.innerHTML = L().map((l, i) => { const [bn, bc] = TYPE_BADGE[l.type] || ["?", "gray"]; return `<div class="layer-row ${bc} ${l.id === MK.s3sel ? "sel" : ""}" draggable="true" data-id="${l.id}">
      <span class="tb ${bc}">${bn}</span><span class="ln" style="flex:1">${esc(l.name)}${l.visible === false ? ' <span class="faint">(숨김)</span>' : ""}</span>
      <button class="btn sm ghost" data-lu="${i}" ${i ? "" : "disabled"}>↑</button><button class="btn sm ghost" data-ld="${i}" ${i < L().length - 1 ? "" : "disabled"}>↓</button>
      ${l.base ? '<span style="width:34px"></span>' : `<button class="btn sm ghost danger" data-lx="${l.id}">🗑</button>`}</div>`; }).join("");
    let from = null;
    box.querySelectorAll(".layer-row").forEach((row) => {
      row.onclick = (e) => { if (e.target.closest("button")) return; MK.s3sel = row.dataset.id; renderList(); renderProps(); drawHits(); };
      row.ondblclick = () => { const l = L().find((x) => x.id === row.dataset.id); const n = prompt("레이어 이름", l.name); if (n) { l.name = n.slice(0, 30); touch(); renderList(); renderProps(); } };
      row.ondragstart = () => (from = row.dataset.id);
      row.ondragover = (e) => e.preventDefault();
      row.ondrop = (e) => { e.preventDefault(); const a = L().findIndex((x) => x.id === from), b = L().findIndex((x) => x.id === row.dataset.id); if (a < 0 || a === b) return; const [m] = L().splice(a, 1); L().splice(b, 0, m); changed(); renderList(); };
    });
    box.querySelectorAll("[data-lu]").forEach((b) => (b.onclick = () => { const i = +b.dataset.lu; [L()[i - 1], L()[i]] = [L()[i], L()[i - 1]]; changed(); renderList(); }));
    box.querySelectorAll("[data-ld]").forEach((b) => (b.onclick = () => { const i = +b.dataset.ld; [L()[i + 1], L()[i]] = [L()[i], L()[i + 1]]; changed(); renderList(); }));
    box.querySelectorAll("[data-lx]").forEach((b) => (b.onclick = () => { p.layout.layers = L().filter((x) => x.id !== b.dataset.lx); MK.s3sel = L()[0]?.id; changed(); renderList(); renderProps(); }));
  }
  body.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => { const l = newLayer(b.dataset.add); L().unshift(l); MK.s3sel = l.id; changed(); renderList(); renderProps(); }));
  $("#bgc").oninput = (e) => { p.layout.bg = e.target.value; changed(); };
  $("#preset").onchange = (e) => {
    const pr = MK.layouts.find((x) => x.id === e.target.value);
    if (!pr) return;
    if (!confirm(`'${pr.name}' 레이아웃으로 바꿀까요? 지금 배치는 사라져요.`)) { e.target.value = ""; return; }
    p.layout = deep(pr.layout); p.layout.name = pr.name; MK.layoutBase = JSON.stringify(p.layout); MK.s3sel = p.layout.layers[0]?.id; touch(); step3(body);
  };
  $("#delPreset").onclick = async () => {
    const pr = MK.layouts.find((x) => x.id === $("#preset").value);
    if (!pr || pr.builtin) return toast("기본 레이아웃은 지울 수 없어요");
    if (!confirm(`'${pr.name}'을 내 레이아웃 목록에서 지울까요?`)) return;
    await api("DELETE", `/api/layouts/${pr.id}`); MK.layouts = await api("GET", "/api/layouts"); step3(body);
  };
  $("#s3Play").onclick = () => { const v = st.video; if (v.paused) { v.play(); $("#s3Play").textContent = "⏸ 정지"; } else { v.pause(); $("#s3Play").textContent = "▶ 영상 재생"; } };
  st.video.loop = true;
  redraw(); renderProps(); renderList();
  ensureFonts(p).then(redraw);
  $("#fPrev").onclick = () => goStep(2);
  $("#fNext").onclick = () => {
    if (JSON.stringify(p.layout) === MK.layoutBase) return goStep(4);
    modal(`<h3>💾 레이아웃 변경 사항 저장</h3>
      <p>기존 레이아웃의 구조가 수정되었습니다.<br>이 설정을 새로운 커스텀 레이아웃으로 저장하시겠습니까?</p>
      <label class="f">레이아웃 이름<input type="text" id="lname" value="${esc(p.layout.name && !MK.layouts.find((x) => x.builtin && x.name === p.layout.name) ? p.layout.name : "새로운 레이아웃")}"></label>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn" id="lSkip">저장하지 않고 진행</button><button class="btn primary" id="lSave">저장하고 진행</button></div>`,
    (m, close) => {
      $("#lSkip", m).onclick = () => { close(); MK.layoutBase = JSON.stringify(p.layout); goStep(4); };
      $("#lSave", m).onclick = async () => {
        const name = $("#lname", m).value.trim() || "새로운 레이아웃";
        try { p.layout.name = name; await api("POST", "/api/layouts", { name, layout: p.layout }); MK.layouts = await api("GET", "/api/layouts"); toast("내 레이아웃으로 저장했어요"); close(); MK.layoutBase = JSON.stringify(p.layout); goStep(4); }
        catch (e) { fail(e); }
      };
    });
  };
}

/* ---------------------------------------------------------------- 실시간 미리보기 플레이어 (영상 조각 + 목소리 + 레이어) */
class Player {
  constructor(st, plan, onScene, onTime) {
    this.st = st; this.plan = plan; this.onScene = onScene; this.onTime = onTime;
    this.audio = new Audio(); this.raf = null; this.playing = false; this.curScene = null;
  }
  sceneAt(t) { const s = this.plan.scenes; for (let i = s.length - 1; i >= 0; i--) if (t >= s[i].start - 1e-6) return i; return 0; }
  showAt(t) { // 정지 화면
    const pc = this.plan.pieces.find((x) => t >= x.start && t < x.start + x.dur) || this.plan.pieces[0];
    if (pc) this.st.setClip(pc.clip, pc.src + (t - pc.start) * pc.speed);
    const i = this.sceneAt(t); const sc = MK.p.scenes.find((s) => s.id === this.plan.scenes[i]?.id);
    this.st.draw(sc || null); this.onTime?.(t);
  }
  play(from, to) {
    this.stop();
    this.from = from; this.to = Math.min(to ?? this.plan.total, this.plan.total);
    this.t0 = performance.now() - from * 1000; this.playing = true; this.curScene = null;
    const v = this.st.video; v.muted = true;
    const loop = () => {
      if (!this.playing || !this.st.el.isConnected) { this.stop(); return; }
      const t = (performance.now() - this.t0) / 1000;
      if (t >= this.to) { this.stop(); this.onTime?.(this.to); return; }
      const pc = this.plan.pieces.find((x) => t >= x.start && t < x.start + x.dur);
      if (pc) {
        const want = pc.src + (t - pc.start) * pc.speed;
        if (this.st.clipIdx !== pc.clip) this.st.setClip(pc.clip, want);
        else if (v.readyState >= 1 && Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
        if (Math.abs(v.playbackRate - pc.speed) > 0.01) v.playbackRate = pc.speed;
        if (v.paused) v.play().catch(() => {});
      }
      const g = this.plan.groups.find((x) => t >= x.start && t < x.start + x.dur);
      if (g) {
        const want = t - g.start;
        if (!this.audio.src.endsWith(g.audio)) { this.audio.src = g.audio; this.audio.currentTime = want; this.audio.play().catch(() => {}); }
        else { if (Math.abs(this.audio.currentTime - want) > 0.25) this.audio.currentTime = want; if (this.audio.paused) this.audio.play().catch(() => {}); }
      } else if (!this.audio.paused) this.audio.pause();
      const i = this.sceneAt(t);
      if (i !== this.curScene) { this.curScene = i; const sc = MK.p.scenes.find((s) => s.id === this.plan.scenes[i].id); this.st.draw(sc); this.onScene?.(i); }
      this.onTime?.(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.playing = false; cancelAnimationFrame(this.raf); this.audio.pause(); this.st?.video?.pause(); }
}

/* ---------------------------------------------------------------- 4단계: 세부 편집 (Story Board) */
async function step4(body) {
  const p = MK.p;
  if (!p.scenes.length) { body.innerHTML = `<div class="card mk-card"><div class="notice warn">장면이 없어요. 2단계에서 대본을 먼저 만들어 주세요.</div>${footer("이전 단계", "다음", { disableNext: true })}</div>`; $("#fPrev").onclick = () => goStep(2); return; }
  body.innerHTML = `<div class="notice">장면 시간을 계산하는 중…</div>`;
  await mkSave(true);
  try { MK.plan = await api("GET", `/api/projects/${p.id}/plan`); } catch (e) { body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; return; }
  const plan = MK.plan;
  MK.sel = Math.min(MK.sel, p.scenes.length - 1);
  const extras = p.layout.layers.filter((l) => l.type === "subtitle" && !l.base);
  const status = (i) => { const s = p.scenes[i], x = plan.scenes[i]; if (!s.text.trim()) return "none"; return x?.ready ? "ok" : "miss"; };
  body.innerHTML = `
  <div class="card mk-card">
    <div class="row between"><b>▤ 장면 타임라인 내비게이터 <span class="faint" style="font-weight:400">(Timeline Navigator)</span></b>
      <div class="row legend"><span><i class="dot sel"></i>선택됨</span><span><i class="dot ok"></i>음성 완료</span><span><i class="dot miss"></i>음성 필요</span><span><i class="dot none"></i>대사 없음</span><span class="badge">전체 ${p.scenes.length}개 장면 · ${plan.total.toFixed(1)}초</span></div></div>
    <div class="film" id="film">${plan.scenes.map((x, i) => `<button class="fr ${status(i)} ${i === MK.sel ? "sel" : ""}" data-fi="${i}"><span>▣</span><small>${x.start.toFixed(1)}s</small></button>`).join("")}</div>
    <div class="cards-row"><button class="btn sm ghost" id="crL">‹</button><div class="cards" id="cards">${p.scenes.map((s, i) => `
      <button class="scard ${i === MK.sel ? "sel" : ""}" data-ci="${i}"><span class="st">${p.clips[s.clip]?.poster && i === MK.sel ? `<img src="${p.clips[s.clip].poster}">` : `▣<small>${plan.scenes[i].dur.toFixed(1)}s</small>`}</span>
        <span class="sx"><span class="row between"><b>장면 ${i + 1}</b><span class="faint">Scene ${i + 1}</span></span><span class="tx">${esc(s.text || "(대사 없음)")}</span></span></button>`).join("")}</div><button class="btn sm ghost" id="crR">›</button></div>
    <div class="voice-bar"><div><b>🔊 전체 AI 목소리 합성 상태</b><div class="faint" style="font-size:12.5px">${plan.missing ? `목소리가 필요한 문장 ${plan.missing}개 (대사를 바꾸면 다시 만들어야 해요)` : "합성 완료 (자막 동기화 완료)"}</div></div>
      <div class="row"><button class="btn" id="toCapcut">✂️ 캡컷으로 열기</button><button class="btn red" id="reVoice">↻ 목소리 재합성 및 동기화</button></div></div>
  </div>
  <div class="s4-grid">
    <div class="card tight stack" style="align-self:start;position:sticky;top:12px">
      <div class="row between"><b>🎬 실시간 영상 미리보기</b><div class="row" style="gap:2px"><button class="btn sm ghost" id="pvL">‹</button><span class="badge brand" id="pvN">장면 ${MK.sel + 1} / ${p.scenes.length}</span><button class="btn sm ghost" id="pvR">›</button></div></div>
      <div class="phone" style="width:316px;margin:0 auto">${stageHTML("s4Stage", 300)}</div>
      <div class="player-bar"><div class="row between"><span class="mono" id="pvT">0.0s / ${plan.total.toFixed(1)}s</span><button class="btn sm" id="pvScene">▶ 이 장면 재생</button></div>
        <div class="ph-bar" id="pvBar"><i></i></div>
        <button class="btn primary" id="pvAll" style="width:100%">🔊 전체 TTS 음성 미리듣기</button></div>
      <div class="faint" style="font-size:12px;text-align:center">미리보기는 최종 영상과 거의 같아요. 최종 파일은 5단계에서 만들어요.</div>
    </div>
    <div class="stack">
      <div><h2 class="mk-h" style="margin:0">세부 연출 및 에셋 매칭 (Story Board)</h2><p class="muted mk-sub">레이아웃 세팅에 매칭할 장면별 정보를 간편하게 작성하세요.</p></div>
      <div class="card stack" id="sceneEd"></div>
      <div class="card tight stack">
        <div class="row between"><b>◎ 장면 레이어 설정</b><span class="faint" style="font-size:12.5px">체크를 끄면 이 장면에서만 숨겨요</span></div>
        <div id="sceneLayers"></div>
      </div>
      <div class="card tight stack">
        <b>🎚 전체 설정</b>
        <label class="f">원본 영상 소리 <span class="faint">(${p.origVolume || 0}%, 0이면 목소리만)</span><input type="range" id="origVol" min="0" max="100" step="5" value="${p.origVolume || 0}"></label>
        <span class="mk-label" style="margin:0">영상 길이 맞추기 (목소리가 영상보다 길거나 짧을 때)</span>
        <div class="seg"><button data-fitv="stretch" class="${p.fitVideo !== "loop" ? "on" : ""}">속도 조절 (0.5~2배)</button><button data-fitv="loop" class="${p.fitVideo === "loop" ? "on" : ""}">원래 속도로 반복</button></div>
      </div>
    </div>
  </div>
  <div class="card mk-card">${footer("이전 단계", "✓ 모든 장면 세부 편집 완료")}</div>`;
  const st = stageApi($("#s4Stage"), p);
  const player = new Player(st, plan, (i) => markSel(i, false), (t) => {
    $("#pvT").textContent = `${t.toFixed(1)}s / ${plan.total.toFixed(1)}s`;
    $("#pvBar").firstElementChild.style.width = (t / plan.total) * 100 + "%";
  });
  MK.player = player;
  $("#toCapcut").onclick = () => { player.stop?.(); exportCapcut(); };
  MK.redraw = () => player.showAt(plan.scenes[MK.sel].start + 0.05);
  ensureFonts(p).then(() => MK.redraw?.());
  function markSel(i, full = true) {
    if (full) MK.sel = i;
    body.querySelectorAll(".fr").forEach((b) => b.classList.toggle("sel", +b.dataset.fi === i));
    body.querySelectorAll(".scard").forEach((b) => b.classList.toggle("sel", +b.dataset.ci === i));
    $("#pvN").textContent = `장면 ${i + 1} / ${p.scenes.length}`;
    if (full) { renderEditor(); player.showAt(plan.scenes[i].start + 0.05); body.querySelector(`.scard[data-ci="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); }
  }
  function renderEditor() {
    const i = MK.sel, s = p.scenes[i], x = plan.scenes[i];
    const pcs = plan.pieces.filter((pc) => pc.scene === s.id);
    const c = p.clips[s.clip] || {};
    $("#sceneEd").innerHTML = `
      <b>▤ ${i + 1}번째 장면 세부 편집</b>
      <div class="ed-row"><div class="row between"><span><b>T 기본 자막 수정</b> <span class="badge ${s.text.trim() ? "warn" : ""}">${s.text.trim() ? "내용 있음" : "비어 있음"}</span></span><span class="faint">${x.dur.toFixed(1)}초 · ${x.ready ? "음성 완료" : "음성 필요"}</span></div>
        <input type="text" id="edText" value="${esc(s.text)}" placeholder="이 장면의 자막 (비우면 화면만 1초)">
        <select class="mini" id="edVoice"><option value="">🎙 이 장면만 목소리 변경 (개별 지정)</option>${voiceOptions(s.voice ? `${s.voice.engine}|${s.voice.voice}` : "", "all")}</select>
        <div class="faint" id="edNote" style="font-size:12px" hidden>대사가 바뀌었어요. 위의 [목소리 재합성 및 동기화]를 누르면 바뀐 문장만 다시 만들어요.</div></div>
      <details class="ed-row" open><summary class="row between"><span><b>▣ 기본 에셋</b> <span class="badge brand">🔒 원본 비디오 고정</span></span><span class="faint">접기</span></summary>
        <div class="asset-box"><img src="${c.poster || ""}" alt=""><div><b>🔒 원본 비디오 고정</b>
          <div class="faint" style="font-size:12.5px">1단계에서 준비한 원본 영상이 전체 타임라인에 걸쳐 고정되어 자동으로 이어서 재생됩니다.</div>
          <div class="faint" style="font-size:12.5px">⏱ 이 장면 원본 구간: ${pcs.map((pc) => `클립 ${pc.clip + 1} · ${pc.src.toFixed(1)}s~${(pc.src + pc.dur * pc.speed).toFixed(1)}s (${pc.speed.toFixed(2)}배속)`).join(", ") || "-"}</div>
          <label class="row" style="font-size:13px;margin-top:6px">이 장면에 쓸 클립 <select class="mini" id="edClip" style="width:auto">${p.clips.map((cc, k) => `<option value="${k}" ${k === s.clip ? "selected" : ""}>클립 #${k + 1}</option>`).join("")}</select></label></div></div></details>
      ${extras.map((l) => `<div class="ed-row"><b>T 추가 자막: ${esc(l.name)}</b>
        <textarea data-extra="${l.id}" rows="2" style="min-height:52px" placeholder="${l.text ? `비우면 공통 문구 '${esc(l.text)}'가 들어가요` : `${esc(l.name)}의 개별 장면용 내용을 입력하세요. 비우면 제외됩니다.`}">${esc((s.extra || {})[l.id] || "")}</textarea></div>`).join("")}
      ${extras.length ? "" : '<div class="faint" style="font-size:12.5px">3단계에서 자막 레이어를 추가하면 장면마다 다른 문구(예: 강조 문구)를 넣을 수 있어요.</div>'}`;
    $("#sceneLayers").innerHTML = p.layout.layers.filter((l) => l.type !== "video").map((l) => { const [bn, bc] = TYPE_BADGE[l.type]; return `
      <label class="layer-row ${bc}"><span class="tb ${bc}">${bn}</span><span style="flex:1">${esc(l.name)}</span><input type="checkbox" data-lay="${l.id}" ${(s.hide || []).includes(l.id) ? "" : "checked"}></label>`; }).join("") +
      `<div class="layer-row green"><span class="tb green">에셋</span><span style="flex:1">기본 배경 영상 (Background)</span><span class="faint">고정</span></div>`;
    const ed = $("#sceneEd");
    $("#edText", ed).oninput = (e) => { s.text = e.target.value; $("#edNote", ed).hidden = false; touch(); st.draw(s); const card = body.querySelector(`.scard[data-ci="${i}"] .tx`); if (card) card.textContent = s.text || "(대사 없음)"; };
    $("#edVoice", ed).onchange = (e) => { if (!e.target.value) s.voice = null; else { const [engine, voice] = e.target.value.split("|"); s.voice = { engine, voice }; } $("#edNote", ed).hidden = false; touch(); };
    $("#edClip", ed).onchange = (e) => { s.clip = +e.target.value; touch(); step4(body); };
    ed.querySelectorAll("[data-extra]").forEach((el) => (el.oninput = () => { s.extra = s.extra || {}; s.extra[el.dataset.extra] = el.value; touch(); st.draw(s); }));
    $("#sceneLayers").querySelectorAll("[data-lay]").forEach((el) => (el.onchange = () => {
      s.hide = (s.hide || []).filter((x) => x !== el.dataset.lay); if (!el.checked) s.hide.push(el.dataset.lay); touch(); st.draw(s);
    }));
  }
  body.querySelectorAll("[data-fi]").forEach((b) => (b.onclick = () => { player.stop(); markSel(+b.dataset.fi); }));
  body.querySelectorAll("[data-ci]").forEach((b) => (b.onclick = () => { player.stop(); markSel(+b.dataset.ci); }));
  $("#crL").onclick = () => $("#cards").scrollBy({ left: -400, behavior: "smooth" });
  $("#crR").onclick = () => $("#cards").scrollBy({ left: 400, behavior: "smooth" });
  $("#pvL").onclick = () => { player.stop(); markSel(Math.max(0, MK.sel - 1)); };
  $("#pvR").onclick = () => { player.stop(); markSel(Math.min(p.scenes.length - 1, MK.sel + 1)); };
  $("#pvScene").onclick = () => { const x = plan.scenes[MK.sel]; player.play(x.start, x.start + x.dur); };
  $("#pvAll").onclick = () => { if (player.playing) { player.stop(); $("#pvAll").textContent = "🔊 전체 TTS 음성 미리듣기"; return; } player.play(0); $("#pvAll").textContent = "⏹ 미리듣기 멈추기"; };
  $("#pvBar").onclick = (e) => { const r = $("#pvBar").getBoundingClientRect(); const t = ((e.clientX - r.left) / r.width) * plan.total; player.stop(); const i = player.sceneAt(t); markSel(i); player.showAt(t); };
  $("#origVol").oninput = (e) => { p.origVolume = +e.target.value; e.target.previousElementSibling.textContent = `(${p.origVolume}%, 0이면 목소리만)`; touch(); };
  body.querySelectorAll("[data-fitv]").forEach((b) => (b.onclick = () => { p.fitVideo = b.dataset.fitv; touch(); step4(body); }));
  $("#reVoice").onclick = async () => {
    player.stop();
    await mkSave(true);
    const fresh = await api("GET", `/api/projects/${p.id}/plan`);
    if (!fresh.missing && !confirm("모든 목소리가 이미 최신이에요. 그래도 전부 다시 만들까요?")) return;
    runVoiceJob(body, () => step4(body), !fresh.missing);
  };
  renderEditor();
  player.showAt(plan.scenes[MK.sel].start + 0.05);
  $("#fPrev").onclick = () => { player.stop(); goStep(3); };
  $("#fNext").onclick = async () => {
    player.stop(); await mkSave(true);
    const fresh = await api("GET", `/api/projects/${p.id}/plan`);
    if (fresh.missing) return runVoiceJob(body, () => goStep(5));
    goStep(5);
  };
}

/* ---------------------------------------------------------------- 5단계: 완료 (렌더링) */
function step5(body) {
  const p = MK.p, r = p.render;
  const script = p.scenes.map((s) => s.text).filter(Boolean).join(" ");
  body.innerHTML = `<div class="card mk-card">
    <h2 class="mk-h">🎉 완료</h2>
    <p class="muted mk-sub">레이어와 자막을 그려 최종 MP4 영상을 만들어요. 영상 길이에 따라 1~3분 정도 걸려요.</p>
    <div class="s5-grid">
      <div class="stack" style="align-items:center">
        ${r ? `<video src="${r.url}" ${r.poster ? `poster="${r.poster}"` : ""} controls playsinline class="final-video"></video>
          <div class="faint">${r.duration}초 · ${r.size_mb}MB · 1080×1920</div>` : `<div class="final-video empty-v">아직 만든 영상이 없어요</div>`}
      </div>
      <div class="stack">
        <div id="rJob"></div>
        <button class="btn primary big" id="doRender">${r ? "↻ 다시 만들기 (수정 반영)" : "🎬 최종 영상 만들기"}</button>
        ${r ? `<div class="row"><a class="btn" href="${r.url}" download="${esc(r.file)}">⬇ MP4 다운로드</a><button class="btn" id="srtDl5">⬇ 자막 SRT</button><button class="btn" id="toCapcut5">✂️ 캡컷으로 열기</button><button class="btn" id="reveal">Finder에서 보기</button>
          <a class="btn primary" href="#/thumb?src=${encodeURIComponent(`proj:${p.id}:${r.file}`)}&url=${encodeURIComponent(r.url)}&name=${encodeURIComponent(p.name)}">🖼 이 영상으로 썸네일 만들기</a></div>` : ""}
        <div class="card tight stack">
          <b>📝 업로드용 정보</b>
          <label class="f">제목<div class="row" style="flex-wrap:nowrap"><input type="text" id="ftitle" value="${esc(p.title)}" placeholder="제목"><button class="btn sm" id="cpTitle">복사</button></div></label>
          <label class="f">대본 전체<div class="row" style="flex-wrap:nowrap;align-items:start"><textarea id="fscript" rows="4" readonly>${esc(script)}</textarea><button class="btn sm" id="cpScript">복사</button></div></label>
          <button class="btn" id="descGpt">✨ 제목·설명·해시태그 만들기 (ChatGPT)</button>
        </div>
        <div class="row"><a class="btn ghost" href="#/make">+ 새 영상 만들기</a><a class="btn ghost" href="#/">대시보드로</a></div>
      </div>
    </div>
    ${footer("이전 단계", "대시보드로")}
  </div>`;
  $("#ftitle").oninput = (e) => { p.title = e.target.value; touch(); };
  $("#cpTitle").onclick = () => copyText(p.title).then(() => toast("제목을 복사했어요"));
  $("#cpScript").onclick = () => copyText(script).then(() => toast("대본을 복사했어요"));
  $("#descGpt").onclick = () => {
    const pr = S.prompts.find((x) => x.category === "제목·설명") || { title: "제목·설명", target: "chatgpt", body: "아래 숏츠 대본으로 제목 5개, 설명 3줄, 해시태그 8개를 만들어줘.\n\n{대본}" };
    usePrompt(pr, { open: true, preset: { "대본": script } });
  };
  $("#srtDl5")?.addEventListener("click", downloadSrt);
  $("#toCapcut5")?.addEventListener("click", () => exportCapcut());
  $("#reveal")?.addEventListener("click", () => api("POST", "/api/reveal", { file: r.file, project: p.id }).catch(fail));
  $("#doRender").onclick = () => doRender(body);
  $("#fPrev").onclick = () => goStep(4);
  $("#fNext").onclick = () => (location.hash = "#/");
}
/* ---------------------------------------------------------------- 캡컷으로 내보내기 */
/** opts: 썸네일 제작에서 열 때 { pid | src, name, cover: {file, position, seconds} } */
async function exportCapcut(opts = {}) {
  let p = opts.pid || opts.src ? null : MK.p;
  let box;
  const close = modal(`<h3>✂️ 캡컷으로 열기</h3><div id="ccBox"></div>`, (m) => (box = $("#ccBox", m)));
  const show = (msg, f) => (box.innerHTML = `<div class="stack"><div class="row between"><b>${esc(msg)}</b><span class="faint">${Math.round(f * 100)}%</span></div><div class="bar"><i style="width:${Math.max(3, f * 100)}%"></i></div></div>`);
  try {
    show(opts.src ? "캡컷 프로젝트 만드는 중" : "장면 그림을 그리는 중", 0.01);
    if (opts.src) { // 작업실에서 만들지 않은 영상: 영상 + 썸네일만
      const job = await api("POST", "/api/thumb/capcut", { src: opts.src, name: opts.name || "", ...opts.cover });
      return ccDone(box, close, (await waitJob(job.id, (j) => show(j.message, j.progress))).result, opts);
    }
    if (p) await mkSave(true); else p = await api("GET", `/api/projects/${opts.pid}`);
    await ensureFonts(p); await ensureImages(p);
    const cv = document.createElement("canvas"); cv.width = CW; cv.height = CH;
    const ctx = cv.getContext("2d");
    const vi = p.layout.layers.findIndex((l) => l.type === "video");
    const textLayers = p.layout.layers.filter((L, i) => L.type === "subtitle" && L.visible && !(vi >= 0 && i > vi));
    const fd = new FormData(), scenes = [];
    for (let i = 0; i < p.scenes.length; i++) {
      const s = p.scenes[i], item = { scene: s.id, texts: {} };
      for (const part of ["under", "over"]) {
        if (drawLayers(ctx, p, s, part, null, true)) {
          const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
          const name = `${part}_${i}.png`; fd.append("files", blob, name); item[part] = name;
        }
      }
      for (const L of textLayers) if (!(s.hide || []).includes(L.id)) item.texts[L.id] = layerText(L, p, s);
      scenes.push(item);
      show(`장면 그림을 그리는 중 (${i + 1}/${p.scenes.length})`, 0.01 + (i / p.scenes.length) * 0.09);
    }
    fd.append("manifest", JSON.stringify({ scenes, textLayers, cover: opts.cover || null }));
    const job = await api("POST", `/api/projects/${p.id}/capcut`, fd);
    const done = await waitJob(job.id, (j) => show(j.message, 0.1 + j.progress * 0.9));
    ccDone(box, close, done.result, opts);
  } catch (e) {
    box.innerHTML = `<div class="notice bad"><b>캡컷으로 내보내지 못했어요.</b><br>${e.message === "Not Found" ? "서버가 예전 버전으로 켜져 있어요. 터미널에서 Ctrl+C로 서버를 끄고 python -m web.server 로 다시 켠 뒤 새로고침해 주세요." : esc(e.message)}</div><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="ccX">닫기</button></div>`;
    $("#ccX").onclick = close;
  }
}

function ccDone(box, close, r, opts) {
  box.innerHTML = `<div class="stack"><div class="notice"><b>✅ 캡컷 프로젝트를 만들었어요: ${esc(r.name)}</b></div>
    <p>캡컷 첫 화면의 프로젝트 목록에서 <b>${esc(r.name)}</b>을 열어 주세요.${r.opened ? " 캡컷을 열어 두었어요." : ""}</p>
    <p class="faint" style="font-size:13px">목록에 안 보이면 캡컷을 완전히 끄고(⌘Q) 다시 열어 주세요.${opts.cover ? `<br>썸네일은 영상 ${opts.cover.position === "end" ? "맨 뒤" : "맨 앞"}에 ${opts.cover.seconds}초 들어가 있어요.` : ""}${opts.src ? "" : "<br>자막은 캡컷에서 바로 고칠 수 있는 글자로 들어가요. 크기·테두리는 비슷하게 맞춘 값이라 캡컷에서 한 번에 다듬어 주세요."}</p>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-close>확인</button></div></div>`;
  box.querySelector("[data-close]").onclick = close;
}

async function doRender(body) {
  const p = MK.p, box = $("#rJob");
  $("#doRender").disabled = true;
  const show = (msg, f) => (box.innerHTML = `<div class="card tight stack"><div class="row between"><b>${esc(msg)}</b><span class="faint">${Math.round(f * 100)}%</span></div><div class="bar"><i style="width:${Math.max(3, f * 100)}%"></i></div></div>`);
  try {
    show("자막과 레이어를 그리는 중", 0.01);
    await mkSave(true);
    const plan = await api("GET", `/api/projects/${p.id}/plan`);
    if (plan.missing) { show("목소리 만드는 중", 0.02); const j = await api("POST", `/api/projects/${p.id}/voice`); await waitJob(j.id, (x) => show(x.message, x.progress * 0.2)); }
    await ensureFonts(p); await ensureImages(p);
    const cv = document.createElement("canvas"); cv.width = CW; cv.height = CH;
    const ctx = cv.getContext("2d");
    const fd = new FormData(), manifest = [];
    for (let i = 0; i < p.scenes.length; i++) {
      const s = p.scenes[i], item = { scene: s.id };
      for (const part of ["under", "over"]) {
        if (drawLayers(ctx, p, s, part)) {
          const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
          const name = `${part}_${i}.png`; fd.append("files", blob, name); item[part] = name;
        }
      }
      manifest.push(item);
      show(`자막과 레이어를 그리는 중 (${i + 1}/${p.scenes.length})`, 0.02 + (i / p.scenes.length) * 0.08);
    }
    fd.append("manifest", JSON.stringify(manifest));
    const job = await api("POST", `/api/projects/${p.id}/render`, fd);
    const done = await waitJob(job.id, (j) => show(j.message, 0.1 + j.progress * 0.9));
    p.render = done.result;
    toast("영상이 완성됐어요!");
    if (MK.afterRender === "thumb") {
      MK.afterRender = null;
      location.hash = `#/thumb?src=${encodeURIComponent(`proj:${p.id}:${p.render.file}`)}&url=${encodeURIComponent(p.render.url)}&name=${encodeURIComponent(p.name)}`;
      return;
    }
    step5(body);
  } catch (e) {
    box.innerHTML = `<div class="notice bad"><b>영상 만들기에 실패했어요.</b><br>${esc(e.message)}</div>`;
    $("#doRender").disabled = false;
  }
}
