// Resolve fro_donor_logs.operator_id to a display name.
//
// operator_id carries the ACTOR behind a claim (who was at the keyboard during
// a Work As / cover session) while fro_worker_id carries the COVERED FRO. It has
// deliberately NO foreign key — see migrations/182_fro_donor_logs_operator_id.sql —
// because the id spans three id spaces: workers (a manual cover by a fellow
// FRO), users (an admin), and crm_agents (a login agent). So a name lookup has
// to ask all three tables.
//
// Reads resolve at query time (no name column is written on the log): historical
// rows keep working and a renamed person shows their current name.
//
// Two names come back for a CRM agent, and the difference is load-bearing:
//
//   name  — the HUMAN behind the login: crm_agents -> linked workers.name, so
//           "Agent 21" shows as "Muskan Khan" in Accounts' claimant display.
//   label — the identity as the system already writes it everywhere else:
//           receipts.agent_name is stamped from the JWT's imposter_name, which
//           IS the agent label. Collection totals group by agent_name, so credit
//           paths must keep using the label or one person's money would split
//           across "Agent 21" and "Muskan Khan" rows.
//
// For a worker-as-worker cover the two are the same string.

import db from '../config/db.js';

// Pure, so the label-vs-human rule is unit-testable without a database.
// `agent` is a crm_agents row, `linkedWorker` the workers row it points at
// (null when the agent has no worker_id or the row is gone).
export const agentDisplayNames = (agent, linkedWorker = null) => {
  const login = agent?.login_id || '';
  const label = agent?.label || '';
  if (linkedWorker?.name) return { name: linkedWorker.name, label, login };
  return { name: label, label, login };
};

// Pure merge of id -> { name, label, login, workerId }. Later sources never
// overwrite an earlier one, so call order carries precedence.
//
// workerId is the workers row this operator's CREDIT belongs to: a crm_agents
// row carries its linked worker, everyone else carries their own id (an admin's
// users id matches nothing in workers, which is the honest answer — an admin
// collects no FRO cash on their own card).
export const mergeOperatorNameRows = (sources = []) => {
  const map = new Map();
  for (const rows of sources) {
    for (const r of rows || []) {
      if (!r?.id) continue;
      const key = String(r.id);
      if (map.has(key)) continue;
      map.set(key, {
        name: r.name || '',
        label: r.label || r.name || '',
        login: r.login_id || r.email || '',
        workerId: r.worker_id ?? r.id ?? null,
      });
    }
  }
  return map;
};

// Batch-resolve a set of operator ids. Returns Map<id, { name, label, login }>;
// unknown ids are simply absent so callers can fall back to the covered FRO.
// Every lookup is independent and non-fatal: a missing table (e.g. crm_agents
// before its bootstrap) must not break the list being rendered.
export const resolveOperatorNames = async (ids) => {
  const unique = [...new Set((ids || []).filter((v) => v != null && String(v) !== '').map(String))];
  if (unique.length === 0) return new Map();

  const safe = (query) => query.then((r) => (r.error ? [] : r.data || [])).catch(() => []);

  const workers = await safe(db.from('workers').select('id, name, login_id').in('id', unique));
  const map = mergeOperatorNameRows([workers]);

  // Anything still unresolved may be an admin (users) or a login agent
  // (crm_agents). Workers were resolved first so a direct workers hit wins.
  const remaining = unique.filter((id) => !map.has(id));
  if (remaining.length === 0) return map;

  const [users, agents] = await Promise.all([
    safe(db.from('users').select('id, name, email').in('id', remaining)),
    safe(db.from('crm_agents').select('id, label, login_id, worker_id').in('id', remaining)),
  ]);
  for (const row of mergeOperatorNameRows([users])) if (!map.has(row[0])) map.set(row[0], row[1]);

  // A CRM agent is not a workers row, but points at one: that linked worker is
  // the human Accounts should name, while the label stays as the credit key.
  const unresolvedAgents = agents.filter((a) => a?.id && !map.has(String(a.id)));
  const linkedWorkerIds = [...new Set(unresolvedAgents.map((a) => a.worker_id).filter((v) => v != null && v !== ''))];
  const linkedWorkers = linkedWorkerIds.length
    ? await safe(db.from('workers').select('id, name, login_id').in('id', linkedWorkerIds))
    : [];
  const workerById = new Map(linkedWorkers.map((w) => [String(w.id), w]));
  for (const agent of unresolvedAgents) {
    const linked = agent.worker_id ? workerById.get(String(agent.worker_id)) : null;
    // worker_id is what a credit reader needs: the agents row's own uuid matches
    // nothing in workers, the LINKED worker's uuid is the person who collects.
    map.set(String(agent.id), { ...agentDisplayNames(agent, linked), workerId: agent.worker_id ?? null });
  }

  return map;
};

// Single-id convenience for the write paths (receipt / bank-entry agent stamps).
export const resolveOperatorName = async (id) => {
  if (id == null || String(id) === '') return null;
  const map = await resolveOperatorNames([id]);
  return map.get(String(id)) || null;
};

// Resolve the id the FRO panel credits collections to.
//
// creditWorkerId on the panel is req.user.imposter_id — the OPERATOR — and under
// an agent login that is a crm_agents uuid, not a workers uuid (authController's
// issueAgentSession). Passing it straight into a workers-keyed lookup returned
// no rows at all, which is why every agent session's Collected card read zero
// no matter how much had been verified.
//
// Returns { workerId, name, label } — workerId for the log-link window, name and
// label (the identity this session stamps into receipts.agent_name) for the name
// window. Never throws: an unresolvable id must degrade to the caller's old
// behaviour, not take the dashboard down.
export const resolveCreditTarget = async (id) => {
  if (id == null || String(id) === '') return null;
  try {
    const map = await resolveOperatorNames([id]);
    const hit = map.get(String(id));
    if (!hit) return null;
    return {
      workerId: hit.workerId != null && String(hit.workerId) !== '' ? String(hit.workerId) : String(id),
      name: hit.name || '',
      label: hit.label || '',
    };
  } catch (e) {
    return null;
  }
};
