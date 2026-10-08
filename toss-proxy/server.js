// 토스 쉐어링크 API 중계 서버 (고정 IP 서버에서 실행)
// 토스는 어드민에 등록한 출발지 IP에서 온 호출만 허용한다. Cloudflare Worker는 IP가 고정되지 않아서
// Worker → (이 서버, 고정 IP) → 토스 순서로 호출한다.
//   /token      → https://oauth2.cert.toss.im/token
//   /openapi/*  → https://sharelink.toss.im/openapi/*
// 실행: PROXY_KEY=긴비밀값 PORT=8080 node server.js   (Node 18 이상, 외부 패키지 없음)
import http from "node:http";

const PROXY_KEY = process.env.PROXY_KEY;
const PORT = Number(process.env.PORT || 8080);
if (!PROXY_KEY) throw new Error("PROXY_KEY 환경변수를 설정하세요");

const target = (path) =>
  path === "/token"
    ? "https://oauth2.cert.toss.im/token"
    : path.startsWith("/openapi/")
      ? `https://sharelink.toss.im${path}`
      : null;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") return res.end("ok");
    const dest = target(url.pathname);
    if (!dest || req.headers["x-proxy-key"] !== PROXY_KEY) {
      res.writeHead(dest ? 401 : 404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const headers = {};
      for (const h of ["authorization", "content-type"]) if (req.headers[h]) headers[h] = req.headers[h];
      const r = await fetch(dest + url.search, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
  })
  .listen(PORT, () => console.log(`toss-proxy listening on :${PORT}`));
