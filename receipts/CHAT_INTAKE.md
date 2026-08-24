# SparkKit Receipts — Forge Chat Intake

Use this when Sharma sends a receipt/tax invoice/till docket image or asks receipt-spend questions.

## Receipt image flow

1. Inspect the image with the vision model using the exact schema intent from `contract.py`:
   - `null` instead of guessing unreadable values
   - `is_receipt=false` for non-receipts
   - Australian context, AUD default, GST matters
   - categories include `Home Building`
2. Store only if `is_receipt=true`:

```sh
python3 receipts/receipt_cli.py add-json '<extracted-json>'
```

3. Reply with the CLI confirmation only, plus any uncertainty note from extraction.

Example reply:

> Saved: Bunnings · 2026-07-09 · AUD 55.50 · Home Building

If `is_receipt=false`, reply:

> Not a receipt — stored nothing.

## Server-side model extraction

If `ANTHROPIC_API_KEY` or `SPARKKIT_ANTHROPIC_API_KEY` is configured server-side, the CLI can do extraction directly:

```sh
python3 receipts/receipt_cli.py ingest-image /path/to/receipt.jpg
```

No API keys should be placed in the repo, logs, or chat replies.

## Questions / summaries

Use deterministic DB helpers rather than eyeballing.

```sh
python3 receipts/receipt_cli.py summary --fy current
python3 receipts/receipt_cli.py summary --from 2026-07-01 --to 2026-07-31 --category Fuel
python3 receipts/receipt_cli.py list --q bunnings
python3 receipts/receipt_cli.py export-csv > receipts-export.csv
```

For tax/BAS-facing figures, include:

> Review AI-extracted amounts before lodging.

## Line items

Item-level questions and clean-up go through the `receipt-items` wrapper —
run it directly by path, never through a shell:

```
receipt-items review
receipt-items list conduit
receipt-items summary --fy current
receipt-items categorise <receipt-id>:<item-id> Tools
receipt-items ignore <receipt-id>:<item-id>
receipt-items backfill-preview
```

Full runbook: `receipts/ITEMS.md`. Item amounts are never edited and items
are never deleted — junk lines get `ignore`d instead.

## Deletion

Never delete receipt records without explicit Sharma instruction.
