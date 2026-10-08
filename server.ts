import express from "express";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint, DocumentReference, CollectionReference } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";
import { buildProductsSql, buildUsersSql } from "./sql-builders.js";
import type { Doc, Built } from "./sql-builders.js";
import { buildGenericSql } from "./sql-generic.js";
import type { TreeDoc } from "./sql-generic.js";

const SQL_BUILDERS: Record<string, (docs: Doc[]) => Built> = {
  products: buildProductsSql,
  users: buildUsersSql,
};

const key = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
initializeApp({ credential: cert(key) });
const db = getFirestore();

const SCHEMA_SAMPLE = 50; 
const SHOW_SAMPLES = 50;
const SUBCOL_CHECK = 50; 

function typeOf(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `array<${[...new Set(v.map(typeOf))].join("|") || "empty"}>`;
  if (v instanceof Timestamp) return "timestamp";
  if (v instanceof GeoPoint) return "geopoint";
  if (v instanceof DocumentReference) return "reference";
  if (Buffer.isBuffer(v)) return "bytes";
  if (typeof v === "object") return "map";
  return typeof v;
}

function collectFields(obj: any, prefix: string, out: Record<string, Set<string>>) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const t = typeOf(v);
    (out[p] ??= new Set()).add(t);
    if (t === "map") collectFields(v, p, out);
  }
}

function serialize(v: any): any {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof GeoPoint) return { lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return `ref:${v.path}`;
  if (Buffer.isBuffer(v)) return `bytes(${v.length})`;
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serialize(x)]));
  return v;
}

async function scan(col: CollectionReference, name: string, report: any) {
  const entry = (report[name] ??= { docCount: 0, fields: {}, samples: [] });
  const found: Record<string, Set<string>> = {};
  entry.docCount += (await col.count().get()).data().count;

  const snap = await col.limit(SCHEMA_SAMPLE).get();
  let i = 0;
  for (const doc of snap.docs) {
    collectFields(doc.data(), "", found);
    if (entry.samples.length < SHOW_SAMPLES)
      entry.samples.push({ _id: doc.id, ...serialize(doc.data()) });
    if (i++ < SUBCOL_CHECK)
      for (const sub of await doc.ref.listCollections())
        await scan(sub, `${name}/{id}/${sub.id}`, report);
  }
  for (const [p, types] of Object.entries(found))
    entry.fields[p] = [...new Set([...(entry.fields[p] ?? []), ...types])];
}

const app = express();
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/discover", async (_req, res) => {
  try {
    const report: any = {};
    for (const c of await db.listCollections()) await scan(c, c.id, report);
    res.json({ projectId: key.project_id, collections: report });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


const VIEW_LIMIT = 100; 

async function findCollection(name: string) {
  const all = await db.listCollections();
  return all.find((c) => c.id === name) ?? null;
}

async function findNested(pattern: string): Promise<QueryDocumentSnapshot[] | null> {
  const segs = pattern.split("/");
  const valid =
    segs.length % 2 === 1 && segs.every((s, i) => (i % 2 === 1 ? s === "{id}" : /^[^/{}]+$/.test(s)));
  if (!valid || !(await findCollection(segs[0]))) return null;
  const snap = await db.collectionGroup(segs[segs.length - 1]).get();
  return snap.docs.filter((d) => {
    const p = d.ref.path.split("/");
    return p.length === segs.length + 1 && segs.every((s, i) => i % 2 === 1 || p[i] === s);
  });
}

const ancestorIds = (p: string) =>
  p.split("/").filter((_, i) => i % 2 === 1).slice(0, -1).join("/");

async function toTree(snaps: QueryDocumentSnapshot[], nested = false): Promise<TreeDoc[]> {
  const out: TreeDoc[] = [];
  for (const d of snaps) {
    const children: Record<string, TreeDoc[]> = {};
    for (const sub of await d.ref.listCollections())
      children[sub.id] = await toTree((await sub.get()).docs);
    const t: TreeDoc = { id: d.id, data: d.data(), children };
    if (nested) t.parentId = ancestorIds(d.ref.path);
    out.push(t);
  }
  return out;
}

function treeToJson(d: TreeDoc): any {
  const subs = Object.fromEntries(
    Object.entries(d.children ?? {})
      .filter(([, v]) => v.length)
      .map(([k, v]) => [k, v.map(treeToJson)]),
  );
  return {
    _id: d.id,
    ...(d.parentId !== undefined ? { _parent: d.parentId } : {}),
    ...serialize(d.data),
    ...(Object.keys(subs).length ? { __subcollections: subs } : {}),
  };
}


app.get("/api/collections", async (_req, res) => {
  try {
    const report: any = {};
    for (const c of await db.listCollections()) await scan(c, c.id, report);
    const out = Object.entries(report).map(([name, r]: [string, any]) => ({
      name,
      count: r.docCount,
      sql: true, 
    }));
    res.json({ projectId: key.project_id, collections: out });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/collection/:name", async (req, res) => {
  try {
    const name = req.params.name;
    if (name.includes("/")) {
      const snaps = await findNested(name);
      if (!snaps) return res.status(404).json({ error: `No collection called "${name}".` });
      const docs = snaps
        .slice(0, VIEW_LIMIT)
        .map((d) => ({ _id: d.id, _path: d.ref.path, ...serialize(d.data()) }));
      return res.json({ name, total: snaps.length, shown: docs.length, docs });
    }
    const col = await findCollection(name);
    if (!col) return res.status(404).json({ error: `No collection called "${name}".` });
    const total = (await col.count().get()).data().count;
    const snap = await col.limit(VIEW_LIMIT).get();
    const docs = snap.docs.map((d) => ({ _id: d.id, ...serialize(d.data()) }));
    res.json({ name: col.id, total, shown: docs.length, docs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/collection/:name/download", async (req, res) => {
  try {
    const name = req.params.name;
    const nested = name.includes("/");
    let snaps: QueryDocumentSnapshot[];
    if (nested) {
      const found = await findNested(name);
      if (!found) return res.status(404).json({ error: `No collection called "${name}".` });
      snaps = found;
    } else {
      const col = await findCollection(name);
      if (!col) return res.status(404).json({ error: `No collection called "${name}".` });
      snaps = (await col.get()).docs;
    }
    const format = String(req.query.format ?? "json");
    const file = name.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (format === "sql") {
      const built =
        !nested && Object.hasOwn(SQL_BUILDERS, name)
          ? SQL_BUILDERS[name](snaps.map((d) => ({ id: d.id, data: d.data() })))
          : buildGenericSql(name, await toTree(snaps, nested));
      built.summary.forEach((l) => console.log(l));
      res.setHeader("Content-Type", "application/sql; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file}.sql"`);
      return res.send(built.sql);
    }

    const json = (await toTree(snaps, nested)).map(treeToJson);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file}.json"`);
    res.send(JSON.stringify(json, null, 2));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log("Open http://localhost:3000"));