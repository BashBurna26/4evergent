#!/usr/bin/env node
// Fails when the routes served by apps/api and the routes in
// openapi/openapi.json diverge in either direction.
// Run: pnpm check:openapi
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const fail = (msg) => { console.error(`openapi check failed: ${msg}`); process.exit(1); };

// --- served routes: parse the router chain in index.ts ---
const src = read("apps/api/src/index.ts");
const served = new Set();
const norm = (p) => p.replace(/\{[^}]+\}/g, "{}");
const add = (m, p) => served.add(`${m} ${norm(p)}`);
for (const m of src.matchAll(/method === "([A-Z]+)" && url === "([^"]+)"/g)) add(m[1], m[2]);
for (const m of src.matchAll(/method === "([A-Z]+)" && (\/\^[^\n]*?\$\/)\.test\(url\)/g)) {
  let p = m[2].slice(2, -2).replace(/\(\\\?\.\*\)\?/g, "").replace(/\\\//g, "/");
  const alt = p.match(/\(([a-z|]+)\)$/);
  const variants = alt ? alt[1].split("|").map((a) => p.replace(alt[0], a)) : [p];
  for (const v of variants) add(m[1], v.replace(/\[\^\/\]\+/g, "{}"));
}
if (served.size === 0) fail("no served routes found; router format changed, update this script");

// --- documented routes ---
let doc;
try { doc = JSON.parse(read("openapi/openapi.json")); } catch (e) { fail(`openapi/openapi.json does not parse: ${e.message}`); }
if (!/^3\./.test(doc.openapi ?? "")) fail("missing OpenAPI 3.x version");
const documented = new Set();
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  for (const [method, o] of Object.entries(item)) {
    documented.add(`${method.toUpperCase()} ${norm(path)}`);
    if (!o.responses || !Object.keys(o.responses).length) fail(`${method} ${path} has no responses`);
  }
}

// --- excluded /auth/* routes must match auth.ts exactly ---
const auth = read("apps/api/src/auth.ts");
const authServed = new Set([...auth.matchAll(/method === "([A-Z]+)" && path === "(\/auth\/[^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`));
const excluded = new Set(doc["x-excluded-routes"]?.routes ?? []);

const problems = [];
for (const r of served) if (!documented.has(r)) problems.push(`served but not documented: ${r}`);
for (const r of documented) if (!served.has(r)) problems.push(`documented but not served: ${r}`);
for (const r of authServed) if (!excluded.has(r)) problems.push(`auth route neither documented nor excluded: ${r}`);
for (const r of excluded) if (!authServed.has(r)) problems.push(`excluded route not served by auth.ts: ${r}`);
if (problems.length) fail("\n  " + problems.join("\n  "));
console.log(`openapi ok: ${documented.size} documented routes match ${served.size} served routes; ${excluded.size} /auth/* routes excluded`);
