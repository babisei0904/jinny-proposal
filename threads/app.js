import { parseKakao, templateHooks, won } from "./parse.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "tp_settings_v1";
const HISTORY_KEY = "tp_history_v1";
const MAX_PHOTOS = 2;

const DEFAULTS = {
  worker: "",
  key: "",
  discToss: "이 게시물은 토스쇼핑 쉐어링크를 통해 일정액의 수수료를 받을 수 있어요.",
  discCoupang: "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.",
  discEtc: "이 게시물은 제휴 링크를 포함하며, 구매 시 일정액의 수수료를 받을 수 있어요.",
  linkPrefix: "👉 구매 링크",
  autoOg: true,
};

// ---------- 저장소 (사생활 모드 등에서 실패해도 동작하게) ----------
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let settings = { ...DEFAULTS, ...store.get(SETTINGS_KEY, {}) };
let status = { threads: false, ai: false, coupang: false };
const state = {
  parsed: null,
  store: "toss",
  photos: [], // { blob, preview, source }
  replyDirty: false,
  selectedHook: -1,
};

// ---------- 공통 ----------
let toastTimer;
function toast(msg, ms = 2600, html = false) {
  const t = $("toast");
  t[html ? "innerHTML" : "textContent"] = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

const hasServer = () => Boolean(settings.worker && settings.key);

async function api(path, { method = "POST", body, headers = {} } = {}) {
  if (!hasServer()) throw new Error("설정에서 서버 주소와 비밀번호를 먼저 입력해주세요");
  const isJson = body && !(body instanceof Blob);
  const res = await fetch(settings.worker.replace(/\/$/, "") + path, {
    method,
    headers: { "X-App-Key": settings.key, ...(isJson ? { "Content-Type": "application/json" } : {}), ...headers },
    body: isJson ? JSON.stringify(body) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
  return data;
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    toast("붙여넣기 권한이 없어요. 칸을 길게 눌러 붙여넣어 주세요.");
    return "";
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ---------- 1. 원문 파싱 + 후킹 문구 ----------
function renderParsed(p) {
  const el = $("parsed");
  const chips = [];
  if (p.productName) chips.push(`<span>🛒 ${esc(p.productName)}</span>`);
  if (p.price) chips.push(`<span>💰 ${won(p.price)}</span>`);
  if (p.unitPrice) chips.push(`<span>📦 개당 ${won(p.unitPrice)}</span>`);
  chips.push(p.link ? `<span>🔗 ${p.store === "toss" ? "토스쇼핑" : p.store === "coupang" ? "쿠팡" : "링크"}</span>` : `<span class="warn">링크 없음</span>`);
  el.innerHTML = chips.join("");
  el.hidden = false;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderHooks(hooks, loading = false) {
  const box = $("hooks");
  box.innerHTML = "";
  hooks.forEach((h, i) => {
    const b = document.createElement("button");
    b.className = "hook" + (i === state.selectedHook ? " sel" : "");
    b.textContent = h;
    b.onclick = () => selectHook(i, h);
    box.appendChild(b);
  });
  if (loading) {
    const l = document.createElement("div");
    l.className = "loading";
    l.textContent = "✨ AI가 지니 말투로 다시 쓰는 중…";
    box.appendChild(l);
  }
}

function selectHook(i, text) {
  state.selectedHook = i;
  $("body").value = text;
  updateCounts();
  document.querySelectorAll(".hook").forEach((el, j) => el.classList.toggle("sel", j === i));
}

async function make() {
  const raw = $("raw").value.trim();
  if (!raw) return toast("카톡 원문을 붙여넣어 주세요");
  const p = parseKakao(raw);
  state.parsed = p;
  renderParsed(p);
  setStore(p.store || "toss");
  updateOrigLink();

  const bodyUntouched = !$("body").value.trim() || state.selectedHook >= 0;
  const tpl = templateHooks(p);
  state.selectedHook = -1;
  renderHooks(tpl, status.ai);
  if (bodyUntouched) selectHook(0, tpl[0]);

  if (settings.autoOg && state.photos.length === 0 && p.link && hasServer()) fetchOg(true);

  if (status.ai) {
    $("btnMake").disabled = true;
    try {
      const { hooks } = await api("/api/generate", { body: { raw } });
      if (hooks?.length) {
        state.selectedHook = -1;
        renderHooks(hooks);
        if (bodyUntouched) selectHook(0, hooks[0]);
      }
    } catch (e) {
      renderHooks(tpl);
      toast(`AI 문구 실패 — 기본 문구를 쓸게요\n${e.message}`);
    } finally {
      $("btnMake").disabled = false;
    }
  }
}

// ---------- 3. 사진 ----------
function renderPhotos() {
  const box = $("photos");
  box.innerHTML = "";
  state.photos.forEach((ph, i) => {
    const d = document.createElement("div");
    d.className = "photo";
    d.innerHTML = `<img alt=""><span class="badge">${ph.source === "og" ? "상품 이미지" : `사진 ${i + 1}`}</span><button aria-label="삭제">✕</button>`;
    d.querySelector("img").src = ph.preview;
    d.querySelector("button").onclick = () => {
      URL.revokeObjectURL(ph.preview);
      state.photos.splice(i, 1);
      renderPhotos();
    };
    box.appendChild(d);
  });
}

// 쓰레드는 JPEG/PNG만 받으므로 폰에서 JPEG(최대 1440px)로 변환
async function toJpeg(blob) {
  let src;
  try {
    src = await createImageBitmap(blob);
  } catch {
    src = await new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => fail(new Error("이미지를 읽지 못했어요"));
      img.src = URL.createObjectURL(blob);
    });
  }
  const w = src.width, h = src.height;
  const scale = Math.min(1, 1440 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.88));
}

async function addPhoto(blob, source) {
  if (state.photos.length >= MAX_PHOTOS) return toast(`사진은 ${MAX_PHOTOS}장까지예요`);
  const jpeg = await toJpeg(blob);
  state.photos.push({ blob: jpeg, preview: URL.createObjectURL(jpeg), source });
  renderPhotos();
}

async function fetchOg(silent = false) {
  const link = state.parsed?.link;
  if (!link) return silent || toast("원문에 링크가 없어요");
  if (state.photos.some((p) => p.source === "og")) return silent || toast("이미 상품 이미지를 넣었어요");
  $("btnOg").disabled = true;
  try {
    const { imageUrl } = await api("/api/og", { body: { url: link } });
    const blob = await (await fetch(imageUrl)).blob();
    await addPhoto(blob, "og");
  } catch (e) {
    if (!silent) toast(e.message);
  } finally {
    $("btnOg").disabled = false;
  }
}

// ---------- 4. 댓글 ----------
function setStore(s) {
  state.store = s;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.store === s));
  $("btnConvert").hidden = !(s === "coupang" && status.coupang);
  const hints = {
    toss: "‘원본 상품 열기’ → 토스 앱에서 공유 → 링크 복사 → 📋 를 누르세요.",
    coupang: status.coupang
      ? "‘쿠팡 내 링크로 변환’을 누르면 내 파트너스 링크로 자동 교체돼요."
      : "쿠팡 파트너스에서 내 링크를 만들어 📋 로 붙여넣으세요.",
    etc: "내 제휴 링크를 붙여넣으세요.",
  };
  $("linkHint").textContent = hints[s];
  composeReply();
}

function updateOrigLink() {
  const a = $("btnOpenOrig");
  const link = state.parsed?.link;
  a.href = link || "#";
  a.style.display = link ? "" : "none";
}

function composeReply(force = false) {
  if (state.replyDirty && !force) return checkLink();
  const disc = { toss: settings.discToss, coupang: settings.discCoupang, etc: settings.discEtc }[state.store];
  const link = $("myLink").value.trim();
  $("reply").value = [disc, link ? `${settings.linkPrefix}\n${link}` : ""].filter(Boolean).join("\n\n");
  state.replyDirty = false;
  updateCounts();
  checkLink();
}

function checkLink() {
  const mine = $("myLink").value.trim();
  const orig = state.parsed?.link;
  const hint = $("linkHint");
  hint.style.color = "";
  if (mine && orig && mine === orig) {
    hint.textContent = "⚠️ 아직 방장 링크예요! 내 쉐어링크로 바꿔주세요.";
    hint.style.color = "var(--bad)";
  }
}

async function convertCoupang() {
  const link = state.parsed?.link || $("myLink").value.trim();
  if (!link) return toast("변환할 쿠팡 링크가 없어요");
  $("btnConvert").disabled = true;
  try {
    const { url } = await api("/api/convert", { body: { url: link } });
    $("myLink").value = url;
    composeReply();
    toast("내 파트너스 링크로 바꿨어요 ✅");
  } catch (e) {
    toast(e.message);
  } finally {
    $("btnConvert").disabled = false;
  }
}

// ---------- 발행 ----------
function updateCounts() {
  for (const [field, counter] of [["body", "bodyCount"], ["reply", "replyCount"]]) {
    const n = [...$(field).value].length;
    $(counter).textContent = n;
    $(counter).parentElement.classList.toggle("over", n > 500);
  }
}

async function publish() {
  const text = $("body").value.trim();
  const replyText = $("reply").value.trim();
  const mine = $("myLink").value.trim();
  if (!text) return toast("본문을 써주세요");
  if ([...text].length > 500 || [...replyText].length > 500) return toast("500자를 넘었어요");
  if (!hasServer()) {
    toast("설정에서 서버를 연결해주세요.\n지금은 ‘앱으로 열기’만 쓸 수 있어요.");
    return openSettings();
  }
  if (!mine && !confirm("댓글에 내 링크가 없어요. 그래도 올릴까요?")) return;
  if (mine && mine === state.parsed?.link && !confirm("댓글 링크가 방장 링크 그대로예요. 그래도 올릴까요?")) return;

  const btn = $("btnPublish");
  btn.disabled = true;
  try {
    const images = [];
    for (let i = 0; i < state.photos.length; i++) {
      btn.textContent = `📤 사진 올리는 중 (${i + 1}/${state.photos.length})`;
      const { url } = await api("/api/upload", { body: state.photos[i].blob, headers: { "Content-Type": "image/jpeg" } });
      images.push(url);
    }
    btn.textContent = "🧵 쓰레드에 올리는 중…";
    const res = await api("/api/publish", { body: { text, images, replyText } });
    addHistory(text, res.permalink);
    const link = res.permalink ? `<a href="${esc(res.permalink)}" target="_blank" rel="noopener">게시물 보기 ↗︎</a>` : "";
    if (res.replyError) {
      await copy(replyText);
      toast(`본문은 올라갔지만 댓글 실패 😢\n댓글은 복사해뒀어요. 직접 달아주세요.<br>${link}`, 0, true);
    } else {
      toast(`발행 완료! 🎉 ${link}`, 8000, true);
    }
  } catch (e) {
    toast(`발행 실패: ${e.message}`, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 쓰레드에 발행";
  }
}

// 서버 없이: 쓰레드 앱에 본문만 채워서 열고, 댓글은 클립보드로
async function openIntent() {
  const text = $("body").value.trim();
  if (!text) return toast("본문을 써주세요");
  const copied = await copy($("reply").value.trim());
  window.open(`https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`, "_blank");
  if (copied) toast("댓글 문구는 복사해뒀어요. 올린 뒤 댓글에 붙여넣으세요.");
}

function addHistory(text, permalink) {
  const list = store.get(HISTORY_KEY, []);
  list.unshift({ t: Date.now(), text: text.split("\n")[0].slice(0, 40), permalink });
  store.set(HISTORY_KEY, list.slice(0, 10));
  renderHistory();
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  $("history").hidden = list.length === 0;
  $("historyList").innerHTML = list
    .map((h) => {
      const d = new Date(h.t);
      const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const label = esc(h.text);
      return `<li><time>${time}</time>${h.permalink ? `<a href="${esc(h.permalink)}" target="_blank" rel="noopener">${label}</a>` : label}</li>`;
    })
    .join("");
}

function reset() {
  $("raw").value = "";
  $("body").value = "";
  $("myLink").value = "";
  $("parsed").hidden = true;
  $("hooks").innerHTML = "";
  state.photos.forEach((p) => URL.revokeObjectURL(p.preview));
  Object.assign(state, { parsed: null, photos: [], replyDirty: false, selectedHook: -1 });
  renderPhotos();
  updateOrigLink();
  composeReply(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("raw").focus();
}

// ---------- 설정 ----------
const FIELDS = { sWorker: "worker", sKey: "key", sDiscToss: "discToss", sDiscCoupang: "discCoupang", sDiscEtc: "discEtc", sLinkPrefix: "linkPrefix" };

function openSettings() {
  for (const [id, k] of Object.entries(FIELDS)) $(id).value = settings[k];
  $("sAutoOg").checked = settings.autoOg;
  $("testResult").textContent = "";
  $("settings").showModal();
}

function readSettingsForm() {
  const s = { ...settings };
  for (const [id, k] of Object.entries(FIELDS)) s[k] = $(id).value.trim();
  s.autoOg = $("sAutoOg").checked;
  return s;
}

async function checkStatus() {
  const conn = $("conn");
  if (!hasServer()) {
    conn.className = "conn";
    conn.title = "서버 미연결";
    return null;
  }
  try {
    status = await api("/api/status", { method: "GET" });
    conn.className = status.threads ? "conn ok" : "conn bad";
    conn.title = status.threads ? `@${status.threadsUser} 연결됨` : "쓰레드 토큰 확인 필요";
  } catch (e) {
    conn.className = "conn bad";
    conn.title = e.message;
    status = { threads: false, ai: false, coupang: false };
  }
  setStore(state.store);
  return status;
}

// ---------- 이벤트 ----------
$("btnPasteRaw").onclick = async () => {
  const t = await readClipboard();
  if (t) { $("raw").value = t; make(); }
};
$("raw").addEventListener("paste", () => setTimeout(make, 0));
$("btnMake").onclick = make;
$("btnReset").onclick = reset;
$("body").addEventListener("input", () => { state.selectedHook = -1; document.querySelectorAll(".hook").forEach((el) => el.classList.remove("sel")); updateCounts(); });
$("reply").addEventListener("input", () => { state.replyDirty = true; updateCounts(); });
$("myLink").addEventListener("input", () => composeReply());
$("btnPasteLink").onclick = async () => {
  const t = (await readClipboard()).trim();
  const m = t.match(/https?:\/\/\S+/);
  if (m) { $("myLink").value = m[0]; composeReply(); }
  else if (t) toast("클립보드에 링크가 없어요");
};
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setStore(t.dataset.store)));
$("btnConvert").onclick = convertCoupang;
$("filePick").onchange = async (e) => {
  for (const f of [...e.target.files]) await addPhoto(f, "upload").catch((err) => toast(err.message));
  e.target.value = "";
};
$("btnOg").onclick = () => fetchOg(false);
$("btnPublish").onclick = publish;
$("btnIntent").onclick = openIntent;
$("btnSettings").onclick = openSettings;
$("btnTest").onclick = async () => {
  const prev = settings;
  settings = readSettingsForm();
  const r = $("testResult");
  r.textContent = "확인 중…";
  const s = await checkStatus();
  settings = prev;
  r.textContent = !s
    ? `❌ 연결 실패: ${$("conn").title}`
    : `${s.threads ? `✅ 쓰레드 @${s.threadsUser}` : "❌ 쓰레드 토큰 없음/만료"} · ${s.ai ? "✅ AI 문구" : "— AI 미설정"} · ${s.coupang ? "✅ 쿠팡 변환" : "— 쿠팡 미설정"}`;
};
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  settings = readSettingsForm();
  store.set(SETTINGS_KEY, settings);
  composeReply(true);
  checkStatus();
  toast("저장했어요");
});

// ---------- 시작 ----------
async function init() {
  updateOrigLink();
  composeReply(true);
  renderHistory();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  await checkStatus();

  // 안드로이드: 카톡에서 ‘공유 → 핫딜발행’으로 바로 들어온 경우
  const q = new URLSearchParams(location.search);
  const shared = [q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n");
  if (shared) {
    $("raw").value = shared;
    history.replaceState(null, "", location.pathname);
    make();
  }
  if (!hasServer()) toast("⚙︎ 설정에서 서버를 연결하면 바로 발행돼요", 4000);
}
init();
