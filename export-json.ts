import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint, DocumentReference } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import fs from "fs";

const key = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
initializeApp({ credential: cert(key) });
const db = getFirestore();


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

async function dump(docs: QueryDocumentSnapshot[]): Promise<any[]> {
  const rows: any[] = [];
  for (const d of docs) {
    const row: any = { _id: d.id, ...serialize(d.data()) };
    const subs: Record<string, any[]> = {};
    for (const sub of await d.ref.listCollections()) {
      const subRows = await dump((await sub.get()).docs);
      if (subRows.length) subs[sub.id] = subRows;
    }
    if (Object.keys(subs).length) row.__subcollections = subs;
    rows.push(row);
  }
  return rows;
}

(async () => {
  fs.mkdirSync("data", { recursive: true });
  for (const col of await db.listCollections()) {
    const rows = await dump((await col.get()).docs);
    fs.writeFileSync(`data/${col.id}.json`, JSON.stringify(rows, null, 2));
    console.log(`data/${col.id}.json: ${rows.length} documents`);
  }
  console.log("Done. Next: npm run json:sql");
})().catch((e) => {
  console.error("Export failed:", e.message);
  process.exit(1);
});