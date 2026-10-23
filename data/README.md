# Vendor data sources (synthetic sample dataset)

This folder is a **synthetic sample dataset**: three fictional vendors
(Nimbus Cloud, Stratus Systems, Cirrus Compute) with illustrative pricing.
They are not real companies and these are not real prices. These sources
are the canonical vendor catalog: the pipeline loads them per run through
`src/zetaris.ts`, either by running the matching SQL against a configured
Zetaris instance (where the same three sources are registered as tables)
or by reading these CSV files directly as the fallback. One catalog, two
access paths, and the receipts record which path served each fetch.

The `differentiator` prose attached to each vendor record is not part of
these sources. It is narrative text, not data, and lives in
`src/zetaris.ts`, keyed by vendor name.

## Files

### quotes.csv

One row per vendor: the headline compute quote.

| Column | Meaning | Unit |
| --- | --- | --- |
| `vendor` | Vendor name. Join key, identical in all three files. | text |
| `compute_annual_usd` | Headline compute price (`headlineAnnual` in the code). | USD per year |

### egress_rates.csv

One row per vendor: the data transfer (egress) pricing.

| Column | Meaning | Unit |
| --- | --- | --- |
| `vendor` | Vendor name. Join key. | text |
| `egress_per_gb_usd` | Base egress rate (`egressPerGB` in the code). | USD per GB |
| `allowance_tb` | Annual volume threshold for the base rate (`egressCapTB` in the code). Empty when the vendor has no threshold. | TB per year |
| `overage_per_gb_usd` | Rate applied to volume above the threshold (`egressOveragePerGB` in the code). | USD per GB |

### terms.csv

One row per vendor: support and SLA terms.

| Column | Meaning | Unit |
| --- | --- | --- |
| `vendor` | Vendor name. Join key. | text |
| `support_tier` | Support package description (`supportTier` in the code). | text |
| `support_annual_usd` | Annual support cost (`supportAnnual` in the code). | USD per year |
| `sla_percent` | Uptime SLA (`sla` in the code, stored there as a display string such as "99.9%"; stored here as the number). | percent |

## Join

Join the three files on `vendor` (exact name match). Every file lists the
same three vendors. The smoke script (`scripts/zetaris-smoke.ts`) checks
that the vendor sets match before it trusts the join.

## Units and conventions

- Money is USD. Rates are USD per GB.
- Volumes are TB per year.
- The code converts TB to GB by multiplying by 1000 (the decimal
  convention, not 1024). 400 TB/yr is 400,000 GB/yr in every calculation.

## Egress semantics, exactly as coded

Annual egress cost comes from `computeTCO` in `src/agents.ts`. The rules:

1. If the vendor has an `allowance_tb` and the annual volume is **above**
   it, the first `allowance_tb` are billed at `egress_per_gb_usd` and the
   remaining volume is billed at `overage_per_gb_usd`.
2. Otherwise (volume at or below the threshold, or no threshold at all),
   the whole volume is billed at `egress_per_gb_usd` and the overage
   column plays no part.

Two consequences are worth stating plainly, because the allowance is
easily misread as free volume:

- The allowance is a **rate threshold, not free volume**. Stratus Systems
  bills its first 500 TB/yr at the base rate of $0.04/GB. At 400 TB/yr its
  egress costs 400,000 GB x $0.04 = $16,000, not $0.
- The overage rate is **punitive, not a continuation**. Above 500 TB/yr,
  Stratus bills extra volume at $0.20/GB, five times the base rate. At
  800 TB/yr its egress is 500,000 x $0.04 + 300,000 x $0.20 = $20,000 +
  $60,000 = $80,000.

For the two vendors with an empty `allowance_tb` (Nimbus Cloud, Cirrus
Compute), the overage value is kept for fidelity with the code record even
though the formula never uses it. In both cases it equals the base rate.

## Total cost of ownership

Annual total = `compute_annual_usd` + annual egress + `support_annual_usd`.
TCO = annual total x term in years. The demo term is 3 years.

Reference results, reproduced by `scripts/zetaris-smoke.ts` from these
CSVs alone:

| Volume | Nimbus Cloud | Stratus Systems | Cirrus Compute | Winner |
| --- | --- | --- | --- | --- |
| 400 TB/yr, 3 years | $306,000 | $237,000 | $300,000 | Stratus Systems |
| 800 TB/yr, 3 years | $450,000 | $429,000 | $408,000 | Cirrus Compute |

The 800 TB/yr row is the demo's flip: doubling the transfer volume pushes
Stratus past its threshold into overage pricing, and Cirrus Compute, the
most expensive headline quote, becomes the cheapest total.
