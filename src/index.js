import { LiveFolder } from "./live-folder.js";
import { validateContents } from "./validate.js";
import { renderPage, notFoundPage } from "./page.js";

export { LiveFolder };

const ID_RE = /^[A-Za-z0-9]{16,64}$/;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomId(len = 24) {
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len))) {
      if (b < 248 && out.length < len) out += B62[b % 62]; // 248 = 62*4, no modulo bias
    }
  }
  return out;
}

const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-owner-token",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

const withCors = (res) => {
  if (res.status === 101) return res; // WebSocket upgrade: pass through untouched
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
};

// Best-effort limit on folder creation per client IP (per Worker isolate).
const creations = new Map();
function createLimited(ip) {
  const now = Date.now();
  const recent = (creations.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 20) return true;
  recent.push(now);
  creations.set(ip, recent);
  return false;
}

const stub = (env, id) => env.LIVE_FOLDER.get(env.LIVE_FOLDER.idFromName(id));
const forward = (env, id, path, request) => stub(env, id).fetch(new Request("https://do" + path, request));

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/api/folders") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (createLimited(request.headers.get("cf-connecting-ip") || "unknown")) {
        return json({ error: "rate limited" }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const v = validateContents(body);
      if (!v.ok) return json({ error: v.error }, 400);

      const id = randomId(24);
      const ownerToken = randomToken();
      const res = await stub(env, id).fetch("https://do/init", {
        method: "POST",
        body: JSON.stringify({ id, ownerToken, contents: v.value }),
      });
      if (!res.ok) return json({ error: "could not create folder" }, 500);
      const folder = await res.json();
      return json({ id, ownerToken, url: `${url.origin}/f/${id}`, folder }, 201);
    }

    let m = path.match(/^\/api\/folders\/([^/]+)(\/live)?$/);
    if (m) {
      const [, id, live] = m;
      if (!ID_RE.test(id)) return json({ error: "not found" }, 404);
      if (live) {
        return request.method === "GET" ? forward(env, id, "/live", request) : json({ error: "method not allowed" }, 405);
      }
      const op = { GET: "/get", PUT: "/put", DELETE: "/delete" }[request.method];
      if (!op) return json({ error: "method not allowed" }, 405);
      return withCors(await forward(env, id, op, request));
    }

    m = path.match(/^\/f\/([^/]+)$/);
    if (m && request.method === "GET") {
      const id = m[1];
      if (!ID_RE.test(id)) return new Response(notFoundPage(), { status: 404, headers: HTML_HEADERS });
      const res = await forward(env, id, "/get", new Request("https://do/get"));
      if (!res.ok) return new Response(notFoundPage(), { status: 404, headers: HTML_HEADERS });
      return new Response(renderPage(await res.json(), id), { headers: HTML_HEADERS });
    }

    if (path === "/") {
      return new Response("Zen Shareable Folders backend. See https://github.com/hajorda/ZenSharableFolders", {
        headers: { "content-type": "text/plain" },
      });
    }

    return json({ error: "not found" }, 404);
  },
};
