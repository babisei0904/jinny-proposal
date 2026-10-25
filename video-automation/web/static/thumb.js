/* 썸네일 제작: 영상 선택 → 장면 캡처 → 문구·배지 꾸미기 → 완성 (숏튜브와 같은 4단계) */
const TH_RATIOS = { "9:16": [1080, 1920, "9:16 쇼츠/릴스", "유튜브 쇼츠, 인스타 릴스"], "16:9": [1920, 1080, "16:9 롱폼", "유튜브 일반 영상"],
  "1:1": [1080, 1080, "1:1 정방형", "인스타 피드"], "orig": [0, 0, "원본 비율", "영상 그대로"] };
const TH_BADGES = [
  ["✨ NEW", "#16a34a"], ["⚡ 품절", "#dc2626"], ["💡 꿀템", "#f59e0b"], ["😮 실화?", "#7c3aed"], ["👑 TOP", "#ca8a04"],
  ["🔥 추천", "#ea580c"], ["💯 대박", "#db2777"], ["🎉 할인", "#2563eb"], ["ㄷㄷ 소름", "#4338ca"],
];
const TH_FONTS = [["Pretendard", "프리텐다드 (기본)"], ["GmarketSans", "지마켓산스 (볼드)"], ["Black Han Sans", "검은고딕 (강렬한 타이틀)"],
  ["Do Hyeon", "도현체 (둥근)"], ["Jua", "주아체 (귀여운)"], ["Nanum Myeongjo", "나눔명조 (감성)"], ["Gaegu", "개구 (손글씨)"], ["Arial Black", "Arial Black (영문 볼드)"]];
function thSize() { // 출력 크기
  const s = TH.st;
  if (s.ratio !== "orig") return TH_RATIOS[s.ratio].slice(0, 2);
  const w = s.bg?.width || s.vw || 1080, h = s.bg?.height || s.vh || 1920, k = Math.min(1, 1920 / Math.max(w, h));
  return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2];
}
const TH_STYLES = [
  ["흰 글자 + 검정 테두리", { color: "#ffffff", hl: "#ffe14d", stroke: 10, strokeColor: "#000000", bg: "", shadow: true }],
  ["노랑 강조", { color: "#ffe14d", hl: "#ffffff", stroke: 10, strokeColor: "#000000", bg: "", shadow: true }],
  ["빨간 박스", { color: "#ffffff", hl: "#ffe14d", stroke: 0, strokeColor: "#000000", bg: "#e11d48", bgOpacity: 100, shadow: false }],
  ["검정 박스", { color: "#ffffff", hl: "#ffe14d", stroke: 0, strokeColor: "#000000", bg: "#000000", bgOpacity: 80, shadow: false }],
  ["흰 박스 + 검정 글자", { color: "#111111", hl: "#e11d48", stroke: 0, strokeColor: "#000000", bg: "#ffffff", bgOpacity: 100, shadow: false }],
];
const TH = { st: null, sel: null, undo: [], cv: null, scale: 1, img: null, mode: "select", pen: { color: "#ff2d55", width: 14 } };
const thDefault = () => ({ step: 1, src: "", srcName: "", srcUrl: "", t: 0, ratio: "9:16", bg: null, view: { zoom: 1, ox: 0, oy: 0 },
  els: [], dim: { top: 0, bottom: 0, all: 0 }, insert: true, position: "start", seconds: 0.04, name: "썸네일", result: null });
const thSave = () => store.set("thumb", TH.st);
const thSnap = () => { TH.undo.push(JSON.stringify({ els: TH.st.els, dim: TH.st.dim, view: TH.st.view })); if (TH.undo.length > 40) TH.undo.shift(); };

async function viewThumb(v, query) {
  TH.st = Object.assign(thDefault(), store.get("thumb", {}));
  const proj = query.get("src");
  if (proj) { Object.assign(TH.st, thDefault(), { src: proj, srcName: query.get("name") || "영상 만들기 결과", srcUrl: query.get("url") || "", step: 2 }); history.replaceState(null, "", "#/thumb"); }
  TH.undo = []; TH.sel = null;
  thRender(v);
}
function thHeader() {
  const s = TH.st.step;
  const names = ["영상 선택", "장면 캡처", "그래픽 꾸미기", "다운로드 & 합성"];
  return `<div class="row between th-head"><div class="row"><a class="back" href="#/">← 대시보드</a><b style="font-size:18px">🖼 썸네일 제작</b><span class="badge brand">1분 완성 쇼츠 썸네일</span></div>
    <div class="row th-steps">${names.map((n, i) => `<span class="${i + 1 === s ? "on" : i + 1 < s ? "done" : ""}"><i>${i + 1 < s ? "✓" : i + 1}</i>${n}</span>`).join("")}</div></div>`;
}
function thRender(v) {
  v = v || $("#view");
  const s = TH.st;
  thSave();
  v.innerHTML = thHeader() + `<div id="thBody" style="margin-top:18px"></div>`;
  const body = $("#thBody");
  [thStep1, thStep2, thStep3, thStep4][s.step - 1](body, v);
}

/* ---------- 1단계: 영상 선택 */
async function thStep1(body, v) {
  body.innerHTML = `<div class="card mk-card" style="text-align:center">
    <h2 style="margin:6px 0;justify-content:center">썸네일을 제작할 쇼츠 영상을 선택하세요</h2>
    <p class="muted">직접 비디오 파일을 업로드하거나, '영상 만들기'에서 완성한 영상을 불러올 수 있어요.</p>
    <span class="badge warn">⏱ 1분(60초) 이하의 쇼츠/릴스 영상을 권장해요</span>
    <div class="drop" id="thDrop" style="margin:18px auto;max-width:640px"><div class="up-ico">⇪</div><b>비디오 파일을 여기에 끌어다 놓거나 파일 선택</b><br><span class="faint">MP4, MOV, WebM</span></div>
    <div id="thSrcs"></div></div>`;
  dropZone($("#thDrop"), "video/*,.mov,.mp4,.m4v", async (files) => {
    const f = files.find((x) => /^video\//.test(x.type) || /\.(mov|mp4|m4v|webm)$/i.test(x.name));
    if (!f) return toast("영상 파일을 골라 주세요");
    try { const [r] = await uploadFiles([f]); Object.assign(TH.st, thDefault(), { src: r.id, srcName: r.name, srcUrl: r.url, step: 2 }); thRender(v); } catch (e) { fail(e); }
  });
  const srcs = await api("GET", "/api/thumb/sources").catch(() => []);
  if (srcs.length) $("#thSrcs").innerHTML = `<div class="faint" style="margin:6px 0">또는</div><div class="mk-label" style="text-align:left">📂 내 보관함 / '영상 만들기'에서 완성한 영상 불러오기</div>
    <div class="items">${srcs.map((x, i) => `<button class="item th-src" data-i="${i}"><div class="media" style="aspect-ratio:9/16;max-height:220px">${x.poster ? `<img src="${x.poster}" alt="">` : ""}</div><div class="body"><span class="name">${esc(x.name)}</span></div></button>`).join("")}</div>`;
  body.querySelectorAll(".th-src").forEach((b) => (b.onclick = () => { const x = srcs[+b.dataset.i]; Object.assign(TH.st, thDefault(), { src: x.src, srcName: x.name, srcUrl: x.url, step: 2 }); thRender(v); }));
}

/* ---------- 2단계: 장면 캡처 */
function thStep2(body, v) {
  const s = TH.st;
  body.innerHTML = `<div class="row between"><div><h2 class="mk-h">2단계: 썸네일로 활용할 명장면 캡처</h2><p class="muted mk-sub">미리보기에서 장면을 멈추고 캡처하세요. 영상 만들기 결과는 같은 순간을 자막·문구 없는 원본으로 캡처할 수 있어요.</p></div><button class="btn ghost" id="reSrc">영상 다시 선택</button></div>
  <div class="th-grid">
    <div class="th-dark stack" style="align-items:center">
      <div class="th-vwrap" id="thVW"><video id="thV" src="${s.srcUrl}" playsinline preload="auto" class="th-video"></video><div class="th-cropbox" id="thBox"></div></div>
      <div class="row" style="width:100%;gap:10px;color:#ddd"><span class="mono" id="thT">0.00s</span><input type="range" id="thSeek" min="0" max="100" step="0.01" value="0" style="flex:1"><span class="mono" id="thD"></span></div>
      <div class="row th-ctrl"><button data-d="-1">-1.0s</button><button data-d="-0.1">-0.1s</button><button data-d="-0.0334">-1프레임</button><button class="play" id="thPlay">▶ 재생</button><button data-d="0.0334">+1프레임</button><button data-d="0.1">+0.1s</button><button data-d="1">+1.0s</button></div>
    </div>
    <div class="stack">
      <div class="card tight stack"><b>▣ 썸네일 출력 비율 프리셋</b>
        <div class="grid g2">${Object.entries(TH_RATIOS).map(([k, r]) => `<button class="ratio-btn ${s.ratio === k ? "on" : ""}" data-r="${k}"><b>${r[2]}</b><span>${r[3]}</span></button>`).join("")}</div>
        ${s.src.startsWith("proj:") ? `<div class="seg2"><button data-c="1" class="${s.clean !== false ? "on" : ""}">자막 없이 (원본 장면)</button><button data-c="0" class="${s.clean === false ? "on" : ""}">보이는 그대로</button></div><div id="cleanNote"></div>` : ""}
        <button class="btn big th-cta" id="cap">📸 현재 장면 캡처하기</button></div>
      <div class="card tight stack" id="snap" ${s.bg ? "" : "hidden"}><div class="row between"><b>✓ 캡처 완료된 스냅샷</b><span class="badge ok">완료</span></div>
        <div class="th-snap"><img id="snapImg" src="${s.bg?.url || ""}" alt=""></div>
        <button class="btn big th-next" id="go3">3단계 썸네일 꾸미기로 이동 ›</button></div>
    </div>
  </div>`;
  const vid = $("#thV"), seek = $("#thSeek");
  const box = () => { // 고른 비율로 잘릴 영역 표시
    const el = $("#thBox"); if (!el || !vid.videoWidth) return;
    const vw = vid.clientWidth, vh = vid.clientHeight, ar = vid.videoWidth / vid.videoHeight;
    let dw = vw, dh = vw / ar; if (dh > vh) { dh = vh; dw = vh * ar; }
    const [W, H] = s.ratio === "orig" ? [vid.videoWidth, vid.videoHeight] : TH_RATIOS[s.ratio];
    let bw = dw, bh = dw * H / W; if (bh > dh) { bh = dh; bw = dh * W / H; }
    Object.assign(el.style, { width: bw + "px", height: bh + "px", left: (vid.offsetLeft + (vw - bw) / 2) + "px", top: (vid.offsetTop + (vh - bh) / 2) + "px", display: Math.abs(bw - dw) + Math.abs(bh - dh) > 2 ? "block" : "none" });
  };
  vid.onloadedmetadata = () => { seek.max = vid.duration; $("#thD").textContent = vid.duration.toFixed(2) + "s"; vid.currentTime = s.t || 0; s.vw = vid.videoWidth; s.vh = vid.videoHeight; box(); };
  vid.ontimeupdate = () => { seek.value = vid.currentTime; $("#thT").textContent = vid.currentTime.toFixed(2) + "s"; };
  vid.onplay = () => { $("#thPlay").textContent = "⏸ 일시정지"; $("#thPlay").classList.add("orange"); };
  vid.onpause = () => { $("#thPlay").textContent = "▶ 재생"; $("#thPlay").classList.remove("orange"); };
  seek.oninput = () => { vid.currentTime = +seek.value; };
  body.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => { vid.pause(); vid.currentTime = Math.max(0, Math.min(vid.duration || 1e9, vid.currentTime + +b.dataset.d)); }));
  $("#thPlay").onclick = () => (vid.paused ? vid.play() : vid.pause());
  body.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => { s.ratio = b.dataset.r; thSave(); body.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("on", x === b)); box(); }));
  body.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { s.clean = b.dataset.c === "1"; thSave(); body.querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x === b)); }));
  $("#reSrc").onclick = () => { s.step = 1; thRender(v); };
  if (s.src.startsWith("proj:")) api("GET", `/api/thumb/clean?src=${encodeURIComponent(s.src)}`).then((c) => {
    const el = $("#cleanNote"); if (!el || c.ok) return;
    el.innerHTML = c.reason === "missing"
      ? `<div class="notice warn" style="font-size:13px">원본 클립 파일을 찾을 수 없어 자막 없는 장면은 캡처할 수 없어요. '보이는 그대로'만 캡처돼요.</div>`
      : `<div class="notice warn stack" style="font-size:13px;gap:8px"><div>이 영상은 업데이트 전에 만들었거나, 만든 뒤 대본·목소리가 바뀌어서 <b>자막 없는 원본 장면을 찾을 수 없어요.</b> 지금 캡처하면 자막·(광고)가 같이 찍혀요.</div>
          <a class="btn sm primary" href="#/make?id=${c.pid}&rerender=thumb">↻ 영상 다시 만들고 여기로 돌아오기</a></div>`;
  }).catch(() => {});
  $("#cap").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "캡처하는 중…"; vid.pause();
    try {
      const r = await api("POST", "/api/thumb/frame", { src: s.src, t: vid.currentTime, clean: s.src.startsWith("proj:") && s.clean !== false });
      s.t = r.t; s.bg = r; s.view = { zoom: 1, ox: 0, oy: 0 }; thSave();
      $("#snapImg").src = r.url; $("#snap").hidden = false; TH.img = null;
      $("#snapNote")?.remove(); if (r.note) $("#snapImg").parentElement.insertAdjacentHTML("afterend", `<div class="notice warn" id="snapNote" style="font-size:13px">${esc(r.note)}</div>`);
      toast(r.note || `${r.t.toFixed(2)}s 장면을 캡처했어요`);
    } catch (err) { fail(err); }
    e.target.disabled = false; e.target.textContent = "📸 현재 장면 캡처하기";
  };
  $("#go3").onclick = () => {
    if (!s.bg) return toast("먼저 장면을 캡처해 주세요");
    if (!s.els.length) s.els = [thNewText("핵심 썸네일 문구 입력")];
    s.step = 3; TH.undo = []; thRender(v);
  };
}

/* ---------- 요소 */
function thNewText(text) {
  const [W, H] = thSize();
  return { id: Math.random().toString(16).slice(2, 8), type: "text", text, x: W / 2, y: H * 0.42, font: "GmarketSans", size: Math.round(Math.min(W, H) * 0.082), weight: 700,
    align: "center", color: "#ffffff", hl: "#ffe14d", stroke: 10, strokeColor: "#000000", shadow: true, bg: "", bgOpacity: 100, radius: 18, pad: 22, lineHeight: 1.18 };
}
function thNewBadge(label, color) {
  const [W, H] = thSize();
  return { ...thNewText(label), type: "badge", y: H * 0.3, size: Math.round(Math.min(W, H) * 0.045), font: "GmarketSans", weight: 700, stroke: 0, shadow: false, bg: color, bgOpacity: 100, radius: 999, pad: 24, color: "#ffffff" };
}
function thSegments(line) { // *강조* 표시를 나눈다
  const out = []; let hl = false;
  line.split("*").forEach((part, i) => { if (i > 0) hl = !hl; if (part) out.push({ t: part, hl }); });
  return out;
}
function thDraw(ctx, W, H, opts = {}) {
  const s = TH.st;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  if (TH.img?.complete && TH.img.naturalWidth) {
    const im = TH.img, v = s.view, base = Math.max(W / im.naturalWidth, H / im.naturalHeight) * (v.zoom || 1);
    const w = im.naturalWidth * base, h = im.naturalHeight * base;
    ctx.drawImage(im, (W - w) / 2 + (v.ox / 100) * Math.abs(W - w) / 2, (H - h) / 2 + (v.oy / 100) * Math.abs(H - h) / 2, w, h);
  }
  const grad = (y0, y1, a) => { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, "rgba(0,0,0,0)"); return g; };
  if (s.dim.all) { ctx.fillStyle = `rgba(0,0,0,${s.dim.all})`; ctx.fillRect(0, 0, W, H); }
  if (s.dim.top) { ctx.fillStyle = grad(0, H * 0.45, s.dim.top); ctx.fillRect(0, 0, W, H * 0.45); }
  if (s.dim.bottom) { ctx.fillStyle = grad(H, H * 0.55, s.dim.bottom); ctx.fillRect(0, H * 0.55, W, H * 0.45); }
  for (const el of s.els) {
    if (el.type === "image") { thDrawImage(ctx, el, opts.selected === el.id); continue; }
    if (el.type === "stroke") {
      if (el.pts.length < 2) continue;
      ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = el.color; ctx.lineWidth = el.width;
      ctx.beginPath(); ctx.moveTo(el.pts[0][0], el.pts[0][1]); el.pts.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.stroke(); ctx.restore();
      continue;
    }
    ctx.font = `${el.weight || 400} ${el.size}px "${el.font}", "Apple SD Gothic Neo", sans-serif`;
    ctx.textBaseline = "middle";
    const lines = String(el.text || "").split("\n").map(thSegments);
    const lh = el.size * (el.lineHeight || 1.18);
    const widths = lines.map((segs) => segs.reduce((a, g) => a + ctx.measureText(g.t).width, 0));
    const maxW = Math.max(1, ...widths), blockH = lines.length * lh;
    const pad = el.bg ? el.pad || 0 : 0;
    const left = el.align === "left" ? el.x : el.align === "right" ? el.x - maxW : el.x - maxW / 2;
    const top = el.y - blockH / 2;
    el._box = { x: left - pad - (el.stroke || 0), y: top - pad - (el.stroke || 0), w: maxW + pad * 2 + (el.stroke || 0) * 2, h: blockH + pad * 2 + (el.stroke || 0) * 2 };
    if (el.bg) { ctx.save(); ctx.fillStyle = hexA(el.bg, (el.bgOpacity ?? 100) / 100); ctx.beginPath(); ctx.roundRect(left - pad, top - pad, maxW + pad * 2, blockH + pad * 2, Math.min(el.radius || 0, (blockH + pad * 2) / 2)); ctx.fill(); ctx.restore(); }
    lines.forEach((segs, i) => {
      let x = el.align === "left" ? left : el.align === "right" ? left + maxW - widths[i] : left + (maxW - widths[i]) / 2;
      const y = top + lh * i + lh / 2;
      ctx.textAlign = "left";
      for (const g of segs) {
        ctx.save();
        if (el.shadow) { ctx.shadowColor = "rgba(0,0,0,.75)"; ctx.shadowBlur = el.size * 0.18; ctx.shadowOffsetY = el.size * 0.05; }
        if (el.stroke > 0) { ctx.lineJoin = "round"; ctx.lineWidth = el.stroke * 2; ctx.strokeStyle = el.strokeColor; ctx.strokeText(g.t, x, y); ctx.shadowColor = "transparent"; }
        ctx.fillStyle = g.hl ? el.hl : el.color; ctx.fillText(g.t, x, y);
        ctx.restore();
        x += ctx.measureText(g.t).width;
      }
    });
    if (opts.selected === el.id) {
      const b = el._box; ctx.save(); ctx.setLineDash([16, 10]); ctx.lineWidth = 5; ctx.strokeStyle = "#a855f7"; ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16); ctx.restore();
    }
  }
}

function thImg(url) { // 사진 요소: 한 번 불러와 두고, 다 불러오면 다시 그린다
  TH.imgs = TH.imgs || {};
  let im = TH.imgs[url];
  if (!im) { im = new Image(); im.onload = () => TH.redraw?.(); im.src = url; TH.imgs[url] = im; }
  return im.complete && im.naturalWidth ? im : null;
}
function thDrawImage(ctx, el, selected) {
  const w = el.w, h = el.w * el.ar, left = el.x - w / 2, top = el.y - h / 2;
  const r = Math.min(+el.radius || 0, w / 2, h / 2), bw = +el.border || 0;
  el._box = { x: left - bw, y: top - bw, w: w + bw * 2, h: h + bw * 2 };
  const im = thImg(el.url);
  ctx.save();
  ctx.globalAlpha = (el.opacity ?? 100) / 100;
  const shadow = () => { ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = Math.max(w, h) * 0.05; ctx.shadowOffsetY = Math.max(w, h) * 0.015; };
  if (bw > 0) { // 테두리 판(그림자 포함)을 먼저 깔고 그 위에 사진
    if (el.shadow) shadow();
    ctx.fillStyle = el.borderColor || "#fff"; ctx.beginPath(); ctx.roundRect(left - bw, top - bw, w + bw * 2, h + bw * 2, r ? r + bw : 0); ctx.fill();
    ctx.shadowColor = "transparent";
  }
  if (!im) { ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fillRect(left, top, w, h); }
  else if (r > 0) { ctx.beginPath(); ctx.roundRect(left, top, w, h, r); ctx.clip(); ctx.drawImage(im, left, top, w, h); }
  else { if (el.shadow && !bw) shadow(); ctx.drawImage(im, left, top, w, h); } // 누끼 PNG는 모양 그대로 그림자
  ctx.restore();
  if (selected) { const b = el._box; ctx.save(); ctx.setLineDash([16, 10]); ctx.lineWidth = 5; ctx.strokeStyle = "#a855f7"; ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16); ctx.restore(); }
}

/* ---------- 3단계: 꾸미기 */
function thStep3(body, v) {
  const s = TH.st;
  if (!s.bg) { s.step = 2; return thRender(v); }
  const [W, H] = thSize();
  const maxH = Math.min(640, Math.round(window.innerHeight * 0.72)), maxW = 640;
  const scale = Math.min(maxH / H, maxW / W);
  body.innerHTML = `<div class="row between"><div><h2 class="mk-h">3단계: 썸네일 문구 & 그래픽 꾸미기</h2><p class="muted mk-sub">강렬한 제목 문구, 시선 집중 배지, 자유 드로잉으로 클릭을 부르는 썸네일을 완성하세요.</p></div><button class="btn ghost" id="reCap">장면 다시 캡처</button></div>
  <div class="th-grid">
    <div class="th-dark stack" style="align-items:center">
      <div class="row between" style="width:${Math.max(320, Math.round(W * scale))}px">
        <div class="row" style="gap:4px">${[["select", "↖ 선택"], ["pen", "✎ 펜"], ["eraser", "⌫ 지우개"]].map(([k, l]) => `<button class="pill ${TH.mode === k ? "purple" : "ghost"}" data-mode="${k}">${l}</button>`).join("")}</div>
        <div class="row" style="gap:4px"><button class="pill ghost" id="undo">↶ 취소</button><button class="pill red" id="del">🗑 삭제</button></div></div>
      <canvas id="thCv" width="${W}" height="${H}" style="width:${Math.round(W * scale)}px;height:${Math.round(H * scale)}px" class="th-canvas mode-${TH.mode}"></canvas>
      <div class="faint" style="font-size:12px;color:#aab">* 문구·배지·사진을 클릭/드래그하여 원하는 위치로 자유롭게 이동하세요.</div>
      <div class="row th-bgctl"><span>배경 확대</span><input type="range" id="bz" min="1" max="2.5" step="0.01" value="${s.view.zoom}"><span>가로</span><input type="range" id="bx" min="-100" max="100" value="${s.view.ox}"><span>세로</span><input type="range" id="by" min="-100" max="100" value="${s.view.oy}"></div>
    </div>
    <div class="stack">
      <div class="card tight stack">
        <b>✨ 요소 추가 및 꾸미기</b>
        <button class="btn th-cta" id="addT">T + 텍스트 문구 추가</button>
        <button class="btn" id="addImg">🖼 + 사진 추가</button><input type="file" id="imgFile" accept="image/*,.heic,.heif" multiple hidden>
        <span class="faint" style="font-size:12px;margin-top:-4px">제품 사진·로고 등을 올려요. 배경이 투명한 PNG(누끼)는 투명한 채로 들어가요. 사진을 캔버스로 끌어다 놓아도 돼요.</span>
        <span class="faint" style="font-size:12.5px">시선 집중 썸네일 배지 (클릭 시 즉시 삽입)</span>
        <div class="chips">${TH_BADGES.map(([l, c], i) => `<button class="badge-chip" data-b="${i}" style="background:${c}">${esc(l)}</button>`).join("")}</div>
        <span class="faint" style="font-size:12.5px">배경 효과 (글씨가 잘 보이게)</span>
        <div class="row">${[["bottom", "하단 어둡게"], ["top", "상단 어둡게"], ["all", "전체 어둡게"]].map(([k, l]) => `<button class="btn sm ${s.dim[k] ? "red" : ""}" data-dim="${k}">${l}</button>`).join("")}</div>
      </div>
      <div class="card tight stack" id="thEd"></div>
    </div>
  </div>
  <div class="card tight stack" style="margin-top:16px">
    <div class="row between"><div><b>🎬 영상에 썸네일 1프레임 자동 삽입</b> <span class="badge brand">유튜브 쇼츠 / 릴스 커버 설정용</span>
      <div class="faint" style="font-size:12.5px">영상의 첫 프레임(또는 마지막 프레임)에 약 0.04초 동안 썸네일을 삽입하여, 플랫폼에서 커버로 지정하기 쉬운 비디오를 합성합니다.</div></div>
      <label class="switch"><input type="checkbox" id="ins" ${s.insert ? "checked" : ""}><span></span></label></div>
    <div class="grid g2" id="insOpts" ${s.insert ? "" : "hidden"}>
      <div class="stack" style="gap:6px"><span class="mk-label" style="margin:0">삽입 위치</span><div class="seg2">${[["start", "⊙ 맨 앞 (첫 프레임)"], ["end", "⊙ 맨 뒤 (마지막 프레임)"]].map(([k, l]) => `<button data-pos="${k}" class="${s.position === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="stack" style="gap:6px"><span class="mk-label" style="margin:0">프레임 노출 시간</span><div class="seg2">${[[0.04, "1프레임 (0.04s)"], [0.1, "0.1초"], [0.5, "0.5초"]].map(([k, l]) => `<button data-sec="${k}" class="${+s.seconds === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    </div>
    <div class="row between"><label class="row" style="font-size:13px;gap:8px">파일 이름 <input type="text" id="tname" value="${esc(s.name)}" style="max-width:220px"></label>
      <button class="btn big th-cta" id="done">4단계: 다운로드 및 합성하기 ›</button></div>
  </div>`;
  const cv = $("#thCv"), ctx = cv.getContext("2d");
  const redraw = () => { thDraw(ctx, W, H, { selected: TH.mode === "select" ? TH.sel : null }); thSave(); };
  TH.redraw = redraw;
  if (!TH.img || TH.img.dataset.src !== s.bg.url) { TH.img = new Image(); TH.img.dataset.src = s.bg.url; TH.img.onload = redraw; TH.img.src = s.bg.url; }
  Promise.all([...new Set(s.els.filter((e) => e.font).map((e) => `${e.weight || 400} 40px "${e.font}"`))].map((f) => document.fonts.load(f).catch(() => {}))).then(redraw);
  const toCanvas = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }; };
  const sel = () => s.els.find((x) => x.id === TH.sel);
  cv.onpointerdown = (e) => {
    const pt = toCanvas(e);
    cv.setPointerCapture(e.pointerId);
    if (TH.mode === "pen") {
      thSnap();
      const st = { id: Math.random().toString(16).slice(2, 8), type: "stroke", color: TH.pen.color, width: TH.pen.width, pts: [[pt.x, pt.y]] };
      s.els.push(st);
      cv.onpointermove = (ev) => { const q = toCanvas(ev); st.pts.push([Math.round(q.x), Math.round(q.y)]); redraw(); };
      cv.onpointerup = () => { cv.onpointermove = null; redraw(); };
      return;
    }
    if (TH.mode === "eraser") {
      thSnap();
      const erase = (q) => {
        const r = 24 * (W / 1080);
        const before = s.els.length;
        s.els = s.els.filter((el) => el.type !== "stroke" || !el.pts.some(([x, y]) => Math.hypot(x - q.x, y - q.y) < r + el.width / 2));
        if (s.els.length !== before) redraw();
      };
      erase(pt);
      cv.onpointermove = (ev) => erase(toCanvas(ev));
      cv.onpointerup = () => { cv.onpointermove = null; };
      return;
    }
    const hit = [...s.els].reverse().find((el) => el._box && el.type !== "stroke" && pt.x >= el._box.x && pt.x <= el._box.x + el._box.w && pt.y >= el._box.y && pt.y <= el._box.y + el._box.h);
    TH.sel = hit?.id || null; editor(); redraw();
    if (!hit) return;
    thSnap();
    const ox = pt.x - hit.x, oy = pt.y - hit.y;
    cv.onpointermove = (ev) => { const q = toCanvas(ev); hit.x = Math.round(q.x - ox); hit.y = Math.round(q.y - oy); redraw(); };
    cv.onpointerup = () => { cv.onpointermove = null; };
  };
  cv.ondblclick = () => $("#thEd textarea")?.focus();
  function editor() {
    const el = sel(), box = $("#thEd");
    if (TH.mode !== "select") {
      box.innerHTML = TH.mode === "pen" ? `<b>✎ 펜 (자유 드로잉)</b><span class="faint" style="font-size:12.5px">썸네일 위에 화살표나 동그라미를 직접 그려 강조하세요.</span>
        <div class="grid g2"><label class="f">펜 색상<input type="color" id="penC" value="${TH.pen.color}"></label><label class="f">펜 굵기 <span class="faint" id="penWL">(${TH.pen.width}px)</span><input type="range" id="penW" min="4" max="60" value="${TH.pen.width}"></label></div>
        <div class="chips">${["#ff2d55", "#ffe14d", "#ffffff", "#00e0ff", "#22c55e", "#000000"].map((c) => `<button class="swatch" data-pc="${c}" style="background:${c}"></button>`).join("")}</div>`
        : `<b>⌫ 지우개</b><span class="faint" style="font-size:12.5px">펜으로 그린 선을 문질러 지워요. 문구와 배지는 '선택' 상태에서 [삭제]로 지워요.</span>`;
      $("#penC")?.addEventListener("input", (e) => (TH.pen.color = e.target.value));
      $("#penW")?.addEventListener("input", (e) => { TH.pen.width = +e.target.value; $("#penWL").textContent = `(${TH.pen.width}px)`; });
      box.querySelectorAll("[data-pc]").forEach((b) => (b.onclick = () => { TH.pen.color = b.dataset.pc; $("#penC").value = b.dataset.pc; }));
      return;
    }
    if (!el) { box.innerHTML = `<b>T 선택된 요소 편집</b><p class="faint" style="margin:0">캔버스의 글자나 스티커를 클릭하면 상세 속성을 수정할 수 있습니다.</p>`; return; }
    if (el.type === "image") {
      const pct = Math.round((el.w / W) * 100);
      box.innerHTML = `<div class="row between"><b>🖼 선택된 사진</b><button class="btn sm ghost danger" id="edDel">🗑 사진 삭제</button></div>
        <span class="faint" style="font-size:12.5px">캔버스에서 드래그하여 원하는 위치로 이동하세요.</span>
        <label class="f">크기 <span class="faint" id="edWL">(화면 너비의 ${pct}%)</span><input type="range" id="edW" min="5" max="150" value="${pct}"></label>
        <div class="grid g2"><label class="f">모서리 둥글게 <span class="faint" id="edRL">(${el.radius || 0}px)</span><input type="range" id="edR" min="0" max="300" value="${el.radius || 0}"></label>
          <label class="f">투명도 <span class="faint" id="edOL">(${el.opacity ?? 100}%)</span><input type="range" id="edO" min="10" max="100" value="${el.opacity ?? 100}"></label></div>
        <div class="grid g2"><label class="f">테두리 두께 <span class="faint" id="edBL">(${el.border || 0}px)</span><input type="range" id="edB" min="0" max="40" value="${el.border || 0}"></label>
          <label class="f">테두리 색<input type="color" id="edBC" value="${el.borderColor || "#ffffff"}"></label></div>
        <label class="row" style="font-size:13px;gap:6px"><input type="checkbox" id="edSh" ${el.shadow ? "checked" : ""}> 그림자</label>
        <div class="row"><button class="btn sm" id="edCx">↔ 가운데로</button><button class="btn sm" id="edDup">⧉ 복제</button><button class="btn sm" id="edUp">맨 앞으로</button><button class="btn sm" id="edDown">맨 뒤로</button></div>`;
      const ch = (fn) => (e) => { thSnap(); fn(e); redraw(); };
      ["edW", "edR", "edO", "edB"].forEach((id) => ($("#" + id).onpointerdown = () => thSnap()));
      $("#edW").oninput = (e) => { el.w = Math.round((W * +e.target.value) / 100); $("#edWL").textContent = `(화면 너비의 ${e.target.value}%)`; redraw(); };
      $("#edR").oninput = (e) => { el.radius = +e.target.value; $("#edRL").textContent = `(${el.radius}px)`; redraw(); };
      $("#edO").oninput = (e) => { el.opacity = +e.target.value; $("#edOL").textContent = `(${el.opacity}%)`; redraw(); };
      $("#edB").oninput = (e) => { el.border = +e.target.value; $("#edBL").textContent = `(${el.border}px)`; redraw(); };
      $("#edBC").oninput = (e) => { el.borderColor = e.target.value; redraw(); };
      $("#edSh").onchange = ch((e) => (el.shadow = e.target.checked));
      $("#edCx").onclick = ch(() => (el.x = W / 2));
      $("#edDup").onclick = ch(() => { const c = { ...deep(el), id: Math.random().toString(16).slice(2, 8), x: el.x + 40, y: el.y + 40 }; s.els.push(c); TH.sel = c.id; editor(); });
      $("#edUp").onclick = ch(() => { s.els = s.els.filter((x) => x !== el); s.els.push(el); });
      $("#edDown").onclick = ch(() => { s.els = [el, ...s.els.filter((x) => x !== el)]; });
      $("#edDel").onclick = () => removeSel();
      return;
    }
    if (el.type === "badge") {
      box.innerHTML = `<div class="row between"><b>🏷 선택된 배지 스티커</b></div>
        <span class="faint" style="font-size:12.5px">캔버스에서 드래그하여 원하는 위치로 이동하세요.</span>
        <input type="text" id="edText" value="${esc(el.text)}">
        <div class="grid g2"><label class="f">배지 색상<input type="color" id="edBg" value="${el.bg}"></label><label class="f">크기 <span class="faint" id="edSizeL">(${el.size}px)</span><input type="range" id="edSize" min="20" max="160" value="${el.size}"></label></div>
        <button class="btn red" id="edDel">🗑 배지 삭제</button>`;
      $("#edText").oninput = (e) => { el.text = e.target.value; redraw(); };
      $("#edBg").oninput = (e) => { el.bg = e.target.value; redraw(); };
      $("#edSize").onpointerdown = () => thSnap();
      $("#edSize").oninput = (e) => { el.size = +e.target.value; $("#edSizeL").textContent = `(${el.size}px)`; redraw(); };
      $("#edDel").onclick = () => removeSel();
      return;
    }
    box.innerHTML = `<div class="row between"><b>T 선택된 텍스트 편집</b><button class="btn sm ghost danger" id="edDel">🗑 텍스트 삭제</button></div>
      <textarea id="edText" rows="2" style="min-height:64px" placeholder="썸네일 문구를 입력하세요">${esc(el.text)}</textarea>
      <span class="faint" style="font-size:12px">엔터로 줄바꿈 · *별표*로 감싼 글자는 강조 색으로 바뀌어요</span>
      <label class="f">폰트 서체<select id="edFont">${[...TH_FONTS, ...FONTS.filter(([f]) => !TH_FONTS.some(([g]) => g === f))].map(([f, n]) => `<option value="${f}" ${el.font === f ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <div class="grid g2"><label class="f">크기 <span class="faint" id="edSizeL">(${el.size}px)</span><input type="range" id="edSize" min="24" max="320" value="${el.size}"></label>
        <label class="f">글자색 <span class="faint">${el.color}</span><input type="color" id="edColor" value="${el.color}"></label></div>
      <div class="grid g2"><label class="f">외곽선 두께 <span class="faint" id="edStrokeL">(${el.stroke}px)</span><input type="range" id="edStroke" min="0" max="30" value="${el.stroke}"></label>
        <label class="f">외곽선 색<input type="color" id="edStrokeC" value="${el.strokeColor}"></label></div>
      <div class="grid g2"><label class="f">배경 박스 투명도 <span class="faint" id="edBgOL">(${el.bg ? el.bgOpacity ?? 100 : 0}%)</span><input type="range" id="edBgO" min="0" max="100" value="${el.bg ? el.bgOpacity ?? 100 : 0}"></label>
        <label class="f">배경 박스 색<input type="color" id="edBg" value="${el.bgColor || el.bg || "#000000"}"></label></div>
      <div class="grid g2"><label class="f">강조 색 (*별표* 글자)<input type="color" id="edHl" value="${el.hl}"></label>
        <label class="f">정렬 · 그림자<div class="row" style="flex-wrap:nowrap"><select id="edAlign">${[["left", "왼쪽"], ["center", "가운데"], ["right", "오른쪽"]].map(([k, n]) => `<option value="${k}" ${el.align === k ? "selected" : ""}>${n}</option>`).join("")}</select><label class="row" style="font-size:13px;color:var(--text);white-space:nowrap"><input type="checkbox" id="edShadow" ${el.shadow ? "checked" : ""}> 그림자</label></div></label></div>
      <span class="faint" style="font-size:12.5px">빠른 스타일</span>
      <div class="chips">${TH_STYLES.map(([n], i) => `<button class="chip" data-sty="${i}">${n}</button>`).join("")}</div>
      <div class="row"><button class="btn sm" id="edCx">↔ 가운데로</button><button class="btn sm" id="edDup">⧉ 복제</button><button class="btn sm" id="edUp">맨 앞으로</button></div>`;
    let typing;
    const ch = (fn, snap = true) => (e) => { if (snap) thSnap(); fn(e); redraw(); };
    $("#edText").oninput = (e) => { if (!typing) thSnap(); clearTimeout(typing); typing = setTimeout(() => (typing = null), 800); el.text = e.target.value; redraw(); };
    $("#edFont").onchange = ch((e) => { el.font = e.target.value; el.weight = ["GmarketSans", "Pretendard", "Arial Black"].includes(el.font) ? 700 : 400; document.fonts.load(`${el.weight} 40px "${el.font}"`).then(redraw); });
    $("#edAlign").onchange = ch((e) => (el.align = e.target.value));
    ["edSize", "edStroke", "edBgO"].forEach((id) => ($("#" + id).onpointerdown = () => thSnap()));
    $("#edSize").oninput = (e) => { el.size = +e.target.value; $("#edSizeL").textContent = `(${el.size}px)`; redraw(); };
    $("#edColor").oninput = ch((e) => { el.color = e.target.value; e.target.previousElementSibling.textContent = el.color; }, false);
    $("#edHl").oninput = ch((e) => (el.hl = e.target.value), false);
    $("#edStroke").oninput = (e) => { el.stroke = +e.target.value; $("#edStrokeL").textContent = `(${el.stroke}px)`; redraw(); };
    $("#edStrokeC").oninput = ch((e) => (el.strokeColor = e.target.value), false);
    $("#edShadow").onchange = ch((e) => (el.shadow = e.target.checked));
    $("#edBgO").oninput = (e) => { const o = +e.target.value; el.bgColor = $("#edBg").value; el.bg = o > 0 ? el.bgColor : ""; el.bgOpacity = o; $("#edBgOL").textContent = `(${o}%)`; redraw(); };
    $("#edBg").oninput = ch((e) => { el.bgColor = e.target.value; if (el.bg) el.bg = e.target.value; }, false);
    $("#edCx").onclick = ch(() => (el.x = W / 2));
    $("#edDup").onclick = ch(() => { const c = { ...deep(el), id: Math.random().toString(16).slice(2, 8), y: el.y + el.size * 1.4 }; s.els.push(c); TH.sel = c.id; editor(); });
    $("#edUp").onclick = ch(() => { s.els = s.els.filter((x) => x !== el); s.els.push(el); });
    box.querySelectorAll("[data-sty]").forEach((b) => (b.onclick = ch(() => { Object.assign(el, TH_STYLES[+b.dataset.sty][1]); editor(); })));
    $("#edDel").onclick = () => removeSel();
  }
  const removeSel = () => { if (!TH.sel) return toast("지울 문구·배지·사진을 먼저 클릭하세요"); thSnap(); s.els = s.els.filter((x) => x.id !== TH.sel); TH.sel = null; editor(); redraw(); };
  const setMode = (m) => { TH.mode = m; body.querySelectorAll("[data-mode]").forEach((b) => { b.classList.toggle("purple", b.dataset.mode === m); b.classList.toggle("ghost", b.dataset.mode !== m); }); cv.className = `th-canvas mode-${m}`; editor(); redraw(); };
  body.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("#del").onclick = removeSel;
  $("#undo").onclick = () => { const u = TH.undo.pop(); if (!u) return toast("되돌릴 내용이 없어요"); Object.assign(s, JSON.parse(u)); TH.sel = null; editor(); redraw(); };
  const addEl = (el) => { thSnap(); s.els.push(el); TH.sel = el.id; setMode("select"); if (el.font) document.fonts.load(`${el.weight} 40px "${el.font}"`).then(redraw).catch(redraw); };
  const addImages = async (files, at) => {
    files = [...files].filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!files.length) return toast("사진 파일을 골라 주세요");
    try {
      const fd = new FormData(); files.forEach((f) => fd.append("files", f));
      toast("사진 올리는 중…", 60000);
      const res = await api("POST", "/api/upload?asset=1", fd);
      for (const [i, r] of res.entries()) {
        const im = await new Promise((ok, no) => { const x = new Image(); x.onload = () => ok(x); x.onerror = no; x.src = r.url; });
        TH.imgs = TH.imgs || {}; TH.imgs[r.url] = im;
        const ar = im.naturalHeight / im.naturalWidth, w = Math.round(Math.min(W * 0.5, (H * 0.4) / ar));
        addEl({ id: Math.random().toString(16).slice(2, 8), type: "image", url: r.url, ar, w, x: Math.round((at?.x ?? W / 2) + i * 40), y: Math.round((at?.y ?? H / 2) + i * 40),
          radius: 0, border: 0, borderColor: "#ffffff", shadow: true, opacity: 100 });
      }
      toast(`사진 ${res.length}장을 넣었어요. 끌어서 옮기고 오른쪽에서 크기를 바꿔요`);
    } catch (err) { fail(err); }
  };
  $("#addImg").onclick = () => $("#imgFile").click();
  $("#imgFile").onchange = (e) => { addImages(e.target.files); e.target.value = ""; };
  cv.ondragover = (e) => e.preventDefault();
  cv.ondrop = (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files, toCanvas(e)); };
  $("#addT").onclick = () => { const el = thNewText("새로운 강조 문구"); el.y = H * (0.3 + 0.12 * (s.els.length % 5)); addEl(el); };
  body.querySelectorAll("[data-b]").forEach((b) => (b.onclick = () => { const [l, c] = TH_BADGES[+b.dataset.b]; addEl(thNewBadge(l, c)); }));
  body.querySelectorAll("[data-dim]").forEach((b) => (b.onclick = () => { thSnap(); const k = b.dataset.dim; s.dim[k] = s.dim[k] ? 0 : k === "all" ? 0.3 : 0.75; b.classList.toggle("red", !!s.dim[k]); redraw(); }));
  ["bz", "bx", "by"].forEach((id) => { const el = $("#" + id); el.onpointerdown = () => thSnap(); el.oninput = () => { s.view = { zoom: +$("#bz").value, ox: +$("#bx").value, oy: +$("#by").value }; redraw(); }; });
  $("#reCap").onclick = () => { s.step = 2; thRender(v); };
  $("#ins").onchange = (e) => { s.insert = e.target.checked; $("#insOpts").hidden = !s.insert; thSave(); };
  body.querySelectorAll("[data-pos]").forEach((b) => (b.onclick = () => { s.position = b.dataset.pos; body.querySelectorAll("[data-pos]").forEach((x) => x.classList.toggle("on", x === b)); thSave(); }));
  body.querySelectorAll("[data-sec]").forEach((b) => (b.onclick = () => { s.seconds = +b.dataset.sec; body.querySelectorAll("[data-sec]").forEach((x) => x.classList.toggle("on", x === b)); thSave(); }));
  $("#tname").oninput = (e) => { s.name = e.target.value; thSave(); };
  const onKey = (e) => {
    if (!document.body.contains(cv)) return document.removeEventListener("keydown", onKey);
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && TH.sel) { e.preventDefault(); removeSel(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); $("#undo").click(); }
  };
  document.addEventListener("keydown", onKey);
  $("#done").onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = "만드는 중…";
    try {
      await Promise.all(s.els.filter((x) => x.font).map((x) => document.fonts.load(`${x.weight || 400} 40px "${x.font}"`).catch(() => {})));
      await Promise.all(s.els.filter((x) => x.type === "image").map((x) => new Promise((ok) => { const im = TH.imgs?.[x.url] || new Image(); if (im.complete && im.naturalWidth) return ok(); im.onload = im.onerror = ok; if (!im.src) { im.src = x.url; (TH.imgs = TH.imgs || {})[x.url] = im; } setTimeout(ok, 5000); })));
      const off = document.createElement("canvas"); off.width = W; off.height = H;
      thDraw(off.getContext("2d"), W, H);
      const blob = await new Promise((r) => off.toBlob(r, "image/png"));
      const fd = new FormData(); fd.append("image", blob, "thumb.png");
      fd.append("meta", JSON.stringify({ name: s.name, src: s.src, insert: s.insert, position: s.position, seconds: s.seconds }));
      const job = await api("POST", "/api/thumb/save", fd);
      const done = await waitJob(job.id, (j) => (b.textContent = j.message || "만드는 중…"));
      s.result = done.result; s.step = 4; thRender(v);
    } catch (err) { fail(err); b.disabled = false; b.textContent = "4단계: 다운로드 및 합성하기 ›"; }
  };
  editor(); redraw();
}

/* ---------- 4단계: 다운로드 & 합성 */
function thStep4(body, v) {
  const s = TH.st, r = s.result || {};
  const [W, H] = thSize();
  body.innerHTML = `<div style="text-align:center;margin-bottom:16px"><div class="ok-ico">✓</div><h2 style="margin:6px 0;justify-content:center">썸네일이 성공적으로 완성되었습니다!</h2>
    <p class="muted" style="margin:0">제작된 고화질 썸네일 이미지를 다운로드하거나, 1프레임이 합성된 쇼츠 영상을 저장하세요.</p></div>
  <div class="card mk-card" style="text-align:center">
    <img src="${r.png}" alt="썸네일" class="th-result" style="aspect-ratio:${W}/${H}">
    <div class="stack" style="align-items:center;margin-top:12px;gap:6px"><span class="badge brand">고화질 원본 이미지</span><b>썸네일 이미지 파일 (PNG)</b>
      <span class="faint">유튜브 스튜디오, 틱톡, 인스타그램 업로드 시 썸네일 이미지로 즉시 등록할 수 있습니다. (${W}×${H})</span>
      <div class="row"><a class="btn th-cta" href="${r.png}" download="${esc(r.png_file || "thumbnail.png")}">⬇ 썸네일 이미지 다운로드 (PNG)</a><button class="btn ghost" data-rv="${esc(r.png_file || "")}">Finder에서 보기</button></div></div>
  </div>
  ${r.mp4 ? `<div class="card mk-card stack" style="margin-top:14px;gap:8px">
    <span class="badge brand" style="align-self:start">${s.position === "end" ? "맨 뒤" : "맨 앞"} ${+s.seconds <= 0.04 ? "1프레임" : s.seconds + "초"} 삽입</span>
    <b>썸네일이 합성된 쇼츠 비디오 (MP4)</b>
    <span class="faint">유튜브 쇼츠 등 썸네일 지정이 불가한 플랫폼을 위해 영상 ${s.position === "end" ? "맨 끝" : "맨 앞"}에 썸네일을 삽입했습니다. (${r.duration}초 · ${r.size_mb}MB)${s.ratio !== "orig" && s.ratio !== "9:16" ? " 썸네일 비율이 영상과 다르면 남는 부분은 검게 채워져요." : ""}</span>
    <div class="row between done-row"><div class="row"><span class="ok-ico sm">✓</span><div><b>합성 완료 (MP4 준비됨)</b><div class="faint" style="font-size:12.5px">클릭하여 합성된 비디오를 저장하세요.</div></div></div>
      <div class="row"><button class="btn ghost sm" id="pv">미리보기</button><a class="btn primary" href="${r.mp4}" download="${esc(r.mp4_file || "thumbnail.mp4")}">⬇ 영상 다운로드 (MP4)</a></div></div>
    <video src="${r.mp4}" controls playsinline id="pvV" hidden class="th-mp4v"></video>
  </div>` : ""}
  <div class="card mk-card stack" style="margin-top:14px;gap:8px">
    <span class="badge brand" style="align-self:start">캡컷에서 이어서 편집</span>
    <b>✂️ 썸네일을 넣은 영상을 캡컷으로 열기</b>
    <span class="faint">${s.src.startsWith("proj:") ? "영상 만들기의 장면·자막·목소리를 따로따로 고칠 수 있는 캡컷 프로젝트로 열고," : "이 영상을 캡컷 프로젝트로 열고,"} 썸네일을 영상 ${s.position === "end" ? "맨 뒤" : "맨 앞"}에 ${s.seconds}초 넣어요.</span>
    <div class="row"><button class="btn primary" id="toCapcutTh">✂️ 캡컷으로 열기</button></div>
  </div>
  <div class="row" style="justify-content:center;margin-top:16px"><button class="btn ghost" id="again">↻ 다른 장면 캡처하기</button><button class="btn ghost" id="restart">새로운 영상으로 처음부터 만들기</button></div>`;
  body.querySelectorAll("[data-rv]").forEach((b) => (b.onclick = () => api("POST", "/api/reveal", { file: b.dataset.rv, project: "thumbs" }).catch(fail)));
  $("#pv")?.addEventListener("click", () => { $("#pvV").hidden = !$("#pvV").hidden; });
  $("#again").onclick = () => { s.step = 2; thRender(v); };
  $("#toCapcutTh").onclick = () => {
    const cover = { file: r.png_file, position: s.position || "start", seconds: +s.seconds || 0.1 };
    if (s.src.startsWith("proj:")) exportCapcut({ pid: s.src.split(":")[1], cover });
    else exportCapcut({ src: s.src, name: s.srcName, cover });
  };
  $("#restart").onclick = () => { TH.st = thDefault(); thRender(v); };
}
document.fonts?.addEventListener?.("loadingdone", () => TH.redraw?.());
