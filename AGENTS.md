# SparkKit — agent brief

Primary maintainer-agent: **Ledger** (OpenClaw finance agent on forgevps).
Owner: Sharma (sharma64). This file is the standing context for any agent
working in this repo.

## What this is

AU/NZ electrical apprentice toolkit. Static PWAs, **no build step, no
framework, no backend dependencies beyond the receipts API**:

- `/` — calculators & reference (main SparkKit app).
- `/receipts/` — receipt capture: PWA (`index.html`, `app.js`, `styles.css`,
  `sw.js`) plus a stdlib-only Python API (`server.py`, contract in
  `contract.py`, CLI in `receipt_cli.py`). Docs: `receipts/SERVER_API.md`,
  `receipts/CHAT_INTAKE.md`.

## Receipts architecture

The PWA is primarily a sync client. `Settings → Ledger sync` (Server URL +
bearer token) is the main configuration surface, and it's deliberately
generic: any sparkkit-receipts-compatible server works, not just Sharma's.
This is so the same app can be handed to another client who points it at
their own agent/server instead. The fields persist in localStorage and
reconnect automatically on every app open — nothing to re-enter. There is
also an *optional* fallback under `Settings → Advanced`: an Anthropic key,
used only when the server's extract endpoint fails (direct browser call).

Server-side extraction (`POST /receipts/extract`) picks its backend
automatically: the **openclaw CLI** when installed (`capability model run`
— rides the box's agent/model account, no API key; this is how forgevps
runs) with `ANTHROPIC_API_KEY` as the alternative. See
`receipts/SERVER_API.md` for the env knobs.

Two intake paths, one store, for Sharma's own deployment:

1. **Phone PWA** (https://receipts.circuitandsoil.au) — Scan uploads photos
   to `POST /api/receipts/extract`; extraction runs server-side via
   OpenClaw. Scanning is disabled (with a prompt to configure Settings)
   until a server is connected or a fallback key is saved.
2. **Ledger chat intake** — Discord photos / iCloud shared links, extracted
   server-side, saved via the wrappers in
   `~/.openclaw/workspace-ledger/bin/` (runbook:
   `~/.openclaw/workspace-ledger/RECEIPTS.md`).

Line items live inside each receipt record (`items_json`), not in a
separate table: shape, notes-backfill and review rules in `receipts/items.py`,
runbook in `receipts/ITEMS.md`. Items are addressed as
`<receipt-id>:<item-id>`; an item with no category of its own follows its
receipt. Ledger's wrapper is `~/.openclaw/workspace-ledger/bin/receipt-items`
(argv only — no shell, pipes or heredocs), backed by
`receipts/receipt_items.py`.

Source of truth: SQLite DB shared by both paths (path in
`/etc/sparkkit-receipts.env`; currently inside Ledger's clone at
`~/.openclaw/workspace/_external/sparkkit/receipts/`). The PWA's IndexedDB
is an offline cache that reconciles on sync. Deployment: `deploy/DEPLOY.md`.

## Conventions & guardrails

- Keep it dependency-free: vanilla JS in the apps, stdlib-only in
  `server.py`. Match the existing terse style.
- Extraction rules: strict JSON schema, defined once in `contract.py`
  (`RECEIPT_SCHEMA`, `PROMPT`, `CATEGORIES`) and used only server-side by
  `server.py`. `app.js` has its own `CATEGORIES` copy for UI dropdowns —
  keep the two lists in sync. Null over guessing, gate on `is_receipt`,
  AUD/GST context.
- Never commit: the SQLite DB, tokens/keys, downloaded receipt images.
- Deletion of receipt records always requires Sharma's explicit approval,
  one receipt at a time (see the safe-delete wrappers).
- Line items are reviewed, never rewritten: amounts stay as extracted, and
  junk lines (loyalty, subtotals) are *excluded* from totals rather than
  deleted. There is deliberately no item-delete path.
- Tax/BAS-facing output must include: "Review AI-extracted amounts before
  lodging."
- `main` is protected (no force pushes, no deletion). Work on branches,
  merge via PR.

## Verifying changes

- Python: `python3 -m py_compile receipts/*.py`, then smoke-test
  `server.py` with curl (`/health`, `/receipts/upsert`, `/receipts`).
- PWA: `python3 -m http.server` from the repo root, exercise scan/list/
  items/sync manually. Bump the `CACHE` version in `sw.js` whenever
  app-shell files change.
