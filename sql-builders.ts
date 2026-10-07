export interface Doc {
  id: string;
  data: Record<string, any>;
}
export interface Built {
  sql: string;
  summary: string[];
}


export function toMysqlDate(v: any): string | null {
  let d: Date | null = null;
  if (v && typeof v.toDate === "function") d = v.toDate();
  else if (typeof v === "string" || typeof v === "number") {
    const x = new Date(v);
    if (!isNaN(x.getTime())) d = x;
  }
  return d ? d.toISOString().replace("T", " ").replace("Z", "") : null;
}

export function esc(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  const s = String(v)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\0/g, "\\0")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\x1a/g, "\\Z");
  return `'${s}'`;
}

function insertSql(table: string, cols: string[], rows: any[][]): string {
  if (rows.length === 0) return `-- no rows for ${table}\n`;
  const values = rows.map((r) => "  (" + r.map(esc).join(", ") + ")").join(",\n");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n${values};\n`;
}

const strings = (v: any): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];


function nullReport(label: string, cols: string[], rows: any[][]): string[] {
  const out: string[] = [];
  cols.forEach((c, i) => {
    const missing = rows.filter((r) => r[i] === null || r[i] === undefined).length;
    if (missing > 0) out.push(`  ${label}.${c}: empty in ${missing} of ${rows.length} rows`);
  });
  return out;
}

export function buildProductsSql(docs: Doc[]): Built {
  const pCols = ["id", "name", "description", "price", "category", "gender", "created_at", "updated_at"];
  const products: any[][] = [];
  const images: any[][] = [];
  const notes: any[][] = [];

  for (const { id, data: d } of docs) {
    products.push([
      id, d.name, d.description,
      typeof d.price === "number" ? d.price : null,
      d.category, d.gender, toMysqlDate(d.createdAt), toMysqlDate(d.updatedAt),
    ]);
    strings(d.imageUrls).forEach((url, i) => images.push([id, i, url]));
    strings(d.notes).forEach((n, i) => notes.push([id, i, n]));
  }

  const sql = `-- Generated from Firestore collection "products"
SET NAMES utf8mb4;

DROP TABLE IF EXISTS product_notes;
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS products;

CREATE TABLE products (
  id          VARCHAR(128) PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  price       DECIMAL(10,2) NOT NULL,
  category    VARCHAR(100) NOT NULL,
  gender      VARCHAR(50) NOT NULL,
  created_at  DATETIME(3) NOT NULL,
  updated_at  DATETIME(3) NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE product_images (
  product_id VARCHAR(128) NOT NULL,
  position   INT NOT NULL,
  url        TEXT NOT NULL,
  PRIMARY KEY (product_id, position),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4;

CREATE TABLE product_notes (
  product_id VARCHAR(128) NOT NULL,
  position   INT NOT NULL,
  note       TEXT NOT NULL,
  PRIMARY KEY (product_id, position),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4;

${insertSql("products", pCols, products)}
${insertSql("product_images", ["product_id", "position", "url"], images)}
${insertSql("product_notes", ["product_id", "position", "note"], notes)}`;

  return {
    sql,
    summary: [
      `products.sql: ${products.length} products, ${images.length} images, ${notes.length} notes`,
      ...nullReport("products", pCols, products),
    ],
  };
}

export function buildUsersSql(docs: Doc[]): Built {
  const cols = ["id", "username", "full_name", "email", "avatar_url", "is_admin", "is_online", "created_at", "last_seen"];
  const rows = docs.map(({ id, data: d }) => [
    id, d.username,
    d.fullName ?? d.name ?? null, // merge old "name" and new "fullName"
    d.email, d.avatarUrl || null, // empty string becomes NULL
    d.isAdmin, d.isOnline, toMysqlDate(d.createdAt), toMysqlDate(d.lastSeen),
  ]);

  const sql = `-- Generated from Firestore collection "users"
SET NAMES utf8mb4;

DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id         VARCHAR(128) PRIMARY KEY,
  username   VARCHAR(100) UNIQUE,
  full_name  VARCHAR(255),
  email      VARCHAR(255) NOT NULL UNIQUE,
  avatar_url TEXT,
  is_admin   BOOLEAN NOT NULL,
  is_online  BOOLEAN,
  created_at DATETIME(3),
  last_seen  DATETIME(3)
) CHARACTER SET utf8mb4;

${insertSql("users", cols, rows)}`;

  return {
    sql,
    summary: [`users.sql: ${rows.length} users`, ...nullReport("users", cols, rows)],
  };
}