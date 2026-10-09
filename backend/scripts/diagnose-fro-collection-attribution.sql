-- Read-only diagnosis for the FRO "Collected" card total.
--
-- Why this exists. Collection totals are attributed by matching
-- receipts.agent_name against workers.name (plus worker_aliases for CRM agent
-- labels like "Agent 13"). receipts.agent_name is free text written by many
-- paths, so a total can be wrong without any code being obviously wrong.
--
-- Run all three. Nothing here writes anything.

-- ---------------------------------------------------------------------------
-- 1. What values does agent_name actually hold?
-- ---------------------------------------------------------------------------
-- Shows every distinct value with its volume. This is the single query that
-- answers "what is in that column right now".
SELECT
  COALESCE(NULLIF(btrim(agent_name), ''), '(blank)') AS agent_name,
  count(*)                                          AS receipts,
  sum(amount)                                       AS total,
  min(receipt_date)                                 AS first_date,
  max(receipt_date)                                 AS last_date
FROM receipts
GROUP BY 1
ORDER BY receipts DESC
LIMIT 100;

-- ---------------------------------------------------------------------------
-- 2. How much money sits under CRM agent labels, and how much survives?
-- ---------------------------------------------------------------------------
-- An agent label only resolves while its worker_aliases row exists. deleteAgent
-- removes that row with the agent (crmAgentModel.js:350-353), after which the
-- historical receipts match nothing and drop out of every total.
--
-- recoverable_via_log > 0 means receipts.log_id still links to a verified
-- fro_donor_logs row, which is how the total can still recover them. If a label
-- shows recoverable_via_log = 0, that money is currently attributed to NOBODY.
SELECT
  r.agent_name,
  count(*)                                                   AS receipts,
  sum(r.amount)                                              AS total,
  count(*) FILTER (WHERE r.log_id IS NOT NULL)               AS has_log_id,
  count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM fro_donor_logs l
      WHERE l.id = r.log_id AND l.accounts_status = 'verified'
    )
  )                                                          AS recoverable_via_log,
  EXISTS (
    SELECT 1 FROM worker_aliases a
    WHERE lower(btrim(a.alias_name)) = lower(btrim(r.agent_name))
  )                                                          AS alias_exists
FROM receipts r
WHERE lower(btrim(r.agent_name)) ~ '^agent\s*[0-9]+$'
GROUP BY r.agent_name
ORDER BY total DESC;

-- ---------------------------------------------------------------------------
-- 3. Values that resolve to no FRO at all.
-- ---------------------------------------------------------------------------
-- Anything not a known worker name, not a curated alias, and not one of the
-- category labels the report layer already treats as non-people. These are the
-- receipts no name-matched total can ever credit.
--   'priyank shah' is hardcoded as an operator label at
--   accountsController.js:751 and bankAuditController.js:687.
SELECT
  COALESCE(NULLIF(btrim(r.agent_name), ''), '(blank)') AS agent_name,
  count(*)                                             AS receipts,
  sum(r.amount)                                        AS total
FROM receipts r
WHERE COALESCE(btrim(r.agent_name), '') <> ''
  AND lower(btrim(r.agent_name)) NOT IN (
        'suspense', 'pg', 'library', 'na', 'priyank shah', 'priyank sir')
  AND NOT EXISTS (
    SELECT 1 FROM workers w
    WHERE lower(btrim(w.name)) = lower(btrim(r.agent_name))
  )
  AND NOT EXISTS (
    SELECT 1 FROM worker_aliases a
    WHERE lower(btrim(a.alias_name)) = lower(btrim(r.agent_name))
  )
GROUP BY 1
ORDER BY total DESC
LIMIT 100;

-- ---------------------------------------------------------------------------
-- 4. Duplicate payments still in the data.
-- ---------------------------------------------------------------------------
-- The fix stops new double counting, but rows already written twice are still
-- stored twice. payment_identity groups on the authoritative reference, so this
-- shows how much money the duplicate path added.
SELECT payment_id, count(*) AS rows, sum(amount) AS summed, min(receipt_date) AS day
FROM receipts
WHERE COALESCE(btrim(payment_id), '') <> ''
GROUP BY payment_id
HAVING count(*) > 1
ORDER BY summed DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
-- 5. Orphan aliases: a label pointing at a worker that no longer exists.
-- ---------------------------------------------------------------------------
SELECT a.alias_name, a.worker_id
FROM worker_aliases a
LEFT JOIN workers w ON w.id = a.worker_id
WHERE w.id IS NULL;