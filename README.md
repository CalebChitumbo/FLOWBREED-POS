# Flowbreeds POS

A custom, **offline-first** Point-of-Sale system for **Flowbreeds Farms Shop** (a Zambian
butchery + bakery, multi-branch). Built to the requirements in
`FFS-POS-SRD-001 v1.0`. The business owns the code, can maintain it independently,
and can extend it.

The **local SQLite database is always the source of truth** for the machine; a cloud
database (Firebase, wired in the final phase) is a background backup + multi-branch
sync target and is never required for day-to-day operation.

## Tech stack

| Concern | Choice |
|---|---|
| Shell | Electron 42 (hardened: contextIsolation, sandbox, no nodeIntegration, header CSP, app:// scheme) |
| UI | React 19 + TypeScript + Vite (electron-vite), Mantine, Zustand, React Router |
| Local DB | better-sqlite3 (WAL, foreign keys) in the MAIN process |
| Auth | argon2id hashing, in-memory session tokens, MAIN-side role gate |
| Cloud sync | Pluggable `SyncTransport` — `FirestoreTransport` (firebase-admin) once the Financial Hub is connected, `NullTransport` before |
| Bookkeeping link | `FinancialBridge` — two-way sync with the **Flowbreeds Financial** app (same Firebase project) |
| Printing | ESC/POS via `node-thermal-printer` on Windows; file/preview transport on dev |
| Packaging | electron-builder → Windows NSIS `.exe`; electron-updater (generic host) |
| Tests | Vitest (unit), Playwright `_electron` (e2e) |

## Architecture

Three processes, strictly separated (see `src/`):

- **MAIN** (`src/main`) — owns all I/O + secrets: the single SQLite connection, the
  service layer (`services/`), ESC/POS printing (`printer/`), the sync engine
  (`sync/`), `safeStorage` for cloud credentials, and every `ipcMain.handle`.
- **PRELOAD** (`src/preload`) — exposes one frozen, typed `window.api` over a
  channel allow-list. No Node/SQLite leaks to the renderer.
- **RENDERER** (`src/renderer`) — React UI; talks to MAIN only through `window.api`.

The **one IPC contract** lives in `src/shared/ipc/contract.ts` and types the MAIN
handlers, the preload bridge, and the renderer client so they cannot drift. Every
payload is zod-validated at the MAIN boundary.

**Data:** UUID text primary keys (idempotent cloud sync), money as INTEGER minor
units (ngwee), ISO-8601 UTC timestamps. Schema: `src/main/db/migrations/001_init.sql`
(append-only `audit_log` + `price_history` enforced by triggers). A transactional
**outbox** (`sync_queue`) is written in the same transaction as each domain change.

## Develop (Linux/macOS/Windows)

```bash
npm install
npm run rebuild     # rebuild native modules (better-sqlite3, argon2) for Electron's ABI
npm run dev         # launch the app with HMR
```

> `npm run rebuild` needs to reach the Electron headers server. If that's blocked,
> run it on a machine with normal internet (e.g. your Windows PC or CI). Vitest uses
> the Node ABI and does **not** need the rebuild.

Quality gates:

```bash
npm test            # Vitest unit tests (services, sync, financial bridge, security) — 113 passing
npm run typecheck   # tsc for main/preload + renderer
npm run build       # production bundles
npm run test:e2e    # Playwright Electron smoke test (needs the Electron-ABI rebuild + a display)
```

## Build the Windows installer

Native modules (better-sqlite3, argon2) **cannot be cross-compiled from Linux to
Windows**. Build the installer on Windows or a `windows-latest` CI runner:

```bash
npm ci
npm run build:win   # electron-vite build && electron-builder --win nsis
```

Output: `release/<version>/Flowbreeds POS-Setup-<version>.exe` — a self-contained
installer (bundles the SQLite engine), with desktop + Start-Menu shortcuts and clean
uninstall. Set the `publish.url` in `electron-builder.yml` to your update host before
the first release.

## First run

On first launch the app prompts you to create the **administrator** account (a
default "Main Branch" is created automatically). Sign in, then:

1. **Settings** (admin) — set the branch name, receipt header (business name,
   address, contact), thermal printer name, sync interval, auto-lock timeout, and
   default low-stock threshold.
2. **Products** (manager+) — add products, barcodes (multi-barcode + weight-based),
   prices and categories.
3. **Checkout** — open a till session with a cash float, then scan/sell.

## Roles

- **Cashier** — checkout, payments, receipts, own till session.
- **Manager** — + product management, pricing, stock, discount authorisation,
  reports, close any session.
- **Administrator** — + user management, settings, backup, updates.

## Hardware

- **Barcode scanner**: USB HID (keyboard emulation). Scans into the focused
  Checkout field; Enter (carriage return) looks up the product.
- **Thermal printer**: ESC/POS. On Windows the `PrinterTransport` uses
  `node-thermal-printer`; on dev it writes a text preview under
  `userData/receipts/`. Set the printer name in Settings.
- **Cash drawer**: kicked automatically on cash-payment completion.

## Backup

Settings → **Back up now** performs a WAL-safe online copy of the database to a
location you choose. Cloud sync is *not* the only backup — take regular local
backups. The app reminds you if the last backup is over a week old.

## Milestone status

| Milestone | Status |
|---|---|
| M0 Scaffold + IPC + DB spine | ✅ |
| M1 Auth, users, roles, audit, inactivity lock | ✅ |
| M2 Product management (multi-barcode, weight, price history) | ✅ |
| M3 Checkout, payments, receipts, refunds, till sessions | ✅ |
| M4 Inventory (stock-in, adjustments, low-stock, count) | ✅ |
| M5 Till-session manager overview | ✅ |
| M6 Reporting (sales, transactions, stock movements, CSV) | ✅ |
| M7 Offline-first sync engine (outbox, idempotency, LWW) | ✅ (NullTransport until M10) |
| M8 Settings, manual backup, auto-update scaffold | ✅ (NSIS/auto-update run on Windows/CI) |
| M9 Multi-branch | ◑ architecture complete (everything branch-tagged; products pull-capable). Consolidated cross-branch reporting can now read the `pos_*` collections. |
| M10 Firestore wiring | ✅ `FirestoreTransport` + encrypted credentials, activated from Settings |
| Financial Hub | ✅ two-way bridge to the Flowbreeds Financial app (below) |

## Financial Hub: one system with the Flowbreeds Financial app

The business's bookkeeping app (**Flowbreeds Financial** — the Firebase web app
that does daily sales, expenses, cash-up, stock, receivables, payroll) and this
POS share **one Firebase project**. The POS pushes into the collections the
Financial app already reads — its spec explicitly shaped `shopSales` for POS
terminals (`source: 'POS'`, `terminalId`) — so the books fill themselves in:

| Direction | What | Where |
|---|---|---|
| POS → books | Each business day's till takings, one doc per day per terminal (id `date__shopId__pos__terminalId`), refunds netted, discounts as negative *Other sales*. Late refunds/voids re-push and **correct** the day — never duplicate it. | `shopSales` |
| POS → books | Locally received stock and count adjustments (SUPPLY on receipt, ADHOC on loss) | `stockMovements` |
| books → POS | Products + price changes from the central catalogue (linked via `products.financial_id`, LWW on write stamps, price changes logged to `price_history`) | `products` |
| books → POS | HQ-recorded deliveries/transfers touching this shop, applied to local stock **exactly once** (`finhub_applied_movements` ledger) | `stockMovements` |
| POS → cloud | Raw POS archive of every entity (M10 outbox sync; password hashes stripped) | `pos_*` collections |

Conversions live in `src/main/financial/mapping.ts` (pure, unit-tested): ngwee ↔
ZMW, UTC instants ↔ Africa/Lusaka business days, POS UUIDs ↔ Financial catalogue
ids. The bridge (`src/main/financial/bridge.ts`) runs on a timer next to the
sync engine, is fully idempotent, and records each run's outcome for the
Settings screen. Bridge-applied deliveries are tagged (`reference_id = finhub:<id>`) so
they are never echoed back up, and inventory writes it makes are attributed to a
disabled `financial-hub` system user for the audit trail.

### Connecting (once, per till)

1. In the **Financial app's Firebase project**: Project settings → Service
   accounts → **Generate new private key** (JSON).
2. In the POS: **Settings → Financial Hub**, paste the JSON, **Connect**. The key
   is encrypted with Electron `safeStorage` and never stored in plain text.
3. Pick which Financial-app **shop** this branch posts to (the list is loaded
   live from the app's `shops` collection) and save.
4. Done. The bridge backfills all history on its first run, then keeps everything
   in step automatically; **Sync now** forces a cycle and shows the outcome.

Notes:
- Products already typed into both systems are auto-linked by name instead of
  duplicated; unlinked delivery lines are surfaced as warnings, never dropped.
- Leave the **terminal id** alone once trading — it is part of the day-doc
  identity in the books.
- The Financial app's Firestore rules (`request.auth != null`) still apply to
  its users; the POS writes via the Admin SDK, and the `pos_*` archive lives
  behind the same rules.
