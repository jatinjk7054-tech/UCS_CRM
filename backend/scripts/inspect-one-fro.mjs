// Narrow investigation: one FRO's total vs the rows behind it, and the same
// receipts as seen by a colleague. Read-only.
//
// The report is that one account shows roughly 10k where the actuals are 8.x,
// and the difference is BSCT collection belonging to a different FRO. That is an
// attribution question, so this prints the rows rather than a summary: who the
// name resolves to, what NGO each receipt is booked to, and whether any of those
// rows are visible to a colleague as well.
//
// Run: node scripts/inspect-one-fro.mjs [worker name]
//   e.g. node scripts/inspect-one-fro.mjs "Varsha Tambe"

const API = process.env.UCS_DB_QUERY_API || 'https://api.beingsevak.org/api/db/query';
const TARGET = process.argv[2] || 'Varsha Tambe';

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
    if (!rows.length) { console.log('(no rows)'); return []; }
    render(rows);
  } catch (e) { console.log(`[query failed] ${e.message}`); }
  return [];
}

const q = (s) => s.replace(/' + TARGET + '/g, `' + TARGET.replace(/'/g, "''") + ''`);

// ---------------------------------------------------------------------------
// 1. Who is this worker? And are there several with similar names?
// ---------------------------------------------------------------------------
await attempt(
  `Workers matching "${TARGET}"`,
  `SELECT w.id, w.name, w.login_id, w.department, w.is_active, w.employment_status, w.ngo_id,
          n.name AS ngo_name
     FROM workers w
     LEFT JOIN ngos n ON n.id = w.ngo_id
    WHERE lower(w.name) = lower('${TARGET.replace(/'/g, "''")}')
       OR lower(w.name) LIKE '%' || lower(split_part('${TARGET.replace(/'/g, "''")}', ' ', 1)) || '%'
    ORDER BY (lower(w.name) = lower('${TARGET.replace(/'/g, "''")}')) DESC, w.name`,
  (rows) => rows.forEach((w) => console.log(
    `${w.name.padEnd(26)} ${String(w.department).padEnd(8)} active=${w.is_active} ngo=${w.ngo_name || '(none)'} login=${w.login_id}\n    id=${w.id}`
  )),
);

// ---------------------------------------------------------------------------
// 2. Every receipt carrying this exact name, this month, with its NGO.
// ---------------------------------------------------------------------------
await attempt(
  `Receipts named exactly "${TARGET}" this month, by NGO`,
  `SELECT COALESCE(NULLIF(btrim(r.project_id), ''), '(blank project_id)') AS project_id,
          count(*) AS receipts,
          sum(r.amount) AS total,
          min(r.receipt_date)::text AS first_date,
          max(r.receipt_date)::text AS last_date
     FROM receipts r
    WHERE lower(btrim(r.agent_name)) = lower('${TARGET.replace(/'/g, "''")}')
      AND to_char(r.receipt_date::date, 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
    GROUP BY 1
    ORDER BY total DESC`,
  (rows) => {
    rows.forEach((r) => console.log(
      `${String(r.project_id).padEnd(22)} ${String(r.receipts).padStart(4)} receipts  ${money(r.total).padStart(13)}  ${r.first_date}..${r.last_date}`
    ));
    const grand = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    console.log(`${'TOTAL'.padEnd(22)} ${String(rows.reduce((s, r) => s + Number(r.receipts), 0)).padStart(4)} receipts  ${money(grand).padStart(13)}`);
  },
);

// ---------------------------------------------------------------------------
// 3. The individual rows, so the numbers can be checked by hand.
// ---------------------------------------------------------------------------
await attempt(
  `Every receipt named "${TARGET}" this month`,
  `SELECT r.receipt_no, r.amount, r.receipt_date, r.project_id, r.donor_name, r.mode,
          r.log_id,
          lw.name AS log_owner,
          (SELECT w.name FROM workers w WHERE lower(btrim(w.name)) = lower(btrim(r.agent_name))) AS name_resolves_to
     FROM receipts r
     LEFT JOIN fro_donor_logs l ON l.id = r.log_id
     LEFT JOIN workers lw ON lw.id = l.fro_worker_id
    WHERE lower(btrim(r.agent_name)) = lower('${TARGET.replace(/'/g, "''")}')
      AND to_char(r.receipt_date::date, 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
    ORDER BY r.receipt_date, r.receipt_no`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.receipt_no || '-').padEnd(10)} ${money(r.amount).padStart(11)}  ${r.receipt_date}  ${String(r.project_id || '-').padEnd(14)} donor=${String(r.donor_name || '-').slice(0, 22).padEnd(22)} log=${r.log_owner || '(none)'}${r.log_owner && r.name_resolves_to && r.log_owner.toLowerCase() !== r.name_resolves_to.toLowerCase() ? '   <-- CONFLICT' : ''}`
  )),
);

// ---------------------------------------------------------------------------
// 4. The same receipts seen from the OTHER FRO: shared rows between two names.
// ---------------------------------------------------------------------------
await attempt(
  'Name pairs that share receipts (substring / overlap check)',
  `SELECT a.agent_name AS name_a, b.agent_name AS name_b,
          count(*) AS shared_rows,
          sum(a.amount) AS value
     FROM receipts a
     JOIN receipts b
       ON b.id = a.id
    WHERE lower(btrim(a.agent_name)) <> lower(btrim(b.agent_name))
      AND lower(btrim(a.agent_name)) LIKE '%' || lower(btrim(b.agent_name)) || '%'
    GROUP BY 1, 2
    ORDER BY shared_rows DESC
    LIMIT 20`,
  (rows) => rows.forEach((r) => console.log(
    `"${r.name_a}" contains "${r.name_b}": ${r.shared_rows} rows, ${money(r.value)}`
  )),
);

// ---------------------------------------------------------------------------
// 5. What NGO do the ngos rows call the big projects?
// ---------------------------------------------------------------------------
await attempt(
  'NGO names, to map project_id values against',
  `SELECT id, name FROM ngos ORDER BY name`,
  (rows) => rows.forEach((r) => console.log(`${String(r.id).padEnd(40)} ${r.name}`)),
);

console.log('\ndone. every statement above was a SELECT.');