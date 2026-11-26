# Decisions, assumptions and rule sources

## Stack (MVP)
- **Node.js 22 + Express**, server‑rendered HTML pages, tiny bit of browser JS. Chosen for speed of building and almost no moving parts.
- **SQLite via Node's built‑in `node:sqlite`** — one database file, no separate database server, no native add‑ons. Fine for 3–10 staff and 100 clients on one server.
- **PWA**: web manifest + service worker caching only static files (never client data).
- **Why not Next.js + Supabase yet?** It was the brief's suggestion and is still the target for production scale (multiple servers, managed backups, Row‑Level Security as a second isolation layer, cloud file storage). The data model was written to port directly to PostgreSQL; the tax engine and ledger modules don't depend on the web framework.

### Estimated running cost
| Option | Monthly (approx.) |
|---|---|
| MVP on a small VPS (1 vCPU, 1–2 GB) + daily backup copied to cloud storage | US$5–8 (₱300–450) |
| Later: Supabase Pro (Postgres + storage + backups) + Vercel/Render app | US$25–45 (₱1,450–2,600) |
| Claude API for receipt OCR (Phase 6), ~3,000 receipts/month | roughly US$10–30, depends on model and image size |

## Accuracy rules
- Money = integer **centavos**. Rates = integer **ppm** (12% = 120000). All multiplication uses BigInt, rounding **half‑up (away from zero) to the centavo** at each computed line.
- VAT from a VAT‑inclusive amount: `VAT = round(total × 12/112)`, `net = total − VAT` (so they always add back to the total).
- Journals must balance (checked in code inside a transaction); DB `CHECK`s forbid negative / double‑sided lines; DB triggers forbid editing or deleting posted lines and the audit log.

## Accounting / tax assumptions (please review)
1. **Input VAT** is claimable only when: client is VAT‑registered, supplier is VAT‑registered, the document is an **invoice** (EOPT Act — ORs no longer support input VAT), and the expense isn't marked personal. Otherwise the VAT goes to the expense account.
2. **Non‑VAT client sales** are stored in the "exempt / non‑VAT" column and are the percentage tax base.
3. **8% option**: ₱250,000 reduction is always applied (assumes purely self‑employed, not mixed‑income). In lieu of graduated rates **and** percentage tax, so no 2551Q is computed for 8% clients.
4. **OSD**: individuals 40% of gross sales/receipts; corporations 40% of gross income (sales − cost of sales + other income).
5. **MCIT** applies from the 4th taxable year after the year operations started (`year ≥ ops_start_year + 4`). Gross income for MCIT = sales − cost of sales + other income (passive income subject to final tax is not separated yet).
6. **Small corporation 20%**: chosen manually on the client profile; the app reminds you of the ₱5M taxable income / ₱100M assets test but doesn't check total assets automatically.
7. **Quarterly income tax** is cumulative; "prior quarter payments" are assumed equal to what the app computed for those quarters (not the amounts actually paid). Creditable withholding = cumulative debits to account **1310**.
8. **GPP** is treated as income‑tax exempt (partners report their shares); a **taxable partnership** uses corporate rates. Non‑stock/coop: exempt by default — confirm the exemption basis per client.
9. Personal expenses post to **Owner's/Partners' Drawings (3020)**; for corporations they can't be posted (reject them).
10. **Deadlines** that land on Saturday/Sunday roll to Monday. **Public holidays are not modelled** yet.
11. **2550Q** quarterly only (monthly 2550M dropped from 2023 under TRAIN). Line references on worksheets are indicative — verify against the current form version.
12. Statement of Changes in Equity shows contributions/drawings during the period inside the "beginning" line (MVP simplification).

## Seeded tax rules and sources
All in `src/rules.js` and visible on the **Tax rules** screen. ⚠ = marked "needs review" in the app.

| Rule | Value | Effective | Source |
|---|---|---|---|
| VAT rate | 12% | 2006‑02‑01 → | NIRC Secs. 106/108 as amended by RA 9337; retained by TRAIN |
| VAT threshold | ₱3,000,000 | 2018‑01‑01 → | NIRC Sec. 109(CC) as amended by TRAIN; RR 13‑2018 |
| Percentage tax | 3% / **1%** / 3% | 2018 / 2020‑07‑01 to 2023‑06‑30 / 2023‑07‑01 → | NIRC Sec. 116; RA 11534 (CREATE); RR 4‑2021 |
| Graduated table | 2018–2022 table; 2023+ table | | NIRC Sec. 24(A)(2)(a) as amended by TRAIN |
| 8% option | 8%, ₱250k reduction, ₱3M ceiling | 2018 → | NIRC Sec. 24(A)(2)(b); RR 8‑2018 |
| OSD | 40% | 2008‑07‑06 → | NIRC Sec. 34(L) as amended by RA 9504; RR 16‑2008 |
| RCIT | 30% → 25% | 2020‑07‑01 | CREATE; RR 5‑2021 |
| Small corp | 20% (≤₱5M NTI, ≤₱100M assets) | 2020‑07‑01 → | CREATE; RR 5‑2021 |
| MCIT | 2% / **1%** / 2% | 2020‑07‑01 to 2023‑06‑30 = 1% | NIRC Sec. 27(E); CREATE; RMC 69‑2023 |
| Penalties (regular) | 25% surcharge, 12% p.a. interest | 2018 → | NIRC Secs. 248–249 as amended by TRAIN |
| Penalties ⚠ | micro/small: 10% surcharge, 6% p.a. interest | 2024‑01‑22 → | RA 11976 (EOPT); RR 6‑2024 — **confirm effective date & coverage** |
| 2550Q deadline ⚠ | 25 days after quarter end | 2023 → | NIRC Sec. 114(A); RR 3‑2024 — **confirm** |
| 2551Q | 25 days after quarter end | 2018 → | NIRC Sec. 128; RR 11‑2018 |
| 0619‑E / 1601‑C | 10th of next month (Dec 1601‑C: Jan 15) | 2018 → | RR 11‑2018 |
| 1601‑EQ | last day of month after quarter | 2018 → | RR 11‑2018 |
| 1701Q | May 15 / Aug 15 / Nov 15 | 2018 → | NIRC Sec. 74; RR 8‑2018 |
| 1702Q | 60 days after quarter end | 2018 → | NIRC Sec. 77(B) |
| 1701 / 1702 | Apr 15 / 15th day of 4th month after FY end | | NIRC Secs. 51(C), 77(B) |
| 1604‑C / 1604‑E | Jan 31 / Mar 1 | 2018 → | RR 11‑2018 as amended |

## Open questions for L2C
1. Should prior‑quarter income tax credits use the **actual amount paid** (from the Filings screen) instead of the computed amount?
2. For 8% clients with **mixed income** (also employed), should we add a "mixed income" flag to skip the ₱250k reduction?
3. Which **public holiday** list do you want (regular + special non‑working, plus local holidays per RDO)?
4. Do any clients need **fiscal‑year 1701Q** handling (individuals are calendar‑year by law, so the app assumes calendar year for 1701Q dates)?
5. Preferred printed layout for loose‑leaf books — continuous page numbers per book per year, or per period?
