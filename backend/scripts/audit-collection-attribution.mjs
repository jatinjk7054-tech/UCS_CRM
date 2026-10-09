// Read-only collection-attribution audit, run over the same HTTP query endpoint
// backend/scripts/inspect-schema.js uses (POST /api/db/query).
//
// Why over HTTP rather than the pg pool: the .env in this checkout has no
// DATABASE_URL, so there is no direct connection here. The endpoint is already
// deployed and reachable, and every statement below is a SELECT.
//
// It answers the question the code fix could not: with the real data, how many
// FRO totals are affected, and does receipt 83746 behave as the bug predicted?
//
// Usage:  node scripts/audit-collection-attribution.mjs
// Nothing here writes. If a query fails it is reported and skipped.

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
  } catch (e) {
    console.log(`[query failed] ${e.message}`);
  }
  return [];
}

// ---------------------------------------------------------------------------
// 0. The reported receipt, if it exists.
// ---------------------------------------------------------------------------
await attempt(
  'Receipt 83746 - name vs log owner',
  `SELECT r.id, r.receipt_no, r.amount, r.receipt_date,
          r.agent_name,
          w.name  AS name_resolves_to,
          l.id    AS log_id,
          lw.name AS log_owner_name
     FROM receipts r
     LEFT JOIN workers w ON lower(btrim(w.name)) = lower(btrim(r.agent_name))
     LEFT JOIN fro_donor_logs l ON l.id = r.log_id
     LEFT JOIN workers lw ON lw.id = l.fro_worker_id
    WHERE r.receipt_no = '83746'
       OR (r.receipt_no::bigint = 83746)`,
  (rows) => rows.forEach((r) => {
    console.log(`receipt ${r.receipt_no}  ${money(r.amount)}  ${r.receipt_date}`);
    console.log(`  agent_name on receipt : ${r.agent_name}`);
    console.log(`  that name is          : ${r.name_resolves_to || '(unresolved)'}`);
    console.log(`  linked log_id         : ${r.log_id ?? '(none)'}`);
    console.log(`  log's FRO             : ${r.log_owner_name || '(unresolved)'}`);
    const conflict = r.name_resolves_to && r.log_owner_name
      && r.name_resolves_to.toLowerCase() !== r.log_owner_name.toLowerCase();
    console.log(`  verdict               : ${conflict ? 'CONFLICT (name now wins)' : 'consistent'}`);
  }),
);

// ---------------------------------------------------------------------------
// 1. What values does receipts.agent_name actually hold?
// ---------------------------------------------------------------------------
await attempt(
  'agent_name values, by volume',
  `SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(blank)') AS agent_name,
          count(*) AS receipts,
          sum(amount) AS total
     FROM receipts
    GROUP BY 1
    ORDER BY receipts DESC
    LIMIT 40`,
  (rows) => {
    console.log('agent_name'.padEnd(34), 'receipts'.padStart(9), 'total'.padStart(14));
    rows.forEach((r) => console.log(String(r.agent_name).padEnd(34), String(r.receipts).padStart(9), money(r.total).padStart(14)));
  },
);

// ---------------------------------------------------------------------------
// 2. How much sits under CRM agent labels, and is it recoverable?
// ---------------------------------------------------------------------------
await attempt(
  'CRM agent labels in receipts',
  `SELECT r.agent_name,
          count(*) AS receipts,
          sum(r.amount) AS total,
          count(*) FILTER (WHERE r.log_id IS NOT NULL) AS has_log_fallback,
          EXISTS (SELECT 1 FROM worker_aliases a
                   WHERE lower(btrim(a.alias_name)) = lower(btrim(r.agent_name))
          ) AS alias_exists
     FROM receipts r
    WHERE lower(btrim(r.agent_name)) ~ '^agent\\s*[0-9]+$'
    GROUP BY r.agent_name
    ORDER BY total DESC`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.agent_name).padEnd(12)} receipts=${String(r.receipts).padStart(4)}  ${money(r.total).padStart(12)}` +
    `  log_fallback=${r.has_log_fallback}  alias=${r.alias_exists}` +
    (String(r.has_log_fallback) === '0' ? '   <-- recoverable via neither signal' : '')
  )),
);

// ---------------------------------------------------------------------------
// 3. Name/log conflicts, per FRO, most money first. This is the audit list the
//    shipped bug would have produced.
// ---------------------------------------------------------------------------
await attempt(
  'Name vs log conflicts, per FRO',
  `SELECT w.name AS credited_to,
          lw.name AS log_says,
          count(*) AS receipts,
          sum(r.amount) AS value
     FROM receipts r
     JOIN workers w  ON lower(btrim(w.name)) = lower(btrim(r.agent_name))
     JOIN fro_donor_logs l ON l.id = r.log_id
     JOIN workers lw ON lw.id = l.fro_worker_id
    WHERE lower(btrim(coalesce(r.agent_name, ''))) NOT IN ('suspense','pg','library','na')
      AND lower(btrim(w.name)) <> lower(btrim(coalesce(lw.name, '')))
    GROUP BY 1, 2
    ORDER BY value DESC
    LIMIT 40`,
  (rows) => rows.forEach((r) => console.log(
    `credited to ${String(r.credited_to).padEnd(24)} log says ${String(r.log_says).padEnd(24)} ${String(r.receipts).padStart(3)} receipts  ${money(r.value).padStart(12)}`
  )),
);

// ---------------------------------------------------------------------------
// 4. Money attributable to nobody at all.
// ---------------------------------------------------------------------------
await attempt(
  'Receipts resolvable by neither signal',
  `SELECT COALESCE(NULLIF(btrim(r.agent_name), ''), '(blank)') AS agent_name,
          count(*) AS receipts,
          sum(r.amount) AS total,
          count(*) FILTER (WHERE r.log_id IS NULL) AS no_log_at_all
     FROM receipts r
    WHERE COALESCE(btrim(r.agent_name), '') <> ''
      AND lower(btrim(r.agent_name)) NOT IN ('suspense','pg','library','na','priyank shah')
      AND NOT EXISTS (SELECT 1 FROM workers w WHERE lower(btrim(w.name)) = lower(btrim(r.agent_name)))
      AND NOT EXISTS (SELECT 1 FROM worker_aliases a WHERE lower(btrim(a.alias_name)) = lower(btrim(r.agent_name)))
    GROUP BY 1
    ORDER BY total DESC
    LIMIT 40`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.agent_name).padEnd(30)} ${String(r.receipts).padStart(4)} receipts  ${money(r.total).padStart(12)}  no_log=${r.no_log_at_all}` +
    (String(r.no_log_at_all) === String(r.receipts) ? '   <-- counted by NOBODY' : '')
  )),
);

// ---------------------------------------------------------------------------
// 5. Duplicate payments the read-time dedup is now collapsing.
// ---------------------------------------------------------------------------
await attempt(
  'Duplicate payment_ids (what dedup saves)',
  `SELECT payment_id,
          count(*) AS rows_in_table,
          sum(amount) AS naive_sum,
          max(amount) AS real_amount,
          sum(amount) - max(amount) AS overstatement
     FROM receipts
    WHERE COALESCE(btrim(payment_id), '') <> ''
    GROUP BY payment_id
   HAVING count(*) > 1
    ORDER BY overstatement DESC
    LIMIT 25`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.payment_id).padEnd(28)} ${String(r.rows_in_table)} rows  overstates by ${money(r.overstatement)}`
  )),
);

// ---------------------------------------------------------------------------
// 6. Orphan aliases: a label pointing at a worker that is gone.
// ---------------------------------------------------------------------------
await attempt(
  'Orphan worker_aliases',
  `SELECT a.alias_name, a.worker_id
     FROM worker_aliases a
     LEFT JOIN workers w ON w.id = a.worker_id
    WHERE w.id IS NULL`,
  (rows) => rows.forEach((r) => console.log(`${r.alias_name} -> ${r.worker_id} (worker no longer exists)`)),
);

console.log('\ndone. every statement above was a SELECT.');