# SparkKit Receipts — itemisation runbook

How item-level purchases are organised after extraction: what the data looks
like, how Ledger reviews and cleans it up, and what the phone shows.

## The shape

Every receipt carries a list of line items in `items_json`. One item:

```json
{ "id": "3f9a2c17", "description": "Cable ties 100pk", "amount": 12.50,
  "qty": 2, "category": null, "excluded": false, "source": "extract" }
```

Defined once in [`items.py`](items.py) and mirrored in `app.js`. The parts
that matter for review:

- **ref** — `<receipt-id>:<item-id>`, how an item is addressed everywhere
  (wrapper, CLI, API). Ids are stable once stored.
- **category `null`** — "same as the receipt". Items only get their own
  category when they differ, so *uncategorised* is a meaningful review queue
  ("nobody has looked at this line") rather than noise.
- **excluded** — a junk line: loyalty points, subtotal, rounding. Kept on the
  record, left out of item totals.
- **source** — `extract` from the photo, `notes` backfilled from an old
  `item:` note line, `manual` typed in.

Two rules keep the data trustworthy:

1. **Amounts are never edited.** They are what the docket says. A misread
   amount is fixed by re-scanning the photo, not by typing over it.
2. **Items are never deleted.** Junk lines are *ignored*, which keeps the
   stored record a faithful copy of the receipt and is reversible. (Deleting
   a whole receipt is a separate, approval-gated wrapper —
   `delete_receipt_safe.py`.)

## Ledger: the `receipt-items` wrapper

`~/.openclaw/workspace-ledger/bin/receipt-items` — run it **directly by
path** with plain argv. No `/bin/bash -lc`, no `bash -c`, no pipes, no
heredocs, no chained commands. It talks to the SQLite store in-process; it
never shells out.

The shim is one line, execing this repo's script in Ledger's clone:

```sh
#!/bin/sh
exec python3 /home/sharma/.openclaw/workspace/_external/sparkkit/receipts/receipt_items.py "$@"
```

(`SPARKKIT_RECEIPTS_DIR` overrides which checkout it uses; otherwise it uses
the one it was installed from.)

### Reviewing

```
receipt-items review
receipt-items review --fy current --limit 20
```

The review queue in one call: items with no category yet, items whose amount
wasn't read, receipts whose items don't add up to the receipt total, and
receipts with no items at all. Every entry prints its ref underneath, ready
to paste into the next command.

### Searching

```
receipt-items list conduit
receipt-items list --month 2026-07 --category Materials
receipt-items list --uncategorised --limit 20
receipt-items list --ignored
receipt-items show <receipt-id>
receipt-items summary --fy current
```

`--category` matches the *effective* category, so an item filed under Tools
on a Materials receipt shows up under Tools where you'd expect it.

### Categorising

```
receipt-items categorise <receipt-id>:<item-id> Tools
receipt-items categorise <receipt-id>:<item-id> inherit     # back to the receipt's
receipt-items categorise-matching "safety boots" "PPE & Workwear"
receipt-items categorise-matching "safety boots" "PPE & Workwear" --apply
```

`categorise-matching` previews what it would change and writes nothing until
`--apply`. Same scope flags as `list`, so it can be narrowed to a month,
merchant or category first.

### Cleaning up

```
receipt-items describe <ref> "Conduit 20mm × 4m"
receipt-items ignore <ref>       # loyalty points, subtotal, rounding line
receipt-items unignore <ref>
```

### Old receipts with `item:` notes

Receipts captured before itemisation sometimes list their lines in the notes:

```
paid cash
items: Wiper blades $30.00; Oil filter 60.00
```

```
receipt-items backfill-preview              # every receipt, writes nothing
receipt-items backfill-preview <receipt-id>
receipt-items backfill-apply
receipt-items backfill-apply --strip-notes  # also drop the note lines it lifted
```

Only lines that actually parse into items are consumed; anything already
itemised is skipped, and notes that yield nothing are left untouched.

## Chat answers

Item questions are answered from the wrapper, not by eyeballing photos:

> Ledger: `receipt-items summary --month 2026-07`

For anything tax/BAS-facing, include:

> Review AI-extracted amounts before lodging.

## Phone (PWA)

**Items** tab: search every line item across all receipts, filter by month,
category, or one of *Needs a category* / *No amount read* / *Ignored lines*.
Tapping an item opens it — category, and an ignore toggle. With a filter or
search active, one button categorises everything matching. Items also appear
on the receipt itself (Receipts → tap a receipt), tappable there too.

Description and amount are read-only on the phone, matching how the rest of
the extracted record behaves; Ledger fixes descriptions on request.

The phone caches items in IndexedDB and syncs them like any other receipt
field. A client that only knows the old `{description, amount}` shape can't
wipe categories or exclusions — the server carries stored review state
forward on upsert.

## CLI (on the server)

Same operations as the wrapper, for use on the box:

```sh
python3 receipts/receipt_cli.py items list --uncategorised
python3 receipts/receipt_cli.py items summary --fy current
python3 receipts/receipt_cli.py items set-category <ref> Tools
python3 receipts/receipt_cli.py items exclude <ref>
python3 receipts/receipt_cli.py items backfill --apply
python3 receipts/receipt_cli.py items export-csv --from 2026-07-01 --to 2026-07-31
```

HTTP equivalents (`/receipts/items…`) are in [`SERVER_API.md`](SERVER_API.md).
