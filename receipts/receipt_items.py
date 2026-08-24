#!/usr/bin/env python3
"""Review, clean up and categorise receipt line items — Ledger's wrapper.

Backs `~/.openclaw/workspace-ledger/bin/receipt-items`. Ledger runs it
directly by path with plain argv: no shell, no pipes, no heredocs. Everything
happens in-process against the same SQLite store as the API.

Usage:
  receipt-items review [--limit N]
  receipt-items list [query] [--month YYYY-MM|--fy current] [--category CAT]
                     [--merchant NAME] [--uncategorised] [--ignored] [--all]
                     [--limit N] [--json]
  receipt-items show <receipt-id>
  receipt-items summary [--month YYYY-MM|--fy current] [--category CAT] [--merchant NAME]
  receipt-items categorise <receipt-id>:<item-id> <category|inherit>
  receipt-items categorise-matching <query> <category> [filters] [--apply]
  receipt-items describe <receipt-id>:<item-id> <text>
  receipt-items ignore <receipt-id>:<item-id>
  receipt-items unignore <receipt-id>:<item-id>
  receipt-items backfill-preview [receipt-id]
  receipt-items backfill-apply [receipt-id] [--strip-notes]
  receipt-items categories

Items are never deleted here: junk lines (loyalty, subtotal, rounding) are
`ignore`d, which keeps the record faithful to the docket and out of totals.
Amounts stay exactly as extracted — descriptions and categories are the
editable part. Receipt deletion is a separate, approval-gated wrapper.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

RECEIPTS = Path(os.environ.get("SPARKKIT_RECEIPTS_DIR") or Path(__file__).resolve().parent)
sys.path.insert(0, str(RECEIPTS))

import items  # noqa: E402
import server  # noqa: E402
from contract import CATEGORIES  # noqa: E402

REVIEW_NOTE = "Review AI-extracted amounts before lodging."


# ---- shared bits ---------------------------------------------------------

def params_from(args) -> dict:
    """Query params for server.list_item_rows from the wrapper's flags."""
    params: dict[str, list[str]] = {}
    month = getattr(args, "month", None)
    if month:
        params["from"] = [f"{month}-01"]
        params["to"] = [f"{month}-31"]
    if getattr(args, "fy", None):
        params["fy"] = [args.fy]
    if getattr(args, "category", None):
        params["category"] = [args.category]
    if getattr(args, "merchant", None):
        params["merchant"] = [args.merchant]
    if getattr(args, "query", None):
        params["item_q"] = [args.query]
    if getattr(args, "uncategorised", False):
        params["uncategorised"] = ["1"]
    if getattr(args, "ignored", False):
        params["excluded"] = ["1"]
    if getattr(args, "all", False):
        params["include_excluded"] = ["1"]
    return params


def plural(n: int, word: str = "item") -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def money(amount, currency="AUD") -> str:
    return "no amount" if amount is None else f"{currency} {amount:.2f}"


def line(row: dict) -> str:
    # A bare category is the item's own; brackets mean it follows the receipt.
    category = row["category"] or f"({row['receipt_category']})"
    qty = f"{row['qty']:g}x " if row["qty"] else ""
    flag = " [ignored]" if row["excluded"] else ""
    return (f"{row['date'] or 'no date'} · {row['merchant']} · {money(row['amount'], row['currency'])}"
            f" · {category} · {qty}{row['description']}{flag}\n    {row['ref']}")


def check_category(value: str):
    """A category name, or None for 'inherit'. Exits on anything else."""
    if value.strip().lower() in {"inherit", "none", "-"}:
        return None
    if value not in CATEGORIES:
        raise SystemExit(f"Unknown category {value!r}. One of: {', '.join(CATEGORIES)}")
    return value


def rows_for(args) -> list[dict]:
    rows, _ = server.list_item_rows(params_from(args))
    return rows


def edit(ref: str, **changes) -> int:
    try:
        receipt_id, item_id = items.parse_ref(ref)
    except ValueError as e:
        raise SystemExit(str(e))
    row = server.edit_item(receipt_id, item_id, **changes)
    if not row:
        print(f"No item found for {ref} — run `receipt-items show <receipt-id>` for the current refs.")
        return 1
    print(line(row))
    return 0


# ---- commands ------------------------------------------------------------

def cmd_review(args) -> int:
    """The itemisation review queue: what still needs a human eye."""
    rows, records = server.list_item_rows({**params_from(args), "include_excluded": ["1"]})
    data = items.summary(rows, records)
    totals, cover = data["totals"], data["coverage"]
    print(f"{plural(totals['items'])} across {cover['itemised']} of {cover['receipts']} receipts "
          f"· AUD {totals['amount']:.2f} counted · {totals['excluded']} ignored")

    uncategorised = [r for r in rows if not r["excluded"] and r["category"] is None]
    if uncategorised:
        print(f"\nNot categorised yet ({len(uncategorised)}) — these follow their receipt's category:")
        for row in uncategorised[:args.limit]:
            print(f"  {line(row)}")
        if len(uncategorised) > args.limit:
            print(f"  … {len(uncategorised) - args.limit} more")

    missing = [r for r in rows if not r["excluded"] and r["amount"] is None]
    if missing:
        print(f"\nNo amount read ({len(missing)}):")
        for row in missing[:args.limit]:
            print(f"  {line(row)}")

    if cover["mismatched"]:
        print(f"\nItems don't add up to the receipt total ({len(cover['mismatched'])}) — "
              "a line was misread, missed, or should be ignored:")
        for m in cover["mismatched"][:args.limit]:
            print(f"  {m['date'] or 'no date'} · {m['merchant']} · receipt {m['total']:.2f} "
                  f"vs items {m['items_total']:.2f} ({m['difference']:+.2f})\n    {m['receipt_id']}")

    if cover["unitemised"]:
        print(f"\nNo items at all ({len(cover['unitemised'])}) — try `receipt-items backfill-preview`, "
              "or re-scan the photo:")
        for u in cover["unitemised"][:args.limit]:
            print(f"  {u['date'] or 'no date'} · {u['merchant']} · {money(u['total'])}\n    {u['receipt_id']}")

    if not (uncategorised or missing or cover["mismatched"] or cover["unitemised"]):
        print("\nNothing to review — every item is categorised and adds up.")
    print(f"\n{REVIEW_NOTE}")
    return 0


def cmd_list(args) -> int:
    rows = rows_for(args)
    shown = rows[:args.limit] if args.limit else rows
    if args.json:
        print(json.dumps({"items": shown}, indent=2, ensure_ascii=False))
        return 0
    if not rows:
        print("No items match.")
        return 1
    for row in shown:
        print(line(row))
    counted = [r for r in rows if not r["excluded"]]
    total = sum(r["amount"] or 0 for r in counted)
    more = f" (showing {len(shown)})" if len(shown) != len(rows) else ""
    print(f"\n{plural(len(rows))}{more} · {len(counted)} counted · AUD {total:.2f}")
    return 0


def cmd_show(args) -> int:
    records = [r for r in server.list_receipts({}) if r["id"] == args.receipt_id]
    if not records:
        print(f"No receipt found for id {args.receipt_id}")
        return 1
    r = records[0]
    print(f"{r['merchant']} · {r['date'] or 'no date'} · {money(r['total'], r['currency'])} · {r['category']}")
    if r.get("notes"):
        print(f"notes: {r['notes']}")
    rows = items.item_rows([r])
    if not rows:
        print("\nNo items on this receipt. `receipt-items backfill-preview "
              f"{r['id']}` checks the notes for `item:` lines.")
        return 0
    print()
    for row in rows:
        print(line(row))
    counted = [row for row in rows if not row["excluded"]]
    total = sum(row["amount"] or 0 for row in counted)
    print(f"\n{plural(len(rows))} · {money(total, r['currency'])} counted"
          + (f" · receipt total {money(r['total'], r['currency'])}" if r.get("total") is not None else ""))
    return 0


def cmd_summary(args) -> int:
    rows, records = server.list_item_rows({**params_from(args), "include_excluded": ["1"]})
    data = items.summary(rows, records)
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0
    totals = data["totals"]
    print(f"{plural(totals['counted'])} · AUD {totals['amount']:.2f} · "
          f"{totals['uncategorised']} not categorised · {totals['excluded']} ignored")
    for title, key in (("By category", "by_category"), ("By merchant", "by_merchant"), ("By month", "by_month")):
        rank = sorted(data[key].items(), key=lambda kv: kv[1]["amount"], reverse=True)
        if not rank:
            continue
        print(f"\n{title}:")
        for name, b in rank[:15]:
            print(f"  {name}: AUD {b['amount']:.2f} ({plural(b['count'])})")
    print(f"\n{REVIEW_NOTE}")
    return 0


def cmd_categorise(args) -> int:
    return edit(args.ref, category=check_category(args.category_name))


def cmd_categorise_matching(args) -> int:
    """Categorise every item matching a search — preview first, then --apply."""
    category = check_category(args.category_name)
    rows = [r for r in rows_for(args) if r["category"] != category]
    if args.limit:
        rows = rows[:args.limit]
    if not rows:
        print("No items match — nothing to change.")
        return 1
    label = category or "inherit from the receipt"
    if not args.apply:
        for row in rows:
            print(line(row))
        print(f"\nWould set {plural(len(rows))} to {label}. Re-run with --apply to write.")
        return 0
    changed = 0
    for row in rows:
        edited = server.edit_item(row["receipt_id"], row["item_id"], category=category)
        if edited:
            changed += 1
            print(line(edited))
    print(f"\nSet {plural(changed)} to {label}.")
    return 0


def cmd_describe(args) -> int:
    return edit(args.ref, description=args.text)


def cmd_ignore(args) -> int:
    return edit(args.ref, excluded=True)


def cmd_unignore(args) -> int:
    return edit(args.ref, excluded=False)


def backfill(args, *, apply: bool) -> int:
    result = server.backfill_notes(apply=apply, receipt_id=args.receipt_id,
                                   strip_notes=getattr(args, "strip_notes", False))
    for change in result["changes"]:
        print(f"{change['date'] or 'no date'} · {change['merchant']} · {change['receipt_id']}")
        for item in change["added"]:
            print(f"    + {item['description']} · {money(item['amount'])}")
        if change["duplicates"]:
            print(f"    ({change['duplicates']} already itemised, skipped)")
        if change["notes_after"] != change["notes_before"]:
            print(f"    notes now: {change['notes_after'] or '(empty)'}")
    if not result["changes"]:
        print("No `item:` / `items:` note lines left to lift.")
        return 1
    if apply:
        print(f"\nAdded {plural(result['items'])} across {plural(result['receipts'], 'receipt')}.")
    else:
        print(f"\nWould add {plural(result['items'])} across {plural(result['receipts'], 'receipt')}. "
              "Nothing written — run `receipt-items backfill-apply` to write.")
    return 0


def cmd_backfill_preview(args) -> int:
    return backfill(args, apply=False)


def cmd_backfill_apply(args) -> int:
    return backfill(args, apply=True)


def cmd_categories(_args) -> int:
    for c in CATEGORIES:
        print(c)
    print("\ninherit — clear an item's own category and follow its receipt")
    return 0


# ---- argv ----------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="receipt-items", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(required=True)

    def add_scope(s, *, with_query=False):
        if with_query:
            s.add_argument("query", nargs="?", help="text to match in the item, merchant or category")
        s.add_argument("--month", help="YYYY-MM")
        s.add_argument("--fy", choices=["current"], help="Australian financial year to date")
        s.add_argument("--category", help="receipt/effective category")
        s.add_argument("--merchant")
        s.add_argument("--uncategorised", action="store_true", help="only items with no category of their own")
        s.add_argument("--ignored", action="store_true", help="only ignored junk lines")
        s.add_argument("--all", action="store_true", help="include ignored lines")

    s = sub.add_parser("review", help="what still needs a look")
    add_scope(s)
    s.add_argument("--limit", type=int, default=10)
    s.set_defaults(func=cmd_review)

    s = sub.add_parser("list", help="search line items")
    add_scope(s, with_query=True)
    s.add_argument("--limit", type=int, default=50)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("show", help="one receipt and its items, with refs")
    s.add_argument("receipt_id")
    s.set_defaults(func=cmd_show)

    s = sub.add_parser("summary", help="item totals by category, merchant and month")
    add_scope(s, with_query=True)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_summary)

    s = sub.add_parser("categorise", help="categorise one item")
    s.add_argument("ref", help="<receipt-id>:<item-id>")
    s.add_argument("category_name", metavar="category", help="a category name, or 'inherit'")
    s.set_defaults(func=cmd_categorise)

    s = sub.add_parser("categorise-matching", help="categorise everything a search matches")
    s.add_argument("query")
    s.add_argument("category_name", metavar="category")
    add_scope(s)
    s.add_argument("--limit", type=int)
    s.add_argument("--apply", action="store_true", help="write the changes (default: preview)")
    s.set_defaults(func=cmd_categorise_matching)

    s = sub.add_parser("describe", help="fix a description (amounts stay as extracted)")
    s.add_argument("ref")
    s.add_argument("text")
    s.set_defaults(func=cmd_describe)

    s = sub.add_parser("ignore", help="mark a junk line out of item totals")
    s.add_argument("ref")
    s.set_defaults(func=cmd_ignore)

    s = sub.add_parser("unignore", help="undo ignore")
    s.add_argument("ref")
    s.set_defaults(func=cmd_unignore)

    s = sub.add_parser("backfill-preview", help="find `item:` / `items:` lines in old notes")
    s.add_argument("receipt_id", nargs="?")
    s.set_defaults(func=cmd_backfill_preview)

    s = sub.add_parser("backfill-apply", help="lift those note lines into real items")
    s.add_argument("receipt_id", nargs="?")
    s.add_argument("--strip-notes", action="store_true", dest="strip_notes",
                   help="also remove the note lines the items came from")
    s.set_defaults(func=cmd_backfill_apply)

    s = sub.add_parser("categories", help="the categories an item can take")
    s.set_defaults(func=cmd_categories)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    server.init_db()
    return args.func(args) or 0


if __name__ == "__main__":
    raise SystemExit(main())
