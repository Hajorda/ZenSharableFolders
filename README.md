# Shareable Folders for Zen

Share a Zen folder as a link. Everyone who adds it sees your changes live — like Arc's shared folders.

- **You (owner):** right-click a folder → **Share live folder**. A link is copied. From then on, adding, closing, renaming or reordering tabs in that folder is pushed automatically.
- **Your friend (subscriber):** opens the link. Zen shows **Add to Zen** at the top of the page; the folder appears in their sidebar and follows your changes.
- **Anyone without the mod** can open the link and use the tabs from the web page.

v1 is read-only for subscribers; only the owner edits.

> Zen also has a built-in **Share** for folders. That one sends a one-time copy; this mod keeps the folder live.

## How it works

```
Owner's Zen ──PUT (debounced snapshot)──▶ Cloudflare Worker ──▶ LiveFolder Durable Object (one per folder)
                                                                   │  stores the folder JSON
Subscriber's Zen ◀──────── WebSocket "update" ─────────────────────┤
Share page /f/:id ◀─────── WebSocket "update" ─────────────────────┘
```

| Part | Where |
| --- | --- |
| Worker: API, share page | [`src/index.js`](src/index.js), [`src/page.js`](src/page.js) |
| Durable Object: storage, owner-token check, broadcasting | [`src/live-folder.js`](src/live-folder.js) |
| Validation (http/https only, sizes) | [`src/validate.js`](src/validate.js) |
| Mod: pure logic (ordering keys, diffing, private-URL check) | [`mod/core.uc.js`](mod/core.uc.js) |
| Mod: **every** Zen-internal call | [`mod/zen-adapter.uc.js`](mod/zen-adapter.uc.js) |
| Mod: sharing, pushing, subscribing, live sync | [`mod/shareable-folders.uc.js`](mod/shareable-folders.uc.js) |

### API

| Method | Endpoint | What it does | Owner token |
| --- | --- | --- | --- |
| POST | `/api/folders` | Create; returns `id`, `ownerToken`, `url` | – |
| GET | `/api/folders/:id` | Current folder JSON | – |
| PUT | `/api/folders/:id` | Replace contents; body includes `baseVersion` (409 if stale) | ✔ |
| DELETE | `/api/folders/:id` | Stop sharing (subscribers get `{"type":"deleted"}`) | ✔ |
| GET | `/api/folders/:id/live` | WebSocket; sends `{"type":"update","folder":…}` | – |
| GET | `/f/:id` | Share page | – |

The owner token goes in the `x-owner-token` header. The server keeps only its SHA-256 hash.

## Setup

### 1. Deploy the backend (free Cloudflare plan)

```sh
npm install
npx wrangler login
npm run deploy        # prints https://zen-shareable-folders.<you>.workers.dev
```

#### Using your own domain

Share links use whatever address the Worker is reached on. To serve it on `folder.hajorda.dev`:

1. `hajorda.dev` must use Cloudflare DNS: in the Cloudflare dashboard, **Add a domain**, then change the nameservers at your registrar to the two Cloudflare gives you. Wait until the domain shows **Active**.
2. `wrangler.toml` already has `routes = [{ pattern = "folder.hajorda.dev", custom_domain = true }]`. Run `npm run deploy`; Cloudflare creates the DNS record and HTTPS certificate.

Links then look like `https://folder.hajorda.dev/f/<id>`. The `workers.dev` address keeps working too; links created through it keep that address.

For local development, `npm run dev` serves on `http://localhost:8787`, and `npm test` runs the test suite (API, share page escaping, the mod's logic, and an owner→subscriber sync simulation).

### 2. Install the mod

1. Install [Sine](https://github.com/CosmoCreeper/Sine) in Zen.
2. In Sine's settings, allow unsafe/unofficial JS mods, then install from this repository's URL.
3. Restart Zen.
4. The mod uses `https://folder.hajorda.dev` by default. If you run your own server, set **Server URL** in the mod's settings in Sine.

Your friends need the mod too. They can follow links from any server, because the server is part of the link.

## Using it

| Action | How |
| --- | --- |
| Share | Right-click a folder → **Share live folder** (link copied) |
| Copy the link again | Right-click → **Copy live folder link** |
| Stop sharing | Right-click → **Stop sharing live folder** |
| Subscribe | Open a link → **Add to Zen** in the bar above the page |
| Unsubscribe | Right-click → **Unsubscribe (keep tabs)** |

A dot after the folder name shows it's live: green = you share it, blue = you follow it, amber = sharing is stuck (see the message bar).

### Behaviour worth knowing

- **What's shared:** each tab's pinned URL and title — not the page you've browsed to inside it, not history, cookies or page content. Subfolders are not shared yet.
- **Private URLs:** before sharing, the mod flags URLs with things like `token=`, `session=`, `key=`, credentials, or local addresses (`localhost`, `192.168.x.x`, `*.local`), and you choose whether to leave them out. Tabs added later that look private are left out with a notice and a **Share it anyway** button. Turn this off in the mod settings.
- **Subscribers:** new tabs arrive unloaded, so a 40-tab folder doesn't load 40 pages. If the owner removes a tab you're using, it's struck through instead of closed. Tabs you close yourself stay closed. Tabs you add are yours and aren't touched.
- **Offline:** the owner's changes are retried with backoff and on the next start. Subscribers catch up on start and poll every 60 s while the live connection is down.
- **Owner token:** stored in Zen's password manager (Settings → Passwords, under `chrome://zen-shareable-folders`), never in prefs. It lives on the device that shared the folder.

### Debugging

With the Browser Toolbox (set `devtools.chrome.enabled` and `devtools.debugger.remote-enabled` in `about:config`), `ZSFDebug.loadState()` shows what the mod tracks. Logs are prefixed `[Shareable Folders]`.

## Security

- Folder ids are 24 random base-62 characters; anyone with the link can view.
- Only `http:` and `https:` URLs are accepted, by the server and again by the subscriber's mod.
- Share page output is escaped, and live updates are rendered with `textContent`.
- Rate limits: 30 updates per minute per folder, 20 new folders per hour per IP (best effort).

## When Zen updates

Zen's folder internals change. Everything the mod depends on is in [`mod/zen-adapter.uc.js`](mod/zen-adapter.uc.js) with a list at the top. It was checked against `zen-browser/desktop` on 2026-09-29. If something breaks, that is the one file to fix. Test on Zen Twilight first.

## Roadmap

- Editors: invite links with their own tokens, operation-based sync with last-writer-wins per item. The order keys are already fractional, so a move changes one key.
- Subfolders inside shared folders.
- Subscriber counts and expiring links.
