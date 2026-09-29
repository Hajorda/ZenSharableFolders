// Folder validation used by the Worker. The mod has its own copy of isSafeUrl.
export const MAX_ITEMS = 500;

export function isSafeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Returns { ok: true, value } with a cleaned copy, or { ok: false, error }.
export function validateContents(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const { name, icon = "", items } = body;
  if (typeof name !== "string" || !name.trim() || name.length > 100) {
    return { ok: false, error: "name must be a non-empty string up to 100 chars" };
  }
  if (typeof icon !== "string" || icon.length > 64) return { ok: false, error: "invalid icon" };
  if (!Array.isArray(items) || items.length > MAX_ITEMS) {
    return { ok: false, error: `items must be an array of at most ${MAX_ITEMS}` };
  }
  const seen = new Set();
  const clean = [];
  for (const it of items) {
    if (!it || typeof it !== "object") return { ok: false, error: "invalid item" };
    if (typeof it.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(it.id) || seen.has(it.id)) {
      return { ok: false, error: "item ids must be unique strings of [A-Za-z0-9_-], up to 64 chars" };
    }
    seen.add(it.id);
    if (!isSafeUrl(it.url)) return { ok: false, error: `unsafe or invalid url for item ${it.id}` };
    if (typeof it.order !== "string" || !it.order || it.order.length > 64) {
      return { ok: false, error: `invalid order for item ${it.id}` };
    }
    const title = typeof it.title === "string" ? it.title.slice(0, 300) : "";
    clean.push({ id: it.id, url: it.url, title, order: it.order });
  }
  clean.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return { ok: true, value: { name: name.trim(), icon, items: clean } };
}
