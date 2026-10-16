# Sparkit — Apprentice Toolkit

A mobile-first toolkit for electrical apprentices: trade calculators + a rules quick-reference.
Built for **AS/NZS** standards (230V single / 400V three-phase). *(Working name — easy to rename.)*

## What's in v1

**Calculators**
- **Ohm's Law / Power** — enter any two of V, I, R, P; get the rest.
- **Voltage Drop** — solver: enter any three of voltage drop / current / route length / cable mV/A/m and it finds the fourth, then checks % drop against the AS/NZS 3000 limit.
- **Three-Phase** — line/phase voltage, kW / kVA / kVAR from line current and power factor.
- **Conduit Fill** — cable overall diameters vs conduit internal diameter, with common fill limits.
- **Cable Deratings** — base current-carrying capacity × ambient / grouping / insulation factors, checked against design load.

**Rules reference** — cable colours, IP ratings, RCD protection, disconnection times, voltage-drop limit.

## Design principle

Calculators do the **maths** from established formulas. Where a value comes from an AS/NZS table
(cable mV/A/m, derating factors), **you enter it from your tables** — typical values are shown only as
indicative hints. This keeps every result correct and avoids shipping table data that could be wrong or out of date.

> ⚠️ Study & field aid only. Verify every result against the current AS/NZS standards and a licensed supervisor.

## Run it

No build step — it's a static PWA. From this folder:

```sh
python3 -m http.server 5173
# then open http://localhost:5173
```

Installable to a phone home screen and works offline (service worker caches the app shell).

## ReceiptWise

Receipt capture lives in its own workspace: [`receipts/`](receipts/README.md) and
is branded **ReceiptWise**.
Photograph a receipt, Claude extracts the details (merchant, date, total, GST,
category), and everything is stored on-device with monthly totals and CSV export.

## Roadmap

- Source-backed regulations lookup with edition, jurisdiction and review dates.
- Worked examples and saved calculator history.
- Max-demand calculator and cable current-capacity tables (needs verified AS/NZS 3008 / 3000 table data).
- Native wrapper once the web version feels right.
