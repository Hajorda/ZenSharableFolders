// Shareable Folders — pure logic (no Zen or Firefox APIs).
// Loaded first by Sine; also loaded by the Node tests via `vm`.
// eslint-disable-next-line no-var
var ZSFCore = (() => {
  "use strict";

  const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const SHARE_PATH_RE = /^\/f\/([A-Za-z0-9]{16,64})$/;

  function isSafeUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  // --- Private-URL detection -------------------------------------------------

  const SECRET_PARAM_RE =
    /^(access_?token|id_?token|refresh_?token|token|auth|authorization|session|sessionid|sid|key|api_?key|apikey|secret|client_secret|password|passwd|pwd|code|otp|signature|sig|x-amz-signature|x-goog-signature|jwt|ticket|nonce|state)$/i;

  function isPrivateHost(host) {
    host = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (/\.(local|internal|lan|home|corp|intranet)$/.test(host)) return true;
    if (!host.includes(".") && !host.includes(":")) return true; // intranet short names
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    }
    if (host.includes(":")) return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80");
    return false;
  }

  // Returns a short human-readable reason if the URL looks private, else null.
  function privateUrlReason(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.username || u.password) return "contains a username or password";
    if (isPrivateHost(u.hostname)) return "points to a local or internal address";
    const params = [...u.searchParams.keys()];
    if (u.hash.includes("=")) {
      try {
        params.push(...new URLSearchParams(u.hash.slice(1)).keys());
      } catch { /* not a query-like hash */ }
    }
    const bad = params.find((p) => SECRET_PARAM_RE.test(p));
    return bad ? `has a "${bad}" parameter` : null;
  }

  // --- Fractional order keys -------------------------------------------------
  // Keys are base-62 strings that sort lexicographically. midpoint(a, b)
  // returns a key strictly between a and b ("" = start, null = end).

  function midpoint(a, b) {
    if (b !== null && a >= b) throw new Error(`midpoint: ${a} >= ${b}`);
    if (b !== null) {
      let n = 0;
      while ((a[n] || "0") === b[n]) n++;
      if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
    const da = a ? DIGITS.indexOf(a[0]) : 0;
    const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
    if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
    if (b && b.length > 1) return b.slice(0, 1);
    return DIGITS[da] + midpoint(a.slice(1), null);
  }

  // n keys, evenly spread between lo and hi (balanced, so keys stay short).
  function keysBetween(lo, hi, n) {
    if (n <= 0) return [];
    const mid = midpoint(lo, hi);
    const left = Math.floor((n - 1) / 2);
    return [...keysBetween(lo, mid, left), mid, ...keysBetween(mid, hi, n - 1 - left)];
  }

  // Given the previous order key per id and the new id sequence, return new
  // keys. The longest run of ids that is still correctly ordered keeps its
  // keys, so moving one tab changes one key.
  function assignOrders(prevOrders, ids) {
    const prev = ids.map((id) => (prevOrders && typeof prevOrders[id] === "string" ? prevOrders[id] : null));
    const keep = longestIncreasing(prev);
    const out = {};
    let i = 0;
    while (i < ids.length) {
      if (keep.has(i)) {
        out[ids[i]] = prev[i];
        i++;
        continue;
      }
      let j = i;
      while (j < ids.length && !keep.has(j)) j++;
      const lo = i > 0 ? out[ids[i - 1]] : "";
      const hi = j < ids.length ? prev[j] : null;
      keysBetween(lo, hi, j - i).forEach((k, n) => (out[ids[i + n]] = k));
      i = j;
    }
    return out;
  }

  // Indices of a longest strictly increasing subsequence of non-null strings.
  function longestIncreasing(values) {
    const tails = []; // index into values
    const parent = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) continue;
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[tails[mid]] < v) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) parent[i] = tails[lo - 1];
      tails[lo] = i;
    }
    const keep = new Set();
    for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = parent[k]) keep.add(k);
    return keep;
  }

  // --- Snapshots -------------------------------------------------------------

  // tabs: [{ id, url, title }] in sidebar order.
  function buildSnapshot({ name, icon, tabs, prevOrders }) {
    const orders = assignOrders(prevOrders || {}, tabs.map((t) => t.id));
    return {
      name: (name || "Folder").slice(0, 100),
      icon: icon || "",
      items: tabs.map((t) => ({ id: t.id, url: t.url, title: (t.title || "").slice(0, 300), order: orders[t.id] })),
    };
  }

  // Stable string for "did anything change?" checks.
  function snapshotKey(snap) {
    return JSON.stringify([snap.name, snap.icon, snap.items.map((i) => [i.id, i.url, i.title, i.order])]);
  }

  // --- Subscriber diff -------------------------------------------------------

  // local:    { [itemId]: { tabId, url, title } } — tabs we created and still track
  // present:  Set of itemIds whose tab still exists in the sidebar
  // dismissed: Set of itemIds the subscriber closed themselves
  // remote:   folder.items from the server (any order)
  function diffFolder(local, present, dismissed, remote) {
    const sorted = [...remote].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const remoteIds = new Set(sorted.map((i) => i.id));
    const add = [], update = [], remove = [], closedByUser = [];
    for (const [itemId] of Object.entries(local)) {
      if (!present.has(itemId)) closedByUser.push(itemId);
      else if (!remoteIds.has(itemId)) remove.push(itemId);
    }
    for (const item of sorted) {
      const mine = local[item.id];
      if (dismissed.has(item.id) || closedByUser.includes(item.id)) continue;
      if (!mine) add.push(item);
      else if (mine.url !== item.url || mine.title !== item.title) update.push(item);
    }
    const order = sorted.map((i) => i.id).filter((id) => !dismissed.has(id) && !closedByUser.includes(id));
    return { add, update, remove, closedByUser, order };
  }

  // --- Misc ------------------------------------------------------------------

  // Recognise a share page URL on any server: https://host/f/<id>
  function parseShareUrl(spec) {
    let u;
    try {
      u = new URL(spec);
    } catch {
      return null;
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    const m = u.pathname.match(SHARE_PATH_RE);
    return m ? { origin: u.origin, id: m[1] } : null;
  }

  function looksLikeFolder(data, id) {
    return !!data && data.id === id && typeof data.name === "string" && Number.isInteger(data.version) && Array.isArray(data.items);
  }

  function backoff(attempt, base = 2000, max = 300000) {
    const ms = Math.min(max, base * 2 ** Math.max(0, attempt));
    return Math.round(ms * (0.8 + Math.random() * 0.4));
  }

  return {
    isSafeUrl, privateUrlReason, isPrivateHost,
    midpoint, keysBetween, assignOrders,
    buildSnapshot, snapshotKey, diffFolder,
    parseShareUrl, looksLikeFolder, backoff,
  };
})();
