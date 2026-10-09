// Verification for two risks the first audit surfaced. Read-only.
//
// RISK A: agent_name values that look like real people but resolve to no worker
//         row. If those names are genuinely missing from `workers`, a large share
//         of collections is attributed to nobody on any screen.
//
// RISK B: payment_id is holding GENERIC MODE LABELS, not payment references.
//         'NA', 'UPI', '*Transfer' and '#####################' are not unique
//         references. The dedup added in c728a865 treats payment_id as the
//         authoritative payment identity, so if many receipts share one of these
//         strings, that dedup would COLLAPSE them into a single payment and
//         under-count a total rather than over-count it.
//
// Run: node scripts/verify-collection-risks.mjs

const API = process.env.UCS_DB_QUERY_API || 'https://api.beingsevak.org/api/db/query';

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
const section = (t) => console.log(`\n=== ${t} ===`);

async function attempt(title, sql, render) {
  section(title);
  try {
    const rows = await run(sql);
    if (!rows.length) { console.log('(no rows)'); return rows; }
    render(rows);
  } catch (e) { console.log(`[query failed] ${e.message}`); }
  return [];
}

// RISK A -----------------------------------------------------------------------
await attempt(
  'A1. Do the "unresolved" names exist in workers at all?',
  `SELECT a.agent_name,
          (SELECT count(*) FROM workers w WHERE lower(btrim(w.name)) = lower(btrim(a.agent_name))) AS exact_worker_matches,
          (SELECT count(*) FROM workers w WHERE lower(w.name) LIKE '%' || split_part(lower(btrim(a.agent_name)), ' ', 1) || '%') AS same_first_name
     FROM (SELECT DISTINCT agent_name FROM receipts
            WHERE COALESCE(btrim(agent_name), '') <> '') a
    WHERE NOT EXISTS (SELECT 1 FROM workers w WHERE lower(btrim(w.name)) = lower(btrim(a.agent_name)))
      AND a.agent_name IN ('Poonam Gawade','Padmini','Sharad Mestry','Shabana','Bank Transfer','Pay U Money','Santosh')
    ORDER BY 1`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.agent_name).padEnd(22)} exact_worker=${r.exact_worker_matches}  same_first_name_workers=${r.same_first_name}`
  )),
);

await attempt(
  'A2. Closest worker name for the big unresolved ones',
  `WITH unres AS (
     SELECT agent_name, count(*) AS receipts, sum(amount) AS total
       FROM receipts r
      WHERE COALESCE(btrim(agent_name), '') <> ''
        AND NOT EXISTS (SELECT 1 FROM workers w WHERE lower(btrim(w.name)) = lower(btrim(r.agent_name)))
      GROUP BY 1 ORDER BY total DESC LIMIT 12
   )
   SELECT u.agent_name, u.receipts, u.total,
          (SELECT string_agg(w.name, ' | ')
             FROM workers w
            WHERE lower(w.name) LIKE '%' || split_part(lower(btrim(u.agent_name)), ' ', 1) || '%') AS same_first_name
     FROM unres u`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.agent_name).padEnd(22)} ${String(r.receipts).padStart(5)} receipts ${money(r.total).padStart(13)}  first-name match: ${r.same_first_name || '(none)'}`
  )),
);

// RISK B -----------------------------------------------------------------------
await attempt(
  'B1. Is payment_id ever a generic mode label rather than a reference?',
  `SELECT payment_id,
          count(*) AS receipts,
          count(DISTINCT agent_name) AS distinct_collectors,
          count(DISTINCT donor_id) AS distinct_donors,
          count(DISTINCT receipt_date) AS distinct_days,
          sum(amount) AS total
     FROM receipts
    WHERE COALESCE(btrim(payment_id), '') <> ''
    GROUP BY payment_id
   HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 25`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.payment_id).padEnd(24)} rows=${String(r.receipts).padStart(4)} collectors=${String(r.distinct_collectors).padStart(3)} donors=${String(r.distinct_donors).padStart(4)} days=${String(r.distinct_days).padStart(4)}  ${money(r.total)}` +
    (Number(r.distinct_donors) > 1 ? '   <-- NOT a unique reference' : '')
  )),
);

await attempt(
  'B2. COLLATERAL: receipts one FRO would lose to the payment_id dedup',
  `WITH shared AS (
     SELECT lower(btrim(agent_name)) AS collector, payment_id, count(*) AS rows_in_group
       FROM receipts
      WHERE COALESCE(btrim(payment_id), '') <> ''
        AND lower(btrim(coalesce(agent_name,''))) NOT IN ('suspense','pg','library','na')
      GROUP BY 1, 2
     HAVING count(*) > 1
   )
   SELECT s.collector,
          count(*) AS payment_id_groups,
          sum(s.rows_in_group) AS receipts_in_those_groups,
          sum(s.rows_in_group) - count(*) AS receipts_the_dedup_would_DROP
     FROM shared s
    GROUP BY 1
   HAVING sum(s.rows_in_group) - count(*) > 0
    ORDER BY receipts_the_dedup_would_DROP DESC
    LIMIT 25`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.collector).padEnd(24)} groups=${String(r.payment_id_groups).padStart(4)}  would DROP ${r.receipts_the_dedup_would_DROP} of ${r.receipts_in_those_groups} receipts`
  )),
);

await attempt(
  'B3. Same test on receipt_no (the other identity candidate)',
  `WITH shared AS (
     SELECT lower(btrim(agent_name)) AS collector, receipt_no, count(*) AS rows_in_group
       FROM receipts
      WHERE COALESCE(btrim(receipt_no), '') <> ''
        AND lower(btrim(coalesce(agent_name,''))) NOT IN ('suspense','pg','library','na')
      GROUP BY 1, 2
     HAVING count(*) > 1
   )
   SELECT collector, count(*) AS groups, sum(rows_in_group) - count(*) AS would_drop
     FROM shared GROUP BY 1 HAVING sum(rows_in_group) - count(*) > 0
    ORDER BY would_drop DESC LIMIT 15`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.collector).padEnd(24)} would DROP ${r.would_drop} receipts`
  )),
);

console.log('\ndone. every statement above was a SELECT.');