/**
 * Zetaris data layer (Lane A): the one module that knows how Thought
 * Receipts talks to its vendor data.
 *
 * The vendor catalog lives in three sources, registered in Zetaris as
 * separate tables and joined on vendor:
 *
 *   quotes        (vendor, compute_annual_usd)
 *   egress_rates  (vendor, egress_per_gb_usd, allowance_tb, overage_per_gb_usd)
 *   terms         (vendor, support_tier, support_annual_usd, sla_percent)
 *
 * Two access paths serve the same queries, and every fetch reports which
 * one actually served it:
 *
 *   1. Live SQL through runSql(sql): active when ZETARIS_BASE_URL is set
 *      (and SAMPLE_MODE is off). The pipeline steps run the SQL below
 *      against the instance and work from the returned rows.
 *      dataSource: "zetaris".
 *
 *   2. Bundled CSV fallback: the same three sources as CSV files under
 *      data/, loaded with loadSource() and joined locally. This path
 *      serves the run when no instance is configured, when SAMPLE_MODE
 *      is on (sample mode makes no network calls at all), and when a
 *      configured instance errors or returns rows we cannot use.
 *      dataSource: "csv-fallback".
 *
 * What public sources pin down about the client protocol (checked
 * Oct 22, 2026):
 *
 *   - Local install (github.com/zetaris/Freemium): a REST API service
 *     (zetaris-api) listens on port 8888 for external clients (8889
 *     internal), the web UI on 9001, and the query engine takes JDBC at
 *     port 10000 (jdbc:zetaris:lightning@host:10000). The REST layer
 *     translates calls into JDBC queries and returns JSON.
 *   - Zetaris knowledge base, "Accessing Zetaris through Rest API"
 *     (kbase.zetaris.com/knowledge/rest-api): the enterprise API logs in
 *     for an idToken used as a Bearer credential, and runs queries
 *     through an OpenSqlQuery request whose JSON body is
 *     { "select": "SELECT ...", "pageLimit": n } with n between 1 and
 *     100; the JSON response carries the result rows plus a queryToken
 *     for pagination.
 *
 * What is NOT public: the managed AWS cluster's exact HTTP contract (the
 * SQL endpoint path, the request field name, the response envelope, and
 * whether auth is Basic or a login token). Assumption, stated plainly:
 * postSql() posts { sql: "..." } as JSON to ZETARIS_SQL_PATH with Basic
 * auth from ZETARIS_USERNAME and ZETARIS_PASSWORD when a username is
 * set, and extractRows() accepts the response shapes described in
 * its comment. Confirming the real cluster contract means changing
 * postSql() and env values, nothing else:
 *
 *   ZETARIS_BASE_URL    instance base URL, e.g. http://localhost:8888
 *   ZETARIS_SQL_PATH    SQL endpoint path (default "/api/sql")
 *   ZETARIS_USERNAME    basic-auth user, when the instance requires one
 *   ZETARIS_PASSWORD    basic-auth password
 *   ZETARIS_DATA_DIR    override for the data/ folder (offline path)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Live path: runSql --------------------------------------------------------

/** Thrown by runSql when no Zetaris instance is configured. */
export class ZetarisNotConfiguredError extends Error {
  readonly code = "ZETARIS_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "ZetarisNotConfiguredError";
  }
}

export interface ZetarisConfig {
  baseUrl: string;
  sqlPath: string;
  username: string | null;
  password: string | null;
}

/** Read the live-path config from the environment. Null when unconfigured. */
export function zetarisConfig(): ZetarisConfig | null {
  const baseUrl = (process.env.ZETARIS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  const sqlPathRaw = (process.env.ZETARIS_SQL_PATH ?? "").trim();
  return {
    baseUrl,
    sqlPath: sqlPathRaw ? (sqlPathRaw.startsWith("/") ? sqlPathRaw : `/${sqlPathRaw}`) : "/api/sql",
    username: (process.env.ZETARIS_USERNAME ?? "").trim() || null,
    password: (process.env.ZETARIS_PASSWORD ?? "").trim() || null,
  };
}

/**
 * The single HTTP call behind runSql. Assumed shape per the header
 * comment: POST the SQL as JSON, read JSON results back. If the confirmed
 * cluster contract differs, this is the only function that changes.
 */
async function postSql(config: ZetarisConfig, sql: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.username !== null) {
      const credentials = Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64");
      headers.Authorization = `Basic ${credentials}`;
    }
    const res = await fetch(`${config.baseUrl}${config.sqlPath}`, {
      method: "POST",
      signal: ctrl.signal,
      headers,
      body: JSON.stringify({ sql }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Zetaris SQL request failed with ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a SQL query against the configured Zetaris instance and return the
 * parsed JSON result. Throws ZetarisNotConfiguredError when
 * ZETARIS_BASE_URL is not set.
 */
export async function runSql(sql: string): Promise<unknown> {
  const config = zetarisConfig();
  if (!config) {
    throw new ZetarisNotConfiguredError(
      "Zetaris is not configured. Set ZETARIS_BASE_URL to enable live SQL, or use loadSource() for the bundled offline sources."
    );
  }
  return postSql(config, sql);
}

// --- Result rows ---------------------------------------------------------------

export type SqlRow = Record<string, unknown>;

/**
 * Extract result rows from a Zetaris JSON payload. The managed cluster's
 * response envelope is not public (see the header comment), so this
 * accepts the shapes the public sources and the local REST pattern
 * suggest, in order:
 *
 *   - a bare array of row objects
 *   - { rows: [...] } of row objects
 *   - { rows: [[...], ...], columns: [...] } with column names as strings
 *     or { name } objects, zipped into row objects
 *   - { results: [...] }, { data: [...] }, or { result: [...] } of row
 *     objects
 *
 * Anything else yields an empty array, which callers treat as unusable
 * and fall back to the bundled CSV sources.
 */
export function extractRows(payload: unknown): SqlRow[] {
  const asObjects = (value: unknown): SqlRow[] | null => {
    if (!Array.isArray(value)) return null;
    if (value.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
      return value as SqlRow[];
    }
    return null;
  };

  const bare = asObjects(payload);
  if (bare) return bare;
  if (payload === null || typeof payload !== "object") return [];

  const rec = payload as Record<string, unknown>;
  for (const key of ["rows", "results", "data", "result"]) {
    const value = rec[key];
    const objects = asObjects(value);
    if (objects) return objects;
    if (Array.isArray(value) && Array.isArray(rec.columns)) {
      const names = rec.columns.map((c) =>
        typeof c === "string" ? c : String((c as Record<string, unknown>)?.name ?? "")
      );
      if (names.every((n) => n !== "")) {
        return value.map((cells) => {
          const row: SqlRow = {};
          names.forEach((name, i) => {
            row[name] = Array.isArray(cells) ? cells[i] : undefined;
          });
          return row;
        });
      }
    }
  }
  return [];
}

/** Normalize typed SQL rows to the string records the CSV path produces. */
export function normalizeRows(rows: SqlRow[]): CsvRow[] {
  return rows.map((row) => {
    const out: CsvRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) out[key] = "";
      else if (typeof value === "string") out[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
      else out[key] = JSON.stringify(value);
    }
    return out;
  });
}

// --- Offline path: the bundled CSV sources ------------------------------------

export type CsvRow = Record<string, string>;

export type SourceName = "quotes" | "egress_rates" | "terms";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Folder holding the CSV sources. Defaults to the repo's data/ folder,
 * which sits one level above both src/ (this file as authored) and dist/
 * (this file as built). ZETARIS_DATA_DIR overrides it.
 */
export function dataDir(): string {
  const override = (process.env.ZETARIS_DATA_DIR ?? "").trim();
  if (override) return override;
  return path.resolve(MODULE_DIR, "..", "data");
}

/**
 * Minimal CSV parser: comma separated, double-quoted fields may contain
 * commas, quotes (escaped as ""), and newlines. Returns one record per
 * data row, keyed by the header row. Empty fields stay empty strings.
 */
export function parseCsv(text: string): CsvRow[] {
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    table.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) endRow();

  const rows = table.filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const rec: CsvRow = {};
    header.forEach((col, idx) => {
      rec[col] = r[idx] ?? "";
    });
    return rec;
  });
}

/**
 * Load one of the bundled vendor sources from data/ and parse it into
 * records keyed by column name. Values are the raw CSV strings; an empty
 * field (for example the allowance_tb of the two uncapped vendors) is an
 * empty string. Callers convert numbers as needed.
 */
export function loadSource(name: SourceName): CsvRow[] {
  const file = path.join(dataDir(), `${name}.csv`);
  return parseCsv(readFileSync(file, "utf8"));
}

// --- The vendor queries and the fetches the pipeline runs ---------------------

/**
 * The catalog query: the three sources joined on vendor, in headline
 * price order. This is the query the research step runs against Zetaris;
 * the CSV fallback computes the identical join locally from data/.
 */
export const CATALOG_SQL =
  "SELECT q.vendor AS vendor, q.compute_annual_usd AS compute_annual_usd, " +
  "e.egress_per_gb_usd AS egress_per_gb_usd, e.allowance_tb AS allowance_tb, " +
  "e.overage_per_gb_usd AS overage_per_gb_usd, t.support_tier AS support_tier, " +
  "t.support_annual_usd AS support_annual_usd, t.sla_percent AS sla_percent " +
  "FROM quotes q " +
  "JOIN egress_rates e ON e.vendor = q.vendor " +
  "JOIN terms t ON t.vendor = q.vendor " +
  "ORDER BY q.compute_annual_usd";

/** The terms query the terms-check step runs against the terms source. */
export const TERMS_SQL =
  "SELECT vendor, support_tier, support_annual_usd, sla_percent FROM terms ORDER BY vendor";

/** One data fetch, with the provenance the receipts record. */
export interface SourceFetch {
  /** The SQL text for this fetch (recorded in both modes). */
  query: string;
  /** The rows the fetch actually used, as string records. */
  rows: CsvRow[];
  /** Which path served the rows. */
  dataSource: "zetaris" | "csv-fallback";
}

function sampleModeOn(): boolean {
  return (process.env.SAMPLE_MODE ?? "").trim().toLowerCase() === "true";
}

/**
 * Run one fetch: live SQL when an instance is configured (and SAMPLE_MODE
 * is off), the bundled CSV computation otherwise, and the CSV computation
 * as a labeled fallback when the live call errors or returns no usable
 * rows. The fallback rows are the rows the run actually uses, so the
 * receipt provenance stays truthful either way.
 */
async function fetchWithFallback(query: string, csvRows: () => CsvRow[]): Promise<SourceFetch> {
  if (!sampleModeOn() && zetarisConfig() !== null) {
    try {
      const rows = normalizeRows(extractRows(await runSql(query)));
      if (rows.length > 0 && rows.every((r) => (r.vendor ?? "") !== "")) {
        return { query, rows, dataSource: "zetaris" };
      }
    } catch {
      // Configured but unreachable or unusable: fall through to the
      // bundled sources and label the fetch accordingly.
    }
  }
  return { query, rows: csvRows(), dataSource: "csv-fallback" };
}

/** Join the three bundled CSV sources on vendor, mirroring CATALOG_SQL. */
export function joinCsvSources(): CsvRow[] {
  const quotes = loadSource("quotes");
  const egressByVendor = new Map(loadSource("egress_rates").map((r) => [r.vendor, r]));
  const termsByVendor = new Map(loadSource("terms").map((r) => [r.vendor, r]));
  const joined = quotes.map((q) => {
    const e = egressByVendor.get(q.vendor);
    const t = termsByVendor.get(q.vendor);
    if (!e || !t) {
      throw new Error(`Vendor "${q.vendor}" is missing from egress_rates.csv or terms.csv`);
    }
    return {
      vendor: q.vendor,
      compute_annual_usd: q.compute_annual_usd,
      egress_per_gb_usd: e.egress_per_gb_usd,
      allowance_tb: e.allowance_tb,
      overage_per_gb_usd: e.overage_per_gb_usd,
      support_tier: t.support_tier,
      support_annual_usd: t.support_annual_usd,
      sla_percent: t.sla_percent,
    };
  });
  // CATALOG_SQL orders by headline price; keep the local join in the
  // same order so both paths hand the pipeline identical catalogs.
  joined.sort((a, b) => Number(a.compute_annual_usd) - Number(b.compute_annual_usd));
  return joined;
}

/** Fetch the joined vendor catalog (the research step's data). */
export async function fetchCatalog(): Promise<SourceFetch> {
  return fetchWithFallback(CATALOG_SQL, joinCsvSources);
}

/** Fetch the support and SLA terms (the terms-check step's data). */
export async function fetchTerms(): Promise<SourceFetch> {
  return fetchWithFallback(TERMS_SQL, () => loadSource("terms"));
}

// --- Vendor records -------------------------------------------------------------

/**
 * A vendor record derived from the joined sources. Structurally the
 * record src/agents.ts reasons over; it is built here so the data layer
 * owns the shape its sources produce.
 */
export interface VendorRecord {
  name: string;
  headlineAnnual: number;
  egressPerGB: number;
  /** TB/yr billed at egressPerGB before the overage rate applies; null means no threshold. */
  egressCapTB: number | null;
  egressOveragePerGB: number;
  supportAnnual: number;
  supportTier: string;
  sla: string;
  differentiator: string;
}

/**
 * The one-line edge each vendor is known for. This is narrative prose,
 * not source data (see data/README.md), so it lives with the code and is
 * attached by vendor name when records are built.
 */
const DIFFERENTIATORS: Record<string, string> = {
  "Nimbus Cloud": "cheapest headline compute price",
  "Stratus Systems": "flat low egress rate inside a 500TB/yr cap, premium support",
  "Cirrus Compute": "no egress cap, predictable cost at any scale",
};

function numField(row: CsvRow, col: string): number {
  const raw = (row[col] ?? "").trim();
  const value = Number(raw);
  if (raw === "" || Number.isNaN(value)) {
    throw new Error(`Expected a number in column "${col}", got "${raw}" (vendor "${row.vendor ?? "?"}")`);
  }
  return value;
}

/**
 * Build vendor records from joined catalog rows (either path's output).
 * Sorted by headline price, matching CATALOG_SQL's ORDER BY, so the
 * pipeline sees the same catalog order no matter which path served it.
 * Egress semantics are NOT applied here; computeTCO in src/agents.ts owns
 * the math, exactly as before.
 */
export function buildVendorRecords(rows: CsvRow[]): VendorRecord[] {
  const records = rows.map((row) => {
    const allowanceRaw = (row.allowance_tb ?? "").trim();
    return {
      name: row.vendor,
      headlineAnnual: numField(row, "compute_annual_usd"),
      egressPerGB: numField(row, "egress_per_gb_usd"),
      egressCapTB: allowanceRaw === "" ? null : Number(allowanceRaw),
      egressOveragePerGB: numField(row, "overage_per_gb_usd"),
      supportAnnual: numField(row, "support_annual_usd"),
      supportTier: row.support_tier ?? "",
      sla: `${numField(row, "sla_percent")}%`,
      differentiator: DIFFERENTIATORS[row.vendor] ?? "",
    };
  });
  records.sort((a, b) => a.headlineAnnual - b.headlineAnnual);
  return records;
}
