# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # Node >= 20 required (CI runs 22.x)
npm start              # runs server.js, reads .env (copy from .env.example first)
npm test               # jest --runInBand
npx jest tests/api.test.js -t "should setup and terminate a client session"   # single test
npx eslint .           # eslint-config-standard via .eslintrc.js; no npm script for it
npm run swagger        # regenerates swagger.json from src/routes.js
```

Tests launch **real Chromium instances** through puppeteer and reach WhatsApp Web, so they are slow
(`jest.setTimeout` is 5 minutes) and must stay serial (`--runInBand`). They write to `./sessions_test`
(`SESSIONS_PATH` override) and delete it in `beforeAll`/`afterAll`.

Lint uses the legacy `.eslintrc.js` format, so it only works with the pinned local eslint 8 —
run `npm install` first; a globally resolved eslint 9+ will refuse the config.

`swagger.json` is generated and committed. After changing routes, controllers, or any `#swagger.*`
comment, re-run `npm run swagger` — the spec is built by scanning `src/routes.js` and the handlers it
references.

## Architecture

REST/WebSocket wrapper around [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js). Each
"session" is one `Client` backed by its own headless Chromium, keyed by a caller-chosen `sessionId`.

**Boot path:** `server.js` → `src/app.js` (Express, CORS, body limits, mounts `routes` at `basePath`) →
`src/routes.js`. `server.js` also attaches `handleUpgrade` for WebSockets and calls `restoreSessions()`
when `AUTO_START_SESSIONS` is on.

**`src/config.js` is the only place env vars are parsed.** Everything else imports named constants from
it rather than reading `process.env`. Two deliberate exceptions: `ALLOWED_ORIGINS` (read in `app.js`)
and the per-session webhook override `<SESSIONID>_WEBHOOK_URL` (read in `sessions.js`, since the name
is dynamic). New settings go in `config.js` *and* `.env.example`.

**`src/sessions.js` is the core.** It owns the `sessions` Map (`sessionId` → `Client`) that every
controller reads from.

- `setupSession` builds the puppeteer arg list, wires `LocalAuth` (its `logout` is deliberately
  stubbed out so folder deletion is handled here instead), optionally injects `--proxy-server` /
  `proxyAuthentication`, applies `webVersionCache`, and removes a stale `SingletonLock` file when
  `RELEASE_BROWSER_LOCK` is set.
- `initializeEvents` wires every whatsapp-web.js event to **both** `triggerWebhook` and
  `triggerWebSocket`, each guarded by `isEventEnabled(...)` (driven by `DISABLED_CALLBACKS`). Adding a
  new event means: add the guarded pair here and list the event name in the `.env.example` callback
  list. `message` additionally emits a synthetic `media` event when the attachment is under
  `MAX_ATTACHMENT_SIZE`.
- With `RECOVER_SESSIONS`, `pupPage` `close`/`error` listeners auto-restart the session.
- Four distinct teardown paths, easy to mix up: `destroySession` (stop, session folder kept),
  `reloadSession` (restart reusing browser cache), `deleteSession` (logout/destroy + delete the session
  folder, with a traversal check), `flushSessions(deleteOnlyInactive)`.

**`src/utils.js` → `patchWWebLibrary`** monkey-patches `Client.prototype.getChats`,
`Chat.prototype.fetchMessages`, `window.WWebJS.getChats`, `getChatModel` and `getMessageModel` inside
the page; it runs once per session on `ready`. These are upstream hotfixes — re-check them whenever
whatsapp-web.js is upgraded (the `edge` Docker tag and the daily CI job build against upstream `main`
precisely to catch breakage).

Most of that patch works around WhatsApp's **LID migration**. Two facts drive it:

- Message keys now expose `$1` instead of `_serialized`. Reading the old name yields `undefined`,
  which reaches IndexedDB as a missing key and throws `Failed to execute 'get' on 'IDBObjectStore'`.
  Puppeteer surfaces that as a minified `r`/`t`, which is where `{"success":false,"error":"r"}` came
  from. The patch restores `_serialized` as a getter on `WAWebMsgKey` and mirrors `$1` onto message
  models so API consumers keep the id field they have always received.
- Chat and participant ids can be `@lid` rather than `@c.us`, and per-chat lookups fail for some of
  them. Anything that maps a collection must therefore degrade per item instead of rejecting the
  batch — a bare `Promise.all` over `getChatModel` took down the entire chat listing.

When debugging these, set `LOG_LEVEL=debug`: the in-page `console.warn` calls in the patch are
forwarded by the `pupPage` console listener (which `RECOVER_SESSIONS` installs) and carry the real
un-minified error text, which the API response never does.

**Routing/middleware convention (`src/routes.js`):** one `express.Router` per domain — `/session`,
`/client`, `/chat`, `/groupChat`, `/message`, `/contact`, `/channel`. Each router does
`.use(middleware.apikey)`; each route lists `[middleware.sessionNameValidation,
middleware.sessionValidation]`. `sessionValidation` guarantees the client exists and is `CONNECTED`,
which is why controllers can call `sessions.get(req.params.sessionId)` without null checks. The
`*Swagger` middlewares in `src/middleware.js` are runtime no-ops that exist only to carry
swagger-autogen tag/requestBody comments.

**Controllers** (`src/controllers/`) are thin: pull ids from `req.body`, call the whatsapp-web.js
object, respond `{ success: true, ... }`, and funnel failures through `sendErrorResponse(res, status,
error)`. `clientController.sendMessage` dispatches on a `contentType` discriminator (`string`,
`MessageMedia`, `MessageMediaFromURL`, `Location`, `Contact`, `Poll`). Client/chat/groupChat/message
controllers each expose a `runMethod` escape hatch that invokes an arbitrary named method on the
underlying object — prefer adding a real endpoint over leaning on it.

**Realtime delivery** is dual: webhooks (`axios` POST carrying `x-api-key`, off via `ENABLE_WEBHOOK`)
and WebSockets (`src/websocket.js`, off by default). One `WebSocketServer` is created per session and
stored in `wssMap`; `handleUpgrade` resolves `/ws/:sessionId` (prefixed by `basePath`) and destroys the
socket if no server matches.

**Reverse proxy support:** `BASE_PATH` shifts every route and the WebSocket path; `TRUST_PROXY`
enables Express `trust proxy` so rate limiting keys on the real client IP. See `REVERSE_PROXY_SETUP.md`.

**Dashboard:** `public/dashboard/` is served statically at `/dashboard` only when `ENABLE_WEB_UI` is
true. Its `app.js` derives `API_BASE` from the current path (so it works under `BASE_PATH`) and keeps
its own copy of the session-id regex — keep it in sync with `sessionNameValidation`.

## Release

Docker images publish on tag push: `v*` → `<tag>` + `latest`, `edge` → `edge` built with
`USE_EDGE=true` (installs whatsapp-web.js from upstream `main`). Tests must pass first.
