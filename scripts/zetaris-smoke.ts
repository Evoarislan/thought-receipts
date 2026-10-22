/**
 * Lane A smoke check for the bundled vendor sources.
 *
 * Loads the three CSVs in data/ through the zetaris seam, joins them on
 * vendor, prints the joined rows, and then verifies the port: recomputing
 * total cost of ownership from the CSV values with the same formula as
 * computeTCO in src/agents.ts must reproduce the numbers the pipeline
 * produces from its in-code catalog.
 *
 * Run it from the compiled output: build the repo (npm run build), compile
 * this script alongside src/zetaris.ts, and run the result with node.
 * Exits 0 when every check passes, 1 otherwise.
 */
import { loadSource, type CsvRow } from "../src/zetaris.js";

interface JoinedVendor {
  name: string;
  computeAnnual: number;
  egressPerGB: number;
  /** TB/yr billed at the base rate before overage applies; null = no threshold. */
  allowanceTB: number | null;
  overagePerGB: number;
  supportTier: string;
  supportAnnual: number;
  slaPercent: number;
}

function num(row: CsvRow, col: string): number {
  const raw = (row[col] ?? "").trim();
  const value = Number(raw);
  if (raw === "" || Number.isNaN(value)) {
    throw new Error(`Expected a number in column "${col}", got "${raw}" (vendor "${row.vendor ?? "?"}")`);
  }
  return value;
}

function joinSources(): JoinedVendor[] {
  const quotes = loadSource("quotes");
  const egress = loadSource("egress_rates");
  const terms = loadSource("terms");
  const egressByVendor = new Map(egress.map((r) => [r.vendor, r]));
  const termsByVendor = new Map(terms.map((r) => [r.vendor, r]));

  return quotes.map((q) => {
    const name = q.vendor;
    const e = egressByVendor.get(name);
    const t = termsByVendor.get(name);
    if (!e || !t) throw new Error(`Vendor "${name}" is missing from egress_rates.csv or terms.csv`);
    const allowanceRaw = (e.allowance_tb ?? "").trim();
    return {
      name,
      computeAnnual: num(q, "compute_annual_usd"),
      egressPerGB: num(e, "egress_per_gb_usd"),
      allowanceTB: allowanceRaw === "" ? null : Number(allowanceRaw),
      overagePerGB: num(e, "overage_per_gb_usd"),
      supportTier: t.support_tier,
      supportAnnual: num(t, "support_annual_usd"),
      slaPercent: num(t, "sla_percent"),
    };
  });
}

/**
 * The computeTCO formula from src/agents.ts, restated over the CSV shape
 * so the numbers can be recomputed from the sources alone. The semantics
 * being mirrored: TB convert to GB at 1000 per TB; volume above the
 * allowance is billed at the overage rate while the allowance itself is
 * billed at the base rate (a threshold, not free volume); TCO is the
 * annual total times the term.
 */
function computeTcoCsv(v: JoinedVendor, volumeTB: number, termYears: number): { egressAnnual: number; tco: number } {
  const gb = volumeTB * 1000;
  let egressAnnual: number;
  if (v.allowanceTB !== null && volumeTB > v.allowanceTB) {
    const cappedGB = v.allowanceTB * 1000;
    egressAnnual = cappedGB * v.egressPerGB + (gb - cappedGB) * v.overagePerGB;
  } else {
    egressAnnual = gb * v.egressPerGB;
  }
  const annual = v.computeAnnual + egressAnnual + v.supportAnnual;
  return { egressAnnual: Math.round(egressAnnual), tco: Math.round(annual * termYears) };
}

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${String(actual)}, expected ${String(expected)}`);
}

function main(): void {
  const vendors = joinSources();

  console.log("Joined vendor rows (quotes + egress_rates + terms on vendor):");
  for (const v of vendors) {
    const allowance = v.allowanceTB === null ? "no threshold" : `${v.allowanceTB}TB/yr at base rate`;
    console.log(
      `- ${v.name}: compute ${fmt(v.computeAnnual)}/yr, egress ${fmt(v.egressPerGB)}/GB (${allowance}, overage ${fmt(v.overagePerGB)}/GB), ` +
        `support ${fmt(v.supportAnnual)}/yr (${v.supportTier}), SLA ${v.slaPercent}%`
    );
  }
  console.log("");

  const names = vendors.map((v) => v.name).sort().join(", ");
  check("vendor set", names, "Cirrus Compute, Nimbus Cloud, Stratus Systems");

  const byName = new Map(vendors.map((v) => [v.name, v]));
  const tcoAt = (name: string, volumeTB: number) => computeTcoCsv(byName.get(name)!, volumeTB, 3).tco;
  const egressAt = (name: string, volumeTB: number) => computeTcoCsv(byName.get(name)!, volumeTB, 3).egressAnnual;
  const winnerAt = (volumeTB: number) =>
    [...vendors].sort((a, b) => computeTcoCsv(a, volumeTB, 3).tco - computeTcoCsv(b, volumeTB, 3).tco)[0].name;

  console.log("TCO checks (3-year term, formula mirrored from computeTCO):");
  check("Stratus Systems TCO at 400TB/yr", tcoAt("Stratus Systems", 400), 237000);
  check("Cirrus Compute TCO at 400TB/yr", tcoAt("Cirrus Compute", 400), 300000);
  check("Nimbus Cloud TCO at 400TB/yr", tcoAt("Nimbus Cloud", 400), 306000);
  check("winner at 400TB/yr", winnerAt(400), "Stratus Systems");
  check("Cirrus Compute TCO at 800TB/yr (the flip)", tcoAt("Cirrus Compute", 800), 408000);
  check("Stratus Systems TCO at 800TB/yr", tcoAt("Stratus Systems", 800), 429000);
  check("Nimbus Cloud TCO at 800TB/yr", tcoAt("Nimbus Cloud", 800), 450000);
  check("winner at 800TB/yr", winnerAt(800), "Cirrus Compute");
  check("Stratus egress at 400TB/yr (allowance billed at base rate)", egressAt("Stratus Systems", 400), 16000);
  check("Stratus egress at 800TB/yr (500TB base + 300TB overage)", egressAt("Stratus Systems", 800), 80000);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
