// End-to-end tests against a local Worker (wrangler + workerd). Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unstable_startWorker } from "wrangler";

let worker, base;

before(async () => {
  worker = await unstable_startWorker({ config: "wrangler.toml", dev: { server: { port: 0 }, inspector: false } });
  base = (await worker.url).origin;
});
after(() => worker?.dispose());

const folder = (items = []) => ({ name: "Design inspo", icon: "palette", items });
const item = (id, order, url = `https://example.com/${id}`) => ({ id, url, title: `T ${id}`, order });

const api = (path, init = {}) =>
  fetch(base + path, { ...init, headers: { "content-type": "application/json", ...init.headers } });

async function create(items = [item("it_01", "a0")]) {
  const res = await api("/api/folders", { method: "POST", body: JSON.stringify(folder(items)) });
  assert.equal(res.status, 201);
  return res.json();
}

test("create and read a folder", async () => {
  const { id, ownerToken, url, folder: f } = await create();
  assert.match(id, /^[A-Za-z0-9]{24}$/);
  assert.match(ownerToken, /^[0-9a-f]{64}$/);
  assert.equal(url, `${base}/f/${id}`);
  assert.equal(f.version, 1);

  const got = await (await api(`/api/folders/${id}`)).json();
  assert.equal(got.name, "Design inspo");
  assert.equal(got.items[0].id, "it_01");
  assert.equal(got.ownerToken, undefined);
});

test("rejects unsafe urls", async () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "about:config", "chrome://browser", "not a url"]) {
    const res = await api("/api/folders", { method: "POST", body: JSON.stringify(folder([item("x", "a0", url)])) });
    assert.equal(res.status, 400, url);
  }
});

test("put requires the owner token and the current version", async () => {
  const { id, ownerToken } = await create();
  const body = (baseVersion) => JSON.stringify({ ...folder([item("it_02", "a1"), item("it_01", "a0")]), baseVersion });

  assert.equal((await api(`/api/folders/${id}`, { method: "PUT", body: body(1) })).status, 401);
  assert.equal(
    (await api(`/api/folders/${id}`, { method: "PUT", body: body(1), headers: { "x-owner-token": "0".repeat(64) } })).status,
    401,
  );

  const ok = await api(`/api/folders/${id}`, { method: "PUT", body: body(1), headers: { "x-owner-token": ownerToken } });
  assert.equal(ok.status, 200);
  const updated = await ok.json();
  assert.equal(updated.version, 2);
  assert.deepEqual(updated.items.map((i) => i.id), ["it_01", "it_02"], "items sorted by order");

  const stale = await api(`/api/folders/${id}`, { method: "PUT", body: body(1), headers: { "x-owner-token": ownerToken } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).currentVersion, 2);
});

test("websocket subscribers get the current folder, updates and deletion", async () => {
  const { id, ownerToken } = await create();
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/folders/${id}/live`);
  const messages = [];
  const waitFor = (n) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${n} messages`)), 5000);
      const check = () => (messages.length >= n ? (clearTimeout(t), resolve()) : setTimeout(check, 20));
      check();
    });
  ws.onmessage = (e) => messages.push(JSON.parse(e.data));

  await waitFor(1);
  assert.equal(messages[0].type, "update");
  assert.equal(messages[0].folder.version, 1);

  await api(`/api/folders/${id}`, {
    method: "PUT",
    headers: { "x-owner-token": ownerToken },
    body: JSON.stringify({ ...folder([item("it_09", "a0")]), name: "Renamed", baseVersion: 1 }),
  });
  await waitFor(2);
  assert.equal(messages[1].folder.name, "Renamed");
  assert.equal(messages[1].folder.version, 2);

  const del = await api(`/api/folders/${id}`, { method: "DELETE", headers: { "x-owner-token": ownerToken } });
  assert.equal(del.status, 200);
  await waitFor(3);
  assert.equal(messages[2].type, "deleted");
  ws.close();

  assert.equal((await api(`/api/folders/${id}`)).status, 404);
});

test("share page escapes attacker-controlled titles", async () => {
  const evil = '</script><img src=x onerror=alert(1)>"\'';
  const { id } = await create([{ id: "x1", url: "https://example.com/?a=<b>", title: evil, order: "a0" }]);
  const res = await fetch(`${base}/f/${id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("<img src=x"), "raw tag must not appear");
  assert.ok(!html.includes("</script><img"), "script tag must not be closable");
  assert.ok(html.includes(`<meta name="zen-shared-folder" content="${id}">`));
});

test("unknown and malformed ids are 404", async () => {
  assert.equal((await api("/api/folders/short")).status, 404);
  assert.equal((await api("/api/folders/" + "A".repeat(24))).status, 404);
  assert.equal((await fetch(`${base}/f/${"B".repeat(24)}`)).status, 404);
});
