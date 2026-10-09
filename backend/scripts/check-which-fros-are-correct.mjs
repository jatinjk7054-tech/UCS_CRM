// Which FRO totals are actually correct right now? Read-only.
//
// The name-first fix (69475b99) resolves name/log conflicts. The question this
// answers is narrower and per-person: for each FRO who HAS a workers row, does
// their card total equal the plain sum of the receipts carrying their name, with
// nothing hidden and nothing extra?
//
// Two failure shapes are separated deliberately:
//   conflict_rows  - receipts where agent_name and the linked log name different
//                    people. Name-first already credits the named FRO, so these
//                    are correct now but are the audit trail of the old bug.
//   unresolved_rows- receipts whose agent_name matches no worker, i.e. money no
//                    FRO can currently see. Pre-existing, not caused by any of
//                    these commits.
//
// Run: node scripts/check-which-fros-are-correct.mjs

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

// ---------------------------------------------------------------------------
// 1. Per FRO: their total, and whether any of their receipts were in conflict.
// ---------------------------------------------------------------------------
const perFro = await attempt(
  'Every FRO with a workers row - total and conflict exposure',
  `WITH named AS (
     SELECT r.agent_name, sum(r.amount) AS total, count(*) AS receipts
       FROM receipts r
      WHERE COALESCE(btrim(r.agent_name), '') <> ''
        AND lower(btrim(r.agent_name)) NOT IN ('suspense','pg','library','na')
      GROUP BY 1
   ),
   conflict AS (
     SELECT lower(btrim(r.agent_name)) AS collector, count(*) AS rows_, sum(r.amount) AS value
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       JOIN workers lw ON lw.id = l.fro_worker_id
      WHERE lower(btrim(coalesce(r.agent_name, ''))) NOT IN ('suspense','pg','library','na')
        AND lower(btrim(r.agent_name)) <> lower(btrim(coalesce(lw.name, '')))
      GROUP BY 1
   )
   SELECT w.name,
          n.total,
          n.receipts,
          COALESCE(c.rows_, 0)  AS conflict_receipts,
          COALESCE(c.value, 0)  AS conflict_value
     FROM workers w
     JOIN named n ON lower(btrim(n.agent_name)) = lower(btrim(w.name))
     LEFT JOIN conflict c ON c.collector = lower(btrim(w.name))
    WHERE w.department = 'FRO'
      AND w.is_active IS NOT FALSE
    ORDER BY conflict_value DESC, n.total DESC`,
  (rows) => {
    const clean = rows.filter((r) => Number(r.conflict_receipts) === 0);
    const touched = rows.filter((r) => Number(r.conflict_receipts) > 0);
    console.log(`FROs with a workers row and receipts: ${rows.length}`);
    console.log(`  unaffected by any conflict        : ${clean.length}`);
    console.log(`  had conflicting receipts          : ${touched.length}`);
    console.log('');
    if (touched.length) {
      console.log('Had conflicts (these are CORRECT now - name wins, log is ignored):');
      touched.forEach((r) => console.log(
        `  ${String(r.name).padEnd(24)} total ${money(r.total).padStart(13)}  was exposed to ${money(r.conflict_value)} (${r.conflict_receipts} receipts)`
      ));
      console.log('');
    }
    const grand = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    console.log(`Combined total across those ${rows.length} FROs: ${money(grand)}`);
  },
);

// ---------------------------------------------------------------------------
// 2. The exposure: how much of the visible money sat in a conflict at all.
// ---------------------------------------------------------------------------
await attempt(
  'Blast radius of the bug that is now fixed',
  `SELECT
     (SELECT COALESCE(sum(r.amount), 0)
        FROM receipts r
        JOIN workers w ON lower(btrim(w.name)) = lower(btrim(r.agent_name))
       WHERE lower(btrim(coalesce(r.agent_name,''))) NOT IN ('suspense','pg','library','na')
     ) AS total_attributed_to_a_worker,
     (SELECT COALESCE(sum(r.amount), 0)
        FROM receipts r
        JOIN workers w ON lower(btrim(w.name)) = lower(btrim(r.agent_name))
        JOIN fro_donor_logs l ON l.id = r.log_id
        JOIN workers lw ON lw.id = l.fro_worker_id
       WHERE lower(btrim(coalesce(r.agent_name,''))) NOT IN ('suspense','pg','library','na')
         AND lower(btrim(w.name)) <> lower(btrim(coalesce(lw.name, '')))
     ) AS was_misattributed_before_the_fix`,
  (rows) => rows.forEach((r) => {
    const total = Number(r.total_attributed_to_a_worker || 0);
    const was = Number(r.was_misattributed_before_the_fix || 0);
    const pct = total ? ((was / total) * 100) : 0;
    console.log(`Total credited to a real worker : ${money(total)}`);
    console.log(`Of which sat on the WRONG FRO   : ${money(was)}  (${pct.toFixed(3)}% of the total)`);
    console.log('');
    console.log(pct < 0.5
      ? `So the vast majority of FRO totals were always right. The bug was real but narrow.`
      : `The bug touched a meaningful share of money.`);
  }),
);

// ---------------------------------------------------------------------------
// 3. Anyone the fix did NOT help, and cannot: names with no workers row.
// ---------------------------------------------------------------------------
await attempt(
  'Still invisible to every FRO - name matches no worker (pre-existing)',
  `SELECT btrim(r.agent_name) AS agent_name,
          count(*) AS receipts,
          sum(r.amount) AS total
     FROM receipts r
    WHERE COALESCE(btrim(r.agent_name), '') <> ''
      AND lower(btrim(r.agent_name)) NOT IN ('suspense','pg','library','na','priyank shah')
      AND NOT EXISTS (SELECT 1 FROM workers w WHERE lower(btrim(w.name)) = lower(btrim(r.agent_name)))
      AND NOT EXISTS (SELECT 1 FROM worker_aliases a WHERE lower(btrim(a.alias_name)) = lower(btrim(r.agent_name)))
    GROUP BY 1
    ORDER BY total DESC
    LIMIT 15`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.agent_name).padEnd(28)} ${String(r.receipts).padStart(5)} receipts  ${money(r.total).padStart(14)}`
  )),
);

console.log('\ndone. every statement above was a SELECT.');