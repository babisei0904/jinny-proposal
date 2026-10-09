// 카톡 핫딜방 원문 → 상품명 / 가격 / 원본 링크 / 스토어 / 코멘트 추출

const BOILERPLATE = /(수수료|쉐어링크|파트너스|품절되거나|가격이\s*올라갈|일정액|광고)/;
const URL_RE = /https?:\/\/[^\s<>"']+/g;
// 수량 단위: [40병], 30롤, 24개입, 2팩 ...
const COUNT_RE = /(\d+)\s*(병|개입|개|롤|팩|매|입|캔|포|봉|구|장|정|구미|알)(?![a-z가-힣])/;

export function detectStore(link) {
  if (!link) return null;
  if (/toss\.(shopping|im)|tossshopping/i.test(link)) return "toss";
  if (/coupang\.com|coupa\.ng/i.test(link)) return "coupang";
  return "etc";
}

const stripLead = (s) => s.replace(/^[\s\p{Extended_Pictographic}️⃣✓✔☑↳└ㄴ\-–•·*>]+/u, "").trim();

export function parseKakao(raw) {
  const text = (raw || "").replace(/\r/g, "");
  const links = text.match(URL_RE) || [];
  const link = links[0] || "";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let productName = "";
  let price = null;
  const comments = [];
  let afterLink = false;

  for (const line of lines) {
    if (URL_RE.test(line)) {
      URL_RE.lastIndex = 0;
      afterLink = true;
      continue;
    }
    URL_RE.lastIndex = 0;
    if (BOILERPLATE.test(line)) continue;

    const priceMatch = line.match(/([\d,]{3,})\s*원/);
    if (!productName && /^(✅|☑|✔|🔥|💥|⭐|🎁|📢)/u.test(line) && !/^↳/.test(line)) {
      productName = stripLead(line);
      if (priceMatch && price === null) price = toNum(priceMatch[1]);
      continue;
    }
    if (price === null && priceMatch && (!afterLink || /^(↳|└|ㄴ)/.test(line))) {
      price = toNum(priceMatch[1]);
      continue;
    }
    if (!productName && !afterLink) {
      productName = stripLead(line);
      continue;
    }
    comments.push(line);
  }

  const countMatch = productName.match(COUNT_RE);
  const count = countMatch ? Number(countMatch[1]) : null;
  const unit = countMatch ? countMatch[2] : null;
  const unitPrice = price && count && count > 1 ? Math.floor(price / count) : null;

  return { productName, price, link, store: detectStore(link), count, unit, unitPrice, comments };
}

const toNum = (s) => Number(String(s).replace(/,/g, ""));
export const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;

// 상품명 간소화: [40병], 괄호, 콤마 뒤 옵션 제거
export const shortName = (name) =>
  (name || "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .split(",")[0]
    .trim();

// AI 없이 쓰는 기본 후킹 문구 3종
export function templateHooks(p) {
  const name = shortName(p.productName) || "이거";
  const price = p.price ? won(p.price) : "";
  const unitWord = p.unit === "병" || p.unit === "캔" ? "개" : p.unit === "롤" ? "롤" : "개";
  const per = p.unitPrice ? `${unitWord}당 ${won(p.unitPrice)}꼴` : "";
  const c = p.comments || [];
  const hooks = [];

  hooks.push([`${name}${per ? ` ${per}` : price ? ` ${price}` : ""} 떴어!🔥`, c[1] || "필요한 사람 지금 쟁여둬", "특가 끝나기 전에 서둘러‼️"].join("\n"));
  hooks.push([`이 가격 실화?😳`, `${name}${price ? ` ${price}` : ""}`, per ? `${per}이면 무조건 사야지` : "역대급이라 바로 공유함"].join("\n"));
  hooks.push([`순삭 각이다🚨`, `${name}${price ? ` ${price}` : ""}`, "품절되기 전에 달려라달려 !!!!"].join("\n"));

  if (c[0] && !c[0].includes("http")) hooks[0] = c.slice(0, 3).join("\n");
  return hooks;
}
