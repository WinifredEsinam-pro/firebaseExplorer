import express from "express";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint, DocumentReference, CollectionReference } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";

const key = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
initializeApp({ credential: cert(key) });
const db = getFirestore();

const SCHEMA_SAMPLE = 1000; 
const SHOW_SAMPLES = 1000;   
const SUBCOL_CHECK = 1000;   

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

app.listen(3000, () => console.log("Open http://localhost:3000"));