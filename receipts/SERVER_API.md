# SparkKit Receipts — Server API

Server-side source of truth for SparkKit receipt records.

## Goals

- Keep receipt records in one durable server-side store.
- Preserve the existing app record shape so phone sync and CSV export stay compatible.
- Keep the API private-network only, protected by bearer token auth.
- Keep owner-controlled export available at all times.

## Record shape

The server stores the same fields the current PWA uses:

```json
{
  "id": "uuid",
  "added": "2026-07-09T00:00:00.000Z",
  "thumb": "data:image/jpeg;base64,...",
  "merchant": "Bunnings",
  "date": "2026-07-09",
  "total": 123.45,
  "gst": 11.22,
  "currency": "AUD",
  "category": "Materials",
  "payment_method": "Visa …1234",
  "items": [{
    "id": "3f9a2c17",
    "description": "Cable ties",
    "amount": 12.50,
    "qty": null,
    "category": null,
    "excluded": false,
    "source": "extract"
  }],
  "notes": null
}
```

`items` is stored as JSON. Amount fields may be `null` when unreadable.

### Line items

The item shape is defined once in `receipts/items.py` and mirrored in
`receipts/app.js`. Beyond `description` and `amount` (what the model
extracts), each item carries:

- `id` — stable, assigned on first store. Items are addressed as
  `<receipt-id>:<item-id>`, called a **ref**.
- `qty` — quantity when one was read, else `null`.
- `category` — `null` means "same as the receipt". An item only gets its own
  category once someone splits it out (e.g. a Home Building line on a
  Materials receipt).
- `excluded` — a junk line (loyalty, subtotal, rounding) kept on the record
  but left out of item totals. Cleanup excludes lines, never deletes them.
- `source` — `extract` (model), `notes` (backfilled from an `item:` note
  line), `manual`.

Older payloads with plain `{description, amount}` items are still accepted:
the server matches them against what it already has (by id, else by
description + amount) and **carries the stored category/exclusion forward**,
so a client that doesn't know about item review can't wipe it.

Amounts are never edited — they are what the docket says. Descriptions,
categories and exclusions are the editable part.

## Categories

Current compatibility categories:

- Tools
- Materials
- Fuel
- Vehicle
- PPE & Workwear
- Food & Drink
- Training
- Office & Admin
- Home Building
- Other

## Auth

All API requests require:

```http
Authorization: Bearer <SPARKKIT_RECEIPTS_TOKEN>
```

The service should only bind to localhost or a private VPN/Tailscale interface. Do not expose it directly to the open internet.

## Endpoints

### Health

```http
GET /health
```

Returns `{ "ok": true }` without auth for local/private health checks.

### List receipts

```http
GET /receipts
GET /receipts?from=2026-07-01&to=2026-07-31&category=Fuel&q=bunnings
```

Returns:

```json
{ "receipts": [ ... ] }
```

Filters are optional. Dates are inclusive. `q` searches merchant, category, notes, payment method, and item descriptions.

### Upsert receipt

```http
POST /receipts/upsert
Content-Type: application/json
```

Body is a full receipt record. If `id` is missing the server creates one. If `added` is missing the server creates it.

Returns:

```json
{ "receipt": { ... } }
```

### Extract receipt from image

```http
POST /receipts/extract
Content-Type: application/json
```

Body: `{ "image": "data:image/jpeg;base64,..." }` — a downscaled photo as a
data URL. Runs the extraction contract (`contract.py`) server-side. Does
**not** store the record; the caller still calls `/receipts/upsert` with
the result (this is what the PWA's scan flow does).

Backend selection (`SPARKKIT_EXTRACT_BACKEND`, default `auto`):

- **`openclaw`** — shells out to `openclaw capability model run` with the
  image and the inline-schema prompt (`PROMPT_INLINE_SCHEMA`). Uses the
  box's existing agent/model account; **no API key needed**. Optional
  `SPARKKIT_OPENCLAW_MODEL=provider/model` override,
  `SPARKKIT_OPENCLAW_BIN` to point at a non-PATH binary. Calls take
  roughly 30–60 s per image.
- **`anthropic`** — direct Anthropic API call with structured outputs;
  requires `ANTHROPIC_API_KEY` (or `SPARKKIT_ANTHROPIC_API_KEY`).
- **`auto`** — openclaw when the CLI is installed, else anthropic when a
  key is set, else `502`.

Returns `502` with an `error` message if no backend is available, the
model declines, or the reply isn't parseable.

(The phone PWA also has an *optional* fallback key under Settings →
Advanced: if this endpoint fails and a key is saved on the device, the
phone retries directly against the Claude API. With no fallback key it
simply surfaces the server's error.)

Returns:

```json
{ "extraction": { "is_receipt": true, "merchant": "...", ... } }
```

### List items

```http
GET /receipts/items
GET /receipts/items?from=2026-07-01&to=2026-07-31&uncategorised=1
GET /receipts/items?item_q=conduit&category=Materials&include_excluded=1
```

Returns a flat list of item rows, each carrying its receipt's context:

```json
{ "items": [{
  "ref": "b1f0…:3f9a2c17", "receipt_id": "b1f0…", "item_id": "3f9a2c17",
  "date": "2026-07-09", "merchant": "Bunnings", "currency": "AUD",
  "receipt_category": "Materials", "description": "Cable ties", "amount": 12.5,
  "qty": null, "category": null, "effective_category": "Materials",
  "excluded": false, "source": "extract"
}] }
```

Receipt-level filters (`from`, `to`, `fy`) narrow the receipts first. The
item-level ones are:

| Param | Effect |
| --- | --- |
| `item_q` (or `q`) | matches the item description, merchant, category or date |
| `category` | effective category — the item's own, else its receipt's |
| `item_category` | only items explicitly filed under that category |
| `merchant` | substring match |
| `uncategorised=1` | only items with no category of their own |
| `missing_amount=1` | only items whose amount wasn't read |
| `source=extract\|notes\|manual` | where the item came from |
| `include_excluded=1` | include ignored junk lines (hidden by default) |
| `excluded=1` | *only* ignored junk lines |

### Item summary

```http
GET /receipts/items/summary?fy=current
```

Item counts and amounts by category, merchant and month, plus `coverage`:
which receipts have no items at all, and which ones whose items don't add up
to the receipt total (more than 5c out). Excluded lines are counted and
reported but never totalled. Includes the standard
`"Review AI-extracted amounts before lodging."` note.

### Export items CSV

```http
GET /receipts/items/export.csv
```

Same filters as `GET /receipts/items`. Columns: `date, merchant,
description, qty, amount, currency, item_category, receipt_category,
excluded, source, receipt_id, item_id`.

### Update items

```http
POST /receipts/items/update
Content-Type: application/json
```

One edit, or a batch:

```json
{ "ref": "b1f0…:3f9a2c17", "category": "Tools", "excluded": false }
{ "updates": [{ "ref": "…", "category": "Fuel" }, { "ref": "…", "excluded": true }] }
```

`receipt_id` + `item_id` work in place of `ref`. Editable keys are
`category` (`null` clears it back to "same as the receipt"), `excluded` and
`description` — amounts are not editable. Returns the updated item rows and
anything that couldn't be found:

```json
{ "updated": [ { …item row… } ], "failed": [] }
```

Responds `404` when nothing matched. Items have no delete endpoint: junk
lines are excluded, which keeps the stored record faithful to the docket.

### Backfill items from notes

```http
POST /receipts/items/backfill
Content-Type: application/json
```

Receipts captured before itemisation sometimes carry their lines in the
notes as `item:` / `items:` lines. This lifts them into real items (with
`source: "notes"`), skipping any that are already itemised.

```json
{ "apply": false, "receipt_id": null, "strip_notes": false }
```

**Dry run by default** — nothing is written unless `apply` is true. With
`strip_notes` the note lines the items came from are removed as well; notes
that produced no items are always left alone. Returns the per-receipt
changes, plus `receipts` / `items` counts.

### Delete receipt

```http
DELETE /receipts/:id
```

Deletes one record. This endpoint exists for app sync, but operationally deletion still requires explicit owner instruction.

Returns:

```json
{ "deleted": true, "id": "..." }
```

### Import CSV

```http
POST /receipts/import-csv
Content-Type: text/csv
```

Accepts the current app export columns:

```csv
date,merchant,category,total,gst,currency,payment_method,items,notes
```

Because the current CSV export does not include `id`, `added`, or `thumb`, imported records receive new ids, current import timestamps, and empty thumbnails unless later matched/edited.

Returns:

```json
{ "imported": 12 }
```

### Export CSV

```http
GET /receipts/export.csv
```

Returns a CSV compatible with the current app export.

### Summary/Q&A helper

```http
GET /receipts/summary?from=2026-07-01&to=2026-09-30&category=Fuel
GET /receipts/summary?fy=current
```

Returns spend/GST/count totals by category, merchant, and month. `fy=current` uses the Australian financial year: 1 July to 30 June.

Tax/BAS-facing answers should include: **Review AI-extracted amounts before lodging.**

## Extraction contract

Server-side receipt image extraction must reuse from `receipts/contract.py`:

- `RECEIPT_SCHEMA`
- `PROMPT`
- `CATEGORIES`

Rules:

- structured JSON schema output only; never parse prose
- `null` over guessing when printed/readable value is missing
- gate on `is_receipt`; store nothing when false
- downscale images to about 1568px long edge before model call
- API keys stay server-side only; never in logs, chat replies, or repo

## Retention

Default implementation keeps thumbnails and structured records only. Full-size/original receipt image retention requires a separate owner decision because it changes privacy and storage behaviour.
