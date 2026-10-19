/* 영상 작업실 화면 (바닐라 JS) */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { settings: null, prompts: [], promptCat: "전체", promptQ: "" };

const LINK_LABELS = {
  shorttube: "숏튜브 첫 화면",
  shorttube_shopping: "숏튜브 쇼핑숏츠 만들기",
  shorttube_subtitle: "숏튜브 자막 제거",
  shorttube_cut: "숏튜브 영상 자르기",
  shorttube_thumbnail: "숏튜브 썸네일 제작",
  compress: "용량 줄이기 (FreeConvert)",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  flow: "구글 플로우",
  fishaudio: "Fish Audio",
  vrew_web: "브루 웹 (앱이 없을 때)",
  taobao: "타오바오 자동화 (내 프로그램)",
};
const TARGETS = {
  chatgpt: { label: "ChatGPT", link: "chatgpt", prefill: true },
  gemini: { label: "Gemini", link: "gemini" },
  flow: { label: "구글 플로우", link: "flow" },
  fishaudio: { label: "Fish Audio", link: "fishaudio" },
  none: { label: "복사만", link: null },
};
const MOTIONS = [
  ["auto", "자동 (번갈아)", "slow cinematic push-in"],
  ["zoom_in", "천천히 확대", "slow dolly push-in toward the center"],
  ["zoom_out", "천천히 축소", "slow dolly pull-back revealing the whole space"],
  ["pan_right", "오른쪽으로 이동", "slow smooth pan to the right"],
  ["pan_left", "왼쪽으로 이동", "slow smooth pan to the left"],
  ["pan_up", "위로 이동", "slow tilt up"],
  ["pan_down", "아래로 이동", "slow tilt down"],
];
const SHORTTUBE_MAX_SEC = 180;

/* ------------------------------------------------------------ 공통 */
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `요청 실패 (${r.status})`);
  return data;
}
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function fail(e) { toast(e.message || String(e), 4000); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
  }
}
function linkUrl(key) { return (S.settings?.links || {})[key] || ""; }
function openLink(key) {
  const url = linkUrl(key);
  if (!url) return toast("설정에서 주소를 넣어 주세요");
  window.open(url, "_blank", "noopener");
}
async function openApp(name, fallbackKey) {
  try { await api("POST", "/api/open-app", { app: name }); toast(`${name} 앱을 열었어요`); }
  catch (e) { if (fallbackKey) { openLink(fallbackKey); toast(e.message, 3500); } else fail(e); }
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const fmtSec = (s) => { s = Math.round(s); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; };

/* ------------------------------------------------------------ 모달 */
function modal(html, onMount) {
  const m = $("#modal");
  m.innerHTML = `<div class="box">${html}</div>`; m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  onMount?.(m, close);
  return close;
}

/* ------------------------------------------------------------ 프롬프트 사용 */
const VAR_RE = /\{([^{}\n]{1,24})\}/g;
const varsOf = (body) => [...new Set([...body.matchAll(VAR_RE)].map((m) => m[1]))];
const fillVars = (body, vals) => body.replace(VAR_RE, (all, k) => (vals[k] !== undefined && vals[k] !== "" ? vals[k] : all));

/* 프롬프트를 복사(하고 해당 사이트를 연다). 빈칸이 있으면 먼저 채우게 한다. */
function usePrompt(p, { open = false, preset = {} } = {}) {
  const t = TARGETS[p.target] || TARGETS.none;
  const finish = (text) => {
    if (open && t.link) {
      let url = linkUrl(t.link);
      if (t.prefill && text.length < 6000) url += (url.includes("?") ? "&" : "?") + "q=" + encodeURIComponent(text);
      window.open(url, "_blank", "noopener");
    }
    copyText(text).then(() => toast(open && t.link ? `복사했어요. ${t.label}에 붙여넣기(⌘V) 하세요` : "복사했어요"));
  };
  const missing = varsOf(p.body).filter((v) => !(v in preset) || preset[v] === "");
  if (!missing.length) return finish(fillVars(p.body, preset));
  const remembered = store.get("varValues", {});
  modal(`
    <h3>빈칸 채우기 · ${esc(p.title)}</h3>
    <p class="faint">비워 두면 {빈칸} 그대로 복사돼요. 입력한 값은 다음에도 기억해요.</p>
    ${missing.map((v) => `<label class="f">${esc(v)}<textarea data-var="${esc(v)}" rows="2" style="min-height:44px">${esc(remembered[v] || "")}</textarea></label>`).join("")}
    <div class="row" style="justify-content:flex-end">
      <button class="btn" data-close>취소</button>
      <button class="btn primary" id="vOk">${open && t.link ? `복사하고 ${esc(t.label)} 열기` : "복사"}</button>
    </div>`, (m, close) => {
    m.querySelector("textarea")?.focus();
    $("#vOk", m).onclick = () => {
      const vals = { ...preset };
      m.querySelectorAll("[data-var]").forEach((el) => { vals[el.dataset.var] = el.value.trim(); remembered[el.dataset.var] = el.value; });
      store.set("varValues", remembered);
      close(); finish(fillVars(p.body, vals));
    };
  });
}

function promptCard(p, { manage = false } = {}) {
  const t = TARGETS[p.target] || TARGETS.none;
  const vars = varsOf(p.body);
  return `<div class="card tight prompt" data-pid="${p.id}">
    <div class="row between"><div class="row"><span class="badge">${esc(p.category)}</span>${p.pinned ? '<span class="badge brand">★ 즐겨찾기</span>' : ""}</div>
      ${manage ? `<div class="row" style="gap:0"><button class="btn sm ghost" data-act="pin" title="즐겨찾기">${p.pinned ? "★" : "☆"}</button>
        <button class="btn sm ghost" data-act="edit">수정</button><button class="btn sm ghost danger" data-act="del">삭제</button></div>` : `<span class="faint">${esc(t.label)}</span>`}</div>
    <h3 style="margin:0">${esc(p.title)}</h3>
    <div class="pv"><span>${esc(p.body)}</span></div>
    ${vars.length ? `<div class="vars">빈칸: ${vars.map(esc).join(", ")}</div>` : ""}
    <div class="row">
      <button class="btn sm" data-act="copy">복사</button>
      ${t.link ? `<button class="btn sm primary" data-act="open">복사하고 ${esc(t.label)} 열기</button>` : ""}
    </div></div>`;
}
function bindPromptCards(root, rerender) {
  root.querySelectorAll("[data-pid]").forEach((el) => {
    const p = S.prompts.find((x) => x.id === el.dataset.pid);
    el.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
      const act = b.dataset.act;
      if (act === "copy") usePrompt(p);
      if (act === "open") usePrompt(p, { open: true });
      if (act === "edit") editPrompt(p, rerender);
      if (act === "pin") { await savePrompt({ ...p, pinned: !p.pinned }); rerender(); }
      if (act === "del" && confirm(`"${p.title}" 프롬프트를 삭제할까요?`)) {
        try { await api("DELETE", `/api/prompts/${p.id}`); S.prompts = S.prompts.filter((x) => x.id !== p.id); rerender(); toast("삭제했어요"); } catch (e) { fail(e); }
      }
    }));
  });
}
async function savePrompt(p) {
  const saved = p.id ? await api("PUT", `/api/prompts/${p.id}`, p) : await api("POST", "/api/prompts", p);
  const i = S.prompts.findIndex((x) => x.id === saved.id);
  if (i >= 0) S.prompts[i] = saved; else S.prompts.push(saved);
  return saved;
}
const categories = () => [...new Set(S.prompts.map((p) => p.category))];
function editPrompt(p, after) {
  p = p || { title: "", category: S.promptCat !== "전체" ? S.promptCat : "대본", target: "chatgpt", body: "", pinned: false };
  modal(`
    <h3>${p.id ? "프롬프트 수정" : "새 프롬프트"}</h3>
    <label class="f">제목<input type="text" id="pTitle" value="${esc(p.title)}" placeholder="예: 쇼핑숏츠 대본 각색"></label>
    <div class="grid g2">
      <label class="f">분류<input type="text" id="pCat" list="catList" value="${esc(p.category)}"><datalist id="catList">${categories().map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
      <label class="f">어디에 쓰나요<select id="pTarget">${Object.entries(TARGETS).map(([k, v]) => `<option value="${k}" ${k === p.target ? "selected" : ""}>${v.label}</option>`).join("")}</select></label>
    </div>
    <label class="f">내용 <span class="faint" style="font-weight:400">{상품명}처럼 중괄호로 감싸면 쓸 때마다 빈칸으로 물어봐요</span>
      <textarea id="pBody" rows="12">${esc(p.body)}</textarea></label>
    <label class="row" style="font-size:14px"><input type="checkbox" id="pPin" ${p.pinned ? "checked" : ""}> 대시보드 즐겨찾기에 보이기</label>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary" id="pSave">저장</button></div>`,
  (m, close) => {
    $("#pTitle", m).focus();
    $("#pSave", m).onclick = async () => {
      const body = $("#pBody", m).value;
      if (!body.trim()) return toast("내용을 입력해 주세요");
      try {
        await savePrompt({ ...p, title: $("#pTitle", m).value, category: $("#pCat", m).value, target: $("#pTarget", m).value, body, pinned: $("#pPin", m).checked });
        close(); toast("저장했어요"); after?.();
      } catch (e) { fail(e); }
    };
  });
}

/* ------------------------------------------------------------ 업로드 */
function dropZone(el, accept, onFiles) {
  const input = document.createElement("input");
  input.type = "file"; input.multiple = true; input.accept = accept; input.hidden = true;
  el.appendChild(input);
  el.onclick = (e) => { if (e.target !== input) input.click(); };
  input.onchange = () => { if (input.files.length) onFiles([...input.files]); input.value = ""; };
  el.ondragover = (e) => { e.preventDefault(); el.classList.add("over"); };
  el.ondragleave = () => el.classList.remove("over");
  el.ondrop = (e) => { e.preventDefault(); el.classList.remove("over"); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); };
}
async function uploadFiles(files) {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  toast(`${files.length}개 올리는 중…`, 60000);
  const res = await api("POST", "/api/upload", fd);
  toast(`${res.length}개 올렸어요`);
  return res;
}

/* ------------------------------------------------------------ 작업 진행 */
function runJob(box, url, body, onDone) {
  box.innerHTML = `<div class="card stack"><div class="row between"><b id="jMsg">시작하는 중</b><span class="faint" id="jPct">0%</span></div><div class="bar"><i id="jBar" style="width:2%"></i></div></div>`;
  api("POST", url, body).then((job) => {
    const tick = async () => {
      try {
        const j = await api("GET", `/api/jobs/${job.id}`);
        $("#jMsg", box).textContent = j.message;
        $("#jPct", box).textContent = Math.round(j.progress * 100) + "%";
        $("#jBar", box).style.width = Math.max(2, j.progress * 100) + "%";
        if (j.status === "running") return setTimeout(tick, 800);
        if (j.status === "error") { box.innerHTML = `<div class="notice bad"><b>실패했어요.</b> ${esc(j.error)}</div>`; return; }
        renderResults(box, j.outputs); onDone?.(j);
      } catch (e) { box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
    };
    tick();
  }).catch((e) => { box.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
}
function renderResults(box, outputs) {
  const total = outputs.reduce((a, o) => a + o.duration, 0);
  box.innerHTML = `<div class="card">
    <div class="row between"><h3 style="margin:0">완성 ${outputs.length}개 · 총 ${fmtSec(total)}</h3>
      <div class="row"><button class="btn sm" id="rSend">클립 합치기로 보내기</button><button class="btn sm" id="rFolder">결과 폴더 열기</button><button class="btn sm primary" id="rST">숏튜브 쇼핑숏츠 열기 ↗</button></div></div>
    ${outputs.length > 3 ? `<p class="notice warn" style="margin:12px 0 0">숏튜브 쇼핑숏츠는 영상을 3개까지 받아요. [클립 합치기로 보내기]로 1~3개로 합쳐 주세요.</p>` : ""}
    <div class="results">${outputs.map((o) => `<div class="result stack">
      <video src="${o.url}" ${o.poster ? `poster="${o.poster}"` : ""} controls preload="none" playsinline></video>
      <div><b>${esc(o.label)}</b><div class="faint">${fmtSec(o.duration)} · ${o.size_mb}MB</div></div>
      <div class="row"><a class="btn sm" href="${o.url}" download="${esc(o.file)}">다운로드</a><button class="btn sm ghost" data-reveal="${esc(o.file)}">Finder에서 보기</button></div>
    </div>`).join("")}</div></div>`;
  box.querySelectorAll("[data-reveal]").forEach((b) => (b.onclick = () => api("POST", "/api/reveal", { file: b.dataset.reveal }).catch(fail)));
  $("#rFolder", box).onclick = () => api("POST", "/api/reveal", { file: "" }).catch(fail);
  $("#rST", box).onclick = () => openLink("shorttube_shopping");
  $("#rSend", box).onclick = () => {
    const m = store.get("merge", {}); m.items = m.items || [];
    outputs.forEach((o) => m.items.push({ id: "out:" + o.file, name: o.label, url: o.url, duration: o.duration, poster: o.poster }));
    store.set("merge", m); location.hash = "#/merge";
  };
}
const moveItem = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };

/* ------------------------------------------------------------ 대시보드 */
async function viewDashboard(v) {
  const tools = [
    ["사진 → 영상", "사진 7장을 움직이는 영상으로", "구글 플로우 · 무료 모션", "go:photo"],
    ["클립 합치기", "여러 영상을 1~3개로 이어 붙이기", "내 컴퓨터", "go:merge"],
    ["자막 제거", "중국어 자막 지우기", "숏튜브", "link:shorttube_subtitle"],
    ["영상 자르기", "구간 자르기 · 9:16 크롭", "숏튜브", "link:shorttube_cut"],
    ["썸네일 제작", "장면 캡처 + 문구", "숏튜브", "link:shorttube_thumbnail"],
    ["용량 줄이기", "업로드용으로 가볍게", "FreeConvert", "link:compress"],
  ];
  const ai = [
    ["대본 만들기", "저장한 대본 프롬프트로", "ChatGPT", "link:chatgpt"],
    ["사진 → 영상 (AI)", "사진을 움직이는 영상으로", "구글 플로우", "link:flow"],
    ["목소리 넣기", "대본을 AI 목소리로", "Fish Audio", "link:fishaudio"],
    ["자막 만들기", "음성으로 자막 자동 생성", "브루 앱", "app:Vrew"],
    ["Gemini", "이미지·영상 질문", "Gemini", "link:gemini"],
  ];
  const projs = await api("GET", "/api/projects").catch(() => []);
  v.innerHTML = `
    <h1>영상 작업실</h1>
    <p class="lead">쇼핑·여행·일상·브이로그 영상을 한 곳에서 만들어요.</p>
    <div class="card make-hero" style="margin-top:20px">
      <div class="stack" style="gap:6px;flex:1;min-width:240px">
        <span class="badge brand" style="align-self:start">숏튜브 쇼핑숏츠와 같은 5단계</span>
        <h2 style="margin:4px 0 0;font-size:24px">🎬 영상 만들기</h2>
        <p class="muted" style="margin:0">원본 입력 → 대본 각색 → 레이아웃 세팅 → 세부 편집 → 완료</p>
        <p class="faint" style="margin:0">영상을 올리면 AI가 대본을 쓰고, 목소리·자막·레이아웃을 입혀 MP4로 만들어요. 유료 API 없이 동작해요.</p>
      </div>
      <a class="btn primary big" href="#/make">+ 새 영상 만들기</a>
    </div>
    ${projs.length ? `<h2>내 작업 <span class="badge">${projs.length}</span></h2>
    <div class="grid g3" id="projs">${projs.slice(0, 9).map((x) => `<div class="card tight proj">
      <div class="pthumb">${x.poster ? `<img src="${x.poster}" alt="">` : "🎞"}</div>
      <div class="stack" style="gap:2px;min-width:0;flex:1"><b class="n">${esc(x.name)}</b>
        <span class="faint">${x.step}단계 · ${["원본 입력", "대본 각색", "레이아웃 세팅", "세부 편집", "완료"][x.step - 1]} · 장면 ${x.scenes}개</span>
        <span class="faint">${new Date(x.updated * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}${x.render ? " · 영상 완성" : ""}</span>
        <div class="row" style="margin-top:4px"><a class="btn sm primary" href="#/make?id=${x.id}">이어서 하기</a><button class="btn sm ghost danger" data-pdel="${x.id}">삭제</button></div></div></div>`).join("")}</div>` : ""}
    <h2>편집 도구</h2>
    <div class="grid g3">${tools.map(toolCard).join("")}</div>
    <h2>AI 도구 <span class="badge">무료로 쓰는 사이트·앱 바로가기</span></h2>
    <div class="grid g4" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">${ai.map(toolCard).join("")}</div>
    <h2>자주 쓰는 프롬프트 <span class="row" style="margin-left:auto;gap:6px"><button class="btn sm" id="newP">+ 새 프롬프트</button><a class="btn sm ghost" href="#/prompts">보관함 전체 보기 →</a></span></h2>
    <div class="grid g3" id="pcats"></div>`;
  v.querySelectorAll("[data-a]").forEach((el) => (el.onclick = () => act(el.dataset.a)));
  v.querySelectorAll("[data-pdel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("이 작업을 삭제할까요? 만든 영상도 함께 지워져요.")) return;
    await api("DELETE", `/api/projects/${b.dataset.pdel}`).catch(fail); viewDashboard(v);
  }));
  $("#newP", v).onclick = () => editPrompt(null, () => renderPromptCats($("#pcats", v)));
  renderPromptCats($("#pcats", v));
}
/* 분류별 프롬프트 카드: 화살표 목록에서 고르고 바로 복사 */
function renderPromptCats(box) {
  const sel = store.get("catSel", {});
  const cats = categories();
  box.innerHTML = cats.map((c) => {
    const list = S.prompts.filter((p) => p.category === c);
    const cur = list.find((p) => p.id === sel[c]) || list.find((p) => p.pinned) || list[0];
    const t = TARGETS[cur?.target] || TARGETS.none;
    return `<div class="card tight prompt pcat" data-cat="${esc(c)}">
      <div class="row between"><b>${esc(c)}</b><span class="faint">${list.length}개</span></div>
      <select data-psel="${esc(c)}">${list.map((p) => `<option value="${p.id}" ${p.id === cur?.id ? "selected" : ""}>${p.pinned ? "★ " : ""}${esc(p.title)}</option>`).join("")}</select>
      <div class="pv"><span>${esc(cur?.body || "")}</span></div>
      ${cur && varsOf(cur.body).length ? `<div class="vars">빈칸: ${varsOf(cur.body).map(esc).join(", ")}</div>` : ""}
      <div class="row"><button class="btn sm primary" data-pact="copy">복사하기</button>${t.link ? `<button class="btn sm" data-pact="open">복사하고 ${esc(t.label)} 열기</button>` : ""}
        <span style="flex:1"></span><button class="btn sm ghost" data-pact="edit">수정</button><button class="btn sm ghost" data-pact="new" title="이 분류에 새 프롬프트">+ 새로</button></div></div>`;
  }).join("") || '<p class="muted">프롬프트가 없어요. [+ 새 프롬프트]로 만들어 보세요.</p>';
  box.querySelectorAll("[data-psel]").forEach((el) => (el.onchange = () => { sel[el.dataset.psel] = el.value; store.set("catSel", sel); renderPromptCats(box); }));
  box.querySelectorAll(".pcat").forEach((card) => card.querySelectorAll("[data-pact]").forEach((b) => (b.onclick = () => {
    const c = card.dataset.cat, id = card.querySelector("select").value, p = S.prompts.find((x) => x.id === id);
    const act = b.dataset.pact;
    if (act === "copy") usePrompt(p);
    if (act === "open") usePrompt(p, { open: true });
    if (act === "edit") editPrompt(p, () => renderPromptCats(box));
    if (act === "new") { S.promptCat = c; editPrompt(null, () => { const last = S.prompts[S.prompts.length - 1]; if (last) { sel[last.category] = last.id; store.set("catSel", sel); } renderPromptCats(box); }); }
  })));
}
function toolCard([t, d, via, a]) {
  return `<div class="card tool" data-a="${a}"><span class="t">${t}</span><span class="d">${d}</span><span class="via">${via} ${a.startsWith("go:") ? "→" : "↗"}</span></div>`;
}
function act(a) {
  const [type, val] = [a.slice(0, a.indexOf(":")), a.slice(a.indexOf(":") + 1)];
  if (type === "go") location.hash = "#/" + val;
  if (type === "link") openLink(val);
  if (type === "app") openApp(val, "vrew_web");
}

/* ------------------------------------------------------------ 사진 → 영상 */
function viewPhoto(v) {
  const st = Object.assign({ items: [], name: "여행숏츠", ratio: "9:16", fit: "cover", seconds: 3, output: "one", transition: true, tpl: null }, store.get("photo", {}));
  const save = () => store.set("photo", st);
  const flowTpls = S.prompts.filter((p) => p.target === "flow" || p.category.includes("사진"));
  if (!flowTpls.find((p) => p.id === st.tpl)) st.tpl = flowTpls[0]?.id || null;

  const render = () => {
    save();
    const total = st.items.length * st.seconds;
    v.innerHTML = `
      <h1>사진 → 영상</h1>
      <p class="lead">사진을 올리고 두 가지 방법 중 하나로 움직이는 영상을 만들어요.</p>
      <div class="drop" id="drop" style="margin-top:18px"><b>사진을 여기로 끌어오거나 클릭</b><br><span class="faint">JPG·PNG·HEIC 모두 돼요 · 7장 정도 추천</span></div>
      ${st.items.length ? `<div class="row between" style="margin:18px 0 10px"><b>사진 ${st.items.length}장</b><button class="btn sm ghost danger" id="clear">모두 지우기</button></div>
      <div class="items">${st.items.map((it, i) => `<div class="item">
        <div class="media"><img src="${it.url}" alt=""><span class="idx">${i + 1}</span></div>
        <div class="body">
          <input type="text" data-memo="${i}" value="${esc(it.memo || "")}" placeholder="장면 메모 (예: 루프탑 수영장)">
          <select data-motion="${i}">${MOTIONS.map(([k, l]) => `<option value="${k}" ${k === (it.motion || "auto") ? "selected" : ""}>${l}</option>`).join("")}</select>
          <div class="row"><button class="btn sm" data-flow="${i}">플로우 프롬프트 복사</button><span style="flex:1"></span>
            <button class="btn sm ghost" data-up="${i}">↑</button><button class="btn sm ghost" data-down="${i}">↓</button><button class="btn sm ghost danger" data-del="${i}">✕</button></div>
        </div></div>`).join("")}</div>` : ""}

      <div class="grid g2" style="margin-top:22px;align-items:start">
        <div class="card stack">
          <div class="row between"><h3 style="margin:0">방법 A. 구글 플로우 (AI 움직임)</h3><span class="badge brand">자연스러움</span></div>
          <ol class="steps" style="margin:0">
            <li>사진마다 <b>플로우 프롬프트 복사</b>를 눌러요 (메모·움직임이 자동으로 들어가요)</li>
            <li>플로우에서 사진을 올리고 붙여넣기 → 영상 만들기 → 다운로드</li>
            <li>다운받은 영상을 <b>클립 합치기</b>에 올려 1~3개로 합쳐요</li></ol>
          <label class="f">사용할 프롬프트<select id="tpl">${flowTpls.map((p) => `<option value="${p.id}" ${p.id === st.tpl ? "selected" : ""}>${esc(p.title)}</option>`).join("") || "<option>프롬프트 보관함에 사진→영상 프롬프트를 추가해 주세요</option>"}</select></label>
          <div class="row"><button class="btn primary" id="openFlow">구글 플로우 열기 ↗</button><a class="btn" href="#/merge">클립 합치기 →</a><a class="btn ghost" href="#/prompts">프롬프트 수정</a></div>
        </div>
        <div class="card stack">
          <div class="row between"><h3 style="margin:0">방법 B. 무료로 바로 만들기</h3><span class="badge ok">몇 초면 끝</span></div>
          <p class="faint" style="margin:0">사진에 천천히 확대·이동하는 효과를 넣어요. AI가 아니라서 사진 속 물체가 움직이진 않아요.</p>
          <div class="grid g2">
            <label class="f">파일 이름<input type="text" id="name" value="${esc(st.name)}"></label>
            <label class="f">장당 길이 <span id="secL">${st.seconds}초</span><input type="range" id="sec" min="2" max="8" step="0.5" value="${st.seconds}"></label>
          </div>
          <label class="f">화면 비율<div class="seg" id="ratio">${["9:16", "4:5", "1:1", "16:9"].map((r) => `<button data-v="${r}" class="${st.ratio === r ? "on" : ""}">${r}</button>`).join("")}</div></label>
          <label class="f">사진 맞추기<div class="seg" id="fit"><button data-v="cover" class="${st.fit === "cover" ? "on" : ""}">꽉 채우기</button><button data-v="contain" class="${st.fit === "contain" ? "on" : ""}">전체 보이기 (흐린 배경)</button></div></label>
          <label class="f">결과<div class="seg" id="output"><button data-v="one" class="${st.output === "one" ? "on" : ""}">하나로 합치기</button><button data-v="three" class="${st.output === "three" ? "on" : ""}">숏튜브용 3개</button><button data-v="each" class="${st.output === "each" ? "on" : ""}">사진마다 따로</button></div></label>
          <label class="row" style="font-size:14px"><input type="checkbox" id="trans" ${st.transition ? "checked" : ""} ${st.output === "each" ? "disabled" : ""}> 사진 사이 부드럽게 전환</label>
          ${st.items.length ? `<p class="faint" style="margin:0">예상 길이 약 ${fmtSec(total)}${total > SHORTTUBE_MAX_SEC && st.output !== "each" ? ` · <span style="color:var(--warn)">숏튜브 한도(${SHORTTUBE_MAX_SEC}초)를 넘어요</span>` : ""}</p>` : ""}
          <button class="btn primary" id="make" ${st.items.length ? "" : "disabled"}>무료로 영상 만들기</button>
        </div>
      </div>
      <div id="job" style="margin-top:16px"></div>`;

    dropZone($("#drop", v), "image/*,.heic,.heif", async (files) => {
      try { const res = await uploadFiles(files.filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name)));
        res.forEach((r) => st.items.push({ id: r.id, url: r.url, name: r.name, memo: "", motion: "auto" })); render(); } catch (e) { fail(e); }
    });
    v.querySelectorAll("[data-memo]").forEach((el) => (el.oninput = () => { st.items[el.dataset.memo].memo = el.value; save(); }));
    v.querySelectorAll("[data-motion]").forEach((el) => (el.onchange = () => { st.items[el.dataset.motion].motion = el.value; save(); }));
    v.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => { moveItem(st.items, +b.dataset.up, -1); render(); }));
    v.querySelectorAll("[data-down]").forEach((b) => (b.onclick = () => { moveItem(st.items, +b.dataset.down, 1); render(); }));
    v.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { st.items.splice(+b.dataset.del, 1); render(); }));
    v.querySelectorAll("[data-flow]").forEach((b) => (b.onclick = () => {
      const p = S.prompts.find((x) => x.id === st.tpl);
      if (!p) return toast("프롬프트 보관함에 사진→영상 프롬프트를 추가해 주세요");
      const it = st.items[+b.dataset.flow];
      const cam = (MOTIONS.find((m) => m[0] === (it.motion || "auto")) || MOTIONS[0])[2];
      usePrompt(p, { preset: { "장면": it.memo || "the place in this photo", "카메라 움직임": cam } });
    }));
    $("#clear", v)?.addEventListener("click", () => { if (confirm("사진을 모두 지울까요?")) { st.items = []; render(); } });
    $("#tpl", v).onchange = (e) => { st.tpl = e.target.value; save(); };
    $("#openFlow", v).onclick = () => openLink("flow");
    $("#name", v).oninput = (e) => { st.name = e.target.value; save(); };
    $("#sec", v).oninput = (e) => { st.seconds = +e.target.value; $("#secL", v).textContent = st.seconds + "초"; save(); };
    $("#sec", v).onchange = () => render();
    ["ratio", "fit", "output"].forEach((k) => $("#" + k, v).querySelectorAll("button").forEach((b) => (b.onclick = (e) => { e.preventDefault(); st[k] = b.dataset.v; render(); })));
    $("#trans", v).onchange = (e) => { st.transition = e.target.checked; save(); };
    $("#make", v).onclick = () => runJob($("#job", v), "/api/jobs/photo-video", {
      name: st.name, ratio: st.ratio, fit: st.fit, seconds: st.seconds, output: st.output, transition: st.transition,
      photos: st.items.map((it) => ({ id: it.id, motion: it.motion || "auto" })),
    });
  };
  render();
}

/* ------------------------------------------------------------ 클립 합치기 */
function viewMerge(v, query) {
  const st = Object.assign({ items: [], name: "합친영상", groups: 1, ratio: "9:16", fit: "cover", max_seconds: 0, keep_audio: false, transition: false }, store.get("merge", {}));
  if (query.get("preset") === "daily") Object.assign(st, { max_seconds: 2, keep_audio: false, transition: false, name: "일상컷" });
  if (query.get("preset") === "vlog") Object.assign(st, { max_seconds: 0, keep_audio: true, transition: true, name: "브이로그" });
  if (query.get("preset")) history.replaceState(null, "", "#/merge");
  const save = () => store.set("merge", st);

  const render = () => {
    save();
    const used = st.items.map((it) => (st.max_seconds > 0 ? Math.min(it.duration || 0, st.max_seconds) : it.duration || 0));
    const total = used.reduce((a, b) => a + b, 0);
    v.innerHTML = `
      <h1>클립 합치기</h1>
      <p class="lead">여러 영상을 순서대로 이어 붙여요. 숏튜브 쇼핑숏츠는 영상 3개, 합계 ${SHORTTUBE_MAX_SEC}초까지 받아요.</p>
      <div class="drop" id="drop" style="margin-top:18px"><b>영상을 여기로 끌어오거나 클릭</b><br><span class="faint">플로우에서 받은 영상, 촬영한 영상(MOV·MP4) 모두 돼요</span></div>
      ${st.items.length ? `<div class="row between" style="margin:18px 0 10px"><b>영상 ${st.items.length}개 · 합계 ${fmtSec(total)}</b><button class="btn sm ghost danger" id="clear">모두 지우기</button></div>
      <div class="list">${st.items.map((it, i) => `<div class="vrow">
        <b class="faint" style="width:20px;text-align:right">${i + 1}</b>
        ${it.poster ? `<img class="thumb" src="${it.poster}" alt="">` : `<video src="${it.url}#t=0.3" muted preload="metadata" playsinline></video>`}
        <div class="meta"><div class="n">${esc(it.name)}</div><div class="faint">${fmtSec(it.duration || 0)}${st.max_seconds > 0 && it.duration > st.max_seconds ? ` → 앞 ${st.max_seconds}초만 사용` : ""}</div></div>
        <button class="btn sm ghost" data-up="${i}">↑</button><button class="btn sm ghost" data-down="${i}">↓</button><button class="btn sm ghost danger" data-del="${i}">✕</button>
      </div>`).join("")}</div>` : ""}
      <div class="card stack" style="margin-top:18px">
        <div class="grid g3">
          <label class="f">파일 이름<input type="text" id="name" value="${esc(st.name)}"></label>
          <label class="f">클립당 최대 길이 (초, 0 = 자르지 않음)<input type="number" id="maxs" min="0" step="0.5" value="${st.max_seconds}"></label>
          <label class="f">결과 개수<div class="seg" id="groups">${[1, 2, 3].map((g) => `<button data-v="${g}" class="${st.groups === g ? "on" : ""}">${g}개</button>`).join("")}</div></label>
        </div>
        <div class="row" style="gap:18px">
          <label class="f">화면 비율<div class="seg" id="ratio">${["9:16", "4:5", "1:1", "16:9"].map((r) => `<button data-v="${r}" class="${st.ratio === r ? "on" : ""}">${r}</button>`).join("")}</div></label>
          <label class="f">화면 맞추기<div class="seg" id="fit"><button data-v="cover" class="${st.fit === "cover" ? "on" : ""}">꽉 채우기</button><button data-v="contain" class="${st.fit === "contain" ? "on" : ""}">전체 보이기 (흐린 배경)</button></div></label>
        </div>
        <div class="row" style="gap:18px;font-size:14px">
          <label class="row"><input type="checkbox" id="audio" ${st.keep_audio ? "checked" : ""}> 원본 소리 유지</label>
          <label class="row"><input type="checkbox" id="trans" ${st.transition ? "checked" : ""}> 영상 사이 부드럽게 전환</label>
        </div>
        ${total > SHORTTUBE_MAX_SEC ? `<div class="notice warn">합계가 ${fmtSec(total)}라 숏튜브 한도(${SHORTTUBE_MAX_SEC}초)를 넘어요. 클립당 최대 길이를 줄여 보세요.</div>` : ""}
        <div class="row"><button class="btn primary" id="make" ${st.items.length ? "" : "disabled"}>합치기</button><span class="faint">쇼핑숏츠용이면 원본 소리는 빼는 게 좋아요 (숏튜브에서 목소리를 새로 넣어요)</span></div>
      </div>
      <div id="job" style="margin-top:16px"></div>`;

    dropZone($("#drop", v), "video/*,.mov,.mp4,.m4v", async (files) => {
      try { const res = await uploadFiles(files.filter((f) => /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name)));
        res.forEach((r) => st.items.push({ id: r.id, url: r.url, name: r.name, duration: r.duration, poster: r.poster })); render(); } catch (e) { fail(e); }
    });
    v.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => { moveItem(st.items, +b.dataset.up, -1); render(); }));
    v.querySelectorAll("[data-down]").forEach((b) => (b.onclick = () => { moveItem(st.items, +b.dataset.down, 1); render(); }));
    v.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { st.items.splice(+b.dataset.del, 1); render(); }));
    $("#clear", v)?.addEventListener("click", () => { if (confirm("영상을 모두 지울까요?")) { st.items = []; render(); } });
    $("#name", v).oninput = (e) => { st.name = e.target.value; save(); };
    $("#maxs", v).onchange = (e) => { st.max_seconds = Math.max(0, +e.target.value || 0); render(); };
    $("#groups", v).querySelectorAll("button").forEach((b) => (b.onclick = (e) => { e.preventDefault(); st.groups = +b.dataset.v; render(); }));
    ["ratio", "fit"].forEach((k) => $("#" + k, v).querySelectorAll("button").forEach((b) => (b.onclick = (e) => { e.preventDefault(); st[k] = b.dataset.v; render(); })));
    $("#audio", v).onchange = (e) => { st.keep_audio = e.target.checked; save(); };
    $("#trans", v).onchange = (e) => { st.transition = e.target.checked; save(); };
    $("#make", v).onclick = () => runJob($("#job", v), "/api/jobs/merge", {
      name: st.name, videos: st.items.map((it) => it.id), groups: st.groups, ratio: st.ratio, fit: st.fit,
      max_seconds: st.max_seconds, keep_audio: st.keep_audio, transition: st.transition,
    });
  };
  render();
}

/* ------------------------------------------------------------ 프롬프트 보관함 */
function viewPrompts(v) {
  const render = () => {
    const cats = ["전체", "★ 즐겨찾기", ...categories()];
    if (!cats.includes(S.promptCat)) S.promptCat = "전체";
    const q = S.promptQ.trim().toLowerCase();
    const list = S.prompts.filter((p) =>
      (S.promptCat === "전체" || (S.promptCat === "★ 즐겨찾기" ? p.pinned : p.category === S.promptCat)) &&
      (!q || (p.title + p.body + p.category).toLowerCase().includes(q)));
    v.innerHTML = `
      <div class="row between"><div><h1>프롬프트 보관함</h1><p class="lead">자주 쓰는 프롬프트를 저장해 두고 바로 복사해요. {빈칸}은 쓸 때마다 채워요.</p></div>
        <div class="row"><button class="btn" id="exp">백업 받기</button><button class="btn" id="imp">백업 불러오기</button><button class="btn primary" id="new">+ 새 프롬프트</button></div></div>
      <div class="row between" style="margin:20px 0 14px">
        <div class="chips">${cats.map((c) => `<button class="chip ${c === S.promptCat ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
        <input type="search" id="q" placeholder="검색" value="${esc(S.promptQ)}" style="max-width:240px">
      </div>
      <div class="grid g3" id="plist">${list.length ? list.map((p) => promptCard(p, { manage: true })).join("") : '<p class="muted">프롬프트가 없어요.</p>'}</div>`;
    v.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { S.promptCat = b.dataset.cat; render(); }));
    $("#q", v).oninput = (e) => { S.promptQ = e.target.value; const pos = e.target.selectionStart; render(); const q2 = $("#q", v); q2.focus(); q2.setSelectionRange(pos, pos); };
    $("#new", v).onclick = () => editPrompt(null, render);
    $("#exp", v).onclick = () => {
      const blob = new Blob([JSON.stringify(S.prompts, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `프롬프트백업_${new Date().toISOString().slice(0, 10)}.json`; a.click();
    };
    $("#imp", v).onclick = () => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
      inp.onchange = async () => {
        try {
          const items = JSON.parse(await inp.files[0].text());
          const replace = confirm("지금 있는 프롬프트를 지우고 바꿀까요?\n[취소]를 누르면 기존 것에 추가해요.");
          const r = await api("POST", "/api/prompts/import", { items, replace });
          S.prompts = await api("GET", "/api/prompts"); render(); toast(`${r.added}개 불러왔어요`);
        } catch (e) { fail(e); }
      };
      inp.click();
    };
    bindPromptCards($("#plist", v), render);
  };
  render();
}

/* ------------------------------------------------------------ 설정 */
async function viewSettings(v) {
  const health = await api("GET", "/api/health").catch(() => ({}));
  const st = S.settings, links = st.links;
  const fv = (st.fish_voices || []).slice();
  const render = () => {
    v.innerHTML = `
    <h1>설정</h1>
    <p class="lead">무료 AI 연결, 목소리, 멘트 프리셋, 바로가기 주소를 정해요. 키는 이 컴퓨터의 data 폴더에만 저장돼요.</p>
    <h2>🤖 무료 AI 연결</h2>
    <div class="card stack">
      <div><b>Gemini API 키 (무료)</b> <span class="faint">— 영상 자동 분석·대본 각색, Gemini 목소리에 써요</span></div>
      <div class="faint" style="font-size:13px"><a class="link" href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>에서 무료로 발급받아 붙여넣으세요. 무료 등급은 하루 사용량이 정해져 있고, 입력 내용이 구글 서비스 개선에 쓰일 수 있어요.</div>
      <div class="grid g2"><label class="f">API 키<input type="password" id="gk" value="${esc(st.gemini_key || "")}" placeholder="AIza…"></label>
        <label class="f">분석 모델<input type="text" id="gm" value="${esc(st.gemini_model || "gemini-2.5-flash")}"></label></div>
      <label class="f">목소리 모델<input type="text" id="gtm" value="${esc(st.gemini_tts_model || "gemini-2.5-flash-preview-tts")}"></label>
      <div class="hr"></div>
      <div><b>타입캐스트 API 키</b> <span class="faint">— 숏튜브가 쓰는 AI 성우</span></div>
      <div class="faint" style="font-size:13px"><a class="link" href="https://typecast.ai/developers/api/" target="_blank">타입캐스트 API 콘솔</a>에서 키를 만들어 넣으세요. 1글자에 1크레딧이고, 무료 플랜은 매달 정해진 크레딧만 쓸 수 있어요. 무료 플랜 음성은 상업적 이용 불가·출처 표기 필요라고 안내돼 있으니 쇼핑숏츠에 쓸 때는 유료 플랜 조건을 확인하세요.</div>
      <div class="grid g2"><label class="f">API 키<input type="password" id="tk" value="${esc(st.typecast_key || "")}"></label>
        <label class="f">모델<select id="tm"><option value="ssfm-v30" ${st.typecast_model !== "ssfm-v21" ? "selected" : ""}>ssfm-v30 (최신, 감정 7가지)</option><option value="ssfm-v21" ${st.typecast_model === "ssfm-v21" ? "selected" : ""}>ssfm-v21 (예전 모델)</option></select></label></div>
      <div class="row"><button class="btn sm" id="tcRefresh">타입캐스트 목소리 목록 새로고침</button><span class="faint" id="tcInfo"></span></div>
      <div class="hr"></div>
      <div><b>Fish Audio API 키 (무료 모델)</b> <span class="faint">— 내가 만든 목소리 모델을 쓸 때</span></div>
      <div class="faint" style="font-size:13px"><a class="link" href="https://fish.audio/" target="_blank">fish.audio</a> 개발자 메뉴에서 API 키를 만들어 넣으세요. 모델은 무료인 <b>s2.1-pro-free</b>로 둬요.</div>
      <div class="grid g2"><label class="f">API 키<input type="password" id="fk" value="${esc(st.fish_key || "")}"></label>
        <label class="f">모델<input type="text" id="fm" value="${esc(st.fish_model || "s2.1-pro-free")}"></label></div>
      <b style="font-size:14px">내 Fish Audio 목소리 목록</b>
      <div class="faint" style="font-size:13px">목소리 페이지 주소의 ID(예: 802e3bc2b27e49c2995d23ef70e6ac89)를 넣어요.</div>
      <div class="stack" id="fvList">${fv.map((x, i) => `<div class="row" style="flex-wrap:nowrap"><input type="text" data-fvn="${i}" value="${esc(x.name)}" placeholder="이름" style="max-width:160px">
        <input type="text" data-fvi="${i}" value="${esc(x.id)}" placeholder="목소리 ID"><select data-fvg="${i}" style="max-width:100px"><option value="female" ${x.gender !== "male" ? "selected" : ""}>여성</option><option value="male" ${x.gender === "male" ? "selected" : ""}>남성</option></select>
        <button class="btn sm ghost danger" data-fvx="${i}">✕</button></div>`).join("")}</div>
      <div><button class="btn sm" id="fvAdd">+ 목소리 추가</button></div>
    </div>
    <h2>🎬 오프닝·아웃트로 멘트 프리셋</h2>
    <div class="card grid g2">
      <label class="f">오프닝 멘트 (한 줄에 하나)<textarea id="opP" rows="5">${esc((st.opening_presets || []).join("\n"))}</textarea></label>
      <label class="f">아웃트로 멘트 (한 줄에 하나)<textarea id="otP" rows="5">${esc((st.outro_presets || []).join("\n"))}</textarea></label>
    </div>
    <h2>🔗 바로가기 주소</h2>
    <p class="faint" style="margin:-4px 0 10px">숏튜브에서 각 기능 페이지를 연 뒤 주소창 주소를 복사해 넣으면 버튼이 그 화면으로 바로 열려요.</p>
    <div class="card"><div class="kv">
      ${Object.keys(LINK_LABELS).map((k) => `<label for="l_${k}" style="font-size:14px;font-weight:600">${LINK_LABELS[k]}</label><input type="text" id="l_${k}" data-link="${k}" value="${esc(links[k] || "")}">`).join("")}
    </div></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end;position:sticky;bottom:12px"><button class="btn primary big" id="saveS">설정 저장</button></div>
    <h2>상태</h2>
    <div class="card stack">
      <div class="row">${health.ffmpeg ? '<span class="badge ok">ffmpeg 준비됨</span>' : '<span class="badge warn">ffmpeg 없음 · 터미널에서 brew install ffmpeg</span>'}</div>
      <div class="faint">결과 저장 위치: ${esc(health.outputs || "")}</div>
      <div><button class="btn sm" id="folder">결과 폴더 열기</button></div>
    </div>`;
    const sync = () => {
      v.querySelectorAll("[data-fvn]").forEach((el) => (fv[+el.dataset.fvn].name = el.value));
      v.querySelectorAll("[data-fvi]").forEach((el) => (fv[+el.dataset.fvi].id = el.value));
      v.querySelectorAll("[data-fvg]").forEach((el) => (fv[+el.dataset.fvg].gender = el.value));
    };
    $("#fvAdd", v).onclick = () => { sync(); fv.push({ name: "", id: "", gender: "female" }); render(); };
    v.querySelectorAll("[data-fvx]").forEach((b) => (b.onclick = () => { sync(); fv.splice(+b.dataset.fvx, 1); render(); }));
    $("#saveS", v).onclick = async () => {
      sync();
      const data = { links: {}, gemini_key: $("#gk", v).value, gemini_model: $("#gm", v).value, gemini_tts_model: $("#gtm", v).value,
        typecast_key: $("#tk", v).value, typecast_model: $("#tm", v).value,
        fish_key: $("#fk", v).value, fish_model: $("#fm", v).value, fish_voices: fv,
        opening_presets: $("#opP", v).value.split("\n"), outro_presets: $("#otP", v).value.split("\n") };
      v.querySelectorAll("[data-link]").forEach((el) => (data.links[el.dataset.link] = el.value));
      try { S.settings = await api("PUT", "/api/settings", data); toast("저장했어요"); } catch (e) { fail(e); }
    };
    $("#folder", v).onclick = () => api("POST", "/api/reveal", { file: "" }).catch(fail);
    $("#tcRefresh", v).onclick = async () => {
      $("#tcInfo", v).textContent = "저장하고 목록을 받는 중…";
      try { await $("#saveS", v).onclick(); const r = await api("POST", "/api/typecast/refresh"); $("#tcInfo", v).textContent = `목소리 ${r.count}개를 받았어요`; }
      catch (e) { $("#tcInfo", v).textContent = e.message; }
    };
  };
  render();
}

/* ------------------------------------------------------------ 라우터 */
async function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, qs] = raw.split("?");
  const query = new URLSearchParams(qs || "");
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.route === name));
  if (S.prompts.length === 0 || name === "" || name === "make") S.prompts = await api("GET", "/api/prompts").catch(() => S.prompts);
  const v = $("#view");
  window.scrollTo(0, 0);
  try { window.__leave?.(); } catch {}
  window.__leave = null;
  document.body.classList.toggle("wide-main", name === "make");
  try {
    if (name === "make") await viewMaker(v, query);
    else if (name === "photo") viewPhoto(v);
    else if (name === "merge") viewMerge(v, query);
    else if (name === "prompts") viewPrompts(v);
    else if (name === "settings") await viewSettings(v);
    else await viewDashboard(v);
  } catch (e) { v.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
}
async function init() {
  try { [S.settings, S.prompts] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/prompts")]); }
  catch (e) { $("#view").innerHTML = `<div class="notice bad">서버에 연결하지 못했어요. 터미널에서 서버가 켜져 있는지 확인해 주세요.<br>${esc(e.message)}</div>`; return; }
  document.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openLink(b.dataset.open)));
  window.addEventListener("hashchange", route);
  route();
}
init();
