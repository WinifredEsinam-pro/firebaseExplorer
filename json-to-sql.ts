import fs from "fs";
import path from "path";
import { buildProductsSql, buildUsersSql } from "./sql-builders.js";
import type { Doc, Built } from "./sql-builders.js";

const inDir = process.argv[2] ?? "data";
const outDir = process.argv[3] ?? "sql";

const builders: Record<string, (docs: Doc[]) => Built> = {
  products: buildProductsSql,
  users: buildUsersSql,
};

if (!fs.existsSync(inDir)) {
  console.error(`Folder "${inDir}" not found. Run "npm run export:json" first.`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

let converted = 0;
for (const file of fs.readdirSync(inDir).filter((f) => f.endsWith(".json"))) {
  const name = path.basename(file, ".json");
  const build = builders[name];
  if (!build) {
    console.log(`Skipped ${file}: no SQL design for "${name}" yet`);
    continue;
  }
  const rows = JSON.parse(fs.readFileSync(path.join(inDir, file), "utf8"));
  if (!Array.isArray(rows)) {
    console.error(`${file} must contain a list of documents`);
    process.exit(1);
  }
  const docs: Doc[] = rows.map(({ _id, ...data }: any) => ({ id: String(_id), data }));
  const result = build(docs);
  fs.writeFileSync(path.join(outDir, `${name}.sql`), result.sql);
  result.summary.forEach((l) => console.log(l));
  converted++;
}

if (converted === 0) {
  console.error(`No products.json or users.json found in "${inDir}".`);
  process.exit(1);
}
console.log(`Done. Files are in the ${outDir}/ folder.`);