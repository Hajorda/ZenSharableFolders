// Shareable Folders — every call into Zen/Firefox internals lives here, so a
// Zen update that renames something only needs fixing in this file.
// Checked against zen-browser/desktop @ 13d57d0 (2026-09-29).
//
// Internals relied on:
//   gZenFolders.createFolder / setFolderUserIcon, <zen-folder>.allItems / addTabs /
//   .name / .iconURL / .isZenFolder, gZenWorkspaces.{activeWorkspace,
//   promiseInitialized, privateWindowOrDisabled, getWorkspaceFromId},
//   gBrowser.{addTrustedTab, pinTab, removeTab, zenHandleTabMove, _setTabLabel},
//   tab.{id (Zen sync id), zenStaticLabel, _zenPinnedInitialState},
//   resource:///modules/zen/ZenWindowSync.sys.mjs (firstSyncedWindow),
//   the #zenFolderActions context menu.
// eslint-disable-next-line no-var
var ZSFZen = (() => {
  "use strict";

  let windowSync = null;
  try {
    ({ ZenWindowSync: windowSync } = ChromeUtils.importESModule("resource:///modules/zen/ZenWindowSync.sys.mjs"));
  } catch (e) {
    console.warn("Shareable Folders: ZenWindowSync not found, falling back to window enumeration", e);
  }

  const isFolder = (el) => !!el?.isZenFolder;

  return {
    // --- Environment ---------------------------------------------------------

    get supported() {
      return typeof gZenFolders !== "undefined" && typeof gZenWorkspaces !== "undefined" && !gZenWorkspaces.privateWindowOrDisabled;
    },

    async whenReady() {
      await window.delayedStartupPromise;
      await gZenWorkspaces.promiseInitialized;
      await SessionStore.promiseAllWindowsRestored;
    },

    // One window does the syncing; the others see changes via Zen's window sync.
    isLeaderWindow() {
      const first = windowSync?.firstSyncedWindow;
      if (first) return first === window;
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (!win.closed && win.gZenWorkspaces && !win.gZenWorkspaces.privateWindowOrDisabled) return win === window;
      }
      return false;
    },

    // --- Folders -------------------------------------------------------------

    getFolder(id) {
      const el = id ? document.getElementById(id) : null;
      return isFolder(el) ? el : null;
    },

    allFolders() {
      return [...gBrowser.tabContainer.querySelectorAll("zen-folder")].filter(isFolder);
    },

    folderId: (folder) => folder.id,
    folderName: (folder) => folder.label || "Folder",
    // Only Zen's built-in chrome:// icons are portable between browsers.
    folderIcon: (folder) => (/^chrome:\/\//.test(folder.iconURL || "") ? folder.iconURL : ""),

    // The folder a tab sits in directly (split views inside a folder count).
    folderOfTab(tab) {
      let g = tab?.group;
      if (g && !isFolder(g) && isFolder(g.group)) g = g.group;
      return isFolder(g) ? g : null;
    },

    hasSubfolders: (folder) => folder.allItems.some(isFolder),

    // Tabs directly in the folder, in sidebar order. Subfolders are skipped (v1).
    folderTabs(folder) {
      const tabs = [];
      for (const item of folder.allItems) {
        if (gBrowser.isTab(item)) tabs.push(item);
        else if (gBrowser.isTabGroup(item) && item.hasAttribute("split-view-group")) tabs.push(...item.tabs);
      }
      return tabs.filter((t) => !t.hasAttribute("zen-empty-tab") && !t.hasAttribute("zen-glance-tab"));
    },

    createFolder(name, icon) {
      const folder = gZenFolders.createFolder([], {
        label: name,
        collapsed: true,
        workspaceId: gZenWorkspaces.activeWorkspace,
      });
      if (icon && /^chrome:\/\//.test(icon)) gZenFolders.setFolderUserIcon(folder, icon);
      return folder;
    },

    renameFolder(folder, name) {
      if (folder.label === name) return;
      try {
        folder.name = name;
      } catch {
        folder.label = name;
      }
    },

    setFolderIcon(folder, icon) {
      if (icon && /^chrome:\/\//.test(icon) && folder.iconURL !== icon) gZenFolders.setFolderUserIcon(folder, icon);
    },

    // --- Tabs ----------------------------------------------------------------

    tabId: (tab) => tab.id || null,
    getTab(id) {
      const el = id ? document.getElementById(id) : null;
      return el && gBrowser.isTab(el) ? el : null;
    },

    // The pinned "home" URL, so browsing inside a shared tab doesn't change what's shared.
    tabUrl(tab) {
      return tab._zenPinnedInitialState?.entry?.url || tab.linkedBrowser?.currentURI?.spec || "";
    },

    tabTitle(tab) {
      if (typeof tab.zenStaticLabel === "string" && tab.zenStaticLabel) return tab.zenStaticLabel;
      return tab._zenPinnedInitialState?.entry?.title || tab.label || "";
    },

    isTabInUse(tab) {
      return tab.selected || (!!tab.linkedPanel && !tab.hasAttribute("pending"));
    },

    createTab(folder, item, beforeTab = null) {
      const workspaceId = folder.getAttribute("zen-workspace-id") || gZenWorkspaces.activeWorkspace;
      const userContextId = gZenWorkspaces.getWorkspaceFromId(workspaceId)?.containerTabId || 0;
      const tab = gBrowser.addTrustedTab(item.url, {
        createLazyBrowser: true,
        inBackground: true,
        skipAnimation: true,
        skipBackgroundNotify: true,
        lazyTabTitle: item.title || undefined,
        skipRoute: true,
        userContextId,
      });
      tab.setAttribute("zen-workspace-id", workspaceId);
      gBrowser.pinTab(tab);
      folder.addTabs([tab]);
      if (beforeTab) this.moveTabBefore(tab, beforeTab);
      return tab;
    },

    removeTab(tab) {
      gBrowser.removeTab(tab, { animate: false });
    },

    setUnloadedTabTitle(tab, title) {
      if (this.isTabInUse(tab) || !title) return;
      try {
        gBrowser._setTabLabel(tab, title);
      } catch (e) {
        console.warn("Shareable Folders: could not set tab title", e);
      }
    },

    moveTabBefore(tab, ref) {
      if (tab === ref || tab.nextElementSibling === ref) return;
      gBrowser.zenHandleTabMove(tab, () => ref.before(tab));
    },

    moveTabAfter(tab, ref) {
      if (tab === ref || ref.nextElementSibling === tab) return;
      gBrowser.zenHandleTabMove(tab, () => ref.after(tab));
    },

    // --- UI ------------------------------------------------------------------

    folderMenu: () => document.getElementById("zenFolderActions"),

    // Same target resolution Zen uses for its own folder menu items.
    folderFromMenuEvent(event) {
      const menu = this.folderMenu();
      const target = event.target === menu ? (menu.triggerNode ?? event.explicitOriginalTarget) : event.explicitOriginalTarget;
      if (!target) return null;
      if (gBrowser.isTabGroupLabel(target)) return isFolder(target.group) ? target.group : null;
      if (gBrowser.isTabGroupLabel(target.parentElement)) return isFolder(target.parentElement.group) ? target.parentElement.group : null;
      if (isFolder(target.parentElement) && target.classList?.contains("tab-group-label-container")) return target.parentElement;
      return null;
    },

    // Info bar above one page (used on share pages).
    async showPageBar(browser, value, label, buttons) {
      const box = gBrowser.getNotificationBox(browser);
      box.getNotificationWithValue(value)?.close();
      return box.appendNotification(value, { label, priority: box.PRIORITY_INFO_HIGH }, buttons);
    },

    closePageBar(browser, value) {
      gBrowser.getNotificationBox(browser).getNotificationWithValue(value)?.close();
    },

    // Info bar at the top of the window.
    async showWindowBar(value, label, buttons = [], { timeout = 0, warning = false } = {}) {
      const box = gNotificationBox;
      box.getNotificationWithValue(value)?.close();
      const n = await box.appendNotification(
        value,
        { label, priority: warning ? box.PRIORITY_WARNING_MEDIUM : box.PRIORITY_INFO_MEDIUM },
        buttons,
      );
      if (timeout) setTimeout(() => n?.close(), timeout);
      return n;
    },

    showLinkCopied() {
      try {
        gZenUIManager.showToast("zen-share-link-copied-toast", { timeout: 4000 });
      } catch {
        this.showWindowBar("zsf-copied", "Live folder link copied to the clipboard.", [], { timeout: 5000 });
      }
    },

    copyToClipboard(text) {
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    },

    addLocationListener(fn) {
      const listener = {
        onLocationChange(browser, webProgress, request, location) {
          if (webProgress.isTopLevel) fn(browser, location.spec);
        },
      };
      gBrowser.addTabsProgressListener(listener);
      return () => gBrowser.removeTabsProgressListener(listener);
    },

    // Events that can change a shared folder's contents.
    CHANGE_EVENTS: [
      "TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned", "TabAttrModified",
      "TabGrouped", "TabUngrouped", "TabGroupUpdate", "TabGroupMoved", "TabGroupRemoved",
      "ZenTabLabelChanged", "ZenTabIconChanged", "ZenFolderRenamed", "FolderGrouped", "FolderUngrouped",
    ],
  };
})();
