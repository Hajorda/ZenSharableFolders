// Runs the real mod scripts (core + shareable-folders) in two fake "profiles"
// against a local Worker. Only the Zen adapter is faked, with an in-memory sidebar.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { unstable_startWorker } from "wrangler";

const read = (f) => readFileSync(new URL(`../mod/${f}`, import.meta.url), "utf8");
const CORE = read("core.uc.js");
const MAIN = read("shareable-folders.uc.js");

let worker, server;
before(async () => {
  worker = await unstable_startWorker({ config: "wrangler.toml", triggers: [], dev: { server: { port: 0 }, inspector: false } });
  server = (await worker.url).origin;
});
after(() => worker?.dispose());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

// --- Fake browser profile -------------------------------------------------

let nextId = 1;
class FakeTab {
  constructor(url, title) {
    this.id = `${Date.now()}-tab${nextId++}`;
    this.url = url;
    this.title = title;
    this.selected = false;
    this.loaded = false;
    this.attrs = {};
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  hasAttribute(k) { return k in this.attrs; }
}

function makeProfile(name) {
  const prefs = new Map();
  const observers = new Set();
  const logins = [];
  const bars = [];
  const folders = new Map(); // id -> { id, label, icon, tabs: [] }
  const locationListeners = [];
  const listeners = new Map();
  const prompts = { confirmEx: 0, confirm: true };
  let offline = false;
  let fetchCalls = 0;
  const fakeFetch = (...a) => (fetchCalls++, offline ? Promise.reject(new TypeError("offline")) : fetch(...a));
  let clipboard = "";

  const win = {
    addEventListener(t, f) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(f); },
    removeEventListener(t, f) { listeners.get(t)?.delete(f); },
    dispatch(t) { for (const f of [...(listeners.get(t) || [])]) f({ type: t }); },
  };

  const Zen = {
    supported: true,
    whenReady: async () => {},
    isLeaderWindow: () => true,
    getFolder: (id) => folders.get(id) || null,
    allFolders: () => [...folders.values()],
    folderId: (f) => f.id,
    folderName: (f) => f.label,
    folderIcon: (f) => f.icon || "",
    folderOfTab: (tab) => [...folders.values()].find((f) => f.tabs.includes(tab)) || null,
    folderTabs: (f) => [...f.tabs],
    createFolder(label, icon) {
      const f = { id: `folder-${nextId++}`, label, icon, tabs: [], attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
      folders.set(f.id, f);
      return f;
    },
    renameFolder: (f, n) => (f.label = n),
    setFolderIcon: (f, i) => i && (f.icon = i),
    tabId: (t) => t.id,
    getTab: (id) => [...folders.values()].flatMap((f) => f.tabs).find((t) => t.id === id) || null,
    tabUrl: (t) => t.url,
    tabTitle: (t) => t.title,
    isTabInUse: (t) => t.selected || t.loaded,
    createTab(folder, item, before = null) {
      const t = new FakeTab(item.url, item.title);
      const i = before ? folder.tabs.indexOf(before) : -1;
      if (i >= 0) folder.tabs.splice(i, 0, t);
      else folder.tabs.push(t);
      return t;
    },
    removeTab(t) { for (const f of folders.values()) f.tabs = f.tabs.filter((x) => x !== t); },
    setUnloadedTabTitle: (t, title) => !t.loaded && (t.title = title),
    moveTabAfter(t, ref) {
      const f = Zen.folderOfTab(t);
      f.tabs.splice(f.tabs.indexOf(t), 1);
      f.tabs.splice(f.tabs.indexOf(ref) + 1, 0, t);
    },
    folderMenu: () => null,
    showPageBar: async (browser, value, label, buttons) => bars.push({ value, label, buttons }),
    closePageBar() {},
    showWindowBar: async (value, label, buttons = []) => bars.push({ value, label, buttons }),
    showLinkCopied() {},
    copyToClipboard: (t) => (clipboard = t),
    addLocationListener(fn) { locationListeners.push(fn); return () => {}; },
    CHANGE_EVENTS: ["TabMove", "TabAttrModified"],
  };

  const Services = {
    prefs: {
      getStringPref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
      setStringPref(k, v) { prefs.set(k, v); for (const o of [...observers]) o.observe(null, "nsPref:changed", k); },
      getBoolPref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
      setBoolPref: (k, v) => prefs.set(k, v),
      addObserver: (k, o) => observers.add(o),
      removeObserver: (k, o) => observers.delete(o),
    },
    logins: {
      searchLoginsAsync: async ({ origin, httpRealm }) => logins.filter((l) => l.origin === origin && l.httpRealm === httpRealm),
      addLoginAsync: async (l) => logins.push(l),
      removeLogin: (l) => logins.splice(logins.indexOf(l), 1),
    },
    prompt: {
      BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536, BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2,
      confirmEx: () => prompts.confirmEx,
      confirm: () => prompts.confirm,
      alert: (w, t, m) => { throw new Error(`unexpected alert: ${m}`); },
      prompt: () => false,
    },
  };
  function LoginInfo(origin, action, httpRealm, username, password) { Object.assign(this, { origin, httpRealm, username, password }); }

  const ctx = vm.createContext({
    window: win, Services, ZSFZen: Zen, Ci: {}, Components: { Constructor: () => LoginInfo },
    WebSocket, fetch: fakeFetch, URL, URLSearchParams, console: { ...console, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  prefs.set("zen.shareable-folders.server-url", server);
  vm.runInContext(CORE, ctx);
  vm.runInContext(MAIN, ctx);

  return {
    name, Zen, folders, bars, logins, prompts, win,
    get clipboard() { return clipboard; },
    get fetchCalls() { return fetchCalls; },
    setOffline(v) { offline = v; },
    get debug() { return win.ZSFDebug; },
    state: () => JSON.parse(Services.prefs.getStringPref("zen.shareable-folders.state", "{}")),
    addFolder(label, tabs) {
      const f = Zen.createFolder(label, "");
      f.tabs = tabs.map(([url, title]) => new FakeTab(url, title));
      return f;
    },
    visit(spec) { for (const fn of locationListeners) fn({ currentURI: { spec } }, spec); },
    shutdown() { win.dispatch("unload"); },
  };
}

const urls = (f) => f.tabs.map((t) => t.url);

// --- The scenario -------------------------------------------------------------

test("owner shares, subscriber follows live, then sharing stops", async (t) => {
  const owner = makeProfile("owner");
  const sub = makeProfile("subscriber");
  t.after(() => { owner.shutdown(); sub.shutdown(); });
  await sleep(10); // let whenReady() resolve and the leaders start

  // 1. Owner shares a folder containing one private-looking URL, and leaves it out.
  const folder = owner.addFolder("Design inspo", [
    ["https://a.com/", "A"],
    ["https://app.com/cb?access_token=secret", "Login"],
    ["https://c.com/", "C"],
  ]);
  owner.prompts.confirmEx = 0; // "Leave them out"
  await owner.debug.shareFolder(folder);
  const entry = owner.state().folders[folder.id];
  assert.equal(entry.role, "owner");
  assert.match(owner.clipboard, new RegExp(`^${server}/f/[A-Za-z0-9]{24}$`));
  assert.equal(owner.logins.length, 1, "owner token stored in the password manager");
  assert.ok(!JSON.stringify(owner.state()).includes(owner.logins[0].password), "token not in prefs");

  const remote = await (await fetch(`${server}/api/folders/${entry.remoteId}`)).json();
  assert.deepEqual(remote.items.map((i) => i.url), ["https://a.com/", "https://c.com/"]);

  // 2. Subscriber opens the link; the mod offers "Add to Zen".
  sub.visit(owner.clipboard);
  const bar = await until(() => sub.bars.find((b) => b.value === "zsf-subscribe"), "subscribe bar");
  assert.match(bar.label, /Design inspo.*2 tabs/);
  bar.buttons[0].callback();
  const subFolder = await until(() => [...sub.folders.values()][0], "subscriber folder");
  await until(() => subFolder.tabs.length === 2, "two tabs");
  assert.deepEqual(urls(subFolder), ["https://a.com/", "https://c.com/"]);
  assert.equal(subFolder.attrs["zsf-live"], "subscriber");
  await until(() => sub.debug.Leader.sockets.get(subFolder.id)?.ws?.readyState === WebSocket.OPEN, "socket open");

  // 3. Owner edits: new tab at the front, rename a tab, close C, rename the folder.
  folder.tabs.unshift(new FakeTab("https://d.com/", "D"));
  folder.tabs.find((x) => x.url === "https://a.com/").title = "A renamed";
  folder.tabs = folder.tabs.filter((x) => x.url !== "https://c.com/");
  folder.label = "Design inspo v2";
  owner.win.dispatch("TabMove");
  await until(() => subFolder.label === "Design inspo v2", "folder rename to arrive");
  assert.deepEqual(urls(subFolder), ["https://d.com/", "https://a.com/"]);
  assert.equal(subFolder.tabs[1].title, "A renamed");

  // 4. A tab the subscriber is using isn't closed when the owner removes it.
  subFolder.tabs[1].selected = true;
  folder.tabs = folder.tabs.filter((x) => x.url !== "https://a.com/");
  owner.win.dispatch("TabMove");
  await until(() => subFolder.tabs[1]?.attrs["zsf-removed"], "in-use tab marked removed");
  assert.equal(subFolder.tabs.length, 2);

  // 5. A tab the subscriber closed stays closed after later updates.
  subFolder.tabs = subFolder.tabs.filter((x) => x.url !== "https://d.com/");
  folder.tabs.push(new FakeTab("https://e.com/", "E"));
  owner.win.dispatch("TabMove");
  await until(() => urls(subFolder).includes("https://e.com/"), "E to arrive");
  assert.ok(!urls(subFolder).includes("https://d.com/"), "closed tab not re-added");

  // 6. Reorder on the owner side reaches the subscriber.
  folder.tabs.push(new FakeTab("https://f.com/", "F"));
  owner.win.dispatch("TabMove");
  await until(() => urls(subFolder).includes("https://f.com/"), "F to arrive");
  folder.tabs.reverse();
  owner.win.dispatch("TabMove");
  await until(() => {
    const live = urls(subFolder).filter((u) => u === "https://e.com/" || u === "https://f.com/");
    return live[0] === "https://f.com/";
  }, "reorder");

  // 7. Owner stops sharing: the subscriber keeps a normal folder.
  owner.prompts.confirm = true;
  await owner.debug.stopSharing(folder.id);
  assert.equal(owner.state().folders[folder.id], undefined);
  assert.equal(owner.logins.length, 0);
  await until(() => !sub.state().folders[subFolder.id], "subscription to end");
  assert.ok(sub.folders.has(subFolder.id), "subscriber keeps the folder");
  assert.ok(sub.bars.some((b) => b.value === "zsf-ended"));
  assert.equal((await fetch(`${server}/api/folders/${entry.remoteId}`)).status, 404);
});

test("offline owner edits are pushed once the server is reachable", async (t) => {
  const owner = makeProfile("owner2");
  t.after(() => owner.shutdown());
  await sleep(10);
  const folder = owner.addFolder("Offline", [["https://a.com/", "A"]]);
  await owner.debug.shareFolder(folder);
  const { remoteId } = owner.state().folders[folder.id];

  owner.setOffline(true);
  folder.tabs.push(new FakeTab("https://b.com/", "B"));
  owner.win.dispatch("TabMove");
  const calls = owner.fetchCalls;
  await until(() => owner.fetchCalls > calls, "a failed push attempt");
  assert.equal(owner.state().folders[folder.id].version, 1, "nothing recorded as pushed");

  owner.setOffline(false); // the backoff retry (about 5s) should now succeed
  await until(() => owner.state().folders[folder.id].version === 2, "retry to succeed", 15000);
  const remote = await (await fetch(`${server}/api/folders/${remoteId}`)).json();
  assert.deepEqual(remote.items.map((i) => i.url), ["https://a.com/", "https://b.com/"]);
});
