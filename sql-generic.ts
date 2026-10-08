import { esc } from "./sql-builders.js";
import type { Built } from "./sql-builders.js";

export interface TreeDoc {
  id: string;
  data: Record<string, any>;
  children?: Record<string, TreeDoc[]>;
  parentId?: string;
}

type Kind = "bool" | "int" | "float" | "datetime" | "text" | "json";
interface Fixed { name: string; ddl: string }
interface ColAcc { kinds: Set<Kind>; maxLen: number; filled: number }
interface Row { fixed: any[]; vals: Record<string, any> }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID_DDL = "VARCHAR(512) NOT NULL";
const BATCH = 500; // rows per INSERT statement

const q = (s: string) => "`" + s + "`";

function ident(s: string): string {
  let x = s.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
  if (!x) x = "col";
  if (/^\d/.test(x)) x = "c_" + x;
  return x.slice(0, 60);
}

function unique(base: string, taken: Set<string>): string {
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  taken.add(n);
  return n;
}

function plain(v: any): any {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v.toDate === "function") return plain(v.toDate());
  if (typeof v.latitude === "number" && typeof v.longitude === "number") return { lat: v.latitude, lng: v.longitude };
  if (typeof v.path === "string" && typeof v.firestore === "object") return `ref:${v.path}`;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return `bytes(${v.length})`;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function flatten(obj: Record<string, any>, prefix: string, out: Record<string, any>) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (Array.isArray(v)) {
      if (v.length) out[key] = v;
    } else if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = v;
  }
}

const isScalar = (x: any) => x === null || ["string", "number", "boolean"].includes(typeof x);

function kindOf(v: any): Kind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return !Number.isFinite(v) ? null : Number.isSafeInteger(v) ? "int" : "float";
  if (typeof v === "string") return ISO.test(v) ? "datetime" : "text";
  return "json";
}

function sqlType(a: ColAcc): string {
  const k = [...a.kinds];
  const text = a.maxLen <= 255 ? "VARCHAR(255)" : "TEXT";
  if (k.length === 0) return "TEXT";
  if (k.length === 1) {
    switch (k[0]) {
      case "bool": return "BOOLEAN";
      case "int": return "BIGINT";
      case "float": return "DOUBLE";
      case "datetime": return "DATETIME(3)";
      case "json": return "JSON";
      default: return text;
    }
  }
  if (k.every((x) => x === "int" || x === "float")) return "DOUBLE";
  if (k.every((x) => x === "text" || x === "datetime")) return text;
  return "TEXT"; 
}

function fmt(v: any, type: string): string {
  if (v === null || v === undefined) return "NULL";
  if (type === "DATETIME(3)") return esc(String(v).replace("T", " ").replace("Z", ""));
  if (type === "JSON") return esc(JSON.stringify(v));
  if (type === "TEXT" || type.startsWith("VARCHAR")) return esc(typeof v === "object" ? JSON.stringify(v) : String(v));
  return esc(v); 
}

class Table {
  private kids = new Map<string, Table>();
  private cols = new Map<string, ColAcc>();
  private keyToCol = new Map<string, string>();
  private taken: Set<string>;
  private rows: Row[] = [];

  constructor(
    readonly name: string,
    private fixed: Fixed[],
    private constraints: string[],
    readonly hasParent = false,
  ) {
    this.taken = new Set(fixed.map((f) => f.name));
  }

  get count() { return this.rows.length; }

  kid(key: string, make: () => Table): Table {
    let t = this.kids.get(key);
    if (!t) { t = make(); this.kids.set(key, t); }
    return t;
  }

  private colFor(key: string): string {
    let c = this.keyToCol.get(key);
    if (!c) {
      c = unique(ident(key), this.taken);
      this.keyToCol.set(key, c);
      this.cols.set(c, { kinds: new Set(), maxLen: 0, filled: 0 });
    }
    return c;
  }

  add(fixedVals: any[], fields: Record<string, any>) {
    const vals: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) {
      const c = this.colFor(k);
      vals[c] = v;
      const kind = kindOf(v);
      if (kind) {
        const a = this.cols.get(c)!;
        a.kinds.add(kind);
        a.filled++;
        if (typeof v === "string") a.maxLen = Math.max(a.maxLen, v.length);
      }
    }
    this.rows.push({ fixed: fixedVals, vals });
  }

  private types(): Map<string, string> {
    return new Map([...this.cols].map(([n, a]) => [n, sqlType(a)]));
  }

  ddl(): string {
    const types = this.types();
    const lines = [
      ...this.fixed.map((f) => `  ${q(f.name)} ${f.ddl}`),
      ...[...this.cols].map(([n, a]) => `  ${q(n)} ${types.get(n)}${a.filled === this.rows.length ? " NOT NULL" : ""}`),
      ...this.constraints.map((c) => `  ${c}`),
    ];
    return `CREATE TABLE ${q(this.name)} (\n${lines.join(",\n")}\n) CHARACTER SET utf8mb4;\n`;
  }

  inserts(): string {
    const types = this.types();
    const names = [...this.cols.keys()];
    const all = [...this.fixed.map((f) => f.name), ...names];
    let out = "";
    for (let i = 0; i < this.rows.length; i += BATCH) {
      const values = this.rows
        .slice(i, i + BATCH)
        .map((r) => "  (" + [...r.fixed.map((x) => esc(x)), ...names.map((n) => fmt(r.vals[n], types.get(n)!))].join(", ") + ")")
        .join(",\n");
      out += `INSERT INTO ${q(this.name)} (${all.map(q).join(", ")}) VALUES\n${values};\n\n`;
    }
    return out;
  }

  report(): string[] {
    const out = [`${this.name}: ${this.rows.length} rows`];
    const types = this.types();
    for (const [n, a] of this.cols) {
      const missing = this.rows.length - a.filled;
      if (missing > 0) out.push(`  ${this.name}.${n}: empty in ${missing} of ${this.rows.length} rows`);
      if (types.get(n) === "JSON") out.push(`  ${this.name}.${n}: list of objects, stored as JSON`);
    }
    return out;
  }
}

/**
 * @param collectionPath "products" or a subcollection pattern like "Ustart/{id}/interns"
 * @param docs           the documents, each optionally carrying its subcollections in `children`
 */
export function buildGenericSql(collectionPath: string, docs: TreeDoc[]): Built {
  const tables: Table[] = [];
  const usedNames = new Set<string>();

  const newTable = (base: string, fixed: Fixed[], constraints: string[], hasParent = false) => {
    const t = new Table(unique(ident(base), usedNames), fixed, constraints, hasParent);
    tables.push(t);
    return t;
  };
  const fk = (parent: Table) =>
    `FOREIGN KEY (${q("parent_id")}) REFERENCES ${q(parent.name)}(${q("id")}) ON DELETE CASCADE`;
  const docCols: Fixed[] = [
    { name: "id", ddl: ID_DDL },
    { name: "doc_id", ddl: ID_DDL },
    { name: "parent_id", ddl: ID_DDL },
  ];

  const nestedRoot = docs.some((d) => d.parentId !== undefined);
  const root = newTable(
    collectionPath.split("/").filter((s) => s !== "{id}").join("_"),
    nestedRoot ? docCols : [{ name: "id", ddl: ID_DDL }],
    [`PRIMARY KEY (${q("id")})`],
    nestedRoot,
  );

  function walk(t: Table, list: TreeDoc[], parentRowId?: string) {
    for (const d of list) {
      const pid = parentRowId ?? d.parentId;
      const rowId = t.hasParent && pid !== undefined ? `${pid}/${d.id}` : d.id;

      const fields: Record<string, any> = {};
      flatten(plain(d.data ?? {}), "", fields);

      const arrays: [string, any[]][] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v) && v.every(isScalar)) { arrays.push([k, v]); delete fields[k]; }
      }

      t.add(t.hasParent ? [rowId, d.id, pid] : [rowId], fields);

      for (const [k, items] of arrays) {
        const at = t.kid(`arr:${k}`, () =>
          newTable(
            `${t.name}_${k}`,
            [{ name: "parent_id", ddl: ID_DDL }, { name: "position", ddl: "INT NOT NULL" }],
            [`PRIMARY KEY (${q("parent_id")}, ${q("position")})`, fk(t)],
          ),
        );
        items.forEach((x, i) => at.add([rowId, i], { value: x }));
      }

      for (const [sub, subDocs] of Object.entries(d.children ?? {})) {
        if (!subDocs.length) continue;
        const st = t.kid(`sub:${sub}`, () =>
          newTable(`${t.name}_${sub}`, docCols, [`PRIMARY KEY (${q("id")})`, fk(t)], true),
        );
        walk(st, subDocs, rowId);
      }
    }
  }
  walk(root, docs);

  const drops = [...tables].reverse().map((t) => `DROP TABLE IF EXISTS ${q(t.name)};`).join("\n");
  const sql =
    `-- Generated from Firestore collection "${collectionPath}" (generic table design)\n` +
    `SET NAMES utf8mb4;\n\n${drops}\n\n` +
    tables.map((t) => t.ddl()).join("\n") + "\n" +
    tables.map((t) => t.inserts()).join("");

  return { sql, summary: tables.flatMap((t) => t.report()) };
}