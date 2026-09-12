#!/usr/bin/env node
/** Controlled HTTP fixtures for loop tests.
 * Sources cover valid, empty, malformed, oversized, slow and failed responses.
 * Receivers record accepted and rejected attempts for independent assertions.
 * Inspect /_received and reset through /_reset.
 */
import { createServer } from "node:http";

const PORT = Number(process.argv.find((a, i) => process.argv[i - 1] === "--port") ?? 19900);
const received = [];

const item = (i) => `
<item><title>Fixture item ${i}</title><link>https://example.test/${i}</link>
  <description><![CDATA[Body of fixture item ${i}.]]></description>
  <pubDate>Fri, 01 Aug 2026 0${i % 10}:00:00 GMT</pubDate></item>`;

const rss = (n) =>
  `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Fixture feed</title>${
    Array.from({ length: n }, (_, i) => item(i + 1)).join("")
  }</channel></rss>`;

const ROUTES = {
  "/feed/ok": () => [200, "application/rss+xml", rss(8)],
  "/feed/one": () => [200, "application/rss+xml", rss(1)],
  /* Empty RSS must fail instead of silently passing with no items. */
  "/feed/empty": () => [200, "application/rss+xml", `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Empty</title></channel></rss>`],
  "/feed/malformed": () => [200, "text/html", "<html><body><h1>Not a feed</h1></body></html>"],
  "/feed/huge": () => [200, "application/rss+xml", rss(60)],
  "/json/ok": () => [200, "application/json", JSON.stringify({ ok: true, rates: { UAH: 44.6, EUR: 0.92 } })],
  "/json/low": () => [200, "application/json", JSON.stringify({ ok: true, rates: { UAH: 38.1, EUR: 0.92 } })],
  "/json/notjson": () => [200, "text/plain", "definitely not json"],
  "/material": () => [200, "application/json", JSON.stringify({
    items: [
      { title: "InnoDB row locks explained", link: "https://example.test/a", note: "Why SELECT FOR UPDATE beats an optimistic claim." },
      { title: "Cron that lies about being alive", link: "https://example.test/b", note: "A tick that always returns 200 is a tick nobody notices is dead." },
    ],
  })],
};

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/_received") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(received));
  }
  if (req.method === "POST" && path === "/_reset") {
    received.length = 0;
    res.writeHead(200); return res.end("ok");
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");

    /* Slow endpoints exceed the configured timeout to exercise real cancellation. */
    if (path === "/slow" || path === "/sink/slow") {
      await new Promise((r) => setTimeout(r, 40_000));
      res.writeHead(200); return res.end("late");
    }

    const status = path.match(/^\/status\/(\d{3})$/);
    if (status) { res.writeHead(Number(status[1]), { "Content-Type": "text/plain" }); return res.end(`forced ${status[1]}`); }

    if (path.startsWith("/sink")) {
      received.push({ path, body, at: new Date().toISOString() });
      if (path === "/sink/reject") { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("receiver refused"); }
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ stored: true, n: received.length }));
    }

    const route = ROUTES[path];
    if (!route) { res.writeHead(404); return res.end("no such fixture"); }
    const [code, type, payload] = route();
    res.writeHead(code, { "Content-Type": type });
    res.end(payload);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fixtures on ${PORT}`));
