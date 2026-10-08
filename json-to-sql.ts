import fs from "fs";
import path from "path";
import { buildProductsSql, buildUsersSql } from "./sql-builders.js";
import type { Doc, Built } from "./sql-builders.js";
import { buildGenericSql } from "./sql-generic.js";
import type { TreeDoc } from "./sql-generic.js";

const inDir = process.argv[2] ?? "data";
const outDir = process.argv[3] ?? "sql";


const builders: Record<string, (docs: Doc[]) => Built> = {
  products: buildProductsSql,
  users: buildUsersSql,
};


const toTree = (rows: any[]): TreeDoc[] =>
  rows.map(({ _id, __subcollections, ...data }: any) => ({
    id: String(_id),
    data,
    children: Object.fromEntries(
      Object.entries(__subcollections ?? {}).map(([k, v]) => [k, toTree(v as any[])]),
    ),
  }));

if (!fs.existsSync(inDir)) {
  console.error(`Folder "${inDir}" not found. Run "npm run export:json" first.`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

let converted = 0;
for (const file of fs.readdirSync(inDir).filter((f) => f.endsWith(".json"))) {
  const name = path.basename(file, ".json");
  const rows = JSON.parse(fs.readFileSync(path.join(inDir, file), "utf8"));
  if (!Array.isArray(rows)) {
    console.error(`${file} must contain a list of documents`);
    process.exit(1);
  }
  const tree = toTree(rows);
  const build = Object.hasOwn(builders, name) ? builders[name] : undefined;
  const result = build
    ? build(tree.map(({ id, data }) => ({ id, data })))
    : buildGenericSql(name, tree);
  fs.writeFileSync(path.join(outDir, `${name}.sql`), result.sql);
  result.summary.forEach((l) => console.log(l));
  converted++;
}

if (converted === 0) {
  console.error(`No .json files found in "${inDir}".`);
  process.exit(1);
}
console.log(`Done. Files are in the ${outDir}/ folder.`);