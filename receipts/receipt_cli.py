#!/usr/bin/env python3
"""Chat/CLI intake for SparkKit Receipts.

Examples:
  # Store model-extracted JSON, useful from Forge after image analysis
  python3 receipts/receipt_cli.py add-json extracted.json

  # Extract a receipt image using server-side Anthropic credentials, then store it
  ANTHROPIC_API_KEY=... python3 receipts/receipt_cli.py ingest-image receipt.jpg

  # Ask data questions via deterministic summaries
  python3 receipts/receipt_cli.py summary --fy current
  python3 receipts/receipt_cli.py list --q bunnings

  # Work on line items: review, clean up, categorise
  python3 receipts/receipt_cli.py items list --uncategorised
  python3 receipts/receipt_cli.py items set-category <receipt-id>:<item-id> Tools
  python3 receipts/receipt_cli.py items backfill            # dry run
  python3 receipts/receipt_cli.py items backfill --apply
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
from pathlib import Path

import requests

try:
    import items
    import server
    from contract import CATEGORIES, PROMPT, RECEIPT_SCHEMA
except ImportError:  # pragma: no cover
    from . import items, server
    from .contract import CATEGORIES, PROMPT, RECEIPT_SCHEMA


IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def read_json_arg(value: str) -> dict:
    if value == "-":
        return json.load(sys.stdin)
    stripped = value.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return json.loads(value)
    p = Path(value)
    if p.exists():
        return json.loads(p.read_text())
    return json.loads(value)


def media_type_for(path: Path) -> str:
    mt = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if mt == "image/jpg":
        mt = "image/jpeg"
    return mt


def image_to_base64(path: Path) -> tuple[str, str]:
    mt = media_type_for(path)
    if mt not in IMAGE_TYPES:
        raise SystemExit(f"Unsupported image type {mt}. Use jpg/png/webp/gif for model extraction.")
    data = path.read_bytes()
    # Optional downscale hook. Pillow is intentionally not a hard dependency for this static repo.
    return mt, base64.b64encode(data).decode("ascii")


def anthropic_extract(path: Path) -> dict:
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("SPARKKIT_ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit("Missing ANTHROPIC_API_KEY or SPARKKIT_ANTHROPIC_API_KEY")
    model = os.environ.get("SPARKKIT_RECEIPTS_MODEL", "claude-opus-4-8")
    media_type, b64 = image_to_base64(path)
    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": model,
            "max_tokens": 4096,
            "output_config": {"format": {"type": "json_schema", "schema": RECEIPT_SCHEMA}},
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": PROMPT},
                ],
            }],
        },
        timeout=90,
    )
    body = res.json() if res.headers.get("content-type", "").startswith("application/json") else None
    if not res.ok:
        msg = (body or {}).get("error", {}).get("message") if isinstance(body, dict) else None
        raise SystemExit(msg or f"Anthropic HTTP {res.status_code}")
    if body.get("stop_reason") == "refusal":
        raise SystemExit("Model declined to process this image")
    if body.get("stop_reason") == "max_tokens":
        raise SystemExit("Model response was cut off; try a clearer photo")
    text = next((b.get("text") for b in body.get("content", []) if b.get("type") == "text"), None)
    if not text:
        raise SystemExit("No extraction JSON returned")
    return json.loads(text)


def store_extracted(data: dict, *, thumb: str = "") -> dict | None:
    if not data.get("is_receipt"):
        return None
    record = {
        "thumb": thumb,
        "merchant": data.get("merchant") or "Unknown merchant",
        "date": data.get("date"),
        "total": data.get("total"),
        "gst": data.get("gst"),
        "currency": data.get("currency") or "AUD",
        "category": data.get("category") if data.get("category") in CATEGORIES else "Other",
        "payment_method": data.get("payment_method"),
        "items": data.get("items") or [],
        "notes": data.get("notes"),
    }
    return server.upsert_record(record)


def confirmation(record: dict | None) -> str:
    if record is None:
        return "Not a receipt — stored nothing."
    total = record.get("total")
    currency = record.get("currency") or "AUD"
    amount = "unknown total" if total is None else f"{currency} {float(total):.2f}"
    return f"Saved: {record.get('merchant')} · {record.get('date') or 'no date'} · {amount} · {record.get('category')}"


def cmd_init(_args):
    server.init_db()
    print(f"Initialised {server.DB_PATH}")


def cmd_add_json(args):
    server.init_db()
    data = read_json_arg(args.json)
    record = store_extracted(data)
    print(confirmation(record))
    if args.print_record and record:
        print(json.dumps(record, indent=2, ensure_ascii=False))


def cmd_ingest_image(args):
    server.init_db()
    data = anthropic_extract(Path(args.path))
    if args.print_extraction:
        print(json.dumps(data, indent=2, ensure_ascii=False), file=sys.stderr)
    record = store_extracted(data)
    print(confirmation(record))
    if args.print_record and record:
        print(json.dumps(record, indent=2, ensure_ascii=False))


def cmd_import_csv(args):
    server.init_db()
    text = Path(args.path).read_text(encoding="utf-8-sig") if args.path != "-" else sys.stdin.read()
    print(json.dumps({"imported": server.import_csv(text)}))


def cmd_export_csv(args):
    server.init_db()
    params = {}
    if args.from_date: params["from"] = [args.from_date]
    if args.to_date: params["to"] = [args.to_date]
    if args.category: params["category"] = [args.category]
    if args.q: params["q"] = [args.q]
    if args.fy: params["fy"] = [args.fy]
    print(server.csv_from_records(server.list_receipts(params)), end="")


def cmd_list(args):
    server.init_db()
    params = {}
    if args.from_date: params["from"] = [args.from_date]
    if args.to_date: params["to"] = [args.to_date]
    if args.category: params["category"] = [args.category]
    if args.q: params["q"] = [args.q]
    if args.fy: params["fy"] = [args.fy]
    records = server.list_receipts(params)
    if args.json:
        print(json.dumps({"receipts": records}, indent=2, ensure_ascii=False))
        return
    for r in records:
        total = "-" if r.get("total") is None else f"{r.get('currency') or 'AUD'} {float(r['total']):.2f}"
        print(f"{r.get('date') or 'no date'} | {r.get('merchant')} | {total} | {r.get('category')} | {r.get('id')}")


def cmd_summary(args):
    server.init_db()
    params = {}
    if args.from_date: params["from"] = [args.from_date]
    if args.to_date: params["to"] = [args.to_date]
    if args.category: params["category"] = [args.category]
    if args.q: params["q"] = [args.q]
    if args.fy: params["fy"] = [args.fy]
    print(json.dumps(server.summary(server.list_receipts(params)), indent=2, ensure_ascii=False))


# ---- items ---------------------------------------------------------------

def item_params(args) -> dict:
    """Query params for the item helpers, in the shape server.list_item_rows wants."""
    params = {}
    for key, value in (
        ("from", args.from_date), ("to", args.to_date), ("category", args.category),
        ("fy", args.fy), ("item_q", args.q), ("item_category", args.item_category),
        ("merchant", args.merchant), ("source", args.source),
    ):
        if value:
            params[key] = [value]
    for key, flag in (
        ("uncategorised", args.uncategorised), ("missing_amount", args.missing_amount),
        ("include_excluded", args.include_excluded), ("excluded", args.excluded),
    ):
        if flag:
            params[key] = ["1"]
    return params


def item_line(row: dict) -> str:
    amount = "-" if row["amount"] is None else f"{row['currency']} {row['amount']:.2f}"
    qty = f"{row['qty']:g}x " if row["qty"] else ""
    # A bare category is the item's own; brackets mean it inherits the receipt's.
    category = row["category"] or f"({row['receipt_category']})"
    flag = " [ignored]" if row["excluded"] else ""
    return (f"{row['date'] or 'no date'} | {row['merchant']} | {amount} | {category} | "
            f"{qty}{row['description']}{flag} | {row['ref']}")


def cmd_items_list(args):
    server.init_db()
    rows, _ = server.list_item_rows(item_params(args))
    if args.limit:
        rows = rows[:args.limit]
    if args.json:
        print(json.dumps({"items": rows}, indent=2, ensure_ascii=False))
        return
    for row in rows:
        print(item_line(row))
    counted = [r for r in rows if not r["excluded"]]
    total = sum(r["amount"] or 0 for r in counted)
    print(f"{len(rows)} items · {len(counted)} counted · AUD {total:.2f}")


def cmd_items_summary(args):
    server.init_db()
    params = {**item_params(args), "include_excluded": ["1"]}
    rows, records = server.list_item_rows(params)
    print(json.dumps(items.summary(rows, records), indent=2, ensure_ascii=False))


def cmd_items_export_csv(args):
    server.init_db()
    rows, _ = server.list_item_rows(item_params(args))
    print(items.csv_from_rows(rows), end="")


def edit_one(ref: str, **changes) -> int:
    server.init_db()
    try:
        receipt_id, item_id = items.parse_ref(ref)
    except ValueError as e:
        raise SystemExit(str(e))
    row = server.edit_item(receipt_id, item_id, **changes)
    if not row:
        print(f"No item found for {ref}", file=sys.stderr)
        return 1
    print(item_line(row))
    return 0


def cmd_items_set_category(args):
    if args.category_name not in CATEGORIES and args.category_name.lower() not in {"none", "inherit", "-"}:
        raise SystemExit(f"Unknown category {args.category_name!r}. One of: {', '.join(CATEGORIES)}")
    value = None if args.category_name.lower() in {"none", "inherit", "-"} else args.category_name
    return edit_one(args.ref, category=value)


def cmd_items_describe(args):
    return edit_one(args.ref, description=args.text)


def cmd_items_exclude(args):
    return edit_one(args.ref, excluded=True)


def cmd_items_include(args):
    return edit_one(args.ref, excluded=False)


def cmd_items_backfill(args):
    server.init_db()
    result = server.backfill_notes(apply=args.apply, receipt_id=args.receipt,
                                   strip_notes=args.strip_notes)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    for change in result["changes"]:
        print(f"{change['date'] or 'no date'} | {change['merchant']} | {change['receipt_id']}")
        for item in change["added"]:
            amount = "-" if item["amount"] is None else f"{item['amount']:.2f}"
            print(f"    + {item['description']} · {amount}")
        if change["duplicates"]:
            print(f"    ({change['duplicates']} already itemised, skipped)")
    verb = "Added" if result["applied"] else "Would add"
    print(f"{verb} {result['items']} items across {result['receipts']} receipts"
          + ("" if result["applied"] else " — re-run with --apply to write."))


def build_parser():
    p = argparse.ArgumentParser(description="SparkKit Receipts chat/CLI intake")
    sub = p.add_subparsers(required=True)

    s = sub.add_parser("init")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("add-json", help="store already-extracted receipt JSON")
    s.add_argument("json", help="JSON string, JSON file, or - for stdin")
    s.add_argument("--print-record", action="store_true")
    s.set_defaults(func=cmd_add_json)

    s = sub.add_parser("ingest-image", help="extract image via Anthropic and store receipt")
    s.add_argument("path")
    s.add_argument("--print-extraction", action="store_true")
    s.add_argument("--print-record", action="store_true")
    s.set_defaults(func=cmd_ingest_image)

    s = sub.add_parser("import-csv")
    s.add_argument("path", help="CSV file or - for stdin")
    s.set_defaults(func=cmd_import_csv)

    def add_filters(s):
        s.add_argument("--from", dest="from_date")
        s.add_argument("--to", dest="to_date")
        s.add_argument("--category")
        s.add_argument("--q")
        s.add_argument("--fy", choices=["current"])

    s = sub.add_parser("export-csv")
    add_filters(s)
    s.set_defaults(func=cmd_export_csv)

    s = sub.add_parser("list")
    add_filters(s)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("summary")
    add_filters(s)
    s.set_defaults(func=cmd_summary)

    def add_item_filters(s):
        add_filters(s)
        s.add_argument("--item-category", help="items explicitly filed under this category")
        s.add_argument("--merchant")
        s.add_argument("--source", choices=list(items.ITEM_SOURCES))
        s.add_argument("--uncategorised", action="store_true", help="items still inheriting their receipt's category")
        s.add_argument("--missing-amount", action="store_true", dest="missing_amount")
        s.add_argument("--include-excluded", action="store_true", dest="include_excluded")
        s.add_argument("--excluded", action="store_true", help="only ignored junk lines")

    it = sub.add_parser("items", help="review, clean up and categorise line items").add_subparsers(required=True)

    s = it.add_parser("list")
    add_item_filters(s)
    s.add_argument("--limit", type=int)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_items_list)

    s = it.add_parser("summary")
    add_item_filters(s)
    s.set_defaults(func=cmd_items_summary)

    s = it.add_parser("export-csv")
    add_item_filters(s)
    s.set_defaults(func=cmd_items_export_csv)

    s = it.add_parser("set-category", help="categorise one item ('inherit' clears it)")
    s.add_argument("ref", help="<receipt-id>:<item-id>")
    s.add_argument("category_name", metavar="category")
    s.set_defaults(func=cmd_items_set_category)

    s = it.add_parser("describe", help="fix an item's description (amounts stay as extracted)")
    s.add_argument("ref")
    s.add_argument("text")
    s.set_defaults(func=cmd_items_describe)

    s = it.add_parser("exclude", help="mark a junk line (loyalty, subtotal) out of item totals")
    s.add_argument("ref")
    s.set_defaults(func=cmd_items_exclude)

    s = it.add_parser("include", help="undo exclude")
    s.add_argument("ref")
    s.set_defaults(func=cmd_items_include)

    s = it.add_parser("backfill", help="lift `item:` / `items:` note lines into real items")
    s.add_argument("--receipt", help="one receipt id (default: every receipt)")
    s.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    s.add_argument("--strip-notes", action="store_true", dest="strip_notes",
                   help="also remove the note lines the items came from")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_items_backfill)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    raise SystemExit(main())
