import db from '../config/db.js';

// Operator attribution for FRO logs.
//
// fro_donor_logs.fro_worker_id and .created_by are BOTH foreign-keyed to
// workers(id). Under a work-as session the operator is not a worker at all —
// a CRM agent has no workers row (their identity lives in crm_agents) and an
// admin work-as carries a users.id — so writing the operator into either column
// raised "violates foreign key constraint fro_donor_logs_created_by_fkey" and
// then "..._fro_worker_id_fkey" once the first was corrected. The insert simply
// cannot express "an agent did this" in a workers-keyed column.
//
// operator_id carries that meaning with NO foreign key, deliberately: it spans
// three id spaces (workers for a manual cover, users for an admin, crm_agents
// for an agent) and none of them can be a constraint target. Readers match it
// alongside fro_worker_id so rows written before this column existed — where a
// manual cover's operator id was legitimately a worker and did land in
// fro_worker_id — keep resolving.
//
// Migrations are not auto-run, so this repairs itself on boot, matching
// ensureStationAgentOfRecordSchema / ensureSevakRenewalSchema.

async function columnExists(table, column) {
  const r = await db._pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column],
  );
  return r.rows.length > 0;
}

export async function ensureFroDonorLogOperatorSchema() {
  if (!(await columnExists('fro_donor_logs', 'id'))) return;
  if (await columnExists('fro_donor_logs', 'operator_id')) return;

  try {
    await db._pool.query(
      `ALTER TABLE public.fro_donor_logs ADD COLUMN IF NOT EXISTS operator_id uuid`,
    );
    // Partial: only work-as rows carry an operator, and the read path always
    // filters on it inside a work-as session.
    await db._pool.query(
      `CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_operator_id
         ON fro_donor_logs (operator_id) WHERE operator_id IS NOT NULL`,
    );
  } catch (e) {
    // Lost a race with a parallel boot, or the role cannot ALTER. Not fatal: the
    // work-as lists fall back to matching fro_worker_id alone, which is exactly
    // the pre-column behaviour.
    console.warn('[fro donor log operator schema] skip:', e?.message || String(e));
  }
}
