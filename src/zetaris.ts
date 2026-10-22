/**
 * Zetaris data seam (Lane A): the one module that knows how Thought
 * Receipts talks to its data layer.
 *
 * Two access paths live here:
 *
 *   1. runSql(sql): live SQL against a Zetaris instance. Active only when
 *      ZETARIS_BASE_URL is set; otherwise it throws
 *      ZetarisNotConfiguredError so callers can fall back to the offline
 *      path instead of failing silently.
 *
 *   2. loadSource(name): offline access to the three bundled vendor
 *      sources in data/ (quotes, egress_rates, terms). This is the path
 *      SAMPLE_MODE and the smoke script use, and the fallback that keeps
 *      the demo alive with no Zetaris instance at all.
 *
 * Honest status of the live path: for the managed AWS cluster, the access
 * surfaces confirmed so far are the cluster Gateway (web UI) and a JDBC
 * endpoint (see the Managed AWS cluster doc in the build plan). The
 * programmatic client contract will be confirmed from Zetaris's own
 * Client setup doc before Lane A wires anything into the pipeline. Until
 * then, the HTTP shape in postSql() below follows the local-install REST
 * pattern (SQL over HTTP to the instance's REST port, JSON results back)
 * as a placeholder. It is isolated in that one function and driven
 * entirely by environment variables, so confirming the real contract
 * means changing postSql() and env values, nothing else:
 *
 *   ZETARIS_BASE_URL    instance base URL, e.g. http://localhost:8888
 *   ZETARIS_SQL_PATH    SQL endpoint path (default "/api/sql")
 *   ZETARIS_USERNAME    basic-auth user, when the instance requires one
 *   ZETARIS_PASSWORD    basic-auth password
 *   ZETARIS_DATA_DIR    override for the data/ folder (offline path)
 *
 * This module is a seam. Nothing in the pipeline imports it yet; the live
 * wiring lands when the cluster exists.
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
 * The single HTTP call behind runSql. Placeholder shape per the header
 * comment: POST the SQL as JSON, read JSON results back. If the confirmed
 * client contract differs, this is the only function that changes.
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
