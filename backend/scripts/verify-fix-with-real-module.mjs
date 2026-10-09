// Verify the fallback fix using the REAL module, not a re-implementation in SQL.
//
// The earlier SQL check was wrong: it counted each FRO's own correctly-matched
// receipts as "wrongly claimed", so every FRO appeared fully removed. This loads
// the actual service and runs the actual merge over receipts fetched from the
// live DB, so the number it prints is the number the card will show.
//
// Run: node scripts/verify-fix-with-real-module.mjs

import {
  mergeAttributedReceipts,
  totalCollectionAmount,
} from '../src/services/froCollectionMatch.js';

const API = process.env.UCS_DB_QUERY_API || 'https://api.beingsevak.org/api/db/query';
const MONTH_START = process.env.MONTH || null; // optional: pin a YYYY-MM to audit

async function run(sql) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j && j.error) throw new Error(String(j.error));
  return Array.isArray(j) ? j : (j.rows || j.data || []);
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

// Current month's receipts, plus the two resolution sets the loader builds.
const ym = MONTH_START || null;
const monthFilter = ym
  ? `r.receipt_date >= '${ym}-01'::date AND r.receipt_date < (date '${ym}-01'::date + interval '1 month')`
  : `r.receipt_date >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata'))::date
     AND r.receipt_date <  (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 month')::date`;

console.log(`auditing ${ym || 'the current IST month'}`);

const receipts = await run(`
  SELECT r.id, r.receipt_no, r.amount, r.receipt_date, r.agent_name, r.log_id,
         l.fro_worker_id AS log_worker_id
    FROM receipts r
    LEFT JOIN fro_donor_logs l ON l.id = r.log_id
   WHERE ${monthFilter}`);

const workers = await run(`
  SELECT id, name FROM workers
   WHERE department = 'FRO' AND is_active IS NOT FALSE AND name IS NOT NULL`);

const aliases = await run(`SELECT alias_name, worker_id FROM worker_aliases`);

const norm = (v) => String(v ?? '').trim().toLowerCase();
const CATS = new Set(['suspense', 'pg', 'library', 'na']);

// Same construction as getAllWorkerNameResolvers().
const resolvers = new Set();
for (const w of workers) { const n = norm(w.name); if (n && !CATS.has(n)) resolvers.add(n); }
for (const a of aliases) { const n = norm(a.alias_name); if (n && !CATS.has(n)) resolvers.add(n); }

// nameSet[workerId] = the names that credit this worker (canonical + aliases).
const nameSet = new Map();
for (const w of workers) {
  const s = new Set();
  const n = norm(w.name);
  if (n && !CATS.has(n)) s.add(n);
  for (const a of aliases) if (String(a.worker_id) === String(w.id)) { const k = norm(a.alias_name); if (k && !CATS.has(k)) s.add(k); }
  nameSet.set(String(w.id), s);
}

const byLog = new Map();
for (const r of receipts) {
  const id = String(r.log_worker_id ?? '');
  if (!id) continue;
  if (!byLog.has(id)) byLog.set(id, []);
  byLog.get(id).push(r);
}

const results = [];
for (const w of workers) {
  const wid = String(w.id);
  const names = nameSet.get(wid) || new Set();
  const byName = receipts.filter((r) => names.has(norm(r.agent_name)));
  const byLogRows = byLog.get(wid) || [];

  const after = mergeAttributedReceipts(byName, byLogRows, resolvers);
  const before = mergeAttributedReceipts(byName, byLogRows); // no resolver set

  const tAfter = totalCollectionAmount(after);
  const tBefore = totalCollectionAmount(before);
  if (tAfter !== tBefore) results.push({ name: w.name, before: tBefore, after: tAfter, removed: tBefore - tAfter });
}

console.log(`\nreceipts in window: ${receipts.length}   FROs: ${workers.length}`);
console.log(`FROs whose card total changes: ${results.length}\n`);
results
  .sort((a, b) => b.removed - a.removed)
  .forEach((r) => console.log(
    `${String(r.name).padEnd(24)} before ${money(r.before).padStart(12)}  ->  after ${money(r.after).padStart(12)}   removed ${money(r.removed)}`
  ));

// The reported case, spelled out row by row.
const VT = workers.find((w) => String(w.name).toLowerCase() === 'varsha tambe');
if (VT) {
  const wid = String(VT.id);
  const names = nameSet.get(wid) || new Set();
  const byName = receipts.filter((r) => names.has(norm(r.agent_name)));
  const byLogRows = byLog.get(wid) || [];
  const after = mergeAttributedReceipts(byName, byLogRows, resolvers);
  const before = mergeAttributedReceipts(byName, byLogRows);
  console.log(`\n=== Varsha Tambe, receipt by receipt ===`);
  console.log(`name-matched rows      : ${byName.length}`);
  console.log(`total after the fix    : ${money(totalCollectionAmount(after))}`);
  console.log(`total before the fix   : ${money(totalCollectionAmount(before))}`);
  const kept = new Set(after.map((r) => String(r.id)));
  const dropped = (byLogRows || []).filter((r) => !kept.has(String(r.id)));
  console.log(`\nrows the log fallback offered but no longer claims:`);
  if (!dropped.length) console.log('  (none)');
  dropped.forEach((r) => console.log(
    `  receipt ${String(r.receipt_no).padEnd(9)} ${money(r.amount).padStart(9)}  stamped "${r.agent_name}"  -> credited to that FRO instead`
  ));
}

console.log('\ndone. every statement above was a SELECT.');