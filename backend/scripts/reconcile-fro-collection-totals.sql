-- Per-FRO reconciliation: does the collection total add up, and do the two
-- attribution signals agree?
--
-- Read-only. Run after deploying 69475b99.
--
-- The bug just fixed made receipts.log_id override agent_name, which moved one
-- FRO's collection onto another (receipt 83746: agent_name 'Mamta Shah' landing
-- in Varsha Tambe's total). That precedence is now name-first everywhere, so the
-- "CONFLICT" rows below are where the two signals DISAGREE. The total credits the
-- name -- which is what the operator confirmed in Edit Receipt -- but a conflict
-- is worth a human look, because it means the name and the lead were attributed
-- to different people.

-- ---------------------------------------------------------------------------
-- 1. Every receipt where agent_name and the linked log name different people.
-- ---------------------------------------------------------------------------
-- This is the check that would have caught receipt 83746 before it shipped.
-- count > 0 is expected and is NOT itself a bug -- it is the audit list.
SELECT
  r.receipt_no,
  r.id                                                       AS receipt_id,
  r.amount,
  r.receipt_date,
  r.agent_name                                               AS name_on_receipt,
  w_name.name                                                AS name_resolves_to,
  l_agent.agent_label                                        AS log_owner_label,
  l_name.name                                                AS log_owner_name,
  l.id                                                       AS log_id,
  'name wins (see commit 69475b99)'                         AS resolution,
  CASE
    WHEN r.log_id IS NULL THEN 'no log - name only'
    WHEN w_name.name IS NULL AND l_name.name IS NULL THEN 'unresolved both ways'
    ELSE 'CONFLICT - check who really collected it'
  END                                                        AS verdict
FROM receipts r
LEFT JOIN workers w_name
       ON lower(btrim(w_name.name)) = lower(btrim(r.agent_name))
LEFT JOIN fro_donor_logs l ON l.id = r.log_id
LEFT JOIN workers l_name ON l_name.id = l.fro_worker_id
LEFT JOIN crm_agents l_agent ON l_agent.worker_id = l.fro_worker_id
WHERE r.log_id IS NOT NULL
  AND lower(btrim(coalesce(r.agent_name, ''))) NOT IN
        ('suspense', 'pg', 'library', 'na')
  AND w_name.id IS NOT NULL
  AND l.fro_worker_id IS NOT NULL
  AND lower(btrim(w_name.name)) <> lower(btrim(coalesce(l_name.name, '')))
ORDER BY r.receipt_date DESC, r.receipt_no;

-- ---------------------------------------------------------------------------
-- 2. Same, condensed per FRO: who is most affected?
-- ---------------------------------------------------------------------------
-- Sort by total value first -- that is where a human should start.
SELECT
  w_name.name                                                AS credited_to,
  count(*)                                                   AS conflicting_receipts,
  sum(r.amount)                                              AS value_in_question
FROM receipts r
JOIN workers w_name
     ON lower(btrim(w_name.name)) = lower(btrim(r.agent_name))
JOIN fro_donor_logs l ON l.id = r.log_id
JOIN workers l_name ON l_name.id = l.fro_worker_id
WHERE lower(btrim(coalesce(r.agent_name, ''))) NOT IN
      ('suspense', 'pg', 'library', 'na')
  AND lower(btrim(w_name.name)) <> lower(btrim(coalesce(l_name.name, '')))
GROUP BY 1
ORDER BY value_in_question DESC;

-- ---------------------------------------------------------------------------
-- 3. Does each FRO's card total equal the sum of the rows in their list?
-- ---------------------------------------------------------------------------
-- The invariant the card depends on. Every FRO should show 0. A non-zero row
-- means that FRO's headline and their rows still disagree -- report the FRO.
WITH per_fro AS (
  SELECT
    w.id AS worker_id,
    w.name,
    sum(r.amount) AS total
  FROM workers w
  JOIN receipts r
    ON lower(btrim(w.name)) = lower(btrim(r.agent_name))
  WHERE (w.department) = 'FRO'
    AND lower(btrim(coalesce(r.agent_name, ''))) NOT IN
          ('suspense', 'pg', 'library', 'na')
  GROUP BY w.id, w.name
)
SELECT
  p.name                                                     AS fro,
  p.total                                                    AS card_total,
  round(sum(DISTINCT r.amount)::numeric, 2)                  AS summed_rows,
  round(p.total - sum(DISTINCT r.amount)::numeric, 2)        AS difference
FROM per_fro p
JOIN workers w2 ON w2.id = p.worker_id
JOIN receipts r
  ON lower(btrim(w2.name)) = lower(btrim(r.agent_name))
 AND lower(btrim(coalesce(r.agent_name, ''))) NOT IN
       ('suspense', 'pg', 'library', 'na')
GROUP BY p.name, p.total
HAVING abs(p.total - sum(DISTINCT r.amount)) > 0.01
ORDER BY abs(p.total - sum(DISTINCT r.amount)) DESC;

-- ---------------------------------------------------------------------------
-- 4. Receipts still credited to nobody (money that will never appear on a card).
-- ---------------------------------------------------------------------------
-- Unresolvable names are not lost -- the log fallback may still find an owner --
-- so cross-check against log_id before treating these as a problem.
SELECT
  COALESCE(NULLIF(btrim(r.agent_name), ''), '(blank)')       AS agent_name,
  count(*)                                                   AS receipts,
  sum(r.amount)                                              AS total,
  count(*) FILTER (WHERE r.log_id IS NOT NULL)               AS has_log_fallback,
  count(*) FILTER (WHERE r.log_id IS NULL)                   AS truly_orphaned
FROM receipts r
WHERE COALESCE(btrim(r.agent_name), '') <> ''
  AND lower(btrim(r.agent_name)) NOT IN
        ('suspense', 'pg', 'library', 'na', 'priyank shah')
  AND NOT EXISTS (
    SELECT 1 FROM workers w
    WHERE lower(btrim(w.name)) = lower(btrim(r.agent_name))
  )
  AND NOT EXISTS (
    SELECT 1 FROM worker_aliases a
    WHERE lower(btrim(a.alias_name)) = lower(btrim(r.agent_name))
  )
GROUP BY 1
ORDER BY total DESC;

-- ---------------------------------------------------------------------------
-- 5. Duplicate payments still inflating a total.
-- ---------------------------------------------------------------------------
-- The read-time dedup now collapses these, so the card is correct even where the
-- table still holds two rows. This query measures what that dedup is saving.
SELECT payment_id,
       count(*)                    AS rows_in_table,
       sum(amount)                 AS naive_sum,
       max(amount)                 AS actual_single_payment,
       sum(amount) - max(amount)   AS overstatement
FROM receipts
WHERE COALESCE(btrim(payment_id), '') <> ''
GROUP BY payment_id
HAVING count(*) > 1
ORDER BY overstatement DESC
LIMIT 50;