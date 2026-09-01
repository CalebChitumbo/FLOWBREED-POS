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
| Cloud sync | Pluggable `SyncTransport` (NullTransport now; firebase-admin Firestore later) |
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
plus `002_order_planning.sql` (append-only `audit_log`, `price_history` and
`order_cost_history` enforced by triggers; closed order plans frozen the same way).
A transactional **outbox** (`sync_queue`) is written in the same transaction as each
domain change.

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
npm test            # Vitest unit tests (services, sync, security) — 97 passing
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
4. **Order Planning** (manager+) — put your *buying* prices on the price list, then
   plan orders against them (see below).

## Order Planning (M11)

So the buying is planned on paper figures, not from memory.

**Price list tab** — every item the shop orders, saved with a short **code**
(`BF01`), what it costs to buy, and the unit it is bought in (kg, box, crate…).
Changing a cost writes an append-only `order_cost_history` row, so the trend is
never lost, and items are *retired*, never deleted, so old plans keep their
history. An item can optionally be linked to the POS product it stocks.

**Order plans tab** — start a plan, then type a **code + quantity** for each thing
the shop manager asked for; each line is costed from the preset price and the plan
totals the spend. Record the **cash taken** and the plan tells you what is left.
Anything not on the price list can go on as a one-off line.

Then:

- **Start shopping** — the plan becomes the shopping list (export it as CSV to
  carry it).
- Against each line record what was **actually bought** and **actually paid** —
  leave a line blank and it counts as going to plan; enter 0 quantity for
  something you did not buy.
- **Close & reconcile** — freezes the real spend and the **change to return**
  (cash taken − spent, shown in red if the order went over).

A closed or cancelled plan is a **permanent record**: the service refuses to edit
it and the migration's triggers block any UPDATE/DELETE at the storage layer too
(only the sync engine's `sync_status` bookkeeping is let through). To repeat a
standing order — or correct a closed one — use **Duplicate**, which copies the
lines into a fresh draft re-priced at today's costs.

## Roles

- **Cashier** — checkout, payments, receipts, own till session.
- **Manager** — + product management, pricing, stock, discount authorisation,
  reports, order planning, close any session.
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
| M9 Multi-branch | ◑ architecture complete (everything branch-tagged; products pull-capable). Consolidated cross-branch reporting depends on M10. |
| M10 Firestore wiring | ☐ requires a Firebase project (see below) |
| M11 Order planning (order price list, plans, budget vs actual, change) | ✅ |

## M10: wiring live Firebase (final phase)

The sync engine already does everything; only the transport needs swapping.

1. Create a Firebase project; enable Firestore; download a **service-account JSON**.
2. Implement `src/main/sync/firestore-transport.ts` as a `SyncTransport` using
   `firebase-admin`: `push` → `db.collection(entityType).doc(entityId).set(doc, { merge: true })`
   (idempotent by our UUID); `pull` → query `where('updatedAt', '>', since)` for the
   pull-capable collections; `isOnline` → a lightweight reachability check.
3. Store the service-account JSON encrypted with Electron `safeStorage` (never in
   plain text); decrypt only in MAIN at sync time.
4. In `src/main/index.ts`, swap `new NullTransport()` for the Firestore transport
   when credentials are configured.

Because IDs are client-generated UUIDs and the conflict policy is Last-Write-Wins on
`updatedAt`, no engine changes are needed.
