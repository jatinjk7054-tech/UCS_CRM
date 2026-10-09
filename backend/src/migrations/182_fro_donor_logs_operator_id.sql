-- 182: operator attribution for FRO logs.
--
-- fro_donor_logs.fro_worker_id and .created_by are BOTH foreign-keyed to
-- workers(id). Under a work-as session the operator is not a worker: a CRM agent
-- has no workers row (their identity lives in crm_agents) and an admin work-as
-- carries a users.id. Writing the operator into either column therefore raised
--
--   insert or update on table "fro_donor_logs" violates foreign key constraint
--   "fro_donor_logs_created_by_fkey"
--
-- and then the same error for fro_worker_id once created_by was corrected --
-- Postgres reports one violated constraint per statement, so fixing the first
-- simply exposed the second.
--
-- Both workers-keyed columns now carry the COVERED FRO, and operator_id carries
-- the actor. operator_id has NO foreign key, deliberately: it spans three id
-- spaces (workers for a manual cover, users for an admin, crm_agents for an
-- agent) and none of them can serve as a constraint target.
--
-- Readers match operator_id OR fro_worker_id, so rows written before this column
-- existed -- where a manual cover's operator was a real worker and legitimately
-- landed in fro_worker_id -- keep resolving.
--
-- Applied on boot by backend/src/bootstrap/ensureFroDonorLogOperatorSchema.js,
-- which is idempotent, because migrations are not auto-run in this deployment.

ALTER TABLE public.fro_donor_logs
  ADD COLUMN IF NOT EXISTS operator_id uuid;

-- Partial: only work-as rows carry an operator, and the read path only filters on
-- it inside a work-as session.
CREATE INDEX IF NOT EXISTS idx_fro_donor_logs_operator_id
  ON fro_donor_logs (operator_id) WHERE operator_id IS NOT NULL;
