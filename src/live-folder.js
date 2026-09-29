import { DurableObject } from "cloudflare:workers";
import { validateContents } from "./validate.js";

const MAX_WRITES_PER_MINUTE = 30;

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// One instance per shared folder. It stores the folder and holds the
// subscribers' WebSockets (hibernatable, so idle folders cost nothing).
export class LiveFolder extends DurableObject {
  writeTimes = [];

  // Called only by the Worker, on internal paths: /init /get /put /delete /live
  async fetch(request) {
    const op = new URL(request.url).pathname;
    if (op === "/init" && request.method === "POST") return this.init(request);

    const folder = await this.ctx.storage.get("folder");
    if (!folder) return json({ error: "not found" }, 404);

    if (op === "/get") return json(folder);
    if (op === "/live") return this.live(request, folder);
    if (op === "/put" || op === "/delete") {
      if (!(await this.authorized(request))) return json({ error: "invalid owner token" }, 401);
      return op === "/put" ? this.put(request, folder) : this.remove();
    }
    return json({ error: "not found" }, 404);
  }

  async authorized(request) {
    const token = request.headers.get("x-owner-token") || "";
    const stored = await this.ctx.storage.get("tokenHash");
    return !!token && !!stored && timingSafeEqual(await sha256(token), stored);
  }

  async init(request) {
    if (await this.ctx.storage.get("folder")) return json({ error: "exists" }, 409);
    const { id, ownerToken, contents } = await request.json();
    const folder = { id, ...contents, version: 1, updatedAt: new Date().toISOString() };
    await this.ctx.storage.put({ folder, tokenHash: await sha256(ownerToken) });
    return json(folder, 201);
  }

  async put(request, current) {
    const now = Date.now();
    this.writeTimes = this.writeTimes.filter((t) => now - t < 60_000);
    if (this.writeTimes.length >= MAX_WRITES_PER_MINUTE) return json({ error: "rate limited" }, 429);
    this.writeTimes.push(now);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    // Only the owner writes in v1, so a stale baseVersion means the owner's
    // client lost track (e.g. two devices). Tell it the real version.
    if (body.baseVersion !== current.version) {
      return json({ error: "version mismatch", currentVersion: current.version }, 409);
    }
    const v = validateContents(body);
    if (!v.ok) return json({ error: v.error }, 400);

    const folder = {
      id: current.id,
      ...v.value,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put("folder", folder);
    this.broadcast({ type: "update", folder });
    return json(folder);
  }

  async remove() {
    this.broadcast({ type: "deleted" });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, "deleted"); } catch { /* already closed */ }
    }
    await this.ctx.storage.deleteAll();
    return json({ ok: true });
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* socket closing */ }
    }
  }

  live(request, folder) {
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "update", folder }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Subscribers never send data; answer keepalive pings.
  webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try { ws.close(code, "closing"); } catch { /* already closed */ }
  }
}
