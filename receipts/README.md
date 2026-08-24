# SparkKit Receipts — snap, extract, organise

Receipt capture. Take a photo of a receipt, a connected server (running
`server.py`, backed by Claude) reads it and extracts structured data —
merchant, date, total, GST, category, line items — and it's kept in sync
between the phone and the server so you can search it, see monthly/category
totals, and export CSV for your accountant or spreadsheet.

## How it works

1. **Settings → Ledger sync** → enter your server's URL and bearer token,
   then Save & sync. This is the only required setup step — the phone needs
   no API key, and connects to *any* compatible server, not
   just one specific one (so the same app can be handed to a different
   client pointed at their own agent). The details are saved on the phone
   and reconnect automatically every time the app is opened.
2. **Scan** → take a photo (or pick several from your gallery). Each image
   is downscaled on-device, uploaded to the server for extraction, and the
   result is cached in IndexedDB with a small thumbnail.
3. **Receipts** → search and filter by month/category, tap a receipt to
   review it. Extracted fields are locked (they're what the receipt says);
   only the category and notes can be changed. Export the current view as CSV.
4. **Items** → every line item across every receipt, searchable on its own.
   Filter to the ones that still need a category, the ones whose amount
   didn't read, or the junk lines you've ignored; tap one to categorise it,
   or categorise a whole filtered set at once. Items CSV export too. See
   [`ITEMS.md`](ITEMS.md).
5. **Totals** → spend and GST per month, broken down by category.

Scanning is disabled with a prompt until a server is connected (or a
fallback key is saved — see below).

## Design decisions

- **Server-side extraction by default.** `POST /receipts/extract` picks a
  backend automatically: the **openclaw CLI** when installed (rides the
  box's existing agent/model account — no API key at all), else the
  Anthropic API via `ANTHROPIC_API_KEY`. See `SERVER_API.md`. The phone is
  a thin sync client over IndexedDB.
- **Optional device fallback.** Settings → Advanced accepts an Anthropic
  key that's used only when the server can't extract; leave it empty to
  rely on the server alone.
- **Strict JSON contract** (`contract.py`) either way — structured outputs
  on Anthropic, an inline-schema prompt on OpenClaw.
- **Items are reviewed, not rewritten.** A line item can be categorised
  (independently of its receipt) and junk lines — loyalty, subtotals — can be
  ignored so they stay on the record but out of totals. Amounts are never
  edited and items are never deleted, so the stored record keeps matching the
  docket. Shape and rules: [`items.py`](items.py), [`ITEMS.md`](ITEMS.md).

## Run it

From the repo root, serve the static app and a local API:

```sh
python3 -m http.server 5173 &
SPARKKIT_RECEIPTS_TOKEN=dev-token python3 receipts/server.py
# (set ANTHROPIC_API_KEY=... if the openclaw CLI isn't installed locally)
# then open http://localhost:5173/receipts/ and connect Settings → Ledger sync
# to http://localhost:8787 with token "dev-token"
```

> ⚠️ The camera and service worker need a secure context: `localhost` is fine
> for development; use HTTPS (e.g. the deployed vhost, see `deploy/DEPLOY.md`) on a phone.

## Server

- [`SERVER_API.md`](SERVER_API.md) — endpoint reference.
- [`server.py`](server.py) — stdlib HTTP + SQLite API.
- [`receipt_cli.py`](receipt_cli.py), [`CHAT_INTAKE.md`](CHAT_INTAKE.md) —
  chat/CLI intake (Ledger's Discord/iCloud flow).
- [`receipt_items.py`](receipt_items.py), [`ITEMS.md`](ITEMS.md) — the
  itemisation runbook and the wrapper behind Ledger's `receipt-items`.

## Roadmap

- Optional cheaper model toggle for bulk back-scanning of old receipts.
- Item-level GST splits (currently GST is tracked per receipt).
- Attach receipts to jobs (ties into the planned invoicing feature).
- Full-size image retention (currently only a thumbnail is kept).
