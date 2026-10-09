import db, { sql } from '../config/db.js';
import { maybeRefreshSpecialIncentives } from '../services/specialIncentiveService.js';
import { resolveCreditTarget } from '../services/operatorNameService.js';
import {
  CATEGORY_LABELS,
  buildAgentNameMatches,
  escapeLikePattern,
  isCategoryLabel,
  mergeAttributedReceipts,
  normalizeAgentName,
  paymentIdentity,
} from '../services/froCollectionMatch.js';

// Keep the id sequence ahead of the highest existing id before inserting, so a
// default-sequence insert never collides with a row that was written earlier
// with an explicit id (e.g. a data migration/import that didn't reset the
// sequence). This prevents "duplicate key value violates unique constraint
// fro_donor_logs_pkey". Runs inside a single statement so it is atomic; if it
// ever fails it is non-fatal (best-effort) and the insert still proceeds.
export const ensureLogSequenceHealth = async () => {
  try {
    await sql(`
      SELECT setval('fro_donor_logs_id_seq',
             GREATEST((SELECT COALESCE(MAX(id), 0) FROM fro_donor_logs),
                      (SELECT last_value FROM fro_donor_logs_id_seq)),
             true)
    `);
  } catch (e) {
    console.error('fro_donor_logs sequence resync failed:', e.message);
  }
};

export const createDonorLog = async (data) => {
  await ensureLogSequenceHealth();
  const { data: result, error } = await db
    .from('fro_donor_logs')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  maybeRefreshSpecialIncentives().catch(() => {});
  return result;
};

// Find a same-day disposition log for the same assignment + actor + detail so
// repeat saves (e.g. re-dialing a ringing/busy donor) refresh the existing row
// instead of piling up identical timeline entries.
//
// The actor is matched against operator_id OR fro_worker_id because those columns
// split by session type: a self-service save records the worker in
// fro_worker_id, while a work-as save records the covered FRO there and the
// operator in operator_id. fro_worker_id is foreign-keyed to workers, so it can
// never hold an agent's or an admin's id.
export const findDispositionLogToday = async (assignmentId, actorId, detail, dayStart) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('id')
    .eq('assignment_id', assignmentId)
    .or(`fro_worker_id.eq.${actorId},operator_id.eq.${actorId}`)
    .eq('action', 'disposition')
    .eq('disposition_detail', detail)
    .gte('created_at', dayStart)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
};

export const updateDonorLog = async (id, updates) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  maybeRefreshSpecialIncentives().catch(() => {});
  return data;
};

export const findLogsByAssignment = async (assignmentId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('*')
    .eq('assignment_id', assignmentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

// OR-groups matching a collection on its ACTUAL collection date, expressed FLAT
// (no or() nested inside and()) so the custom query builder's or()-parser can
// handle it. donations & 'done' logs count on created_at OR transaction_datetime;
// verified 'lead_done' logs count on verified_at.
export const COLLECTION_DATE_OR = (s, e) =>
  `and(action.eq.donation,created_at.gte.${s},created_at.lte.${e}),` +
  `and(action.eq.donation,transaction_datetime.gte.${s},transaction_datetime.lte.${e}),` +
  `and(disposition_detail.eq.done,action.eq.disposition,created_at.gte.${s},created_at.lte.${e}),` +
  `and(disposition_detail.eq.done,action.eq.disposition,transaction_datetime.gte.${s},transaction_datetime.lte.${e}),` +
  `and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified,verified_at.gte.${s},verified_at.lte.${e})`;

const dayKey = (iso) => (iso ? String(iso).slice(0, 10) : null);

// A log counts as a collection on its ACTUAL transaction date, not its upload date.
// Imported receipts carry the real date in transaction_datetime; verified lead-dones
// are counted on the date they were verified.
export function logCollectionDate(d) {
  if (d.action === 'disposition' && d.disposition_detail === 'lead_done' && d.accounts_status === 'verified') {
    return d.verified_at;
  }
  return d.transaction_datetime || d.created_at;
}

export function inRange(date, start, end) {
  if (!date) return false;
  const dk = dayKey(date);
  return dk >= dayKey(start) && dk <= dayKey(end);
}

// Discriminates genuinely distinct payments that share donor + amount + day + NGO
// (e.g. a donor paying the same amount twice in one day) from duplicate copies of
// the SAME payment (a donation log plus its verified lead_done copy), which always
// carry the same payment reference.
export function paymentDiscriminant(d) {
  const ref = String(d.upi_transaction_id || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  if (ref) return `U${ref}`;
  const rm = /receipt\s+([A-Za-z0-9]+)/i.exec(String(d.remark || ''));
  if (rm) return `R${rm[1]}`;
  return 'X';
}

// The per-NGO chips rendered directly beneath the Collected card.
//
// It deliberately reuses getWorkerCollectionReceipts rather than running its own
// query. It used to match with `lower(btrim(agent_name)) = $3` while the card's
// headline matched with `ilike` on the same rows, so the chips did not add up to
// the number above them whenever a name needed a trim or a case fold. Both now
// read one deduplicated row set, so the chips summing to the card is structural
// rather than a coincidence.
export const getCollectedByNgo = async (workerId, monthStart, monthEnd, allowedNgoIds) => {
  const receipts = await getWorkerCollectionReceipts(workerId, monthStart, monthEnd);
  if (receipts.length === 0) return {};

  const { data: ngos } = await db.from('ngos').select('id, name');
  const projToNgoId = {};
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const n of ngos || []) {
    const nn = norm(n.name);
    projToNgoId[nn] = n.id;
    if (nn.includes('beingsevak') || nn.includes('sevak')) projToNgoId['bsct'] = n.id;
    if (nn.includes('ashray')) projToNgoId['aflf'] = n.id;
    if (nn.includes('mann')) projToNgoId['mann'] = n.id;
  }

  const byNgo = {};
  for (const r of receipts) {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) continue;
    const projectNorm = norm(r.project_id);
    const ngoId = projToNgoId[projectNorm] || r.project_id || 'others';
    const key = (allowedNgoIds && allowedNgoIds.length > 0 && allowedNgoIds.includes(ngoId)) ? ngoId : (ngoId || 'others');
    byNgo[key] = (byNgo[key] || 0) + amount;
  }
  return byNgo;
};

// Curated spelling variants for this worker, from the worker_aliases table
// (migration 080). Imported receipts carry printed-name variants that never
// matched the canonical name, so those donations were silently never credited.
// Returns [] rather than throwing: an alias lookup failure must not take the
// collection total down with it.
const getWorkerAliasNames = async (workerId) => {
  try {
    const { data } = await db
      .from('worker_aliases')
      .select('alias_name')
      .eq('worker_id', workerId);
    return (data || []).map((a) => a.alias_name).filter(Boolean);
  } catch (e) {
    return [];
  }
};

// Which real worker each printed agent_name belongs to, for the whole FRO
// population rather than one person.
//
// Needed because the log fallback must be able to ask "does this receipt's
// agent_name already name somebody?" before claiming it. Without that question
// the fallback stayed additive: a receipt stamped 'Mamta Shah' but linked to
// another FRO's station log was counted on both cards, which is how one FRO's
// total read ~10,284 against a real 7,433.
//
// Every FRO row is included, so the answer is "yes, it names a real person, not
// you" for any colleague. Category labels and blanks are absent by
// construction: they are not workers.
//
// Returns a Map of normalized name -> worker id rather than a bare Set, because
// a CRM agent label ('Agent 21') is only a competing claim once it resolves to
// somebody — worker_aliases maps every label to the login's worker, and the
// caller needs to know whether that somebody is itself (a work-as receipt
// carries the ACTOR's label while the log's fro_worker_id is the COVERED FRO).
const getAllWorkerNameResolvers = async () => {
  const resolvers = new Map();
  const claim = (name, workerId) => {
    const n = normalizeAgentName(name);
    if (!n || isCategoryLabel(n)) return;
    if (resolvers.has(n)) return;
    resolvers.set(n, String(workerId));
  };
  try {
    const { data: workers } = await db
      .from('workers')
      .select('id, name')
      .not('name', 'is', null);
    for (const w of workers || []) claim(w.name, w.id);
  } catch (e) {
    // Fail open: with no resolver map, the fallback behaves as it did before,
    // which risks a duplicate credit but never hides a collection.
    return new Map();
  }
  try {
    const { data: aliases } = await db
      .from('worker_aliases')
      .select('alias_name, worker_id')
      .not('alias_name', 'is', null);
    for (const a of aliases || []) claim(a.alias_name, a.worker_id);
  } catch (e) { /* canonical names alone are enough to spot a competing claim */ }
  return resolvers;
};

/**
 * Every receipt that counts as this worker's collection in the window, already
 * deduplicated. This is the ONE loader behind both the dashboard's "Collected"
 * card and the "View collections" list.
 *
 * Attribution is NAME first, log_id only as a fallback -- deliberately reversed
 * from an earlier version of this file, which trusted the log and credited one
 * FRO with another FRO's collection.
 *
 * receipts.log_id is a reliable LINK but not a reliable OWNER. When an operator
 * matches a bank entry to a donor's pending lead (bankAuditController.js:181),
 * the receipt inherits that lead's log, and log.fro_worker_id is whoever the
 * ASSIGNMENT belongs to -- not who collected the cash. A donor on a station
 * produces a receipt whose agent_name is the real collector while the log points
 * at the station's FRO.
 *
 * So agent_name wins whenever it resolves to a real person: on the bank-audit and
 * suspense paths that is the name the operator saw and confirmed in the Edit
 * Receipt form. The log is used only when the name is blank or is a category
 * label, where there is no name evidence at all.
 *
 * agent_name still cannot be trusted blindly -- a CRM agent's work-as switch
 * stamps the label "Agent 13" rather than a name (authController.js:960), and the
 * bank-audit and suspense paths write 'Suspense'/'PG'/free text -- so the name
 * query is alias-expanded (migration 080) and category labels are excluded
 * outright, leaving unreconciled bank money credited to nobody.
 *
 * Category labels ('Suspense', 'PG', 'Library', 'NA') are never matched, so
 * unreconciled bank money is not credited to an FRO who never collected it.
 */
export const getWorkerCollectionReceipts = async (workerId, monthStart, monthEnd) => {
  const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);
  const RECEIPT_COLS = 'id, donor_id, amount, project_id, receipt_date, receipt_no, payment_id, agent_name, log_id, donor_name, donor_mobile, mode';

  // The id handed in here is creditWorkerId from the FRO panel, which is the
  // OPERATOR (req.user.imposter_id), not always a workers row: under an agent
  // login it is a crm_agents uuid. Querying workers/logs with that uuid matched
  // nothing, so every agent session's Collected card read zero however much had
  // been verified. Resolve it once — window 1 runs against the linked worker,
  // window 2 matches the linked worker's name plus the label this session
  // stamps into receipts.agent_name.
  const credit = await resolveCreditTarget(workerId);
  const queryWorkerId = credit?.workerId || workerId;

  // Window 1 - authoritative. The log states the owner, so this needs no name at
  // all and is immune to a mislabelled agent_name. Only consulted for receipts
  // whose name gave us nothing (blank, or a category label like 'Suspense'),
  // so it can never override a name an operator actually confirmed.
  let byLogId = [];
  try {
    byLogId = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.project_id, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id, r.donor_name, r.donor_mobile, r.mode
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = $1
         AND r.receipt_date >= $2 AND r.receipt_date <= $3`,
      [queryWorkerId, monthStartDay, monthEndDay]
    );
  } catch (e) { byLogId = []; }

  // Window 2 - primary. Receipts whose printed agent_name names this worker (or
  // one of their curated aliases), matched exactly with LIKE wildcards escaped.
  // Category labels are excluded so 'Suspense' bank money is never credited to a
  // person.
  const { data: worker } = await db.from('workers').select('name').eq('id', queryWorkerId).maybeSingle();
  const workerName = (credit?.name || worker?.name || '').trim();
  let byName = [];
  if (workerName) {
    const aliasNames = await getWorkerAliasNames(queryWorkerId);
    const matches = buildAgentNameMatches(workerName, [...aliasNames, credit?.label]);
    const patterns = [...matches]
      .filter((n) => !CATEGORY_LABELS.includes(n))
      .map((n) => escapeLikePattern(n));
    if (patterns.length > 0) {
      // Params start at $3: only the two date bounds precede the name patterns.
      const orClause = patterns.map((_, i) => `lower(btrim(agent_name)) = $${i + 3}`).join(' OR ');
      try {
        byName = await sql(
          `SELECT ${RECEIPT_COLS}
           FROM receipts r
           WHERE r.receipt_date >= $1 AND r.receipt_date <= $2
             AND (${orClause})`,
          [monthStartDay, monthEndDay, ...patterns]
        );
      } catch (e) { byName = []; }
    }
  }

  return mergeAttributedReceipts(byName, byLogId, await getAllWorkerNameResolvers(), queryWorkerId);
};

export const getTotalCollectedByWorker = async (workerId, monthStart, monthEnd) => {
  const receipts = await getWorkerCollectionReceipts(workerId, monthStart, monthEnd);
  return receipts.reduce((sum, r) => sum + Number(r.amount || 0), 0);
};

// Same attribution as getWorkerCollectionReceipts -- name first, log as a
// fallback -- so the daily AKI chart and the Collected card can never disagree
// about who collected what. It cannot simply reuse that loader because the two
// bucket by different dates: the card counts a collection in the transaction
// month, while this has historically credited a backdated receipt to the day it
// was VERIFIED, so the daily AKI days line up with the Verified Today card.
// That day choice is the only difference; ownership comes from the shared
// helpers so it cannot drift.
export const getDailyCollectionByWorker = async (workerId, monthStart, monthEnd) => {
  const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);

  // Same operator-vs-worker resolution as the card loader: creditWorkerId may be
  // a crm_agents uuid under an agent login, and a workers-keyed lookup against
  // it returns nothing.
  const credit = await resolveCreditTarget(workerId);
  const queryWorkerId = credit?.workerId || workerId;

  // Authoritative window: linked to this worker's log, in the verified window so
  // the bucket day can be the verification date. Fallback only, for receipts whose
  // name resolved to nobody.
  let byLogId = [];
  try {
    byLogId = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id,
              l.verified_at AS verified_at
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = $1
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [queryWorkerId, monthStart, monthEnd]
    );
  } catch (e) { byLogId = []; }

  const { data: worker } = await db.from('workers').select('name').eq('id', queryWorkerId).maybeSingle();
  const workerName = (credit?.name || worker?.name || '').trim();
  let byName = [];
  if (workerName) {
    const aliasNames = await getWorkerAliasNames(queryWorkerId);
    const patterns = [...buildAgentNameMatches(workerName, [...aliasNames, credit?.label])]
      .filter((n) => !CATEGORY_LABELS.includes(n))
      .map((n) => escapeLikePattern(n));
    if (patterns.length > 0) {
      const orClause = patterns.map((_, i) => `lower(btrim(agent_name)) = $${i + 3}`).join(' OR ');
      try {
        byName = await sql(
          `SELECT id, donor_id, amount, receipt_date, receipt_no, payment_id, agent_name, log_id
           FROM receipts
           WHERE receipt_date >= $1 AND receipt_date <= $2
             AND (${orClause})`,
          [monthStartDay, monthEndDay, ...patterns]
        );
      } catch (e) { byName = []; }
    }
  }

  // Every receipt credited here is in the window by whichever date applies, and
  // deduplicated once across both windows before bucketing.
  const merged = mergeAttributedReceipts(
    byName.map((r) => ({ ...r, verified_at: null })),
    byLogId.map((r) => ({ ...r, verified_at: r.verified_at || null })),
    await getAllWorkerNameResolvers(),
    queryWorkerId,
  );

  const seenPayments = new Set();
  const byDay = {};
  for (const r of merged) {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) continue;
    const vDay = r.verified_at ? String(r.verified_at).slice(0, 10) : null;
    const rDay = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    const day = (vDay && vDay >= monthStartDay && vDay <= monthEndDay) ? vDay : rDay;
    if (!day) continue;
    const identity = paymentIdentity(r);
    if (seenPayments.has(identity)) continue;
    seenPayments.add(identity);
    byDay[day] = (byDay[day] || 0) + amount;
  }
  return byDay;
};

export const getBatchCollectionStats = async (workerIds, monthStart, monthEnd, todayStart, todayEnd, ngoIds) => {
  if (workerIds.length === 0) {
    const zero = {};
    for (const id of workerIds) zero[id] = 0;
    const zeroV = {};
    for (const id of workerIds) zeroV[id] = { amount: 0, count: 0 };
    return { monthCollection: zero, todayCollection: zero, weekCollection: zero, verifiedMonth: zeroV, unverifiedMonth: zeroV, verifiedToday: zeroV, unverifiedToday: zeroV };
  }

  const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
  const workerNames = (workers || []).filter(w => w.name).map(w => ({ id: w.id, name: w.name.trim() }));

  const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);
  const todayStartDay = String(todayStart).slice(0, 10);
  const todayEndDay = String(todayEnd).slice(0, 10);

  const init = () => ({ amount: 0, count: 0 });
  const monthCollection = {}; for (const id of workerIds) monthCollection[id] = 0;
  const todayCollection = {}; for (const id of workerIds) todayCollection[id] = 0;
  const weekCollection = {}; for (const id of workerIds) weekCollection[id] = 0;
  const verifiedMonth = {}; for (const id of workerIds) verifiedMonth[id] = init();
  const unverifiedMonth = {}; for (const id of workerIds) unverifiedMonth[id] = init();
  const verifiedToday = {}; for (const id of workerIds) verifiedToday[id] = init();
  const unverifiedToday = {}; for (const id of workerIds) unverifiedToday[id] = init();

  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6); weekEnd.setHours(23, 59, 59, 999);
  const weekStartDay = weekStart.toISOString().slice(0, 10);
  const weekEndDay = weekEnd.toISOString().slice(0, 10);

  if (workerNames.length === 0) {
    return { monthCollection, todayCollection, weekCollection, verifiedMonth, unverifiedMonth, verifiedToday, unverifiedToday };
  }

  const byName = {};
  for (const w of workerNames) {
    const k = w.name.toLowerCase();
    (byName[k] = byName[k] || []).push(w.id);
  }

  const receipts = await sql(
    `SELECT id, donor_id, amount, project_id, receipt_date, receipt_no, payment_id, agent_name, log_id
     FROM receipts
     WHERE receipt_date >= $1 AND receipt_date <= $2
       AND lower(btrim(agent_name)) = ANY($3)`,
    [monthStartDay, monthEndDay, Object.keys(byName)]
  );

  // Receipts verified in-month but backdated to an earlier receipt_date.
  // Attributed by linked log worker so Verified ⊆ Collected per worker.
  let verifiedLinked = [];
  try {
    verifiedLinked = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.project_id, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id,
              l.fro_worker_id AS log_worker_id, l.verified_at AS verified_at
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = ANY($1) AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerIds, monthStart, monthEnd]
    );
  } catch (e) { verifiedLinked = []; }

  const dedup = {}; for (const id of workerIds) dedup[id] = new Set();
  const verifiedLinkedIds = new Set((verifiedLinked || []).map(r => `${r.log_worker_id}|${String(r.id)}`));
  const applyReceipt = (id, r, day) => {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0 || !day) return;
    const idKey = String(r.id);
    if (dedup[id].has(idKey)) return;
    dedup[id].add(idKey);
    if (day >= monthStartDay && day <= monthEndDay) monthCollection[id] += amount;
    if (day >= weekStartDay && day <= weekEndDay) weekCollection[id] += amount;
    if (day >= todayStartDay && day <= todayEndDay) todayCollection[id] += amount;
    if (day >= monthStartDay && day <= monthEndDay) {
      verifiedMonth[id].amount += amount;
      verifiedMonth[id].count++;
    }
    if (day >= todayStartDay && day <= todayEndDay) {
      verifiedToday[id].amount += amount;
      verifiedToday[id].count++;
    }
  };

  for (const r of receipts) {
    // Skip linked receipts here when the linked log belongs to a known worker;
    // they are attributed via verifiedLinked to avoid agent_name mismatches.
    if (r.log_id) continue;
    const matched = byName[String(r.agent_name || '').trim().toLowerCase()];
    if (!matched) continue;
    const day = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    for (const id of matched) applyReceipt(id, r, day);
  }
  for (const r of receipts) {
    if (!r.log_id) continue;
    const matched = byName[String(r.agent_name || '').trim().toLowerCase()];
    if (!matched) continue;
    const day = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    for (const id of matched) {
      // Verified-day bucket below wins for the same receipt+worker; skip here
      // to avoid counting one receipt twice on two different days.
      if (verifiedLinkedIds.has(`${id}|${String(r.id)}`)) continue;
      applyReceipt(id, r, day);
    }
  }
  for (const r of verifiedLinked || []) {
    const id = r.log_worker_id;
    if (!id || !dedup[id]) continue;
    const vDay = r.verified_at ? String(r.verified_at).slice(0, 10) : null;
    const day = (vDay && vDay >= monthStartDay && vDay <= monthEndDay)
      ? vDay
      : (r.receipt_date ? String(r.receipt_date).slice(0, 10) : null);
    applyReceipt(id, r, day);
  }

  // Unverified = pending lead_done logs (receipts only exist after verify, so
  // the receipts loop above can never fill these — previously always zero).
  try {
    const pending = await sql(
      `SELECT fro_worker_id, amount_collected, created_at
       FROM fro_donor_logs
       WHERE fro_worker_id = ANY($1) AND disposition_detail = 'lead_done' AND accounts_status = 'pending'
         AND created_at >= $2 AND created_at <= $3`,
      [workerIds, monthStart, monthEnd]
    );
    for (const l of pending || []) {
      const id = l.fro_worker_id;
      if (!id || !unverifiedMonth[id]) continue;
      const amount = parseFloat(l.amount_collected || 0);
      const day = l.created_at ? String(l.created_at).slice(0, 10) : null;
      unverifiedMonth[id].amount += amount;
      unverifiedMonth[id].count++;
      if (day && day >= todayStartDay && day <= todayEndDay) {
        unverifiedToday[id].amount += amount;
        unverifiedToday[id].count++;
      }
    }
  } catch (e) { /* keep zeros on failure */ }

  return { monthCollection, todayCollection, weekCollection, verifiedMonth, unverifiedMonth, verifiedToday, unverifiedToday };
};

// Verified collection credited to each worker (by receipts.agent_name) within an
// arbitrary inclusive day range. Mirrors the month/today receipt matching used by
// getBatchCollectionStats but lets the dashboard compute period performance
// (yesterday / this week / this month / a custom range) instead of only today.
export const getRangeCollectionByWorker = async (workerIds, startDay, endDay) => {
  const result = {};
  for (const id of workerIds) result[id] = 0;
  if (workerIds.length === 0) return result;

  const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
  const byName = {};
  for (const w of workers || []) {
    if (!w.name) continue;
    const k = w.name.trim().toLowerCase();
    (byName[k] = byName[k] || []).push(w.id);
  }
  // Widen the map with each worker's curated aliases. Without this, a receipt
  // stamped "Agent 13" (the label an agent's work-as switch writes, see
  // authController.js:960) matched no name here and was invisible to this
  // batch total even though worker_aliases still maps it to its FRO.
  if (workerIds.length > 0) {
    try {
      const { data: aliasRows } = await db
        .from('worker_aliases')
        .select('alias_name, worker_id')
        .in('worker_id', workerIds);
      const known = new Set(workerIds.map(String));
      for (const a of aliasRows || []) {
        const k = String(a.alias_name || '').trim().toLowerCase();
        // Category labels are not people; never let one become a worker key.
        if (!k || CATEGORY_LABELS.includes(k)) continue;
        if (!known.has(String(a.worker_id))) continue;
        const list = (byName[k] = byName[k] || []);
        if (!list.some((id) => String(id) === String(a.worker_id))) list.push(a.worker_id);
      }
    } catch (e) { /* an alias lookup failure must not lose the canonical names */ }
  }
  if (Object.keys(byName).length === 0) return result;

  const receipts = await sql(
    `SELECT id, amount, receipt_date, receipt_no, donor_id, payment_id, agent_name, log_id
     FROM receipts
     WHERE receipt_date >= $1 AND receipt_date <= $2
       AND lower(btrim(agent_name)) = ANY($3)`,
    [startDay, endDay, Object.keys(byName)]
  );
  let verifiedLinked = [];
  try {
    verifiedLinked = await sql(
      `SELECT r.id, r.amount, r.receipt_date, r.receipt_no, r.donor_id, r.payment_id, r.agent_name, r.log_id,
              l.fro_worker_id AS log_worker_id
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = ANY($1) AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerIds, startDay, endDay]
    );
  } catch (e) { verifiedLinked = []; }

  const dedup = {};
  for (const id of workerIds) dedup[id] = new Set();
  const addAmt = (id, r) => {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) return;
    const idKey = String(r.id);
    if (dedup[id].has(idKey)) return;
    dedup[id].add(idKey);
    result[id] += amount;
  };
  for (const r of receipts) {
    const matched = byName[String(r.agent_name || '').trim().toLowerCase()];
    if (!matched) continue;
    const day = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    if (!day) continue;
    for (const id of matched) addAmt(id, r);
  }
  for (const r of verifiedLinked || []) {
    if (r.log_worker_id && dedup[r.log_worker_id]) addAmt(r.log_worker_id, r);
  }
  return result;
};

export const findLogsByDonorAndWorker = async (donorId, workerId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('*')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('findLogsByDonorAndWorker query failed, trying fallback:', error.message);
    const { data: assignment, error: asgnErr } = await db
      .from('fro_assignments')
      .select('id')
      .eq('donor_id', donorId)
      .eq('fro_worker_id', workerId)
      .not('status', 'eq', 'reassigned')
      .maybeSingle();
    if (asgnErr) {
      console.error('findLogsByDonorAndWorker fallback also failed:', asgnErr.message);
      throw asgnErr;
    }
    if (assignment) {
      return findLogsByAssignment(assignment.id);
    }
    return [];
  }
  return data || [];
};

export const getTotalCollectedByDonorAndWorker = async (donorId, workerId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('amount_collected')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)');
  if (error) {
    console.error('getTotalCollectedByDonorAndWorker failed, trying fallback:', error.message);
    const { data: assignment, error: asgnErr } = await db
      .from('fro_assignments')
      .select('id')
      .eq('donor_id', donorId)
      .eq('fro_worker_id', workerId)
      .not('status', 'eq', 'reassigned')
      .maybeSingle();
    if (asgnErr) {
      console.error('getTotalCollectedByDonorAndWorker fallback also failed:', asgnErr.message);
      throw asgnErr;
    }
    if (assignment) {
      return getTotalCollectedByAssignment(assignment.id);
    }
    return 0;
  }
  let total = 0;
  for (const d of data || []) {
    total += parseFloat(d.amount_collected || 0);
  }
  return total;
};

// One loader behind the dashboard's Verified and Unverified cards.
//
// attribution decides WHOSE row a claim is:
//
//   'station' (default) — fro_worker_id, the assignment's FRO. What the NGO
//     per-FRO report asks for, and the historical behaviour of both callers
//     that pass a plain workers id.
//   'credit' — whoever was at the keyboard: operator_id when the row records a
//     cover, otherwise the worker. This is what the FRO panel's cards pass, and
//     it is the same rule the receipt loader applies by name, so the Verified
//     figure sits with the same person the Collected figure sits with.
//
// Under an agent login creditWorkerId is a crm_agents uuid, which matches
// nothing in fro_worker_id — that alone made both cards read zero for every
// agent session. resolveCreditTarget maps it to the linked worker for the
// no-cover half; the cover half has to match the id as handed in, because
// operator_id holds the agent's uuid.
const loadClaimRows = async ({ workerId, startDate, endDate, dateCol, status, attribution }) => {
  const scoped = () => db
    .from('fro_donor_logs')
    .select('id, amount_collected, fro_worker_id, operator_id')
    .eq('disposition_detail', 'lead_done')
    .eq('accounts_status', status)
    .gte(dateCol, startDate)
    .lte(dateCol, endDate);

  if (attribution !== 'credit') {
    const { data, error } = await scoped().eq('fro_worker_id', workerId);
    if (error) throw error;
    return data || [];
  }

  const credit = await resolveCreditTarget(workerId);
  const queryWorkerId = credit?.workerId || workerId;
  const taken = new Map();
  // Tolerated failures: a non-uuid id would make Postgres refuse the
  // comparison, and the dashboard must lose a slice of detail rather than the
  // whole card.
  try {
    const { data, error } = await scoped().eq('fro_worker_id', queryWorkerId).is('operator_id', null);
    if (error) throw error;
    for (const r of data || []) taken.set(String(r.id), r);
  } catch (e) { /* station half stands alone */ }
  try {
    const { data, error } = await scoped().eq('operator_id', workerId);
    if (error) throw error;
    for (const r of data || []) taken.set(String(r.id), r);
  } catch (e) { /* cover half is optional for an id outside operator_id's spaces */ }
  return [...taken.values()];
};

export const getVerifiedCollection = async (workerId, startDate, endDate, options = {}) => {
  const data = await loadClaimRows({
    workerId,
    startDate,
    endDate,
    dateCol: 'verified_at',
    status: 'verified',
    attribution: options.attribution,
  });

  let total = 0;
  for (const d of data) total += parseFloat(d.amount_collected || 0);
  return { amount: total, count: data.length };
};

export const getUnverifiedCollection = async (workerId, startDate, endDate, options = {}) => {
  const data = await loadClaimRows({
    workerId,
    startDate,
    endDate,
    dateCol: 'created_at',
    status: 'pending',
    attribution: options.attribution,
  });

  let total = 0;
  for (const d of data) total += parseFloat(d.amount_collected || 0);
  return { amount: total, count: data.length };
};

export const getTotalCollectedByAssignment = async (assignmentId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('amount_collected, action, disposition_detail')
    .eq('assignment_id', assignmentId)
    .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)');
  if (error) throw error;

  let total = 0;
  for (const d of data) {
    total += parseFloat(d.amount_collected || 0);
  }
  return total;
};
