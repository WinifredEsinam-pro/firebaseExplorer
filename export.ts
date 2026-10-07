import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import { buildProductsSql, buildUsersSql } from "./sql-builders.js";
import type { Doc } from "./sql-builders.js";

const key = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
initializeApp({ credential: cert(key) });
const db = getFirestore();

async function load(name: string): Promise<Doc[]> {
  const snap = await db.collection(name).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

(async () => {
  fs.mkdirSync("sql", { recursive: true });

  const products = buildProductsSql(await load("products"));
  fs.writeFileSync("sql/products.sql", products.sql);
  products.summary.forEach((l) => console.log(l));

  const users = buildUsersSql(await load("users"));
  fs.writeFileSync("sql/users.sql", users.sql);
  users.summary.forEach((l) => console.log(l));

  console.log("Done. Files are in the sql/ folder.");
})().catch((e) => {
  console.error("Export failed:", e.message);
  process.exit(1);
});