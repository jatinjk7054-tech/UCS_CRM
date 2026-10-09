// Is the FRO Collected card monthly or all-time? Read-only.
//
// The card renders ts.collected, which /fro/target fills from
// getTotalCollectedByWorker(creditWorkerId, monthStart, monthEnd) where the
// bounds come from istMonthBounds(now) -- i.e. the CURRENT calendar month. On
// paper that is already monthly. This checks it against the data, because
// "monthly" can still be wrong in three ways that no code read would reveal:
//   1. the window is not the calendar month (timezone slip),
//   2. the card is silently showing an all-time figure from a different field,
//   3. one worker's total coincidentally looks monthly.
//
// Run: node scripts/check-card-window.mjs

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
    if (!rows.length) { console.log('(no rows)'); return []; }
    render(rows);
  } catch (e) { console.log(`[query failed] ${e.message}`); }
  return [];
}

// ---------------------------------------------------------------------------
// 1. The calendar month the card should be showing.
// ---------------------------------------------------------------------------
await attempt(
  'Current IST calendar month and the rows falling in it',
  `SELECT
     to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS ist_month,
     (SELECT count(*) FROM receipts WHERE to_char(receipt_date::date,'YYYY-MM')
        = to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM')) AS receipts_this_month,
     (SELECT count(*) FROM receipts) AS receipts_all_time,
     (SELECT min(receipt_date)::text FROM receipts) AS earliest_receipt,
     (SELECT max(receipt_date)::text FROM receipts) AS latest_receipt`,
  (rows) => rows.forEach((r) => {
    console.log(`IST month the card covers : ${r.ist_month}`);
    console.log(`receipts dated in it     : ${r.receipts_this_month}`);
    console.log(`receipts in the table    : ${r.receipts_all_time}`);
    console.log(`receipt_date range       : ${r.earliest_receipt} .. ${r.latest_receipt}`);
    console.log('');
    console.log(r.receipt_date_range_note || '');
  }),
);

// ---------------------------------------------------------------------------
// 2. Per FRO: this month vs all-time. If the card showed all-time these would
//    be identical columns; a real difference proves it is monthly.
// ---------------------------------------------------------------------------
await attempt(
  'Per FRO - this month vs all time (top 20 by all-time)',
  `SELECT w.name,
          sum(r.amount) FILTER (
            WHERE to_char(r.receipt_date::date, 'YYYY-MM')
                = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
          ) AS this_month,
          sum(r.amount) AS all_time,
          count(*) FILTER (
            WHERE to_char(r.receipt_date::date, 'YYYY-MM')
                = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
          ) AS rows_this_month,
          count(*) AS rows_all_time
     FROM workers w
     JOIN receipts r ON lower(btrim(w.name)) = lower(btrim(r.agent_name))
    WHERE w.department = 'FRO'
      AND lower(btrim(coalesce(r.agent_name,''))) NOT IN ('suspense','pg','library','na')
    GROUP BY w.name
    HAVING count(*) FILTER (
             WHERE to_char(r.receipt_date::date, 'YYYY-MM')
                 = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
           ) > 0
    ORDER BY all_time DESC
    LIMIT 20`,
  (rows) => {
    console.log('FRO'.padEnd(24), 'this month'.padStart(14), 'all time'.padStart(14), '  rows this/total');
    rows.forEach((r) => console.log(
      String(r.name).padEnd(24),
      money(r.this_month).padStart(14),
      money(r.all_time).padStart(14),
      `  ${r.rows_this_month}/${r.rows_all_time}`
    ));
    const identical = rows.filter((r) => Number(r.this_month) === Number(r.all_time)).length;
    console.log('');
    console.log(`Rows shown: ${rows.length}. this_month == all_time for ${identical} of them.`);
    console.log(identical === rows.length
      ? 'Suspicious: these look like all-time totals, not monthly.'
      : 'this_month differs from all_time, so the figure is genuinely month-scoped.');
  },
);

// ---------------------------------------------------------------------------
// 3. Does any receipt carry a NULL receipt_date? Those cannot fall in a month.
// ---------------------------------------------------------------------------
await attempt(
  'Receipts with no receipt_date (invisible to any monthly window)',
  `SELECT count(*) AS receipts_without_date, COALESCE(sum(amount),0) AS value
     FROM receipts
    WHERE receipt_date IS NULL OR btrim(receipt_date::text) = ''`,
  (rows) => rows.forEach((r) => console.log(
    `${r.receipts_without_date} receipts, ${money(r.value)} - excluded from the monthly card by construction`
  )),
);

// ---------------------------------------------------------------------------
// 4. What date field the window actually uses, per row type.
// ---------------------------------------------------------------------------
await attempt(
  'Month buckets across the whole table, most recent first',
  `SELECT to_char(receipt_date::date, 'YYYY-MM') AS month, count(*) AS receipts, sum(amount) AS total
     FROM receipts
    GROUP BY 1 ORDER BY 1 DESC NULLS LAST LIMIT 12`,
  (rows) => rows.forEach((r) => console.log(
    `${String(r.month || '(null)').padEnd(10)} ${String(r.receipts).padStart(5)} receipts  ${money(r.total).padStart(14)}`
  )),
);

console.log('\ndone. every statement above was a SELECT.');