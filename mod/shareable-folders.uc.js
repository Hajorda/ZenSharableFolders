// Shareable Folders — share a Zen folder as a live link; subscribers follow changes.
// Needs core.uc.js (ZSFCore) and zen-adapter.uc.js (ZSFZen), loaded before this file.
(() => {
  "use strict";
  const Core = ZSFCore;
  const Zen = ZSFZen;
  if (!Zen.supported) return;

  const PREF_STATE = "zen.shareable-folders.state";
  const PREF_SERVER = "zen.shareable-folders.server-url";
  const PREF_WARN = "zen.shareable-folders.warn-private-urls";
  // Used when the Server URL setting is empty (Sine doesn't apply preference defaults).
  const DEFAULT_SERVER = "https://folder.hajorda.dev";
  const LOGIN_ORIGIN = "chrome://zen-shareable-folders";
  const PUSH_DEBOUNCE_MS = 2000;
  const TICK_MS = 30_000;
  const POLL_MS = 60_000;
  const log = (...a) => console.log("[Shareable Folders]", ...a);

  // --- State (shared by all windows through one pref) ----------------------
  // folders[localFolderId] = {
  //   role: "owner" | "subscriber", server, remoteId, name, version,
  //   owner:      orders {tabId: key}, lastKey, allowed [tabId]
  //   subscriber: items {itemId: {tabId, url, title}}, dismissed [itemId]
  // }

  function loadState() {
    try {
      const s = JSON.parse(Services.prefs.getStringPref(PREF_STATE, "{}"));
      return s && typeof s.folders === "object" ? s : { folders: {} };
    } catch {
      return { folders: {} };
    }
  }

  // Read-modify-write; all chrome windows share one thread, so this is atomic.
  function updateState(fn) {
    const s = loadState();
    const r = fn(s);
    Services.prefs.setStringPref(PREF_STATE, JSON.stringify(s));
    return r;
  }

  const entryFor = (folderId) => loadState().folders[folderId] || null;

  function findSubscription(server, remoteId) {
    for (const [id, e] of Object.entries(loadState().folders)) {
      if (e.server === server && e.remoteId === remoteId) return { id, entry: e };
    }
    return null;
  }

  // --- Server --------------------------------------------------------------

  async function api(server, path, { method = "GET", body, token } = {}) {
    const headers = { "content-type": "application/json" };
    if (token) headers["x-owner-token"] = token;
    let res;
    try {
      res = await fetch(server + path, { method, headers, body: body && JSON.stringify(body), cache: "no-store" });
    } catch (e) {
      return { status: 0, data: null, error: "network" };
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* empty or non-JSON */ }
    return { status: res.status, data };
  }

  function serverUrl({ ask = false } = {}) {
    let url = (Services.prefs.getStringPref(PREF_SERVER, "").trim() || DEFAULT_SERVER).replace(/\/+$/, "");
    if (!url && ask) {
      const input = { value: "https://" };
      const ok = Services.prompt.prompt(
        window,
        "Shareable Folders",
        "Enter the URL of your Shareable Folders server (the Cloudflare Worker you deployed, e.g. https://zen-shareable-folders.you.workers.dev):",
        input, null, {},
      );
      if (!ok) return "";
      url = input.value.trim().replace(/\/+$/, "");
      if (!/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
        Services.prompt.alert(window, "Shareable Folders", "That doesn't look like a server URL (https://host, no path).");
        return "";
      }
      Services.prefs.setStringPref(PREF_SERVER, url);
    }
    return url;
  }

  // Owner tokens live in the password manager, never in prefs.
  const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");

  async function findLogin(server, remoteId) {
    const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: server });
    return logins.find((l) => l.username === remoteId) || null;
  }
  async function saveToken(server, remoteId, token) {
    await Services.logins.addLoginAsync(new LoginInfo(LOGIN_ORIGIN, null, server, remoteId, token, "", ""));
  }
  async function getToken(server, remoteId) {
    return (await findLogin(server, remoteId))?.password || null;
  }
  async function forgetToken(server, remoteId) {
    const login = await findLogin(server, remoteId);
    if (login) Services.logins.removeLogin(login);
  }

  // --- Owner: building snapshots -------------------------------------------

  function readFolderTabs(folder) {
    return Zen.folderTabs(folder)
      .map((tab) => ({ id: Zen.tabId(tab), url: Zen.tabUrl(tab), title: Zen.tabTitle(tab) }))
      .filter((t) => t.id && /^[A-Za-z0-9_-]{1,64}$/.test(t.id) && Core.isSafeUrl(t.url));
  }

  const warnPrivate = () => Services.prefs.getBoolPref(PREF_WARN, true);

  function privateTabs(tabs, allowed = []) {
    if (!warnPrivate()) return [];
    return tabs
      .filter((t) => !allowed.includes(t.id))
      .map((t) => ({ ...t, reason: Core.privateUrlReason(t.url) }))
      .filter((t) => t.reason);
  }

  // --- Owner: share / stop -------------------------------------------------

  async function shareFolder(folder) {
    const server = serverUrl({ ask: true });
    if (!server) return;
    const tabs = readFolderTabs(folder);
    const allowed = [];
    let shared = tabs;

    const risky = privateTabs(tabs);
    if (risky.length) {
      const list = risky.slice(0, 8).map((t) => `• ${t.title || t.url} — ${t.reason}`).join("\n");
      const more = risky.length > 8 ? `\n…and ${risky.length - 8} more` : "";
      const flags =
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL +
        Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING;
      const choice = Services.prompt.confirmEx(
        window, "Shareable Folders",
        `${risky.length} tab(s) may contain private information (login tokens, internal addresses):\n\n${list}${more}\n\nAnyone with the link will see these URLs.`,
        flags, "Leave them out", null, "Share them anyway", null, {},
      );
      if (choice === 1) return;
      if (choice === 2) allowed.push(...risky.map((t) => t.id));
      else shared = tabs.filter((t) => !risky.some((r) => r.id === t.id));
    }

    const snap = Core.buildSnapshot({ name: Zen.folderName(folder), icon: Zen.folderIcon(folder), tabs: shared });
    const res = await api(server, "/api/folders", { method: "POST", body: snap });
    if (res.status !== 201) {
      showError(res, "Couldn't share the folder");
      return;
    }
    const { id: remoteId, ownerToken, url } = res.data;
    try {
      await saveToken(server, remoteId, ownerToken);
    } catch (e) {
      console.error(e);
      Services.prompt.alert(window, "Shareable Folders", "Couldn't save the owner token in the password manager, so the folder can't be kept live. Sharing was cancelled.");
      api(server, `/api/folders/${remoteId}`, { method: "DELETE", token: ownerToken });
      return;
    }
    updateState((s) => {
      s.folders[Zen.folderId(folder)] = {
        role: "owner", server, remoteId, name: snap.name, version: res.data.folder.version,
        orders: Object.fromEntries(snap.items.map((i) => [i.id, i.order])),
        lastKey: Core.snapshotKey(snap),
        allowed,
      };
    });
    Zen.copyToClipboard(url);
    Zen.showLinkCopied();
    log("shared", folder.label, url);
  }

  function copyLink(folderId) {
    const e = entryFor(folderId);
    if (!e) return;
    Zen.copyToClipboard(`${e.server}/f/${e.remoteId}`);
    Zen.showLinkCopied();
  }

  async function stopSharing(folderId) {
    const e = entryFor(folderId);
    if (!e || e.role !== "owner") return;
    const ok = Services.prompt.confirm(
      window, "Stop sharing",
      `Stop sharing "${e.name}"? The link will stop working and subscribers keep their current copy as a normal folder.`,
    );
    if (!ok) return;
    const token = await getToken(e.server, e.remoteId);
    if (token) {
      const res = await api(e.server, `/api/folders/${e.remoteId}`, { method: "DELETE", token });
      if (res.status !== 200 && res.status !== 404) {
        showError(res, "Couldn't stop sharing");
        return;
      }
    }
    await forgetToken(e.server, e.remoteId);
    updateState((s) => delete s.folders[folderId]);
  }

  function unsubscribe(folderId) {
    updateState((s) => delete s.folders[folderId]);
  }

  function showError(res, what) {
    const why =
      res.status === 0 ? "you seem to be offline or the server can't be reached"
      : res.status === 429 ? "too many requests, try again in a minute"
      : res.data?.error || `server error ${res.status}`;
    Zen.showWindowBar("zsf-error", `${what}: ${why}.`, [], { timeout: 10_000, warning: true });
  }

  // --- Subscriber: share page detection and subscribing --------------------

  async function onLocation(browser, spec) {
    Zen.closePageBar(browser, "zsf-subscribe");
    const share = Core.parseShareUrl(spec);
    if (!share) return;
    const res = await api(share.origin, `/api/folders/${share.id}`);
    if (res.status !== 200 || !Core.looksLikeFolder(res.data, share.id)) return;
    if (browser.currentURI?.spec !== spec) return; // navigated away meanwhile

    const existing = findSubscription(share.origin, share.id);
    const n = res.data.items.length;
    if (existing?.entry.role === "owner") {
      Zen.showPageBar(browser, "zsf-subscribe", `This is your live folder "${res.data.name}".`, []);
      return;
    }
    if (existing) {
      Zen.showPageBar(browser, "zsf-subscribe", `"${res.data.name}" is already in your sidebar as a live folder.`, []);
      return;
    }
    Zen.showPageBar(browser, "zsf-subscribe", `Add "${res.data.name}" (${n} tab${n === 1 ? "" : "s"}) to Zen as a live folder?`, [
      {
        label: "Add to Zen",
        accessKey: "A",
        callback: () => {
          subscribe(share.origin, share.id);
          return false;
        },
      },
    ]);
  }

  async function subscribe(server, remoteId) {
    if (findSubscription(server, remoteId)) return;
    const res = await api(server, `/api/folders/${remoteId}`);
    if (res.status !== 200 || !Core.looksLikeFolder(res.data, remoteId)) {
      showError(res, "Couldn't add the folder");
      return;
    }
    const remote = res.data;
    const items = {};
    Leader.applying++;
    try {
      const folder = Zen.createFolder(remote.name, remote.icon);
      for (const item of [...remote.items].sort((a, b) => (a.order < b.order ? -1 : 1))) {
        if (!Core.isSafeUrl(item.url)) continue;
        const tab = Zen.createTab(folder, item);
        const tabId = Zen.tabId(tab);
        if (tabId) items[item.id] = { tabId, url: item.url, title: item.title };
      }
      updateState((s) => {
        s.folders[Zen.folderId(folder)] = {
          role: "subscriber", server, remoteId, name: remote.name, version: remote.version, items, dismissed: [],
        };
      });
    } finally {
      Leader.applying--;
    }
    log("subscribed", remote.name);
  }

  // --- Leader: pushing, live sockets, applying updates ---------------------
  // Only one window runs this; the rest mirror tabs through Zen's window sync.

  const Leader = {
    running: false,
    applying: 0,
    pushTimer: null,
    pushAttempt: 0,
    pushing: false,
    tickTimer: null,
    sockets: new Map(), // folderId -> { ws, attempt, retryTimer, lastPoll, key }
    remoteCache: new Map(), // folderId -> last folder JSON from server
    warnedPrivate: new Set(),
    stopListeners: [],

    async start() {
      if (this.running) return;
      this.running = true;
      log("sync running in this window");
      const onChange = () => {
        if (!this.applying) this.schedulePush();
      };
      for (const type of Zen.CHANGE_EVENTS) window.addEventListener(type, onChange);
      this.stopListeners.push(() => Zen.CHANGE_EVENTS.forEach((t) => window.removeEventListener(t, onChange)));
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
      this.reconcile();
      this.schedulePush(0);
    },

    stop() {
      if (!this.running) return;
      this.running = false;
      this.stopListeners.forEach((f) => f());
      this.stopListeners = [];
      clearInterval(this.tickTimer);
      clearTimeout(this.pushTimer);
      for (const id of [...this.sockets.keys()]) this.closeSocket(id);
    },

    // Called when state changes (any window) and on start.
    reconcile() {
      if (!this.running) return;
      const { folders } = loadState();
      for (const id of [...this.sockets.keys()]) {
        const e = folders[id];
        if (!e || e.role !== "subscriber" || this.sockets.get(id).key !== `${e.server}|${e.remoteId}`) this.closeSocket(id);
      }
      for (const [id, e] of Object.entries(folders)) {
        if (e.role === "subscriber" && !this.sockets.has(id)) {
          this.poll(id);
          this.openSocket(id, e);
        }
      }
    },

    tick() {
      const { folders } = loadState();
      const now = Date.now();
      for (const [id, e] of Object.entries(folders)) {
        if (e.role !== "subscriber") continue;
        const s = this.sockets.get(id);
        if (s?.ws?.readyState === WebSocket.OPEN) {
          s.ws.send("ping");
          // Re-apply the last version: finishes changes deferred because a tab was in use.
          const cached = this.remoteCache.get(id);
          if (cached) this.apply(id, cached);
        } else if (!s || now - (s.lastPoll || 0) >= POLL_MS) {
          this.poll(id);
        }
      }
      // Catches changes no event reports (e.g. "replace pinned URL").
      this.schedulePush(0);
    },

    // --- owner side ---

    schedulePush(delay = PUSH_DEBOUNCE_MS) {
      if (!this.running) return;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.pushAll(), delay);
    },

    async pushAll() {
      if (this.pushing) return this.schedulePush();
      this.pushing = true;
      let retry = false;
      try {
        for (const [id, e] of Object.entries(loadState().folders)) {
          if (e.role !== "owner" || e.broken) continue;
          const result = await this.pushOne(id, e);
          if (result === "retry") retry = true;
        }
      } finally {
        this.pushing = false;
      }
      if (retry) {
        const delay = Core.backoff(this.pushAttempt++, 5000);
        log(`push failed, retrying in ${Math.round(delay / 1000)}s`);
        this.schedulePush(delay);
      } else {
        this.pushAttempt = 0;
      }
    },

    async pushOne(folderId, e) {
      const folder = Zen.getFolder(folderId);
      if (!folder) {
        this.warnOrphan(folderId, e);
        return "ok";
      }
      let tabs = readFolderTabs(folder);
      const risky = privateTabs(tabs, e.allowed || []);
      if (risky.length) {
        tabs = tabs.filter((t) => !risky.some((r) => r.id === t.id));
        for (const t of risky) this.warnExcluded(folderId, t);
      }
      const snap = Core.buildSnapshot({ name: Zen.folderName(folder), icon: Zen.folderIcon(folder), tabs, prevOrders: e.orders });
      const key = Core.snapshotKey(snap);
      if (key === e.lastKey) return "ok";

      const token = await getToken(e.server, e.remoteId);
      if (!token) {
        this.markBroken(folderId, `The owner token for "${e.name}" is missing from the password manager, so changes can't be sent.`);
        return "ok";
      }
      let res = await api(e.server, `/api/folders/${e.remoteId}`, { method: "PUT", token, body: { ...snap, baseVersion: e.version } });
      if (res.status === 409 && Number.isInteger(res.data?.currentVersion)) {
        // v1 has a single writer, so the local folder wins.
        res = await api(e.server, `/api/folders/${e.remoteId}`, { method: "PUT", token, body: { ...snap, baseVersion: res.data.currentVersion } });
      }
      if (res.status === 200) {
        updateState((s) => {
          const cur = s.folders[folderId];
          if (!cur) return;
          cur.version = res.data.version;
          cur.name = snap.name;
          cur.orders = Object.fromEntries(snap.items.map((i) => [i.id, i.order]));
          cur.lastKey = key;
        });
        return "ok";
      }
      if (res.status === 404) {
        await forgetToken(e.server, e.remoteId);
        updateState((s) => delete s.folders[folderId]);
        Zen.showWindowBar("zsf-gone", `"${e.name}" no longer exists on the server, so it stopped being shared.`, [], { warning: true });
        return "ok";
      }
      if (res.status === 401) {
        this.markBroken(folderId, `The server rejected the owner token for "${e.name}". Stop sharing and share it again.`);
        return "ok";
      }
      if (res.status === 400) {
        this.markBroken(folderId, `The server refused an update to "${e.name}": ${res.data?.error || "invalid data"}.`);
        return "ok";
      }
      return "retry"; // offline, rate limited or server error
    },

    markBroken(folderId, message) {
      updateState((s) => s.folders[folderId] && (s.folders[folderId].broken = true));
      Zen.showWindowBar("zsf-broken", message, [], { warning: true });
    },

    // The owner deleted a shared folder; the link still works until they stop it.
    warnOrphan(folderId, e) {
      if (this.warnedPrivate.has(`orphan|${folderId}`)) return;
      this.warnedPrivate.add(`orphan|${folderId}`);
      Zen.showWindowBar(
        `zsf-orphan-${folderId}`,
        `You deleted the live folder "${e.name}", but its link still works.`,
        [{ label: "Stop sharing", accessKey: "S", callback: () => void stopSharing(folderId) }],
      );
    },

    warnExcluded(folderId, tab) {
      const key = `${folderId}|${tab.id}|${tab.url}`;
      if (this.warnedPrivate.has(key)) return;
      this.warnedPrivate.add(key);
      Zen.showWindowBar(
        "zsf-private",
        `"${tab.title || tab.url}" wasn't shared: its URL ${tab.reason}.`,
        [{
          label: "Share it anyway",
          accessKey: "S",
          callback: () => {
            updateState((s) => {
              const e = s.folders[folderId];
              if (e && !e.allowed.includes(tab.id)) e.allowed.push(tab.id);
            });
            this.schedulePush(0);
          },
        }],
        { warning: true },
      );
    },

    // --- subscriber side ---

    async poll(folderId) {
      const e = entryFor(folderId);
      if (!e || e.role !== "subscriber") return;
      const s = this.sockets.get(folderId);
      if (s) s.lastPoll = Date.now();
      const res = await api(e.server, `/api/folders/${e.remoteId}`);
      if (res.status === 200 && Core.looksLikeFolder(res.data, e.remoteId)) this.apply(folderId, res.data);
      else if (res.status === 404) this.ended(folderId);
    },

    openSocket(folderId, e) {
      const state = this.sockets.get(folderId) || { attempt: 0, lastPoll: Date.now(), key: `${e.server}|${e.remoteId}` };
      this.sockets.set(folderId, state);
      const ws = new WebSocket(`${e.server.replace(/^http/, "ws")}/api/folders/${e.remoteId}/live`);
      state.ws = ws;
      ws.onopen = () => (state.attempt = 0);
      ws.onmessage = (msg) => {
        let m;
        try {
          m = JSON.parse(msg.data);
        } catch {
          return; // "pong"
        }
        if (m.type === "update" && Core.looksLikeFolder(m.folder, e.remoteId)) this.apply(folderId, m.folder);
        if (m.type === "deleted") this.ended(folderId);
      };
      ws.onclose = () => {
        if (this.sockets.get(folderId) !== state || !this.running) return;
        state.ws = null;
        const delay = Core.backoff(state.attempt++, 1000, 60_000);
        state.retryTimer = setTimeout(() => {
          const cur = entryFor(folderId);
          if (cur?.role === "subscriber" && this.sockets.get(folderId) === state) this.openSocket(folderId, cur);
        }, delay);
      };
    },

    closeSocket(folderId) {
      const s = this.sockets.get(folderId);
      this.sockets.delete(folderId);
      this.remoteCache.delete(folderId);
      if (!s) return;
      clearTimeout(s.retryTimer);
      try {
        s.ws?.close();
      } catch { /* already closed */ }
    },

    ended(folderId) {
      const e = entryFor(folderId);
      if (!e) return;
      updateState((s) => delete s.folders[folderId]);
      Zen.showWindowBar("zsf-ended", `"${e.name}" is no longer shared by its owner. Your copy was kept as a normal folder.`);
    },

    apply(folderId, remote) {
      const e = entryFor(folderId);
      if (!e || e.role !== "subscriber" || remote.version < e.version) return;
      const folder = Zen.getFolder(folderId);
      if (!folder) {
        // The subscriber deleted the folder: stop following it.
        updateState((s) => delete s.folders[folderId]);
        return;
      }
      this.remoteCache.set(folderId, remote);
      const items = { ...(e.items || {}) };
      const dismissed = new Set(e.dismissed || []);
      const tabOf = (itemId) => {
        const tab = Zen.getTab(items[itemId]?.tabId);
        return tab && Zen.folderOfTab(tab) === folder ? tab : null;
      };
      const present = new Set(Object.keys(items).filter((id) => tabOf(id)));
      const safeRemote = remote.items.filter((i) => Core.isSafeUrl(i.url)).slice(0, 500);
      const d = Core.diffFolder(items, present, dismissed, safeRemote);

      this.applying++;
      try {
        for (const id of d.closedByUser) {
          dismissed.add(id);
          delete items[id];
        }
        for (const id of d.remove) {
          const tab = tabOf(id);
          delete items[id];
          if (Zen.isTabInUse(tab)) tab.setAttribute("zsf-removed", "true");
          else Zen.removeTab(tab);
        }
        for (const item of d.update) {
          const tab = tabOf(item.id);
          const mine = items[item.id];
          if (mine.url !== item.url) {
            if (Zen.isTabInUse(tab)) continue; // retried on a later tick
            const fresh = Zen.createTab(folder, item, tab);
            Zen.removeTab(tab);
            items[item.id] = { tabId: Zen.tabId(fresh), url: item.url, title: item.title };
          } else {
            Zen.setUnloadedTabTitle(tab, item.title);
            items[item.id] = { ...mine, title: item.title };
          }
        }
        for (const item of d.add) {
          const tab = Zen.createTab(folder, item);
          const tabId = Zen.tabId(tab);
          if (tabId) items[item.id] = { tabId, url: item.url, title: item.title };
        }
        // Reorder the tracked tabs; tabs the subscriber added stay where they are.
        const ordered = d.order.map((id) => tabOf(id)).filter(Boolean);
        for (let i = 1; i < ordered.length; i++) Zen.moveTabAfter(ordered[i], ordered[i - 1]);

        Zen.renameFolder(folder, remote.name);
        Zen.setFolderIcon(folder, remote.icon);
      } catch (err) {
        console.error("Shareable Folders: failed to apply update", err);
      } finally {
        this.applying--;
      }

      const next = { items, dismissed: [...dismissed], version: remote.version, name: remote.name };
      const prev = { items: e.items || {}, dismissed: e.dismissed || [], version: e.version, name: e.name };
      if (JSON.stringify(next) === JSON.stringify(prev)) return;
      updateState((s) => s.folders[folderId] && Object.assign(s.folders[folderId], next));
    },
  };

  // --- Per-window UI -------------------------------------------------------

  function refreshBadges() {
    const { folders } = loadState();
    for (const folder of Zen.allFolders()) {
      const e = folders[Zen.folderId(folder)];
      if (e) folder.setAttribute("zsf-live", e.role);
      else folder.removeAttribute("zsf-live");
      if (e?.broken) folder.setAttribute("zsf-broken", "true");
      else folder.removeAttribute("zsf-broken");
    }
  }

  function initMenu() {
    const menu = Zen.folderMenu();
    if (!menu) {
      console.warn("Shareable Folders: folder context menu not found");
      return;
    }
    const make = (id, label, onCommand) => {
      const item = document.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("label", label);
      item.addEventListener("command", () => menuFolder && onCommand(menuFolder));
      return item;
    };
    let menuFolder = null;
    const items = {
      share: make("zsf-share", "Share live folder", (f) => shareFolder(f)),
      copy: make("zsf-copy", "Copy live folder link", (f) => copyLink(f.id)),
      stop: make("zsf-stop", "Stop sharing live folder", (f) => stopSharing(f.id)),
      unsub: make("zsf-unsubscribe", "Unsubscribe (keep tabs)", (f) => unsubscribe(f.id)),
    };
    const sep = document.createXULElement("menuseparator");
    sep.id = "zsf-separator";
    const anchor = document.getElementById("context_zenShareFolder");
    const frag = [sep, ...Object.values(items)];
    if (anchor?.parentElement === menu) anchor.after(...frag);
    else menu.append(...frag);

    menu.addEventListener("popupshowing", (event) => {
      if (event.target !== menu) return;
      menuFolder = Zen.folderFromMenuEvent(event);
      const e = menuFolder ? entryFor(menuFolder.id) : null;
      items.share.hidden = !menuFolder || !!e;
      items.copy.hidden = !e;
      items.stop.hidden = e?.role !== "owner";
      items.unsub.hidden = e?.role !== "subscriber";
      sep.hidden = !menuFolder;
    });
  }

  // For the Browser Console and the test harness.
  window.ZSFDebug = { loadState, shareFolder, stopSharing, subscribe, unsubscribe, onLocation, Leader };

  // --- Startup -------------------------------------------------------------

  Zen.whenReady().then(() => {
    initMenu();
    refreshBadges();

    const prefObserver = { observe: () => (refreshBadges(), Leader.reconcile()) };
    Services.prefs.addObserver(PREF_STATE, prefObserver);
    const stopLocation = Zen.addLocationListener((browser, spec) => onLocation(browser, spec).catch(console.error));
    const onGroupCreate = () => refreshBadges();
    window.addEventListener("TabGroupCreate", onGroupCreate);

    const electLeader = () => {
      refreshBadges(); // folders synced in from other windows need the badge too
      const lead = Zen.isLeaderWindow();
      if (lead && !Leader.running) Leader.start();
      else if (!lead && Leader.running) Leader.stop();
    };
    electLeader();
    const electTimer = setInterval(electLeader, 5000);

    window.addEventListener("unload", () => {
      clearInterval(electTimer);
      Leader.stop();
      stopLocation();
      Services.prefs.removeObserver(PREF_STATE, prefObserver);
      window.removeEventListener("TabGroupCreate", onGroupCreate);
    }, { once: true });
  }).catch((e) => console.error("Shareable Folders failed to start", e));
})();
