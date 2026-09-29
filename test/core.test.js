// Unit tests for the mod's pure logic (mod/core.uc.js), loaded the same way Sine does: as a classic script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { URL, URLSearchParams };
vm.runInNewContext(readFileSync(new URL("../mod/core.uc.js", import.meta.url), "utf8") + "\nthis.ZSFCore = ZSFCore;", ctx);
// Copy results into this realm: arrays from the vm context have a different prototype.
const local = (v) => JSON.parse(JSON.stringify(v));
const C = new Proxy(ctx.ZSFCore, { get: (t, k) => (...a) => { const r = t[k](...a); return r && typeof r === "object" ? local(r) : r; } });

test("isSafeUrl allows only http(s)", () => {
  assert.ok(C.isSafeUrl("https://example.com"));
  assert.ok(C.isSafeUrl("http://example.com/a?b"));
  for (const u of ["javascript:alert(1)", "file:///x", "about:blank", "chrome://browser/content", "data:text/html,x", ""]) {
    assert.ok(!C.isSafeUrl(u), u);
  }
});

test("privateUrlReason flags tokens and internal hosts", () => {
  assert.equal(C.privateUrlReason("https://example.com/page?q=cats"), null);
  assert.equal(C.privateUrlReason("https://figma.com/file/abc"), null);
  assert.match(C.privateUrlReason("https://app.com/cb?access_token=abc"), /access_token/);
  assert.match(C.privateUrlReason("https://app.com/x#id_token=abc&state=1"), /id_token/);
  assert.match(C.privateUrlReason("https://app.com/?Session=1"), /Session/);
  assert.match(C.privateUrlReason("http://localhost:3000/"), /local/);
  assert.match(C.privateUrlReason("http://192.168.1.10/admin"), /local/);
  assert.match(C.privateUrlReason("http://172.20.0.1/"), /local/);
  assert.match(C.privateUrlReason("http://intranet/"), /local/);
  assert.match(C.privateUrlReason("https://wiki.corp/"), /local/);
  assert.match(C.privateUrlReason("https://user:pw@example.com/"), /password/);
  assert.equal(C.privateUrlReason("http://172.32.0.1/"), null);
});

test("midpoint produces keys strictly between its bounds", () => {
  const pairs = [["", null], ["V", null], ["", "V"], ["a", "b"], ["a", "a1"], ["az", "b"], ["zz", null], ["0001", "0002"]];
  for (const [a, b] of pairs) {
    const m = C.midpoint(a, b);
    assert.ok(m > a && (b === null || m < b), `${a} < ${m} < ${b}`);
  }
});

test("keysBetween stays short even for many keys", () => {
  const keys = C.keysBetween("", null, 500);
  assert.equal(keys.length, 500);
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(new Set(keys).size, 500);
  assert.ok(Math.max(...keys.map((k) => k.length)) <= 6);
});

test("assignOrders keeps keys for items that didn't move", () => {
  const first = C.assignOrders({}, ["a", "b", "c", "d"]);
  assert.deepEqual(Object.keys(first), ["a", "b", "c", "d"]);
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(ids.map((i) => first[i]), ids.map((i) => first[i]).sort());

  // Move d to the front: only d changes.
  const moved = C.assignOrders(first, ["d", "a", "b", "c"]);
  assert.equal(moved.a, first.a);
  assert.equal(moved.b, first.b);
  assert.equal(moved.c, first.c);
  assert.ok(moved.d < moved.a);

  // Insert x between b and c: only x is new.
  const inserted = C.assignOrders(first, ["a", "b", "x", "c", "d"]);
  for (const id of ids) assert.equal(inserted[id], first[id]);
  assert.ok(inserted.b < inserted.x && inserted.x < inserted.c);
});

test("assignOrders result always sorts in the requested order", () => {
  let prev = {};
  let ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
  for (let round = 0; round < 200; round++) {
    ids = [...ids];
    const op = round % 3;
    if (op === 0) ids.splice(Math.floor(Math.random() * ids.length), 0, `n${round}`);
    if (op === 1 && ids.length > 1) ids.splice(Math.floor(Math.random() * ids.length), 1);
    if (op === 2) {
      const [x] = ids.splice(Math.floor(Math.random() * ids.length), 1);
      ids.splice(Math.floor(Math.random() * (ids.length + 1)), 0, x);
    }
    prev = C.assignOrders(prev, ids);
    const keys = ids.map((i) => prev[i]);
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i], `round ${round}`);
    assert.ok(keys.every((k) => k.length <= 64));
  }
});

test("snapshotKey changes only when content changes", () => {
  const tabs = [{ id: "1", url: "https://a.com", title: "A" }];
  const s1 = C.buildSnapshot({ name: "F", icon: "", tabs });
  const s2 = C.buildSnapshot({ name: "F", icon: "", tabs, prevOrders: { 1: s1.items[0].order } });
  assert.equal(C.snapshotKey(s1), C.snapshotKey(s2));
  const s3 = C.buildSnapshot({ name: "F2", icon: "", tabs });
  assert.notEqual(C.snapshotKey(s1), C.snapshotKey(s3));
});

test("diffFolder adds, updates, removes and respects user-closed tabs", () => {
  const local = {
    a: { tabId: "t1", url: "https://a.com", title: "A" },
    b: { tabId: "t2", url: "https://b.com", title: "B" },
    c: { tabId: "t3", url: "https://c.com", title: "C" },
  };
  const present = new Set(["a", "b"]); // user closed c
  const dismissed = new Set(["z"]);
  const remote = [
    { id: "d", url: "https://d.com", title: "D", order: "a0" },
    { id: "a", url: "https://a.com", title: "A renamed", order: "a1" },
    { id: "c", url: "https://c.com", title: "C", order: "a2" },
    { id: "z", url: "https://z.com", title: "Z", order: "a3" },
  ];
  const d = C.diffFolder(local, present, dismissed, remote);
  assert.deepEqual(d.add.map((i) => i.id), ["d"]);
  assert.deepEqual(d.update.map((i) => i.id), ["a"]);
  assert.deepEqual(d.remove, ["b"]);
  assert.deepEqual(d.closedByUser, ["c"]);
  assert.deepEqual(d.order, ["d", "a"]);
});

test("parseShareUrl recognises share pages on any https host", () => {
  assert.deepEqual({ ...C.parseShareUrl("https://x.workers.dev/f/k7Qp2xVb9mRt4sLwAbCdEfGh") }, {
    origin: "https://x.workers.dev",
    id: "k7Qp2xVb9mRt4sLwAbCdEfGh",
  });
  assert.ok(C.parseShareUrl("http://localhost:8787/f/k7Qp2xVb9mRt4sLwAbCdEfGh"));
  assert.equal(C.parseShareUrl("http://example.com/f/k7Qp2xVb9mRt4sLwAbCdEfGh"), null);
  assert.equal(C.parseShareUrl("https://example.com/f/short"), null);
  assert.equal(C.parseShareUrl("https://example.com/g/k7Qp2xVb9mRt4sLwAbCdEfGh"), null);
});

test("looksLikeFolder checks the API shape", () => {
  assert.ok(C.looksLikeFolder({ id: "x", name: "n", version: 1, items: [] }, "x"));
  assert.ok(!C.looksLikeFolder({ id: "y", name: "n", version: 1, items: [] }, "x"));
  assert.ok(!C.looksLikeFolder({ error: "not found" }, "x"));
});
