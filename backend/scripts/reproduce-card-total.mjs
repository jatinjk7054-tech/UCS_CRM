// Reproduce the card's own arithmetic for one FRO, so a mismatch between the
// headline and the rows can be attributed to a specific query rather than
// guessed at. Read-only.
//
// Run: node scripts/reproduce-card-total.mjs "Varsha Tambe"

const API = process.env.UCS_DB_QUERY_API || 'https://api.beingsevak.org/api/db/query';
const NAME = (process.argv[2] || 'Varsha Tambe').replace(/'/g, "''");

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
const rows = async (t, sql) => {
  console.log(`\n=== ${t} ===`);
  try { const r = await run(sql); r.forEach((x) => console.log(JSON.stringify(x))); return r; }
  catch (e) { console.log(`[failed] ${e.message}`); return []; }
};

const W = `(SELECT id FROM workers WHERE lower(btrim(name)) = lower('${NAME}') LIMIT 1)`;

await rows(
  'Worker row',
  `SELECT w.id, w.name, w.department, w.ngo_id, n.name AS worker_ngo
     FROM workers w LEFT JOIN ngos n ON n.id = w.ngo_id
    WHERE lower(btrim(w.name)) = lower('${NAME}')`,
);

await rows(
  'The card total: name matches (primary path after 69475b99)',
  `SELECT count(*) AS receipts, sum(amount) AS total
     FROM receipts
    WHERE lower(btrim(agent_name)) = lower('${NAME}')
      AND to_char(receipt_date::date,'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')`,
);

await rows(
  'Rows the LOG fallback would add on top (name did not match)',
  `SELECT r.receipt_no, r.amount, r.receipt_date, r.project_id, r.agent_name
     FROM receipts r JOIN fro_donor_logs l ON l.id = r.log_id
    WHERE l.fro_worker_id = ${W}
      AND lower(btrim(r.agent_name)) <> lower('${NAME}')
      AND to_char(r.receipt_date::date,'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')`,
);

await rows(
  'Per-NGO split of her name-matched rows (what the chips show)',
  `SELECT project_id, count(*) AS receipts, sum(amount) AS total
     FROM receipts
    WHERE lower(btrim(agent_name)) = lower('${NAME}')
      AND to_char(receipt_date::date,'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')
    GROUP BY 1 ORDER BY total DESC`,
);

await rows(
  'Her worker NGO vs the NGOs her receipts are booked to',
  `SELECT w.name AS worker, wn.name AS worker_ngo,
          r.project_id, count(*) AS receipts, sum(r.amount) AS total
     FROM receipts r
     CROSS JOIN (SELECT id, name, ngo_id FROM workers WHERE lower(btrim(name)) = lower('${NAME}')) w
     LEFT JOIN ngos wn ON wn.id = w.ngo_id
    WHERE lower(btrim(r.agent_name)) = lower('${NAME}')
      AND to_char(r.receipt_date::date,'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')
    GROUP BY 1, 2, 3 ORDER BY total DESC`,
);

await rows(
  'Do her stations belong to her NGO? (assignment scope check)',
  `SELECT a.ngo_id, n.name AS ngo, count(*) AS assignments
     FROM fro_assignments a LEFT JOIN ngos n ON n.id = a.ngo_id
    WHERE a.fro_worker_id = ${W}
    GROUP BY 1, 2 ORDER BY assignments DESC LIMIT 10`,
);

await rows(
  'Her assigned donors and what those donors actually gave (BSCT vs AFLF)',
  `SELECT a.ngo_id, r.project_id, count(DISTINCT a.donor_id) AS donors, sum(r.amount) AS total
     FROM receipts r
     JOIN fro_assignments a ON a.donor_id = r.donor_id AND a.fro_worker_id = ${W}
    WHERE lower(btrim(r.agent_name)) = lower('${NAME}')
      AND to_char(r.receipt_date::date,'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')
    GROUP BY 1, 2 ORDER BY total DESC`,
);

console.log('\ndone. every statement above was a SELECT.');