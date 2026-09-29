// The share page at /f/:id. Folder titles and URLs are untrusted: they are
// HTML-escaped on the server and set with textContent in the browser.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const host = (u) => {
  try { return new URL(u).hostname; } catch { return ""; }
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}
h1{margin:0;font-size:1.6rem;overflow-wrap:anywhere}
.meta{color:var(--muted);margin:4px 0 20px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px}
.dot.off{background:var(--muted)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
#hint{color:var(--muted);font-size:.9rem}
ul{list-style:none;padding:0;margin:20px 0 0}
li{padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
li a{color:var(--fg);text-decoration:none;overflow-wrap:anywhere}
li a:hover{color:var(--accent)}
li small{color:var(--muted)}
`;

export function renderPage(folder, id) {
  // JSON inside <script>: escape "<" so a title can't close the tag.
  const data = JSON.stringify(folder).replace(/</g, "\\u003c");
  const items = folder.items
    .map(
      (i) =>
        `<li><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(i.title || i.url)}</a><small>${esc(host(i.url))}</small></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="zen-shared-folder" content="${esc(id)}">
<title>${esc(folder.name)} · Shared folder</title>
<style>${STYLE}</style></head><body><main>
<h1 id="name">${esc(folder.name)}</h1>
<p class="meta"><span class="dot" id="dot"></span><span id="count">${folder.items.length}</span> tabs · <span id="status">live</span></p>
<div class="actions">
  <button class="primary" id="add">Add to Zen</button>
  <button id="openall">Open all</button>
</div>
<p id="hint" hidden></p>
<ul id="list">${items}</ul>
</main>
<script id="init" type="application/json">${data}</script>
<script>
(function () {
  var id = ${JSON.stringify(id)};
  var folder = JSON.parse(document.getElementById("init").textContent);
  var $ = function (x) { return document.getElementById(x); };

  function render(f) {
    folder = f;
    $("name").textContent = f.name;
    document.title = f.name + " · Shared folder";
    $("count").textContent = f.items.length;
    var list = $("list");
    list.textContent = "";
    f.items.forEach(function (i) {
      var li = document.createElement("li"), a = document.createElement("a"), s = document.createElement("small");
      a.href = i.url; a.textContent = i.title || i.url; a.target = "_blank"; a.rel = "noopener noreferrer nofollow";
      try { s.textContent = new URL(i.url).hostname; } catch (e) {}
      li.append(a, s); list.append(li);
    });
  }

  $("openall").onclick = function () {
    folder.items.forEach(function (i) { window.open(i.url, "_blank", "noopener"); });
  };
  // The mod recognises this page's URL and shows an "Add to Zen" bar at the
  // top of the window; the button only explains that.
  $("add").onclick = function () {
    var h = $("hint"); h.hidden = false;
    h.textContent = "With the Shareable Folders mod installed in Zen, use the “Add to Zen” bar at the top of the window. Without it, use Open all.";
  };

  var retry = 1000;
  function setLive(on) {
    $("dot").className = on ? "dot" : "dot off";
    $("status").textContent = on ? "live" : "reconnecting…";
  }
  function connect() {
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/folders/" + id + "/live");
    var gone = false;
    ws.onopen = function () { retry = 1000; setLive(true); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === "update") render(m.folder);
      if (m.type === "deleted") {
        gone = true;
        document.querySelector("main").textContent = "This folder is no longer shared.";
      }
    };
    ws.onclose = function () {
      if (gone) return;
      setLive(false);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    };
  }
  connect();
})();
</script></body></html>`;
}

export function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><style>${STYLE}</style></head><body><main><h1>Folder not found</h1><p class="meta">This folder doesn't exist or is no longer shared.</p></main></body></html>`;
}
