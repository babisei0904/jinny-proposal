// 쓰레드 자동발행 백엔드 (Cloudflare Worker)
// - 비밀값(쓰레드 토큰, Claude API 키, 쿠팡 파트너스 키)은 여기에만 보관하고 폰 앱에는 두지 않는다.
// - 모든 /api/* 요청은 X-App-Key 헤더(APP_PASSWORD)로 보호한다.
import Anthropic from "@anthropic-ai/sdk";

const GRAPH = "https://graph.threads.net/v1.0";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-App-Key",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    try {
      // 이미지 서빙은 공개 (쓰레드 서버가 가져가야 함)
      const img = url.pathname.match(/^\/img\/([a-z0-9]+)(\.jpg)?$/);
      if (img && req.method === "GET") return serveImage(env, img[1]);

      if (!url.pathname.startsWith("/api/")) return json({ ok: true, name: "threads-autopost" });

      if (!env.APP_PASSWORD || req.headers.get("X-App-Key") !== env.APP_PASSWORD) {
        throw new HttpError(401, "앱 비밀번호가 맞지 않아요");
      }

      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/status":
          return json(await status(env));
        case "POST /api/generate":
          return json(await generate(env, await req.json()));
        case "POST /api/upload":
          return json(await upload(env, req, url));
        case "POST /api/og":
          return json(await ogImage(env, (await req.json()).url, url));
        case "POST /api/convert":
          return json(await convertLink(env, (await req.json()).url));
        case "POST /api/publish":
          return json(await publish(env, await req.json()));
        case "POST /api/refresh-token":
          return json(await refreshToken(env));
        default:
          throw new HttpError(404, "없는 경로예요");
      }
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },

  // 장기 토큰(60일)이 만료되지 않도록 주기적으로 갱신
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshToken(env).catch((e) => console.log("refresh failed", e.message)));
  },
};

// ---------- 상태 ----------

async function status(env) {
  const token = await getToken(env).catch(() => null);
  let threadsUser = null;
  if (token) {
    const r = await fetch(`${GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
    const d = await r.json();
    threadsUser = d.username || null;
  }
  return {
    threads: Boolean(threadsUser),
    threadsUser,
    ai: Boolean(env.ANTHROPIC_API_KEY),
    coupang: Boolean(env.COUPANG_ACCESS_KEY && env.COUPANG_SECRET_KEY),
    toss: Boolean(env.TOSS_ACCESS_KEY && env.TOSS_SECRET_KEY && env.TOSS_PUBLISHER_ID),
  };
}

// ---------- 후킹 문구 생성 (Claude) ----------

const HOOK_SYSTEM = `너는 스레드(Threads)에서 핫딜/특가 정보를 올리는 인플루언서 "지니"의 카피라이터야.
카톡 핫딜방에 올라온 원문을 받아서, 스레드 본문에 올릴 짧은 후킹 문구를 만든다.

지니 말투 예시:
- "쿠팡보다 싼데,\\n심지어 가격역주행중 순삭 품절이다!\\n달려라달려 !!!!"
- "생수 개당 147원꼴 떴어!🔥\\n외출할 때 부담없이 하나씩 챙기기 좋아\\n특가 떴을 때 서둘러‼️"

규칙:
- 친구한테 말하듯 반말, 2~4줄, 줄마다 짧게. 전체 120자 이내.
- 첫 줄에서 바로 눈길을 끌 것: 가격 충격, 개당 단가, 품절 임박, "이 가격 실화?" 같은 감탄.
- 개수/용량 정보가 있으면 개당(또는 1장·1롤당) 단가를 계산해서 활용해도 좋다. 계산은 정확하게.
- 이모지는 1~3개만 (🔥‼️🚨😳💸 등).
- 링크, 해시태그, "광고", "수수료", "쉐어링크", "파트너스" 같은 말은 절대 넣지 마. (그건 댓글에 따로 단다)
- 원문에 없는 효능·후기·가격을 지어내지 마.
- 서로 다른 각도(가격 충격 / 실사용 공감 / 긴급함)로 3개를 만든다.`;

const HOOK_SCHEMA = {
  type: "object",
  properties: {
    productName: { type: "string", description: "짧게 다듬은 상품명" },
    hooks: { type: "array", items: { type: "string" }, description: "후킹 문구 3개" },
  },
  required: ["productName", "hooks"],
  additionalProperties: false,
};

async function generate(env, { raw }) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(400, "ANTHROPIC_API_KEY가 설정되지 않았어요");
  if (!raw || !raw.trim()) throw new HttpError(400, "원문이 비어 있어요");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low", // 빠른 응답이 중요해서 low
      format: { type: "json_schema", schema: HOOK_SCHEMA },
    },
    system: HOOK_SYSTEM,
    messages: [{ role: "user", content: `카톡 원문:\n"""\n${raw.slice(0, 3000)}\n"""` }],
  });

  if (res.stop_reason === "refusal") throw new HttpError(502, "AI가 문구 생성을 거절했어요. 직접 써주세요.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const data = JSON.parse(text);
  return { productName: data.productName, hooks: (data.hooks || []).slice(0, 3) };
}

// ---------- 이미지 ----------

const randId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

async function putImage(env, bytes, contentType, ttl) {
  const id = randId();
  await env.IMAGES.put(id, bytes, { expirationTtl: ttl, metadata: { contentType } });
  return id;
}

async function serveImage(env, id) {
  const { value, metadata } = await env.IMAGES.getWithMetadata(id, { type: "arrayBuffer" });
  if (!value) return new Response("not found", { status: 404, headers: CORS });
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      ...CORS,
    },
  });
}

// 폰에서 JPEG로 변환·리사이즈한 사진을 받아 공개 URL로 돌려준다 (쓰레드 API는 image_url만 받음)
async function upload(env, req, url) {
  const type = req.headers.get("Content-Type") || "";
  if (!/^image\/(jpeg|png)$/.test(type)) throw new HttpError(400, "JPEG/PNG만 올릴 수 있어요");
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 8 * 1024 * 1024) throw new HttpError(400, "사진이 너무 커요 (8MB 이하)");
  const id = await putImage(env, bytes, type, 7 * 24 * 3600);
  return { url: `${url.origin}/img/${id}.jpg` };
}

// 상품 링크의 대표 이미지(og:image)를 가져와 임시로 보관 → 폰에서 JPEG로 변환 후 다시 업로드
async function ogImage(env, link, url) {
  if (!/^https?:\/\//.test(link || "")) throw new HttpError(400, "링크가 올바르지 않아요");
  const page = await fetch(link, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR" }, redirect: "follow" });
  const html = await page.text();
  const pick = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
      "i",
    );
    const m = html.match(re);
    return m ? decodeEntities(m[1] || m[2]) : null;
  };
  let image = pick("og:image") || pick("twitter:image");
  if (!image) throw new HttpError(404, "상품 이미지를 찾지 못했어요. 캡처 사진을 올려주세요.");
  image = new URL(image, page.url).href;

  const imgRes = await fetch(image, { headers: { "User-Agent": UA, Referer: page.url } });
  if (!imgRes.ok) throw new HttpError(502, "상품 이미지를 받지 못했어요");
  const id = await putImage(env, await imgRes.arrayBuffer(), imgRes.headers.get("Content-Type") || "image/jpeg", 3600);
  return { imageUrl: `${url.origin}/img/${id}`, title: pick("og:title") };
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---------- 내 링크로 변환 ----------

async function convertLink(env, link) {
  if (/toss\.(shopping|im)/i.test(link || "")) return convertToss(env, link);
  if (/coupang\.com|coupa\.ng/i.test(link || "")) return convertCoupang(env, link);
  throw new HttpError(400, "토스쇼핑/쿠팡 링크만 변환할 수 있어요");
}

// ---------- 토스쇼핑 쉐어링크 Open API ----------
// 문서: https://sharelink-docs.toss.im/developers/open-api.md
// 토스는 등록된 고정 출발지 IP에서만 호출을 허용한다. Cloudflare Worker는 출발지 IP가 고정되지 않으므로
// TOSS_PROXY_URL(고정 IP 서버에서 돌리는 toss-proxy)을 거쳐 호출한다.

function tossUrl(env, path) {
  if (env.TOSS_PROXY_URL) return env.TOSS_PROXY_URL.replace(/\/$/, "") + path;
  return path === "/token" ? "https://oauth2.cert.toss.im/token" : `https://sharelink.toss.im${path}`;
}

function tossFetch(env, path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (env.TOSS_PROXY_URL) headers["X-Proxy-Key"] = env.TOSS_PROXY_KEY || "";
  return fetch(tossUrl(env, path), { ...init, headers });
}

// 토큰은 유효기간(약 1년) 동안 재사용해야 한다 — 매번 발급하면 이용이 제한될 수 있음
async function getTossToken(env) {
  const cached = await env.IMAGES.get("__toss_token", { type: "json" });
  if (cached && cached.exp > Date.now() + 86400_000) return cached.token;
  const r = await tossFetch(env, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TOSS_ACCESS_KEY,
      client_secret: env.TOSS_SECRET_KEY,
      scope: "sharelink:read sharelink:write",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new HttpError(502, `토스 토큰 발급 실패 (${r.status})`);
  await env.IMAGES.put("__toss_token", JSON.stringify({ token: d.access_token, exp: Date.now() + d.expires_in * 1000 }));
  return d.access_token;
}

async function tossApi(env, path, init = {}) {
  const token = await getTossToken(env);
  const r = await tossFetch(env, path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (d.resultType !== "SUCCESS") {
    const code = d.error?.errorCode;
    const msg =
      code === "SHARELINK_OPENAPI_ACCESS_DENIED"
        ? "토스가 접근을 거부했어요 (출발지 IP 등록 또는 키 확인)"
        : code === "SHARELINK_OPENAPI_QUOTA_EXCEEDED"
          ? "오늘 토스 API 한도를 다 썼어요"
          : d.error?.reason || `HTTP ${r.status}`;
    throw new HttpError(502, `토스 링크 발급 실패: ${msg}`);
  }
  return d.success;
}

// 방장 링크(toss.shopping/_m/xxx) → 상품 페이지(toss.shopping/t/{tacaId}) 로 풀어서 상품 그룹 ID를 얻는다
async function resolveTacaId(link) {
  let current = link;
  for (let i = 0; i < 5; i++) {
    const m = current.match(/toss\.shopping\/t\/(\d+)/);
    if (m) return Number(m[1]);
    const r = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = r.headers.get("Location");
    if (!loc) break;
    current = new URL(loc, current).href;
  }
  throw new HttpError(400, "토스 상품 번호를 찾지 못했어요");
}

async function convertToss(env, link) {
  if (!env.TOSS_ACCESS_KEY || !env.TOSS_SECRET_KEY || !env.TOSS_PUBLISHER_ID) {
    throw new HttpError(400, "토스 쉐어링크 API 키가 설정되지 않았어요");
  }
  const tacaId = await resolveTacaId(link);
  // 같은 상품은 저장해 둔 링크를 재사용 (문서 권장, 일 발급 한도 절약)
  const cacheKey = `__toss_link_${tacaId}`;
  const cached = await env.IMAGES.get(cacheKey, { type: "json" });
  if (cached) return cached;

  const issued = await tossApi(env, "/openapi/links", {
    method: "POST",
    body: JSON.stringify({ landingType: "PRODUCT", tacaId, publisherId: env.TOSS_PUBLISHER_ID }),
  });

  // 링크가 어떤 옵션으로 발급됐는지 확인용 (원문의 옵션과 다를 수 있음)
  let option = null;
  try {
    const detail = await tossApi(env, `/openapi/products/detail?tacaItemIds=${issued.tacaItemId}`);
    const item = detail.items?.[0];
    if (item) option = { name: item.displayName, price: item.displayPrice, soldOut: item.isSoldOut };
  } catch {}

  const result = { url: issued.shortUrl, option };
  await env.IMAGES.put(cacheKey, JSON.stringify(result), { expirationTtl: 30 * 86400 });
  return result;
}

// ---------- 쿠팡 파트너스 링크 변환 ----------

async function convertCoupang(env, link) {
  if (!env.COUPANG_ACCESS_KEY || !env.COUPANG_SECRET_KEY) {
    throw new HttpError(400, "쿠팡 파트너스 API 키가 설정되지 않았어요");
  }
  const productUrl = await resolveCoupangUrl(link);
  const path = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
  const signedDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").slice(2); // yyMMddTHHmmssZ
  const signature = await hmacHex(env.COUPANG_SECRET_KEY, `${signedDate}POST${path}`);
  const r = await fetch(`https://api-gateway.coupang.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${signedDate}, signature=${signature}`,
    },
    body: JSON.stringify({ coupangUrls: [productUrl] }),
  });
  const d = await r.json().catch(() => ({}));
  const short = d?.data?.[0]?.shortenUrl;
  if (!short) throw new HttpError(502, `쿠팡 변환 실패: ${d.rMessage || r.status}`);
  return { url: short };
}

// 다른 사람의 파트너스 단축링크(link.coupang.com/a/...)를 실제 상품 URL로 풀고 추적 파라미터를 제거
async function resolveCoupangUrl(link) {
  let current = link;
  for (let i = 0; i < 6; i++) {
    const u = new URL(current);
    if (/(^|\.)coupang\.com$/.test(u.hostname) && u.pathname.startsWith("/vp/products/")) {
      const clean = new URL(`https://www.coupang.com${u.pathname}`);
      for (const k of ["itemId", "vendorItemId"]) if (u.searchParams.get(k)) clean.searchParams.set(k, u.searchParams.get(k));
      return clean.href;
    }
    const r = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = r.headers.get("Location");
    if (!loc) break;
    current = new URL(loc, current).href;
  }
  if (/coupang\.com/.test(current)) return current;
  throw new HttpError(400, "쿠팡 상품 링크를 찾지 못했어요");
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- 쓰레드 발행 ----------

async function getToken(env) {
  const stored = await env.IMAGES.get("__threads_token");
  const token = stored || env.THREADS_ACCESS_TOKEN;
  if (!token) throw new HttpError(400, "THREADS_ACCESS_TOKEN이 설정되지 않았어요");
  return token;
}

async function refreshToken(env) {
  const token = await getToken(env);
  const r = await fetch(
    `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
  const d = await r.json();
  if (!d.access_token) throw new HttpError(502, `토큰 갱신 실패: ${d.error?.message || r.status}`);
  await env.IMAGES.put("__threads_token", d.access_token);
  return { ok: true, expiresInDays: Math.round((d.expires_in || 0) / 86400) };
}

async function graphPost(path, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}`, { method: "POST", body });
  const d = await r.json();
  if (!r.ok || d.error) throw new HttpError(502, `쓰레드 오류: ${d.error?.error_user_msg || d.error?.message || r.status}`);
  return d;
}

async function graphGet(path, fields, token) {
  const r = await fetch(`${GRAPH}/${path}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 컨테이너가 FINISHED 될 때까지 대기 (이미지 처리 시간)
async function waitReady(id, token) {
  for (let i = 0; i < 20; i++) {
    const d = await graphGet(id, "status,error_message", token);
    if (d.status === "FINISHED") return;
    if (d.status === "ERROR" || d.status === "EXPIRED") {
      throw new HttpError(502, `쓰레드 미디어 처리 실패: ${d.error_message || d.status}`);
    }
    await sleep(1500);
  }
  throw new HttpError(504, "쓰레드 미디어 처리가 너무 오래 걸려요. 잠시 후 다시 시도해주세요.");
}

async function createAndPublish(userId, params, token) {
  const { id } = await graphPost(`${userId}/threads`, params, token);
  await waitReady(id, token);
  const published = await graphPost(`${userId}/threads_publish`, { creation_id: id }, token);
  return published.id;
}

async function publish(env, { text, images = [], replyText }) {
  if (!text || !text.trim()) throw new HttpError(400, "본문이 비어 있어요");
  if (text.length > 500 || (replyText || "").length > 500) throw new HttpError(400, "쓰레드 글은 500자까지예요");
  const token = await getToken(env);
  const userId = env.THREADS_USER_ID || (await graphGet("me", "id", token)).id;
  if (!userId) throw new HttpError(400, "쓰레드 계정을 확인하지 못했어요. 토큰을 확인해주세요.");

  let mainParams;
  if (images.length === 0) {
    mainParams = { media_type: "TEXT", text };
  } else if (images.length === 1) {
    mainParams = { media_type: "IMAGE", image_url: images[0], text };
  } else {
    const children = [];
    for (const image_url of images.slice(0, 20)) {
      const { id } = await graphPost(`${userId}/threads`, { media_type: "IMAGE", image_url, is_carousel_item: "true" }, token);
      children.push(id);
    }
    for (const id of children) await waitReady(id, token);
    mainParams = { media_type: "CAROUSEL", children: children.join(","), text };
  }

  const postId = await createAndPublish(userId, mainParams, token);

  let replyId = null;
  let replyError = null;
  if (replyText && replyText.trim()) {
    try {
      replyId = await createAndPublish(userId, { media_type: "TEXT", text: replyText, reply_to_id: postId }, token);
    } catch (e) {
      // 본문은 이미 올라갔으므로 실패해도 본문 링크는 돌려준다
      replyError = e.message;
    }
  }

  const { permalink } = await graphGet(postId, "permalink", token);
  return { postId, replyId, permalink, replyError };
}
