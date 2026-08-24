#!/usr/bin/env python3
"""Receipt itemisation model for SparkKit Receipts.

One place for the shape of the line items stored in `receipts.items_json`, so
the server, the CLI, the PWA and Ledger's wrappers all read and write them the
same way.

Stored item shape (unknown keys are dropped):

    {"id": "3f9a2c17", "description": "Cable ties 100pk", "amount": 12.5,
     "qty": 2, "category": "Materials", "excluded": false, "source": "extract"}

- `id`        stable per item, assigned the first time it is stored. Items are
              addressed as `<receipt-id>:<item-id>`.
- `category`  null means "same as the receipt" — an item only carries its own
              category once someone splits it out.
- `excluded`  a junk line (loyalty, subtotal, rounding) kept for the record but
              left out of item totals. Cleanup excludes lines, never deletes
              them: the extracted record stays a faithful copy of the docket.
- `source`    extract (model), notes (backfilled from an `item:` note line),
              manual (typed by a person).

Amounts stay as extracted. Descriptions and review state (category, excluded)
are the editable part.
"""

from __future__ import annotations

import csv
import io
import json
import re
import uuid

try:
    from contract import CATEGORIES
except ImportError:  # pragma: no cover - package-style import fallback
    from .contract import CATEGORIES

ITEM_SOURCES = ("extract", "notes", "manual")
ITEM_FIELDS = ("id", "description", "amount", "qty", "category", "excluded", "source")
ITEM_CSV_COLUMNS = [
    "date", "merchant", "description", "qty", "amount", "currency",
    "item_category", "receipt_category", "excluded", "source", "receipt_id", "item_id",
]
# Item amounts and the receipt total are allowed to differ by this much before
# the receipt is flagged as worth a look (rounding, unpriced lines).
COVERAGE_TOLERANCE = 0.05


def new_item_id() -> str:
    return uuid.uuid4().hex[:8]


def parse_amount(value):
    """Money-ish text or number -> float; None when it isn't a number."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("$", "").replace(",", "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def normalise_category(value):
    """A known category, or None meaning 'same as the receipt'."""
    if not value:
        return None
    text = str(value).strip()
    return text if text in CATEGORIES else None


def as_list(value):
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def normalise_item(raw, *, source: str = "extract"):
    """Coerce one item into the stored shape. None when there's nothing in it."""
    if isinstance(raw, str):
        raw = {"description": raw}
    if not isinstance(raw, dict):
        return None
    description = str(raw.get("description") or raw.get("desc") or "").strip()
    amount = parse_amount(raw.get("amount"))
    if not description and amount is None:
        return None
    return {
        "id": str(raw.get("id") or "").strip() or new_item_id(),
        "description": description or "Unnamed item",
        "amount": amount,
        "qty": parse_amount(raw.get("qty")),
        "category": normalise_category(raw.get("category")),
        "excluded": bool(raw.get("excluded")),
        "source": raw.get("source") if raw.get("source") in ITEM_SOURCES else source,
    }


def match_key(item: dict):
    """Identity for items that arrive without an id (older clients, CSV)."""
    amount = parse_amount(item.get("amount"))
    return (
        str(item.get("description") or "").strip().lower(),
        None if amount is None else round(amount, 2),
    )


def normalise_items(value, *, previous=None, source: str = "extract") -> list[dict]:
    """Normalise a list of items, carrying review state over from `previous`.

    A client that only knows the old `{description, amount}` shape (the phone
    before this feature, a CSV import, a re-extraction) must not wipe the
    categories and exclusions someone already set, so anything it doesn't send
    is taken from the matching stored item — by id, else by description+amount.
    """
    prev_by_id, prev_by_key = {}, {}
    for old in previous or []:
        if not isinstance(old, dict):
            continue
        if old.get("id"):
            prev_by_id[str(old["id"])] = old
        prev_by_key.setdefault(match_key(old), old)

    out, used_ids = [], set()
    for entry in as_list(value):
        item = normalise_item(entry, source=source)
        if not item:
            continue
        sent = entry if isinstance(entry, dict) else {}
        base = prev_by_id.get(item["id"]) if sent.get("id") else prev_by_key.get(match_key(item))
        if base:
            item["id"] = str(base.get("id") or item["id"])
            if "category" not in sent:
                item["category"] = normalise_category(base.get("category"))
            if "excluded" not in sent:
                item["excluded"] = bool(base.get("excluded"))
            if not sent.get("source") and base.get("source") in ITEM_SOURCES:
                item["source"] = base["source"]
            if item["qty"] is None:
                item["qty"] = parse_amount(base.get("qty"))
        while item["id"] in used_ids:
            item["id"] = new_item_id()
        used_ids.add(item["id"])
        out.append(item)
    return out


# ---- notes -> items ------------------------------------------------------
# Receipts captured before itemisation sometimes carry their lines in the
# notes field, as `item:` / `items:` lines. Backfill lifts those out.

NOTE_LINE_RE = re.compile(r"^\s*[-*•]?\s*items?\s*[:\-–—]\s*(.*)$", re.I)
BULLET_RE = re.compile(r"^\s*[-*•]\s+(.+)$")
ENTRY_SPLIT_RE = re.compile(r"\s*[;|]\s*")
QTY_RE = re.compile(r"^\s*(?P<qty>\d+(?:\.\d+)?)\s*[x×]\s*(?P<rest>\S.*)$", re.I)
TRAIL_AMOUNT_RE = re.compile(
    r"^(?P<desc>.*?)\s*(?P<sep>[@=(]|[-–—]|\bfor\b)?\s*(?P<dollar>\$)?\s*"
    r"(?P<amount>\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*\)?\s*$",
    re.I,
)


def parse_note_entry(text: str):
    """One `item:` fragment -> an item dict, or None if there's nothing in it."""
    text = (text or "").strip().strip(".,")
    if not text:
        return None
    qty = None
    m = QTY_RE.match(text)
    if m:
        qty = parse_amount(m.group("qty"))
        text = m.group("rest").strip()
    description, amount = text, None
    m = TRAIL_AMOUNT_RE.match(text)
    if m:
        # Only read a trailing number as money when it looks like money: a $
        # sign, cents, or a separator in front of it. "Conduit 20" stays a
        # description; "Conduit @ 20" and "Conduit $20" are priced.
        looks_like_money = bool(m.group("dollar")) or "." in m.group("amount") or bool(m.group("sep"))
        desc = m.group("desc").strip(" \t-–—@=(")
        if looks_like_money and desc:
            description, amount = desc, parse_amount(m.group("amount"))
    if not description:
        return None
    return normalise_item(
        {"description": description, "amount": amount, "qty": qty}, source="notes"
    )


def parse_notes_items(notes):
    """Split notes into (items, remaining notes).

    Only the `item:`/`items:` lines that actually yielded items are consumed;
    everything else is handed back untouched.
    """
    if not notes:
        return [], notes
    lines = str(notes).splitlines()
    items: list[dict] = []
    keep: list[str] = []
    i = 0
    while i < len(lines):
        m = NOTE_LINE_RE.match(lines[i])
        if not m:
            keep.append(lines[i])
            i += 1
            continue
        block, entries = [lines[i]], [e for e in ENTRY_SPLIT_RE.split(m.group(1).strip()) if e]
        i += 1
        if not entries:  # an "Items:" heading followed by bullet lines
            while i < len(lines):
                b = BULLET_RE.match(lines[i])
                if not b:
                    break
                block.append(lines[i])
                entries.extend(e for e in ENTRY_SPLIT_RE.split(b.group(1).strip()) if e)
                i += 1
        found = [item for item in (parse_note_entry(e) for e in entries) if item]
        if found:
            items.extend(found)
        else:
            keep.extend(block)
    remaining = "\n".join(keep).strip() or None
    return items, remaining


# ---- flat views ----------------------------------------------------------

def item_rows(records) -> list[dict]:
    """Flatten receipts into item rows carrying their receipt's context."""
    rows = []
    for r in records:
        for item in normalise_items(r.get("items")):
            rows.append({
                "ref": f"{r.get('id')}:{item['id']}",
                "receipt_id": r.get("id"),
                "item_id": item["id"],
                "date": r.get("date"),
                "merchant": r.get("merchant"),
                "currency": r.get("currency") or "AUD",
                "receipt_category": r.get("category") or "Other",
                "description": item["description"],
                "amount": item["amount"],
                "qty": item["qty"],
                "category": item["category"],
                "effective_category": item["category"] or r.get("category") or "Other",
                "excluded": item["excluded"],
                "source": item["source"],
            })
    rows.sort(key=lambda x: ((x["date"] or ""), x["merchant"] or "", x["description"]), reverse=True)
    return rows


def filter_rows(rows, *, q=None, category=None, item_category=None, merchant=None,
                uncategorised=False, missing_amount=False, source=None,
                include_excluded=False, only_excluded=False) -> list[dict]:
    out = []
    needle = (q or "").strip().lower()
    for row in rows:
        if row["excluded"] and not (include_excluded or only_excluded):
            continue
        if only_excluded and not row["excluded"]:
            continue
        if category and row["effective_category"] != category:
            continue
        if item_category and row["category"] != item_category:
            continue
        if uncategorised and row["category"] is not None:
            continue
        if missing_amount and row["amount"] is not None:
            continue
        if source and row["source"] != source:
            continue
        if merchant and merchant.strip().lower() not in (row["merchant"] or "").lower():
            continue
        if needle:
            hay = " ".join([
                row["description"], row["merchant"] or "", row["effective_category"],
                row["date"] or "", row["source"],
            ]).lower()
            if needle not in hay:
                continue
        out.append(row)
    return out


def summary(rows, records=None) -> dict:
    """Totals over item rows, plus how well items line up with receipt totals."""
    def bucket(store, key, row):
        b = store.setdefault(key or "unknown", {"count": 0, "amount": 0.0})
        b["count"] += 1
        b["amount"] += row["amount"] or 0
        return b

    by_category, by_merchant, by_month = {}, {}, {}
    totals = {"items": 0, "counted": 0, "excluded": 0, "uncategorised": 0,
              "missing_amount": 0, "amount": 0.0}
    for row in rows:
        totals["items"] += 1
        if row["excluded"]:
            totals["excluded"] += 1
            continue
        totals["counted"] += 1
        totals["amount"] += row["amount"] or 0
        if row["amount"] is None:
            totals["missing_amount"] += 1
        if row["category"] is None:
            totals["uncategorised"] += 1
        bucket(by_category, row["effective_category"], row)
        bucket(by_merchant, row["merchant"] or "Unknown merchant", row)
        bucket(by_month, (row["date"] or "unknown")[:7] if row["date"] else "unknown", row)

    out = {
        "totals": totals,
        "by_category": by_category,
        "by_merchant": by_merchant,
        "by_month": by_month,
        "review_note": "Review AI-extracted amounts before lodging.",
    }
    if records is not None:
        out["coverage"] = coverage(records)
    return out


def receipt_items_total(record) -> float:
    return sum(i["amount"] or 0 for i in normalise_items(record.get("items")) if not i["excluded"])


def coverage(records) -> dict:
    """Which receipts have no items, and which don't add up to their total."""
    unitemised, mismatched = [], []
    for r in records:
        items = normalise_items(r.get("items"))
        counted = [i for i in items if not i["excluded"]]
        if not counted:
            unitemised.append({"receipt_id": r.get("id"), "date": r.get("date"),
                               "merchant": r.get("merchant"), "total": r.get("total")})
            continue
        total = r.get("total")
        if not isinstance(total, (int, float)):
            continue
        items_total = sum(i["amount"] or 0 for i in counted)
        difference = round(items_total - float(total), 2)
        if abs(difference) > COVERAGE_TOLERANCE:
            mismatched.append({"receipt_id": r.get("id"), "date": r.get("date"),
                               "merchant": r.get("merchant"), "total": round(float(total), 2),
                               "items_total": round(items_total, 2), "difference": difference})
    return {
        "receipts": len(records),
        "itemised": len(records) - len(unitemised),
        "unitemised": unitemised,
        "mismatched": mismatched,
    }


def csv_from_rows(rows) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=ITEM_CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({
            "date": row["date"], "merchant": row["merchant"], "description": row["description"],
            "qty": row["qty"], "amount": row["amount"], "currency": row["currency"],
            "item_category": row["category"] or "", "receipt_category": row["receipt_category"],
            "excluded": "yes" if row["excluded"] else "", "source": row["source"],
            "receipt_id": row["receipt_id"], "item_id": row["item_id"],
        })
    return out.getvalue()


# ---- edits ---------------------------------------------------------------

def parse_ref(ref: str) -> tuple[str, str]:
    """`<receipt-id>:<item-id>` -> (receipt id, item id)."""
    receipt_id, _, item_id = str(ref or "").partition(":")
    if not receipt_id or not item_id:
        raise ValueError(f"Expected a <receipt-id>:<item-id> reference, got {ref!r}")
    return receipt_id, item_id


def apply_item_edit(items, item_id: str, *, category=..., excluded=..., description=...):
    """Edit one item in a list. Returns (new items, edited item) or (items, None)."""
    items = normalise_items(items)
    for item in items:
        if item["id"] != item_id:
            continue
        if category is not ...:
            item["category"] = normalise_category(category)
        if excluded is not ...:
            item["excluded"] = bool(excluded)
        if description is not ...:
            text = str(description or "").strip()
            if text:
                item["description"] = text
        return items, item
    return items, None
