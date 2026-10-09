import db from '../config/db.js';
import { FRO_IDLE_LIVE_COLS } from '../utils/froIdleCols.js';
import { emitRealtime, isWorkerOnline } from '../socket.js';
import { getWorkerById, getWorkerBySession } from '../models/workerModel.js';
import { enrichDonorProfileFromReceipt } from '../models/bankAuditModel.js';
import { findAutoMatches } from '../services/autoMatchService.js';
import { getActiveSalaryByWorker } from '../models/salaryModel.js';
import { resolveMonthlyTarget } from '../services/froMonthlyTarget.js';
import {
  batchCreateAssignments,
  findAssignmentById,
  updateAssignmentStatus,
  getDashboardStats,
  createScheduledContact,
  completeAllScheduledByAssignment,
  getScheduledByAssignment,
} from '../models/froAssignmentModel.js';
import { getTargetByWorker, getLatestTargetBeforeMonth } from '../models/froTargetModel.js';
import { classifyLogSide, bustTlCache } from './ngoAdminController.js';
import { getUserNgoAccess } from '../models/userNgoAccessModel.js';
import { getOfficeStart, getOfficeEnd } from '../utils/attendanceStatus.js';
import {
  getShiftWindowMs,
  withinShift,
  liveIdleSeconds,
  effectiveIdleSeconds,
  openIdleSeconds,
  idlePeriodStartMs,
  deadlinePassed,
  dispositionDueMs,
  nextDeadline,
  secondsLeft,
  istDateStr,
  withoutStaleIdle,
  isIdleNow,
  idleFreezeCutoffMs,
  isCounterDayStale,
  settleGrant,
  settleWindowArm,
  settleSecondsLeft,
  IDLE_LIVE_FRESH_MS,
} from '../utils/froIdle.js';
import {
  createDonorLog,
  ensureLogSequenceHealth,
  findDispositionLogToday,
  updateDonorLog,
  findLogsByDonorAndWorker,
  findLogsByAssignment,
  getTotalCollectedByWorker,
  getWorkerCollectionReceipts,
  getCollectedByNgo,
  getTotalCollectedByAssignment,
  getTotalCollectedByDonorAndWorker,
  getVerifiedCollection,
  getUnverifiedCollection,
  getDailyCollectionByWorker,
  COLLECTION_DATE_OR,
  logCollectionDate,
  paymentDiscriminant,
  inRange,
} from '../models/froDonorLogModel.js';
import { buildFroLeaderboard } from '../services/froRankService.js';
import { commitIdleOnExit, stampLapsedIdle } from '../services/froIdleCommit.js';
import { rollCountersForNewDay, writeDailySnapshot, ledgerIdleForDate } from '../services/froCounterDay.js';
import { getAchievements } from '../models/dailyAchievementModel.js';
import { getDayName, calculateAKI, getMonthsEmployed, getAKISlabs } from '../utils/incentive.js';
import { cached, cacheGet, cacheSet, cacheDelPrefix } from '../utils/ttlCache.js';
import redis from '../config/redis.cjs';

// FRO read payloads are recomputed on every poll and on every page visit, and
// most of them only change when the FRO themselves act. Caching them keeps a
// browser refresh or a 30s poll from re-running the same aggregate scans.
//
// TTLs are deliberately short and every payload that depends on the FRO's own
// work is invalidated explicitly by invalidateFroCaches() the moment a
// disposition or donation is written, so a stale number is never shown for more
// than the window it takes the next request to arrive.
const FRO_DASHBOARD_TTL_MS = 30 * 1000;
const FRO_TARGET_TTL_MS = 30 * 1000;
const FRO_SEARCH_TTL_MS = 60 * 1000;
const FRO_SEARCH_SCOPE_TTL_MS = 60 * 1000;
// My Leads runs 11+ sequential queries per request, so it is the most expensive
// read in this file and the one refetched most often - the client re-requests it
// on every mount, on every station/NGO/tab change (up to 3x per load), and on
// every fro_assignments INSERT socket event.
//
// Two tiers. L1 is in-process, so it costs nothing, survives a Redis outage, and
// absorbs the repeat hits without a network round-trip. L2 is Upstash so the
// cache is shared if the backend is ever run as more than one process - today it
// is a single process (see socket.js) and L2 is mostly insurance, which is also
// why L1 is checked first.
//
// This endpoint does NOT poll on an interval, unlike /fro/my-performance, so its
// request volume is a small fraction of that one's. Volume estimate: ~20 FROs x
// ~25 list loads/day (mount + a few tab/station switches + socket reloads) is
// roughly 500 GET/day, ~15k/month even before misses add their SET - comfortably
// inside the 500k/month budget noted in utils/ttlCache.js, which was set against
// the 30s-poll endpoint at ~57.6k requests/day, not this one.
const FRO_DONORS_TTL_MS = 30 * 1000;
const FRO_DONORS_REDIS_PREFIX = 'v1:fro:donors:';
// Longer than L1 on purpose: a cold L1 (new process, or an L1 eviction) can then
// still be served from Upstash instead of falling through to those 11+ queries.
const FRO_DONORS_REDIS_TTL_S = 60;
// The client renders this list incrementally (LEADS_PAGE_SIZE/visibleCount) and
// does NOT send limit/offset, so the cached payload is the WHOLE filtered list -
// sometimes multiple MB of ~38 keys per donor. Large payloads stay in L1 only:
// shipping them to Upstash on every miss would burn storage and bandwidth to
// cache a view that is refetched rarely anyway. Oversized views still get the
// full benefit of L1, which is where the repeat hits actually are.
const FRO_DONORS_REDIS_MAX_BYTES = 512 * 1024;

// Every query param that changes the My Leads payload. Anything left out of this
// list would let two differently-filtered views share one entry and show the FRO
// the wrong queue.
const FRO_DONORS_KEY_PARAMS = [
  'status', 'status_group', 'ngo_id', 'station', 'new_only', 'old_only',
  'verified_only', 'active_only', 'inactive_only', 'include_suppressed',
  'period', 'limit', 'offset',
];

/**
 * Identity of one My Leads view: worker + work-as scope + filter combination.
 *
 * The act-stations segment is not redundant with workerId: a "work as" token
 * carries act_stations that narrow the FRO's (ngo, station) scope while workerId
 * stays the same, so two operators impersonating the same FRO can hold two
 * different queues at once. Without it one would be served the other's leads.
 *
 * Returned hashed, so both tiers get short fixed-width keys. The L1 key keeps its
 * `fro:donors:<workerId>:` head because invalidation deletes that prefix.
 */
function froDonorsCacheKeys(req, workerId) {
  const params = FRO_DONORS_KEY_PARAMS.map(p => `${p}=${req.query?.[p] ?? ''}`);
  const actPairs = froActPairs(req);
  const act = actPairs
    ? actPairs.map(p => `${p?.ngo_id ?? ''}|${String(p?.station ?? '').trim()}`).sort().join(',')
    : '-';
  const hash = redis.hashKey(`${workerId}|act=${act}|${params.join('&')}`);
  return {
    l1: `fro:donors:${workerId}:${hash}`,
    l2: `${FRO_DONORS_REDIS_PREFIX}${workerId}:${hash}`,
  };
}

/**
 * Drop every cached read payload belonging to one FRO. Called from the write
 * paths that change what those payloads contain (disposition saved, donation
 * recorded, station scope edited).
 */
export function invalidateFroCaches(workerId) {
  cacheDelPrefix(`fro:dash:${workerId}:`);
  cacheDelPrefix(`fro:target:${workerId}:`);
  cacheDelPrefix(`fro:search:${workerId}:`);
  cacheDelPrefix(`fro:donors:${workerId}:`);
  // Upstash cannot delete a prefix cheaply, but this namespace stays small - one
  // key per live filter combination for that worker, and oversized views are
  // never written - so a bounded SCAN is a couple of round-trips, which is noise
  // next to the DB write that triggered this. Fire-and-forget so the write path
  // never waits on the cache; worst case the entries age out on their TTL.
  redis.delByPrefix(`${FRO_DONORS_REDIS_PREFIX}${workerId}:`).catch(() => { });
}

import { istDayBounds, istDateString, istMonthBounds, istMonthKey, istParts } from '../utils/ist.js';
import { reconcileQueue, getNextQueueRow, markShown, markDisposed, countQueueRows, cycleKey, getActiveQueueRows, clearActiveRowsNotIn, classifyDisposition, removeFromQueue } from '../models/workQueueModel.js';
import { splitWorkerContext } from '../utils/workAs.js';
import { getAgentById } from '../models/crmAgentModel.js';
import { buildTeamCollection, getWorkerTeamKey, resolvePeriodRange, PERIODS, PERIOD_LABELS } from '../services/teamCollectionService.js';
import { getActiveCoversForTargets, refreshCoverExpiry } from '../models/workAsSessionModel.js';
import { resetLiveWindow } from '../services/froLiveWindow.js';
import { computeTimeStatus, toStatusPayload } from '../services/froTimeStatus.js';
import { transition as transitionTimeState, applyEvent as applyTimeEvent, getOpenSession, closeSessionOpenedBeforeDay } from '../services/froTimeSessions.js';
import { reconcileDispositionIdle } from '../services/froTimeReconcile.js';
import { TIME_STATES, TIME_EVENTS, isHeldState } from '../utils/froTimeState.js';

async function findOrCreateAssignment(donorId, workerId, ngoId) {
  // 1) Worker already owns an active assignment for this donor (and ngo).
  let query = db
    .from('fro_assignments')
    .select('id, station')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .not('status', 'eq', 'reassigned');
  if (ngoId) query = query.eq('ngo_id', ngoId);
  const { data: existing } = await query.maybeSingle();
  if (existing) return existing;

  // 2) Resolve ngo from the donor profile when the caller did not pass one.
  if (!ngoId) {
    const { data: donor } = await db
      .from('donor_profiles')
      .select('ngo')
      .eq('id', donorId)
      .single();
    if (!donor) return null;
    const { data: ngo } = await db
      .from('ngos')
      .select('id')
      .eq('name', donor.ngo)
      .maybeSingle();
    ngoId = ngo?.id || null;
  }
  if (!ngoId) return null;

  // 3) Claim an unassigned lead (fro_worker_id is null) for this ngo.
  const { data: unassigned } = await db
    .from('fro_assignments')
    .select('id, station')
    .eq('donor_id', donorId)
    .is('fro_worker_id', null)
    .eq('ngo_id', ngoId)
    .or('status.neq.reassigned,status.is.null')
    .maybeSingle();
  if (unassigned) {
    await db
      .from('fro_assignments')
      .update({ fro_worker_id: workerId, assigned_at: new Date().toISOString() })
      .eq('id', unassigned.id);
    return unassigned;
  }

  // 4) Claim the donor's existing assignment for this ngo when it falls in the
  //    worker's (station, ngo) scope and the current owner no longer covers
  //    that scope (orphaned rows left behind by staff changes). Creating a new
  //    row instead would violate fro_assignments' unique (donor_id, ngo_id)
  //    constraint, and reassigning from an active co-worker would steal it.
  const { data: myStationRows } = await db
    .from('fro_station_assignments')
    .select('station, ngo_id')
    .eq('fro_worker_id', workerId);
  const scopePairs = new Set((myStationRows || [])
    .filter(s => s.ngo_id && s.station)
    .map(s => `${s.station}|${s.ngo_id}`));
  if (scopePairs.size > 0) {
    const { data: candidates } = await db
      .from('fro_assignments')
      .select('id, station, fro_worker_id')
      .eq('donor_id', donorId)
      .eq('ngo_id', ngoId)
      .or('status.neq.reassigned,status.is.null')
      .limit(20);
    for (const c of candidates || []) {
      if (!c.fro_worker_id || c.fro_worker_id === workerId) continue;
      if (!scopePairs.has(`${c.station}|${ngoId}`)) continue;
      const { data: ownerScope } = await db
        .from('fro_station_assignments')
        .select('id')
        .eq('fro_worker_id', c.fro_worker_id)
        .eq('station', c.station)
        .eq('ngo_id', ngoId)
        .limit(1);
      if (!ownerScope || ownerScope.length === 0) {
        await db
          .from('fro_assignments')
          .update({ fro_worker_id: workerId, assigned_at: new Date().toISOString() })
          .eq('id', c.id);
        return { id: c.id, station: c.station };
      }
    }
  }

  // 5) Create the worker's own row (only possible when no (donor_id, ngo_id)
  //    row exists yet).
  //
  // Ghost-row guard: a (donor_id, ngo_id) pair must resolve to exactly ONE
  // active fro_assignments row, otherwise the same donor surfaces in two
  // stations at once and two FROs work (and call) the same lead.
  //
  // The reuse pass below only claims rows that already fall in the worker's
  // (station, ngo) scope. If a live row exists that we cannot claim — because
  // it belongs to a different station, or to an active co-worker in this one —
  // we must NOT fall through to the INSERT: that is exactly how the duplicate
  // rows were born (22k+ cross-station pairs). Return null instead; every
  // caller answers 404, which is the correct outcome for a donor this worker
  // does not own.
  if (ngoId != null) {
    const { data: anyRows } = await db
      .from('fro_assignments')
      .select('id, station, fro_worker_id, status')
      .eq('donor_id', donorId)
      .eq('ngo_id', ngoId)
      .limit(20);
    const rows = anyRows || [];
    for (const c of rows) {
      if (myStationRows && scopePairs.size > 0 && scopePairs.has(`${c.station}|${ngoId}`)) {
        // This row is already inside the worker's scope; claim it if it isn't
        // already theirs (e.g. an orphan/reassigned row left by a staff change).
        if (!c.fro_worker_id || c.fro_worker_id === workerId) {
          if (c.fro_worker_id !== workerId) {
            await db
              .from('fro_assignments')
              .update({ fro_worker_id: workerId, assigned_at: new Date().toISOString() })
              .eq('id', c.id);
          }
          return { id: c.id, station: c.station };
        }
      }
    }
    // A live row exists that this worker may not claim -> refuse to duplicate.
    if (rows.some(c => c.status !== 'reassigned')) return null;
  }

  const myStation = (myStationRows || []).find(s => s.ngo_id === ngoId);
  const { data: created } = await db
    .from('fro_assignments')
    .insert({ donor_id: donorId, fro_worker_id: workerId, ngo_id: ngoId, status: 'pending', station: myStation?.station || null, assigned_at: new Date().toISOString() })
    .select('id, station')
    .single();
  if (created) return created;

  // 6) Re-query fallback (e.g., concurrent create).
  const { data: retry } = await db
    .from('fro_assignments')
    .select('id, station')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .not('status', 'eq', 'reassigned')
    .maybeSingle();
  return retry;
}

// Scope guard: does this FRO hold an active assignment for the donor? Used to
// block IDOR reads/writes on donors outside the worker's assigned scope.
async function getFroAssignment(donorId, workerId, ngoId) {
  let query = db
    .from('fro_assignments')
    .select('id, ngo_id')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .not('status', 'eq', 'reassigned')
    .limit(1);
  if (ngoId) query = query.eq('ngo_id', ngoId);
  const { data } = await query.maybeSingle();
  return data || null;
}

async function getMyStationNames(workerId) {
  const { data: stationAssigns, error } = await db
    .from('fro_station_assignments')
    .select('station')
    .eq('fro_worker_id', workerId);
  if (error) throw error;
  return (stationAssigns || []).map(s => s.station);
}

// Station restriction for impersonated ("work as") sessions: when the token
// carries act_stations, the operator may only touch those (ngo_id, station)
// pairs — every data surface funnels through getMyStationScope below.
export function froActPairs(req) {
  const u = req?.user;
  if (!u?.impersonation || !Array.isArray(u.act_stations)) return null;
  return u.act_stations.length > 0 ? u.act_stations : null;
}

async function getMyStationScope(workerId, restrictPairs = null) {
  const { data: stationAssigns, error } = await db
    .from('fro_station_assignments')
    .select('station, ngo_id')
    .eq('fro_worker_id', workerId);
  if (error) throw error;
  let scope = (stationAssigns || []).map(s => ({ station: s.station, ngo_id: s.ngo_id }));
  if (restrictPairs && restrictPairs.length > 0) {
    const allowed = new Set(restrictPairs.map(p => `${p?.ngo_id ?? ''}|${String(p?.station ?? '').trim()}`));
    scope = scope.filter(s => allowed.has(`${s.ngo_id ?? ''}|${String(s.station).trim()}`));
  }
  const stationNames = scope.map(s => s.station);
  const allowedNgoIds = [...new Set(scope.map(s => s.ngo_id).filter(Boolean))];
  return { scope, stationNames, allowedNgoIds };
}

function withStationNgoPairs(queryBuilder, scope, stationCol = 'station', ngoCol = 'ngo_id') {
  if (!scope || scope.length === 0) return queryBuilder;
  const validPairs = scope.filter(s => s.ngo_id && s.station);
  if (validPairs.length === 0) return queryBuilder;
  const stations = [...new Set(validPairs.map(s => s.station))];
  queryBuilder = queryBuilder.in(stationCol, stations);
  const pairs = validPairs.map(s => `and(${stationCol}.eq.${s.station},${ngoCol}.eq.${s.ngo_id})`);
  queryBuilder = queryBuilder.or(pairs.join(','));
  return queryBuilder;
}

// ─── donor_dnd: explicit "do not contact" registry (migration 165) ────────────
// Before 165 a DND mark deleted the assignment, its logs and its scheduled
// contacts, so the decision left no trace and could never be explained, audited
// or released. donor_dnd records it durably instead.
//
// Scope is (donor_id, ngo_id), NOT donor_id alone: 41k donors in this system sit
// under more than one NGO, so a global suppression would silently strip donors
// from stations whose FRO never marked them DND.

// Fetch the set of DND'd donors for a worker's (station, ngo) scope, keyed
// "donorId|ngoId". Any failure degrades to an empty set rather than throwing:
// this table is read on the My Leads hot path, and before migration 165 is
// applied it does not exist. Returning "nothing is suppressed" is the safe
// fallback — the worst case is a previously-deletion-based flow behaving as it
// did before, never a dead page for the FRO.
async function fetchActiveDndIds(scope) {
  try {
    const pairs = (scope || []).filter(s => s.ngo_id);
    if (pairs.length === 0) return new Set();
    const ngoIds = [...new Set(pairs.map(s => s.ngo_id))];
    const { rows, error } = await db._pool.query(
      `SELECT DISTINCT donor_id, ngo_id
         FROM public.donor_dnd
        WHERE released_at IS NULL
          AND ngo_id = ANY($1::uuid[])`,
      [ngoIds]
    );
    if (error) throw new Error(error.message);
    return new Set((rows || []).map(r => `${r.donor_id}|${r.ngo_id}`));
  } catch (err) {
    console.warn('donor_dnd unavailable, treating no donor as suppressed:', err.message);
    return new Set();
  }
}

// Record a DND mark. Upserts on the partial unique index so marking the same
// donor twice is a no-op rather than an error, and is deliberately best-effort:
// failing to write the registry must never abort the disposition the FRO is
// trying to save.
async function recordDndMark({ donorId, ngoId, station, markedBy, reason = 'dnd', note = null }) {
  if (!donorId || !ngoId) return false;
  try {
    const { rows, error } = await db._pool.query(
      `INSERT INTO public.donor_dnd (donor_id, ngo_id, station, reason, note, marked_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual')
       ON CONFLICT (donor_id, ngo_id) WHERE released_at IS NULL
       DO UPDATE SET note = COALESCE(EXCLUDED.note, donor_dnd.note),
                     marked_at = now(),
                     marked_by = EXCLUDED.marked_by
       RETURNING id`,
      [donorId, ngoId, station || null, reason, note, markedBy || null]
    );
    if (error) throw new Error(error.message);
    return !!(rows && rows.length);
  } catch (err) {
    console.error('Failed to record DND mark for donor', donorId, 'ngo', ngoId, ':', err.message);
    return false;
  }
}

// Lift a DND without losing the audit trail (released_at is set, the row stays).
async function releaseDndMark({ donorId, ngoId, releasedBy }) {
  if (!donorId || !ngoId) return false;
  try {
    const { rowCount, error } = await db._pool.query(
      `UPDATE public.donor_dnd
          SET released_at = now(), released_by = $3
        WHERE donor_id = $1 AND ngo_id = $2 AND released_at IS NULL`,
      [donorId, ngoId, releasedBy || null]
    );
    if (error) throw new Error(error.message);
    return (rowCount || 0) > 0;
  } catch (err) {
    console.error('Failed to release DND for donor', donorId, 'ngo', ngoId, ':', err.message);
    return false;
  }
}

// Defense-in-depth: withStationNgoPairs applies the strict (station, ngo_id) pair
// filter at SQL level for all columns, but callers that join through an embedded
// resource (e.g. fro_donor_logs -> fro_assignments) also enforce it here in JS so
// other NGOs' donors in the same station can never leak into the response.
function filterByScope(rows, scope, getPair) {
  const pairs = new Set(scope.filter(s => s.station && s.ngo_id).map(s => `${s.station}|${s.ngo_id}`));
  if (pairs.size === 0) return rows || [];
  return (rows || []).filter(r => pairs.has(getPair(r)));
}

// Follow-up lists are attributed to the OWNER of the assignment
// (fro_assignments.fro_worker_id). Work done inside a "work as" session belongs
// to the impersonated owner: it shows in the owner's account only, and the real
// operator never sees it again after they exit. While the operator is still
// acting, they see only the items they personally tagged
// (fro_donor_logs.fro_worker_id), so the impersonated owner's pre-existing
// backlog stays out of that session too.
function realOperatorId(user) {
  return user?.impersonation && user.imposter_id != null ? user.imposter_id : user.id;
}

async function taggedAssignmentIds(assignmentIds, operatorId) {
  if (!operatorId || !Array.isArray(assignmentIds) || assignmentIds.length === 0) return new Set();
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('assignment_id')
    .in('assignment_id', assignmentIds)
    .or(`operator_id.eq.${operatorId},fro_worker_id.eq.${operatorId}`);
  if (error) throw error;
  return new Set((data || []).map(l => l.assignment_id));
}

// Returns a predicate keeping only the assignments the current account may work:
//  - the FRO's OWN account: assignments they own (work-as items excluded);
//  - a "work as" session: only assignments the acting operator tagged.
async function buildFollowUpOwnerFilter(assignments, user) {
  const isImpersonating = !!(user?.impersonation && user.imposter_id != null);
  const realId = realOperatorId(user);
  const tagged = isImpersonating
    ? await taggedAssignmentIds((assignments || []).map(a => a.id), realId)
    : new Set();
  return (a) => a && (
    (!isImpersonating && String(a.fro_worker_id) === String(user?.id))
    || (isImpersonating && tagged.has(a.id))
  );
}

// Resolves worker ids to display names (used for the owner tile on rows).
async function resolveWorkerNames(workerIds) {
  const ids = [...new Set((workerIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const { data } = await db.from('workers').select('id, name').in('id', ids);
  const map = {};
  for (const w of data || []) map[w.id] = w.name;
  return map;
}

async function chunkedInQuery(ids, queryFn, chunkSize = 1000) {
  const allData = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await queryFn(chunk);
    if (error) throw error;
    if (data) allData.push(...data);
  }
  return allData;
}

// Fetches donation evidence for the worker's assignments. Logs are matched by
// assignment_id (fro_assignments.ngo_id already reflects the NGO the worker is
// allocated to); imported receipts are matched by (donor_id, project_id) where
// project_id = the NGO name lowercased — so a donation only counts toward the
// exact NGO the FRO holds the donor in, never leaking across NGOs. The "current
// period" flag is sized to the donor's frequency (monthly / quarterly /
// half_yearly / yearly / one_time) and dated from the actual donation date
// (transaction_datetime -> verified_at -> created_at), not the log's created_at.
// Returns per-assignment sets (keyed by assignment id) plus per-(donor, project)
// receipt sets so callers can build NGO-scoped flags and row totals.
async function fetchScopedDonationEvidence({ assignments, donorIds, projectSet, oneYearAgo, donorTypeMap: preTypeMap }) {
  const assignmentIds = (assignments || []).map(a => a.id);
  const assignmentDonorMap = new Map();
  for (const a of assignments || []) assignmentDonorMap.set(a.id, a.donor_id);

  // The three inputs are independent — fetch in parallel instead of three
  // sequential chunked round-trips. Callers may pass a pre-fetched
  // donorTypeMap (built from a profiles read they already need) to skip the
  // third query entirely.
  const [logRows, receiptRows, profiles] = await Promise.all([
    (assignmentIds && assignmentIds.length > 0)
      ? chunkedInQuery(assignmentIds, chunk => {
          let q = db
            .from('fro_donor_logs')
            .select('assignment_id, accounts_status, action, disposition_detail, created_at, transaction_datetime, verified_at')
            .in('assignment_id', chunk)
            .gte('created_at', oneYearAgo);
          return q;
        })
      : Promise.resolve([]),
    (donorIds && donorIds.length > 0 && projectSet && projectSet.length > 0)
      ? chunkedInQuery(donorIds, chunk =>
          db
            .from('receipts')
            .select('donor_id, project_id, receipt_date')
            .in('donor_id', chunk)
            .in('project_id', projectSet)
        )
      : Promise.resolve([]),
    (!preTypeMap && donorIds && donorIds.length > 0)
      ? chunkedInQuery(donorIds, chunk =>
          db.from('donor_profiles').select('id, donor_type, donation_frequency').in('id', chunk)
        )
      : Promise.resolve([]),
  ]);

  const donorTypeMap = preTypeMap || {};
  if (!preTypeMap) {
    for (const p of profiles || []) donorTypeMap[p.id] = p.donor_type || p.donation_frequency || '';
  }

  const activeAssignmentIds = new Set();
  const periodDonatedAssignmentIds = new Set();
  const periodVerifiedAssignmentIds = new Set();
  const verifiedAssignmentIds = new Set();

  const sinceDate = new Date(oneYearAgo);
  const now = new Date();

  for (const l of logRows || []) {
    const isDonation = l.action === 'donation';
    const isLeadDoneVerified = l.disposition_detail === 'lead_done' && l.accounts_status === 'verified';
    if (!isDonation && !isLeadDoneVerified) continue;
    activeAssignmentIds.add(l.assignment_id);
    if (l.accounts_status === 'verified') verifiedAssignmentIds.add(l.assignment_id);
    const donorId = assignmentDonorMap.get(l.assignment_id);
    const periodStart = periodStartForType(donorTypeMap[donorId] || '', now);
    const donationDate = new Date(l.transaction_datetime || l.verified_at || l.created_at);
    if (!isNaN(donationDate) && donationDate >= periodStart) {
      periodDonatedAssignmentIds.add(l.assignment_id);
      if (l.accounts_status === 'verified') periodVerifiedAssignmentIds.add(l.assignment_id);
    }
  }

  const receiptPairs = new Set();
  const receiptRecentPairs = new Set();
  const receiptPeriodPairs = new Set();
  for (const r of receiptRows || []) {
    const key = `${r.donor_id}|${(r.project_id || '').toLowerCase()}`;
    receiptPairs.add(key);
    if (r.receipt_date) {
      const d = new Date(r.receipt_date);
      if (d >= sinceDate) receiptRecentPairs.add(key);
      if (d >= periodStartForType(donorTypeMap[r.donor_id] || '', now)) receiptPeriodPairs.add(key);
    }
  }

  return {
    activeAssignmentIds,
    periodDonatedAssignmentIds,
    periodVerifiedAssignmentIds,
    verifiedAssignmentIds,
    receiptPairs,
    receiptRecentPairs,
    receiptPeriodPairs,
  };
}

// Start of the current donation window for a donor's frequency. Defaults to the
// current calendar month for monthly/unknown donors.
//
// The window is anchored to IST, not the server's local clock. Postgres is pinned
// to Asia/Kolkata (config/db.js), so every SQL-side "current month" is already IST;
// using local getters here made the two disagree whenever the process does not run
// in IST. On a UTC host that window was wrong in BOTH directions on the 1st:
//   00:00-05:29 IST  local clock is still the previous month -> last month's
//                    collections kept counting, so donors collected in September
//                    stayed hidden from October's queue.
//   05:30 IST        local month start lands 5.5h INTO the month -> donations made
//                    in the first 5.5h did not count, so those donors reappeared in
//                    the queue as if unpaid.
const periodStartForType = (type, now = new Date()) => {
  const t = (type || '').toLowerCase();
  const p = istParts(now);
  const istMonthStart = (year, month0) => new Date(Date.UTC(year, month0, 1) - 330 * 60 * 1000);
  if (t === 'quarterly') {
    return istMonthStart(p.year, Math.floor((p.month - 1) / 3) * 3);
  }
  if (t === 'half_yearly') {
    return istMonthStart(p.year, p.month < 7 ? 0 : 6);
  }
  if (t === 'yearly') {
    return istMonthStart(p.year, 0);
  }
  if (t === 'one_time') {
    return new Date(Date.UTC(2000, 0, 1) - 330 * 60 * 1000);
  }
  return istMonthStart(p.year, p.month - 1);
};

function getMonthRange(dateStr) {
  const p = istParts(new Date(dateStr));
  const start = new Date(Date.UTC(p.year, p.month, 1) - 330 * 60 * 1000);
  const end = new Date(Date.UTC(p.year, p.month + 1, 1) - 330 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

// calculateAutoTarget / monthsSinceJoining now live in services/froAutoTarget.js
// so the FRO's own strip and the leaderboard derive a new hire's target the same
// way. They used to be defined only here, which is why the board showed 0.

const STATUS_PRIORITY = [
  'pending',
  'contacted',
  'follow_up',
  'scheduled',
  'busy', 'ringing', 'call_waiting', 'switched_off', 'out_of_coverage', 'unreachable', 'wrong_number', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail',
  'visit_donate',
  'will_donate_online',
  'promise_to_pay',
  'payment_pending',
  'already_donated',
  'email_sent', 'whatsapp_sent',
  'not_interested', 'not_interested_now', 'dnd', 'wrong_person',
  'language_barrier',
  'transferred_senior',
  'query_complaint',
  'receipt_request',
  'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'call_disconnected',
  'lead_done',
  'donation_collected',
];

export const getDashboard = async (req, res) => {
  try {
    const workerId = req.user.id;

    // This handler fans out to a dozen read-all-then-count-in-JS queries over the
    // FRO's whole assignment history, and the dashboard is refetched on every
    // visit. Serve the last payload while it is fresh instead.
    const dashKey = `fro:dash:${workerId}:${req.query.month || 'cur'}`;
    const hitDash = cacheGet(dashKey, FRO_DASHBOARD_TTL_MS);
    if (hitDash !== undefined) return res.json(hitDash);

    // Count donors by this FRO's stations (from fro_assignments)
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    let totalDonors = 0;
    let assignedByNgo = {};
    let assignedByStation = {};
    let assignedByType = {};
    if (stationNames.length > 0) {
      const { data: assignedRows } = await withStationNgoPairs(
        db
          .from('fro_assignments')
          .select('donor_id, ngo_id, station, batch_type')
          .in('station', stationNames)
          .not('status', 'eq', 'reassigned'),
        myScope
      );
      const rows = assignedRows || [];
      totalDonors = new Set(rows.map(a => a.donor_id)).size;
      for (const row of rows) {
        if (row.ngo_id) assignedByNgo[row.ngo_id] = (assignedByNgo[row.ngo_id] || 0) + 1;
        if (row.station) assignedByStation[row.station] = (assignedByStation[row.station] || 0) + 1;
        const type = row.batch_type || 'unknown';
        assignedByType[type] = (assignedByType[type] || 0) + 1;
      }
    }
    const ngoIds = Object.keys(assignedByNgo).filter(Boolean);
    const ngoMap = {};
    if (ngoIds.length > 0) {
      const { data: ngos } = await db.from('ngos').select('id, name').in('id', ngoIds);
      for (const n of ngos || []) ngoMap[n.id] = n.name;
    }
    const assignedData = {
      byNgo: Object.entries(assignedByNgo).map(([id, count]) => ({ ngo_id: id, ngo_name: ngoMap[id] || 'Unknown', count })),
      byStation: Object.entries(assignedByStation).map(([station, count]) => ({ station, count })),
      byType: Object.entries(assignedByType).map(([type, count]) => ({ type, count })),
    };

    const stats = await getDashboardStats(workerId);
    stats.total = totalDonors;
    const worker = await getWorkerBySession(req.user);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });
    const salary = await getActiveSalaryByWorker(workerId);
    const currentSalary = salary ? parseFloat(salary.salary) : 0;

    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const monthBounds = istMonthBounds(now);
    const monthStart = monthBounds.start.toISOString();
    const monthEnd = monthBounds.end.toISOString();
    const monthStr = monthBounds.month;
    const creditWorkerId = req.user.impersonation && req.user.imposter_id ? req.user.imposter_id : workerId;

    const collected = await getTotalCollectedByWorker(creditWorkerId, monthStart, monthEnd);

    const [manualTarget, priorTarget] = await Promise.all([
      getTargetByWorker(workerId, monthStr),
      getLatestTargetBeforeMonth(workerId, monthStr),
    ]);
    const resolved = resolveMonthlyTarget({
      joiningDate: worker.created_at,
      salary: currentSalary,
      currentRow: manualTarget,
      priorRow: priorTarget,
      refDate: now,
    });
    const target = resolved.target;
    const targetSource = resolved.source;
    const targetSourceMonth = resolved.sourceMonth;
    const monthsEmployed = resolved.monthsEmployed;
    const achieved_target = resolved.achievedTarget;

    const todayStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0, 0));
    const todayEnd = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 23, 59, 59, 999));

    const verifiedMonth = await getVerifiedCollection(creditWorkerId, monthStart, monthEnd);
    const unverifiedMonth = await getUnverifiedCollection(creditWorkerId, monthStart, monthEnd);
    const verifiedToday = await getVerifiedCollection(creditWorkerId, todayStart.toISOString(), todayEnd.toISOString());
    const unverifiedToday = await getUnverifiedCollection(creditWorkerId, todayStart.toISOString(), todayEnd.toISOString());

    const fyYear = istNow.getUTCMonth() < 3 ? istNow.getUTCFullYear() - 1 : istNow.getUTCFullYear();
    const fyStart = new Date(fyYear, 3, 1);

    // Active donors: those who donated within the last 1 year.
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    // The year-long active-donor scan and today's punch-in lookup are
    // independent of the 9 aggregations below, so they ride in the same
    // Promise.all instead of costing two extra sequential round-trips.
    const [
      monthlyConnectedRes, dailyConnectedRes, dailyDonationsRes, totalDonationsRes, assignmentsRes,
      leadDoneAllRes, fyDonorsRes, todayDonorsRes, monthDonorsRes, activeDonorsRes,
    ] = stationNames.length > 0
      ? await Promise.all([
          withStationNgoPairs(db.from('fro_donor_logs').select('donor_id, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).gte('created_at', monthStart).lte('created_at', monthEnd), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_donor_logs').select('donor_id, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).gte('created_at', todayStart.toISOString()).lte('created_at', todayEnd.toISOString()), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_donor_logs').select('amount_collected, action, disposition_detail, accounts_status, created_at, transaction_datetime, verified_at, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).or(COLLECTION_DATE_OR(todayStart.toISOString(), todayEnd.toISOString())), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_donor_logs').select('amount_collected, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified)').gte('created_at', fyStart.toISOString()), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_assignments').select('status, donor_id').in('station', stationNames).not('status', 'eq', 'reassigned'), myScope),
          withStationNgoPairs(db.from('fro_donor_logs').select('donor_id, created_at, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).eq('action', 'disposition').eq('disposition_detail', 'lead_done').eq('accounts_status', 'verified'), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_donor_logs').select('donor_id, created_at, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified)').gte('created_at', fyStart.toISOString()), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_donor_logs').select('donor_id, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified)').gte('created_at', todayStart.toISOString()).lte('created_at', todayEnd.toISOString()), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(db.from('fro_donor_logs').select('donor_id, fro_assignments!inner(station, ngo_id)').in('fro_assignments.station', stationNames).or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified)').gte('created_at', monthStart).lte('created_at', monthEnd), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
          withStationNgoPairs(
            db
              .from('fro_donor_logs')
              .select('donor_id, fro_assignments!inner(station, ngo_id)')
              .in('fro_assignments.station', stationNames)
              .eq('action', 'donation')
              .gte('created_at', oneYearAgo.toISOString()),
            myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'
          ),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];

    const pairOf = l => `${l.fro_assignments?.station}|${l.fro_assignments?.ngo_id}`;
    monthlyConnectedRes.data = filterByScope(monthlyConnectedRes.data, myScope, pairOf);
    dailyConnectedRes.data = filterByScope(dailyConnectedRes.data, myScope, pairOf);
    dailyDonationsRes.data = filterByScope(dailyDonationsRes.data, myScope, pairOf);
    totalDonationsRes.data = filterByScope(totalDonationsRes.data, myScope, pairOf);
    leadDoneAllRes.data = filterByScope(leadDoneAllRes.data, myScope, pairOf);
    fyDonorsRes.data = filterByScope(fyDonorsRes.data, myScope, pairOf);
    todayDonorsRes.data = filterByScope(todayDonorsRes.data, myScope, pairOf);
    monthDonorsRes.data = filterByScope(monthDonorsRes.data, myScope, pairOf);

    const connectedStatuses = new Set(['contacted', 'donation_collected', 'lead_done', 'done', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback']);
    const donorInfo = new Map();
    for (const a of assignmentsRes.data || []) {
      if (!donorInfo.has(a.donor_id)) {
        donorInfo.set(a.donor_id, { connected: false });
      }
      if (a.status !== 'reassigned' && connectedStatuses.has(a.status)) {
        donorInfo.get(a.donor_id).connected = true;
      }
    }
    let dataUsed = 0, dataUnused = 0;
    for (const [, d] of donorInfo) {
      if (d.connected) dataUsed++;
      else dataUnused++;
    }

    const monthlyDonorIds = new Set((monthlyConnectedRes.data || []).map(l => l.donor_id).filter(Boolean));
    const dailyDonorIds = new Set((dailyConnectedRes.data || []).map(l => l.donor_id).filter(Boolean));
    const todayISO = todayStart.toISOString();
    const todayEndISO = todayEnd.toISOString();
    let dailyDonations = 0;
    for (const l of dailyDonationsRes.data || []) {
      if (!inRange(logCollectionDate(l), todayISO, todayEndISO)) continue;
      dailyDonations += parseFloat(l.amount_collected || 0);
    }
    let totalDonations = 0;
    for (const l of totalDonationsRes.data || []) totalDonations += parseFloat(l.amount_collected || 0);

    // New donors: first lead_done per donor
    const earliestLeadDone = {};
    for (const log of leadDoneAllRes.data || []) {
      if (!earliestLeadDone[log.donor_id] || log.created_at < earliestLeadDone[log.donor_id]) {
        earliestLeadDone[log.donor_id] = log.created_at;
      }
    }
    const todayStr = todayStart.toISOString();
    const todayEndStr = todayEnd.toISOString();
    const newDonorsToday = Object.entries(earliestLeadDone)
      .filter(([_, date]) => date >= todayStr && date <= todayEndStr).length;
    const newDonorsMonthly = Object.entries(earliestLeadDone)
      .filter(([_, date]) => date >= monthStart && date <= monthEnd).length;

    // Reactivated: donors who donated in period but had no donation in FY before the period
    const fyBeforeTodayDonors = new Set();
    const fyBeforeMonthDonors = new Set();
    for (const log of fyDonorsRes.data || []) {
      if (log.created_at < todayStr) fyBeforeTodayDonors.add(log.donor_id);
      if (log.created_at < monthStart) fyBeforeMonthDonors.add(log.donor_id);
    }
    const todayDonorSet = new Set((todayDonorsRes.data || []).map(l => l.donor_id).filter(Boolean));
    const monthDonorSet = new Set((monthDonorsRes.data || []).map(l => l.donor_id).filter(Boolean));
    const reactivatedToday = [...todayDonorSet].filter(id => !fyBeforeTodayDonors.has(id)).length;
    const reactivatedMonthly = [...monthDonorSet].filter(id => !fyBeforeMonthDonors.has(id)).length;

    // FRO-specific reactivations: donors THIS worker reactivated (donated today/month but no prior donation in FY).
    // Own-money rule: match on the log's collector only. Cross-FRO verifications reuse
    // another FRO's assignment, so station-pair scoping used to hide them here.
    // Single FY-range query instead of 3 sequential round-trips (today, month,
    // FY): the FY window always covers today and the current month, so all
    // four sets below derive from the same rows with identical boundaries.
    let froReactivatedToday = 0, froReactivatedMonthly = 0;
    {
      const { data: froFyDonors } = await db
        .from('fro_donor_logs')
        .select('donor_id, created_at')
        .eq('fro_worker_id', workerId)
        .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified)')
        .gte('created_at', fyStart.toISOString());

      const todayStr = todayStart.toISOString();
      const todayEndStr = todayEnd.toISOString();
      const fyBeforeTodayDonorsSet = new Set();
      const fyBeforeMonthDonorsSet = new Set();
      const froTodayDonorSet = new Set();
      const froMonthDonorSet = new Set();
      for (const log of froFyDonors || []) {
        if (!log.donor_id) continue;
        if (log.created_at < todayStr) fyBeforeTodayDonorsSet.add(log.donor_id);
        if (log.created_at < monthStart) fyBeforeMonthDonorsSet.add(log.donor_id);
        if (log.created_at >= todayStr && log.created_at <= todayEndStr) froTodayDonorSet.add(log.donor_id);
        if (log.created_at >= monthStart && log.created_at <= monthEnd) froMonthDonorSet.add(log.donor_id);
      }

      froReactivatedToday = [...froTodayDonorSet].filter(id => !fyBeforeTodayDonorsSet.has(id)).length;
      froReactivatedMonthly = [...froMonthDonorSet].filter(id => !fyBeforeMonthDonorsSet.has(id)).length;
    }

    // Active donors: those who donated within the last 1 year (fetched in the
    // batch above; only the scope filter + counting happen here).
    const donorsWithRecentDonations = stationNames.length > 0
      ? filterByScope(
          activeDonorsRes.data || [],
          myScope,
          l => `${l.fro_assignments?.station}|${l.fro_assignments?.ngo_id}`
        )
      : [];

    const activeDonorIds = new Set(donorsWithRecentDonations.map(d => d.donor_id).filter(Boolean));
    let activeDonors = 0, inactiveDonors = 0;
    for (const [donorId] of donorInfo) {
      if (activeDonorIds.has(donorId)) activeDonors++;
      else inactiveDonors++;
    }

    const { data: myAtt } = await db
      .from('attendance')
      .select('status')
      .eq('worker_id', workerId)
      .eq('date', todayStart.toISOString().slice(0, 10))
      .maybeSingle();
    const is_punched_in = myAtt && (myAtt.status === 'present' || myAtt.status === 'late');

    const dashboardPayload = {
      worker: {
        is_active: worker.is_active !== false,
        is_punched_in,
      },
      target: {
        amount: target,
        source: targetSource,
        source_month: targetSourceMonth,
        collected,
        achieved: achieved_target,
        salary: currentSalary,
        months_employed: monthsEmployed,
      },
      stats,
      connected: {
        monthly: monthlyDonorIds.size,
        daily: dailyDonorIds.size,
      },
      donations: {
        daily: dailyDonations,
        total: totalDonations,
        new_donors: {
          today: newDonorsToday,
          monthly: newDonorsMonthly,
        },
      },
      reactivations: {
        today: reactivatedToday,
        monthly: reactivatedMonthly,
        fro_today: froReactivatedToday,
        fro_monthly: froReactivatedMonthly,
      },
      donors: {
        active: activeDonors,
        inactive: inactiveDonors,
      },
      verification: {
        month: {
          verified: { amount: verifiedMonth.amount, count: verifiedMonth.count },
          unverified: { amount: unverifiedMonth.amount, count: unverifiedMonth.count },
        },
        today: {
          verified: { amount: verifiedToday.amount, count: verifiedToday.count },
          unverified: { amount: unverifiedToday.amount, count: unverifiedToday.count },
        },
      },
      data: {
        used: dataUsed,
        unused: dataUnused,
      },
      assignedData,
    };
    cacheSet(dashKey, dashboardPayload);
    return res.json(dashboardPayload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// FRO-facing performance summary for the My Leads workspace. This stays scoped
// to the authenticated worker while rank is calculated against their active NGO
// team, so the admin performance endpoint is never exposed to FRO users.
export const getMyPerformance = async (req, res) => {
  try {
    // Two identities, previously conflated into one variable.
    //
    //   data  -> the painted account: queue, stations, donors, logs being worked.
    //   human -> the person at the keyboard: card figures, live row, presence.
    //
    // They are equal for an ordinary login. Under work-as they differ, and that
    // difference is the whole point: Priya working as Riya must see PRIYA's rank,
    // worked, calls, idle and performance, because Priya is the one doing the
    // work. The strip used to paint the target (req.user.id), so it showed
    // Riya's numbers to Priya — and because fro_donor_logs are already credited
    // to the operator during work-as, the calls she actually made were being
    // counted for nobody.
    const { data: dataCtx, human: humanCtx, isWorkAs, agent: agentCtx } = splitWorkerContext(req.user);
    const workerId = dataCtx.id;
    const metricsWorkerId = humanCtx.id;
    // `identityWorkerId` is the long-standing name for "who the strip counts",
    // which is now the human. Every metric below reads through it.
    const identityWorkerId = metricsWorkerId;
    const worker = await getWorkerBySession(req.user);
    const { allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const day = istNow.toISOString().slice(0, 10);
    const dayStart = new Date(`${day}T00:00:00.000+05:30`).toISOString();
    const dayEnd = new Date(`${day}T23:59:59.999+05:30`).toISOString();
    const istHour = istNow.getUTCHours();
    const elapsedHours = Math.max(0, Math.min(12, istHour < 9 ? 0 : istHour - 8));
    const targetPace = Math.round((200 * elapsedHours) / 12);
    const hours = Array.from({ length: 12 }, (_, i) => ({
      hour: `${String(9 + i).padStart(2, '0')}:00`,
      calls: 0,
      connected: 0,
    }));

    // Overall, not NGO-scoped: the strip's Calls metric counts every connected
    // call the worker logged today across all their NGOs.
    const { data: logs, error } = await db
      .from('fro_donor_logs')
      .select('created_at, fro_worker_id, disposition_detail, disposition_category, accounts_status, workers!fro_donor_logs_fro_worker_id_fkey(id, name, is_test)')
      .eq('fro_worker_id', identityWorkerId)
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd);
    if (error) throw error;

    const teamConnected = {};
    const teamLogs = {};
    // Name the HUMAN whose figures the strip paints. Under work-as that is the
    // operator, not the account on screen — getWorkerBySession() resolves the
    // target, so it is only the right name when nobody is covering.
    const currentName = (isWorkAs ? humanCtx.name : null)
      || worker?.name
      || logs?.find(l => String(l.fro_worker_id) === String(identityWorkerId))?.workers?.name
      || null;
    for (const log of logs || []) {
      if (!log.fro_worker_id || log.workers?.is_test === true) continue;
      const id = String(log.fro_worker_id);
      teamConnected[id] = (teamConnected[id] || 0);
      teamLogs[id] = (teamLogs[id] || 0) + 1;
      if (classifyLogSide(log) === 'connected') teamConnected[id]++;
      if (id !== String(identityWorkerId)) continue;
      const hour = new Date(new Date(log.created_at).getTime() + istOffset).getUTCHours();
      if (hour < 9 || hour > 20) continue;
      const bucket = hours[hour - 9];
      bucket.calls++;
      if (classifyLogSide(log) === 'connected') bucket.connected++;
    }
    if (!teamLogs[String(identityWorkerId)]) teamLogs[String(identityWorkerId)] = 0;
    if (!teamConnected[String(identityWorkerId)]) teamConnected[String(identityWorkerId)] = 0;

    // Leaderboard: one shared org-wide ranking service so the strip number is
    // always identical to the admin High/Low tables. This worker's own logged
    // metrics above stay scoped to their stations.
    const leaderboard = await buildFroLeaderboard({ startDay: day, endDay: day, todayDay: day });
    const me = leaderboard.find(p => String(p.id) === String(identityWorkerId));
    const rank = me?.rank || null;

    const todayCollection = {};
    const monthCollection = {};
    const dailyTargetMap = {};
    const pacePct = {};
    for (const p of leaderboard) {
      const id = String(p.id);
      todayCollection[id] = p.period_collection;
      monthCollection[id] = p.collection_amount;
      dailyTargetMap[id] = Math.round((p.period_target || 0) * 100) / 100;
      pacePct[id] = p.performance_pct;
    }
    const workerKey = String(identityWorkerId);
    if (!(workerKey in todayCollection)) {
      todayCollection[workerKey] = 0;
      monthCollection[workerKey] = 0;
      dailyTargetMap[workerKey] = 0;
      pacePct[workerKey] = 0;
    }

    const connected = teamConnected[String(identityWorkerId)] || 0;
    const performance = targetPace > 0 ? Math.round((connected / targetPace) * 1000) / 10 : 0;
    // The live row is filed under the HUMAN, since updateLiveStatus() writes it
    // there while a cover is active. Reading the target's row would show the
    // covered FRO's counters — or, once two people are on screen at once, the
    // row one of them last overwrote.
    const { data: liveStatus } = await db
      .from('fro_live_status')
      // idle_since and today_idle_seconds are NOT in the shared column list, and
      // this row is the input to isIdleNow() and to the legacy fallback below. With
      // them missing they simply arrive as undefined: is_idle went false and the
      // fallback idle silently lost the banked total, which is how this strip ended
      // up disagreeing with the admin board's IDLE cell for the same person at the
      // same moment. The admin board selects the same two extras for the same
      // reason.
      .select(`${FRO_IDLE_LIVE_COLS}, idle_since, today_idle_seconds`)
      .eq('worker_id', metricsWorkerId)
      .maybeSingle();

    // Worked clock: shift time actually on the clock. It runs from the CRM
    // login anchor, clamped to never start before today's shift start, and
    // never past today's shift end (an early login earns nothing; time after
    // shift end can't inflate the day). Idle is reported separately, not
    // subtracted, so the FRO still sees the full shift they were present for.
    const nowMs = Date.now();
    // Shift and login anchor belong to the HUMAN on the clock. Asking for the
    // target's shift credited an operator with the covered FRO's hours window,
    // and asking for the target's login anchor credited them with a session they
    // never opened.
    const [officeStart, officeEnd] = await Promise.all([getOfficeStart(metricsWorkerId), getOfficeEnd(metricsWorkerId)]);
    const officeStartMs = new Date(`${day}T${String(officeStart.hour).padStart(2, '0')}:${String(officeStart.minute).padStart(2, '0')}:00.000+05:30`).getTime();
    const officeEndMs = new Date(`${day}T${String(officeEnd.hour).padStart(2, '0')}:${String(officeEnd.minute).padStart(2, '0')}:00.000+05:30`).getTime();
    let loginAnchorMs = officeStartMs;
    try {
      const { rows } = await db._pool.query(
        `SELECT logged_in_at FROM auth_sessions WHERE user_id = $1`,
        [String(metricsWorkerId)]
      );
      const lgMs = rows?.[0]?.logged_in_at ? new Date(rows[0].logged_in_at).getTime() : NaN;
      if (Number.isFinite(lgMs)) loginAnchorMs = Math.max(officeStartMs, Math.min(nowMs, lgMs));
    } catch (_) {
      // auth_sessions may be absent until migration 125 — fall back to shift start.
    }
    const workedEndMs = Math.min(nowMs, officeEndMs);
    // No coveredByOther suppression here any more, and none is needed: the row
    // being read is this human's own row, so any time on it is genuinely theirs.
    // That guard existed to stop an absent covered FRO banking the operator's
    // shift. Filing the row on the human removes the situation instead of
    // filtering its symptoms — and keeping the filter would now zero a real
    // figure whenever the retired work_as_operator_id column held a stale id.
    const workedSeconds = Math.max(0, Math.round((workedEndMs - loginAnchorMs) / 1000));
    const workedTarget = 8 * 3600;

    // Idle: committed + any period still running, clamped to their shift — the
    // same effectiveIdleSeconds() the NGO-admin telecaller table uses, so the two
    // surfaces cannot show different numbers for the same person at the same
    // moment. read as the human's own row, so a cover cannot be charged to the
    // person being covered.
    const idleShift = await getShiftWindowMs(metricsWorkerId, nowMs);
    if (liveStatus && !liveStatus.idle_since
      && !liveStatus.is_paused && liveStatus.status !== 'meeting') {
      const dueNow = dispositionDueMs(liveStatus);
      if (Number.isFinite(dueNow) && nowMs >= dueNow
        && istDateStr(new Date(dueNow)) === istDateStr(new Date(nowMs))
        && withinShift(idleShift, nowMs)) {
        if (await stampLapsedIdle(metricsWorkerId, nowMs)) {
          liveStatus.idle_since = liveStatus.disposition_due_at;
          liveStatus.status = 'idle';
        }
      }
    }
    let idleSeconds = effectiveIdleSeconds(liveStatus || {}, idleShift, nowMs);
    try {
      const ts = await computeTimeStatus({ workerId: metricsWorkerId, liveRow: liveStatus || {}, shift: idleShift, nowMs, agentId: agentCtx?.id ?? null });
      if (ts.hasLedger) idleSeconds = ts.totals.idle_seconds;
    } catch (ledgerErr) {
      // Must stay loud. A silent fallback here once shipped a version where every
      // FRO's idle read 0 on their own strip while the admin board showed the
      // truth — the strip and the board were reading the same thing and only one
      // of them was allowed to fail quietly.
      console.error('performance strip ledger idle read failed:', ledgerErr.message);
    }

    return res.json({
      // Whose figures these are: the person at the keyboard. Identical to
      // `data` for an ordinary login.
      worker: { id: humanCtx.id, name: currentName },
      // The account being worked (queue, donors, stations). Exposed so the UI can
      // say so if it ever needs to; deliberately NOT what the card paints.
      painted_account: { id: dataCtx.id, name: dataCtx.name || currentName },
      is_work_as: isWorkAs,
      connected,
      target_pace: targetPace,
      elapsed_hours: elapsedHours,
      performance,
      level: performance >= 100 ? 'high' : 'low',
      rank: rank || null,
      team_size: leaderboard.length,
      calls: hours,
      worked_seconds: workedSeconds,
      worked_target_seconds: workedTarget,
      worked_remaining: Math.max(0, workedTarget - workedSeconds),
      worked_pct: workedTarget > 0 ? Math.min(100, Math.round((workedSeconds / workedTarget) * 1000) / 10) : 0,
      today_calls: connected,
      idle_seconds: idleSeconds,
      idle_minutes: Math.floor(idleSeconds / 60),
      // TEMPORARY diagnostic echo.
      //
      // Idle is derived from four stored values and a shift window, and when the
      // strip and the panel timer disagree there is no way to tell from the number
      // alone WHICH input was wrong. A missing column is the usual culprit: it does
      // not error, it just arrives as undefined and quietly zeroes the figure. This
      // echoes the raw inputs so one network-tab glance settles it instead of a
      // round of guessing. Deliberately carries no name or identifying detail —
      // only the worker's own row. Remove once the idle discrepancy is closed.
      debug_idle: {
        banked: liveStatus ? Number(liveStatus.today_idle_seconds || 0) : 0,
        running_since: liveStatus?.idle_since || null,
        deadline_at: liveStatus?.disposition_due_at || null,
        counters_day: liveStatus?.stats_date || null,
        last_written_at: liveStatus?.updated_at || null,
        frozen_at: liveStatus?.frozen_at || null,
        is_paused: !!liveStatus?.is_paused,
        status: liveStatus?.status || null,
        shift_start: idleShift?.startMs ? new Date(idleShift.startMs).toISOString() : null,
        shift_end: idleShift?.endMs ? new Date(idleShift.endMs).toISOString() : null,
        has_attendance: !!idleShift?.hasAttendance,
        derived_total: idleSeconds,
        server_now: new Date(nowMs).toISOString(),
      },
      // A lapsed deadline counts as idle even before the next heartbeat has
      // stamped idle_since, so the badge and the number can never disagree.
      // Same helper the panel hydrates with, so the badge and the overlay agree.
      is_idle: isIdleNow(liveStatus, idleShift, nowMs),
      today_collected: todayCollection[String(identityWorkerId)] || 0,
      monthly_collected: monthCollection[String(identityWorkerId)] || 0,
      daily_target: dailyTargetMap[String(identityWorkerId)] || 0,
      today_pct: Math.round(pacePct[String(identityWorkerId)] * 10) / 10,
      date: day,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Team-wise collection board for the FRO's Collection Race popup - the SAME board
// the NGO-admin dashboard header shows, lanes and all (UFS1..UFS5), so an FRO can
// see which team is ahead and how their own team is doing.
//
// Built by services/teamCollectionService.js, which the admin endpoint calls too.
// That shared service is the point: one query behind two screens, so the popup and
// the admin card can never quote different totals for the same day.
//
// Scope is org-wide rather than the caller's NGO list. An FRO has no NGO access
// list to narrow by (getMyStationScope is station-scoped, not NGO-granted), and the
// existing org-wide FRO leaderboards - the lead-incentive one and this panel's own
// My-Leads rank strip - set that precedent. If per-team figures ever need to be
// NGO-restricted, that is a change in one place: pass ngoIds here.
//
// No per-FRO and per-NGO filter is accepted: the popup shows the board as it stands,
// not a filtered slice of it. `period` selects the window (today / this week / month
// to date) and is resolved server-side so the IST day boundaries cannot be shifted by
// a client in another timezone.
export const getMyTeamsCollection = async (req, res) => {
  try {
    const rawPeriod = String(req.query.period || '').trim().toLowerCase();
    const period = PERIODS.includes(rawPeriod) ? rawPeriod : 'today';

    // Work-as: the highlight is the team of the HUMAN at the keyboard, the same
    // choice getDashboard makes - an operator driving someone else's account must be
    // shown where THEY stand, not where the impersonated owner stands.
    const { human } = splitWorkerContext(req.user);
    const youTeam = await getWorkerTeamKey(human?.id);
    const board = await buildTeamCollection({ ...resolvePeriodRange(period), youTeam });

    return res.json({ period, period_label: PERIOD_LABELS[period], ...board });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

// List this month's collections for the "Collected" card modal.
// Own-money rule: every fro_donor_logs row credited to this worker (fro_worker_id)
// is THEIR collection, regardless of which (station, ngo) assignment the donor sits
// in — cross-FRO manual verifies, work-as and receipt auto-credits reuse another
// FRO's assignment, so filtering by the assignment pair used to hide them here.
// Rows whose assignment belongs to another FRO, or whose NGO is outside this
// worker's access, are grouped under the "Others" tab; the rest keep their real
// NGO tab. For work-as rows the owning FRO's identity is masked so the operator
// cannot tell which FRO the donor belonged to.
// Supports optional ?ngo_id= query param to return only that tab's rows.
export const getMyCollections = async (req, res) => {
  try {
    const workerId = req.user.id;
    const worker = await getWorkerBySession(req.user);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });
    const { scope: myScope, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    const ngoFilter = (req.query.ngo_id && allowedNgoIds.includes(req.query.ngo_id)) ? req.query.ngo_id : null;

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    let monthStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
    const lastDay = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth() + 1, 0)).getUTCDate();
    let monthEnd = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), lastDay, 23, 59, 59, 999)).toISOString();

    const creditWorkerName = req.user.impersonation && req.user.imposter_name ? String(req.user.imposter_name).trim() : (worker.name || '').trim();
    const workerName = creditWorkerName;
    // Under work-as the rows belong to the FRO being stood in for, so the total
    // has to resolve against that worker's receipts, not the session holder's.
    // getDashboard and getMyTarget both pick creditWorkerId this way.
    const creditWorkerId = req.user.impersonation && req.user.imposter_id ? req.user.imposter_id : workerId;

    const monthParam = String(req.query.month || '').trim();
    if (monthParam && monthParam !== 'current') {
      let y;
      let m;
      if (monthParam === 'prev' || monthParam === 'last' || monthParam === 'previous') {
        const d = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), 1));
        d.setUTCMonth(d.getUTCMonth() - 1);
        y = d.getUTCFullYear();
        m = d.getUTCMonth();
      } else {
        const mt = /^(\d{4})-(\d{2})$/.exec(monthParam);
        if (!mt) return res.status(400).json({ message: 'Invalid month. Use YYYY-MM, "current", or "prev".' });
        y = Number(mt[1]);
        m = Number(mt[2]) - 1;
      }
      if (!(y >= 2000 && y <= 2100 && m >= 0 && m <= 11)) {
        return res.status(400).json({ message: 'Invalid month' });
      }
      const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const end = new Date(Date.UTC(y, m, lastDay, 23, 59, 59, 999));
      monthStart = start.toISOString();
      monthEnd = end.toISOString();
    }

    // The same rows the Collected card totals, from the same loader, so the
    // number on the card is by construction the sum of the rows listed here.
    // This used to run its own receipts query with a different name match and no
    // verified-in-month union, so the two disagreed: backdated-but-verified
    // receipts appeared in the total but not in the list, and a printed name
    // needing a trim or a case fold matched one and not the other.
    const receipts = await getWorkerCollectionReceipts(creditWorkerId, monthStart, monthEnd);

    const { data: allNgos } = await db.from('ngos').select('id, name');
    const normProj = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const projToNgo = new Map();
    for (const [canon, aliases] of Object.entries(NGO_PROJECT_ALIASES)) {
      const ngoRow = (allNgos || []).find((n) => {
        const nn = normProj(n.name);
        return nn === canon || nn.includes(canon) || aliases.some((a) => normProj(a) === nn);
      });
      if (!ngoRow) continue;
      projToNgo.set(normProj(canon), ngoRow);
      for (const a of aliases) projToNgo.set(normProj(a), ngoRow);
    }
    for (const n of allNgos || []) {
      const k = normProj(n.name);
      if (k && !projToNgo.has(k)) projToNgo.set(k, n);
    }

    const ngoMap = {};
    for (const s of myScope) {
      if (s.ngo_id && !ngoMap[s.ngo_id]) ngoMap[s.ngo_id] = null;
    }
    const ngoIds = Object.keys(ngoMap);
    if (ngoIds.length > 0) {
      const { data: ngoRows } = await db.from('ngos').select('id, name').in('id', ngoIds);
      for (const n of ngoRows || []) ngoMap[n.id] = n.name;
    }

    // No dedup here on purpose: getWorkerCollectionReceipts already applied the
    // one shared rule. Re-applying the old composite key here would drop rows the
    // card counts, re-opening the very gap this was meant to close.
    const collections = [];
    for (const r of receipts || []) {
      const amount = parseFloat(r.amount || 0);
      if (amount <= 0) continue;

      let tabNgoId = null;
      let tabNgoName = null;
      if (r.project_id) {
        const ngoRow = projToNgo.get(normProj(r.project_id)) || null;
        if (ngoRow) { tabNgoId = ngoRow.id; tabNgoName = ngoRow.name; }
      }
      if (!tabNgoId) {
        tabNgoId = allowedNgoIds[0] || allNgos[0]?.id || null;
        tabNgoName = allNgos?.find((n) => n.id === tabNgoId)?.name || null;
      }
      if (tabNgoId && !Object.prototype.hasOwnProperty.call(ngoMap, tabNgoId)) ngoMap[tabNgoId] = tabNgoName;
      if (ngoFilter && tabNgoId !== ngoFilter) continue;

      collections.push({
        id: r.id,
        donor_id: r.donor_id,
        donor_name: r.donor_name || 'Unknown',
        donor_mobile: r.donor_mobile || '',
        amount_collected: amount,
        collected_at: r.receipt_date || null,
        ngo_id: tabNgoId,
        ngo_name: tabNgoName,
        receipt_no: r.receipt_no != null ? String(r.receipt_no) : null,
        owner_worker_id: workerId,
        owner_name: workerName,
        is_work_as: false,
      });
    }

    collections.sort((a, b) => new Date(b.collected_at || 0) - new Date(a.collected_at || 0));

    const ngos = Object.entries(ngoMap).map(([id, name]) => ({ id, name: name || 'Unknown' }));

    return res.json({
      month: monthStart.slice(0, 7),
      collections,
      ngos,
      ngoMap,
      // The sum of exactly the rows above, before the ngo_id filter is applied.
      // With no filter this is the same number the Collected card shows; with
      // one it is the whole-month total, so the modal can label the filtered
      // subtotal without re-deriving it.
      total: (receipts || []).reduce((sum, r) => sum + parseFloat(r.amount || 0), 0),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Suspense receipts (this month only) + claims ────────────
// IST current-month bounds shared by the suspense endpoints.
//
// This used to build monthStart as an instant and then read the month back out
// of it with toISOString().slice(). monthStart is midnight IST on the 1st, which
// as an instant is 18:30 UTC on the LAST day of the previous month, so that slice
// returned the PREVIOUS month on every day of the month, not just near the
// boundary - suspense receipts were being read a month behind throughout.
// istMonthBounds derives every value from the IST calendar directly.
function currentMonthBoundsIST() {
  const b = istMonthBounds();
  return { month: b.monthKey, monthStart: b.startDay, monthEnd: b.endDay };
}

// Every project_id value a receipt can legitimately carry for an NGO. Mirrors
// the keyword classification the accounts bank-audit page uses (matchesNgo), so
// a FRO assigned to 'MANN' also sees receipts whose project_id is spelled as
// 'manncar' or 'mann care' alongside the canonical 'mann' series.
const NGO_PROJECT_ALIASES = {
  bsct: ['bsct', 'beingsevak', 'being sevak', 'sevak'],
  mann: ['mann', 'manncar', 'mann care'],
  aflf: ['aflf', 'ashray'],
};

async function myProjectSet(workerId, restrictPairs = null) {
  const { allowedNgoIds } = await getMyStationScope(workerId, restrictPairs);
  if (allowedNgoIds.length === 0) return [];
  const { data: ngos } = await db.from('ngos').select('id, name').in('id', allowedNgoIds);
  const names = (ngos || []).map(n => n.name.toLowerCase()).filter(Boolean);
  const aliases = new Set();
  for (const n of names) {
    aliases.add(n);
    const byKey = NGO_PROJECT_ALIASES[n];
    if (byKey) byKey.forEach(a => aliases.add(a));
  }
  return [...aliases];
}

export const getSuspenseReceipts = async (req, res) => {
  try {
    const workerId = req.user.id;
    // Suspense is a shared pool: every FRO sees their assigned NGO AND all
    // other NGOs' unclaimed receipts here (NGO pills on the frontend filter).
    const { month } = currentMonthBoundsIST();

    const { data: entries, error: eErr } = await db
      .from('bank_audit_entries')
      .select('id, receipt_id, receipt_no, payer_name, amount, transaction_date, payment_time, project_id, payment_id, check_id, source_id, agent_name, verify_fro_worker_id')
      .eq('status', 'unverified')
      .is('matched_lead_log_id', null);
    if (eErr) throw eErr;

    const receiptLinked = (entries || []).filter(e => e.receipt_id);
    const receiptIds = [...new Set(receiptLinked.map(e => e.receipt_id))];
    let receiptMap = {};
    if (receiptIds.length > 0) {
      const { data: receipts } = await db
        .from('receipts')
          .select('id, log_id, donor_name, donor_mobile, amount, receipt_date, receipt_time, project_id')
        .in('id', receiptIds);
      for (const r of (receipts || [])) receiptMap[r.id] = r;
    }

    const pool = receiptLinked.map(e => {
      const r = receiptMap[e.receipt_id] || {};
      // Receipt already linked to a lead (credited to an FRO) — skip.
      if (r.log_id) return null;
      return {
        id: e.receipt_id,
        entry_id: e.id,
        receipt_no: e.receipt_no || r.receipt_no || null,
        donor_name: e.payer_name || r.donor_name || null,
        donor_mobile: r.donor_mobile || null,
        amount: r.amount || e.amount,
        receipt_date: r.receipt_date || e.transaction_date,
        receipt_time: r.receipt_time || e.payment_time,
        project_id: r.project_id || e.project_id,
        payment_id: e.payment_id || null,
        has_receipt: true,
        // Only an explicit Accounts assignment (manual-verify save) parks an
        // entry as "waiting for receipt number". A missing receipt number alone
        // must NOT block claiming: rejected/unlinked receipts and bank-statement
        // imports create numberless suspense receipts, and numbers are allocated
        // automatically at claim/verify time.
        waiting_receipt_no: !!e.verify_fro_worker_id,
      };
    }).filter(Boolean);

    for (const e of entries || []) {
      if (e.receipt_id) continue;
      pool.push({
        id: `entry-${e.id}`,
        entry_id: e.id,
        receipt_no: e.receipt_no || null,
        donor_name: e.payer_name || null,
        donor_mobile: null,
        amount: e.amount,
        receipt_date: e.transaction_date,
        receipt_time: e.payment_time,
        project_id: e.project_id,
        payment_id: e.payment_id || null,
        has_receipt: false,
        waiting_receipt_no: !!e.verify_fro_worker_id,
      });
    }

    const poolIds = pool.filter(r => r.has_receipt).map(r => r.id);
    let claims = [];
    if (poolIds.length > 0) {
      const { data: c, error: cErr } = await db
        .from('receipt_claims')
        .select('receipt_id, fro_worker_id, status')
        .in('receipt_id', poolIds);
      if (cErr) throw cErr;
      claims = c || [];
    }

    const claimCountByReceipt = {};
    const myClaimStatusByReceipt = {};
    for (const cl of claims) {
      claimCountByReceipt[cl.receipt_id] = (claimCountByReceipt[cl.receipt_id] || 0) + 1;
      if (cl.fro_worker_id === workerId && !myClaimStatusByReceipt[cl.receipt_id]) {
        myClaimStatusByReceipt[cl.receipt_id] = cl.status;
      }
    }

    const result = pool.map(r => ({
      id: r.id,
      receipt_no: r.receipt_no,
      donor_name: r.donor_name,
      donor_mobile: r.donor_mobile,
      amount: parseFloat(r.amount || 0),
      receipt_date: r.receipt_date,
      receipt_time: r.receipt_time,
      project_id: r.project_id,
      payment_id: r.payment_id || null,
      kind: r.has_receipt ? 'entry' : 'no_receipt',
      waiting_receipt_no: r.waiting_receipt_no || false,
      _bank_audit_entry_id: r.entry_id,
      claim_count: claimCountByReceipt[r.id] || 0,
      my_claim_status: myClaimStatusByReceipt[r.id] || null,
    }));

    return res.json({ month, receipts: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Search the FRO's own receipt history (any linked or past receipts in their
// project scope) by donor name/mobile so the suspense claim modal can auto-fill
// donor details even when the donor has no profile inside the FRO's station
// scope. donor_id is intentionally left null: these rows are a fallback for
// donors the normal in-scope search misses, and passing a linked id would hit
// the "allotted donors only" guard on claim; the claim then resolves/creates
// the profile through the normal name-based path.
export const searchSuspenseDonors = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const projectSet = await myProjectSet(workerId, froActPairs(req));
    if (projectSet.length === 0) return res.json([]);

    const term = `%${q.trim()}%`;
    const { data: receipts, error } = await db
      .from('receipts')
      .select('id, donor_id, donor_name, donor_mobile, pan_number, address, email, project_id, receipt_date')
      .in('project_id', projectSet)
      .or(`donor_mobile.ilike.${term},donor_name.ilike.${term}`)
      .order('receipt_date', { ascending: false })
      .limit(25);
    if (error) throw error;
    if (!receipts || receipts.length === 0) return res.json([]);

    // Resolve city from linked donor profiles for a richer auto-fill.
    const linkedIds = [...new Set(receipts.map(r => r.donor_id).filter(Boolean))];
    const cityById = {};
    if (linkedIds.length > 0) {
      const { data: profiles } = await db
        .from('donor_profiles')
        .select('id, city')
        .in('id', linkedIds);
      for (const p of (profiles || [])) cityById[p.id] = p.city;
    }

    const seen = new Set();
    const result = [];
    for (const r of receipts) {
      const mobile = (r.donor_mobile || '').replace(/\D/g, '');
      const key = r.donor_id ? `id:${r.donor_id}` : `mob:${mobile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        donor_id: null,
        donor_name: r.donor_name || '',
        donor_mobile: r.donor_mobile || '',
        donor_city: cityById[r.donor_id] || '',
        donor_address: r.address || '',
        donor_pan: r.pan_number || '',
        donor_email: r.email || '',
        project_id: r.project_id || '',
        source: 'receipt',
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Best-effort: when an FRO claims a suspense receipt, write the donor details
// they provided (prefilled from their donor pick, editable) onto the linked
// bank_audit_entries row so the Accounts Bank Audit card shows them right after
// the claim, before Accounts verifies. Never blocks the claim if the entry
// lookup/write fails.
const linkClaimDonorToAuditEntry = async (receiptId, donorId, details) => {
  if (!receiptId || !donorId) return;
  const fill = {};
  const mobile = (details?.donor_mobile || '').trim();
  const email = (details?.donor_email || '').trim();
  const pan = (details?.donor_pan || '').trim();
  const city = (details?.donor_city || '').trim();
  const address = (details?.donor_address || '').trim();
  if (mobile) fill.donor_mobile = mobile;
  if (email) fill.donor_email = email;
  if (pan) fill.donor_pan = pan;
  if (city) fill.donor_city = city;
  if (address) fill.donor_address_1 = address;
  if (Object.keys(fill).length === 0) return;
  fill.donor_id = donorId;
  try {
    const { data: entries } = await db
      .from('bank_audit_entries')
      .select('id')
      .eq('receipt_id', receiptId);
    for (const entry of (entries || [])) {
      await db.from('bank_audit_entries').update(fill).eq('id', entry.id);
    }
  } catch (e) {
    console.error('Link claim donor to audit entry failed:', e.message);
  }
};

// Find the bank audit entry that represents the same money as a claimed
// suspense receipt (matched by payment id, falling back to receipt_id). The
// entry — not the FRO's claim input or the receipt's own fields — is the
// source of truth for the money's UPI id and transaction date, so its values
// drive the pending lead created by the claim.
const findClaimAuditEntry = async (receipt, claimUpiId = '') => {
  if (!receipt?.id) return null;
  const paymentId = String(receipt.payment_id || '').trim();
  const typedUpi = String(claimUpiId || '').trim();
  try {
    if (paymentId || typedUpi) {
      const key = paymentId || typedUpi;
      const { rows } = await db._pool.query(
        `SELECT * FROM bank_audit_entries
         WHERE upper(trim(coalesce(payment_id, ''))) = upper($1)
         ORDER BY (status = 'verified') ASC, (matched_lead_log_id IS NOT NULL) ASC, id ASC
         LIMIT 1`,
        [key]
      );
      if (rows?.[0]) return rows[0];
    }
    const { data } = await db
      .from('bank_audit_entries')
      .select('*')
      .eq('receipt_id', receipt.id)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch (e) {
    console.error('Suspense claim audit entry lookup failed:', e.message);
    return null;
  }
};

// Link the claimed money's audit entry to the pending lead so the audit shows
// the money once (with the claim pill) instead of a separate unlinked entry.
// Never relinks an entry that is already verified or matched to a different
// lead; never blocks the claim if the link fails.
const linkClaimAuditEntry = async (entry, receiptId, logId, workerId, donorId, workerName) => {
  if (!entry?.id) return;
  if (entry.status === 'verified') return;

  const alreadyLinkedToDifferentLog = entry.matched_lead_log_id != null && String(entry.matched_lead_log_id) !== String(logId);

  const patch = {
    updated_at: new Date().toISOString(),
    agent_name: workerName || null,
  };

  if (!alreadyLinkedToDifferentLog) {
    patch.receipt_id = receiptId;
    patch.matched_lead_log_id = logId;
    patch.match_status = 'matched';
    patch.match_source = 'manual';
    patch.matched_by = workerId;
    patch.matched_at = new Date().toISOString();
    patch.donor_id = donorId || entry.donor_id || null;
    if (!entry.match_no) {
      try {
        const { rows } = await db._pool.query("SELECT nextval('bank_audit_match_no_seq') AS n");
        patch.match_no = 'MTCH-' + String(rows[0].n).padStart(6, '0');
      } catch (e) { console.error('Match no allocation failed:', e.message); }
    }
  }

  try {
    await db.from('bank_audit_entries').update(patch).eq('id', entry.id);
  } catch (e) {
    console.error('Suspense claim audit entry link failed:', e.message);
  }
};

export const claimSuspenseReceipt = async (req, res) => {
  try {
    const workerId = req.user.id;
    // When working-as another FRO, the collection credit goes to the operator
    // (imposter) while donor/assignment ownership stays with the impersonated FRO.
    const creditWorkerId = req.user.impersonation && req.user.imposter_id != null ? req.user.imposter_id : workerId;
    const creditWorkerName = req.user.impersonation && req.user.imposter_name ? req.user.imposter_name : req.user.name;
    const rawId = (req.params.receiptId || '').trim();
    const { donor_id, donor_name, donor_mobile, donor_city, donor_email, donor_pan, donor_address, upi_transaction_id, transaction_datetime, notes, screenshot_url } = req.body || {};
    let donorId = donor_id ? parseInt(donor_id, 10) : null;
    const explicitDonor = donorId !== null;
    let donorName = (donor_name || '').trim();
    if (!donorId && !donorName) return res.status(400).json({ message: 'Select a donor to claim this receipt' });

    const projectSet = await myProjectSet(workerId, froActPairs(req));

    // Handle entry-XXX IDs (bank audit entries without a linked receipt):
    // auto-create a suspense receipt and link it, then continue the normal
    // claim flow so the FRO can claim raw bank-audit rows.
    // If THIS request authors a brand-new suspense receipt but the claim fails
    // later, track it so the failure path can roll it back and keep the entry
    // fully claimable (not stuck as "Waiting for receipt number").
    let createdReceiptId = null;
    let rollbackEntryId = null;
    let receiptId = parseInt(rawId, 10);
    if (!receiptId && rawId.startsWith('entry-')) {
      const entryId = parseInt(rawId.slice(6), 10);
      if (!entryId) return res.status(400).json({ message: 'Invalid entry ID' });
      const { data: entry, error: eErr } = await db
        .from('bank_audit_entries')
        .select('id, amount, transaction_date, payment_time, project_id, payer_name, receipt_no, receipt_id')
        .eq('id', entryId)
        .single();
      if (eErr || !entry) return res.status(404).json({ message: 'Bank audit entry not found' });
      if (entry.receipt_id) {
        // Already linked — just continue with that receipt
        receiptId = entry.receipt_id;
      } else {
        // Create a minimal suspense receipt from the entry data
        const receiptDate = entry.transaction_date || new Date().toISOString().slice(0, 10);
        const { data: newReceipt, error: crErr } = await db
          .from('receipts')
          .insert({
            project_id: entry.project_id || 'bsct',
            amount: entry.amount || 0,
            receipt_date: receiptDate,
            receipt_time: entry.payment_time || null,
            donor_name: entry.payer_name || donorName || null,
            payment_id: entry.payment_id || null,
            agent_name: creditWorkerName || null,
          })
          .select('id, donor_id, log_id, project_id, receipt_date, receipt_time, amount, donor_name, donor_mobile, payment_id, mode, pan_number, address, email, bank_payer_name')
          .single();
        if (crErr || !newReceipt) return res.status(500).json({ message: 'Failed to create receipt from bank entry: ' + (crErr?.message || 'unknown') });
        createdReceiptId = newReceipt.id;
        rollbackEntryId = entryId;
        // Link the entry to the new receipt
        try {
          await db.from('bank_audit_entries').update({ receipt_id: newReceipt.id, receipt_no: entry.receipt_no || null }).eq('id', entryId);
        } catch (e) { console.error('Failed to link bank entry to new receipt:', e.message); }
        receiptId = newReceipt.id;
      }
    }
    if (!receiptId) return res.status(400).json({ message: 'Receipt ID is required' });

    const { data: receipt, error: rErr } = await db
      .from('receipts')
      .select('id, donor_id, log_id, project_id, receipt_date, receipt_time, amount, donor_name, donor_mobile, payment_id, mode, pan_number, address, email, bank_payer_name')
      .eq('id', receiptId)
      .single();
    if (rErr || !receipt) return res.status(404).json({ message: 'Receipt not found' });

    // Detect "receipt_sent" entries: receipt has a donor but no log (no FRO assigned).
    const isReceiptSent = receipt.donor_id != null && receipt.log_id == null;
    if (!isReceiptSent) {
      if (receipt.donor_id) return res.status(409).json({ message: 'This receipt is already linked to a donor' });
      if (receipt.log_id) return res.status(409).json({ message: 'This receipt has already been claimed' });
    }

    // For receipt_sent entries, pre-fill the donor from the receipt so the FRO
    // sees the existing donor but can override if the bank name was wrong.
    if (isReceiptSent && !donorId) {
      donorId = receipt.donor_id;
      donorName = receipt.donor_name || donorName;
    }

    // FROs may claim any suspense receipt whenever they want (no current-month
    // restriction): the pool lists unverified entries from any month, so the
    // claim must accept them too.

    // Best-effort real-donor resolution: when the FRO supplies a UPI
    // transaction id, match it against collected leads (preferring this FRO's
    // own) so the claim links to the canonical donor profile even when the
    // bank spells the payer's name differently. No match is fine — the claim
    // falls through to the normal pick/create below.
    const claimUpiId = (upi_transaction_id || '').trim();
    if (claimUpiId) {
      let upiLogs = [];
      try {
        const { rows } = await db._pool.query(
          `SELECT id, donor_id, fro_worker_id, transaction_datetime
           FROM fro_donor_logs
           WHERE upper(trim(upi_transaction_id)) = upper(trim($1))
             AND donor_id IS NOT NULL
           ORDER BY (fro_worker_id = $2) DESC, created_at DESC`,
          [claimUpiId, workerId]
        );
        upiLogs = rows || [];
      } catch (e) {
        console.error('Suspense claim UPI donor lookup failed:', e.message);
      }
      if (upiLogs.length > 0) {
        let matchLog = upiLogs[0];
        if (transaction_datetime) {
          const claimDate = new Date(transaction_datetime).toDateString();
          const sameDay = upiLogs.find(l =>
            l.transaction_datetime && new Date(l.transaction_datetime).toDateString() === claimDate
          );
          if (sameDay) matchLog = sameDay;
        }
        const { data: upiDonor } = await db
          .from('donor_profiles')
          .select('id, name')
          .eq('id', matchLog.donor_id)
          .maybeSingle();
        if (upiDonor) {
          donorId = upiDonor.id;
          donorName = upiDonor.name;
        }
      }
    }

    // Resolve the donor: prefer an explicit donor_id (selected from the FRO's
    // own donor search); otherwise resolve by name (create a profile if none
    // matches) so the claimed receipt and its pending lead can be linked.
    if (donorId) {
      const { data: found, error: dErr } = await db
        .from('donor_profiles')
        .select('id, name')
        .eq('id', donorId)
        .single();
      if (dErr || !found) throw Object.assign(new Error('Donor not found'), { status: 404 });
      donorName = found.name;
      // Update the existing donor profile with any edits the FRO made in the
      // claim form so Lead Verification shows the latest data.
      const donorUpdate = {};
      if (donor_name) donorUpdate.name = donor_name;
      if (donor_mobile) donorUpdate.mobile_number = donor_mobile;
      if (donor_city) donorUpdate.city = donor_city;
      if (donor_email) donorUpdate.email = donor_email;
      if (donor_pan) donorUpdate.pan_number = donor_pan;
      if (donor_address) donorUpdate.address_1 = donor_address;
      if (Object.keys(donorUpdate).length > 0) {
        donorUpdate.updated_at = new Date().toISOString();
        await db.from('donor_profiles').update(donorUpdate).eq('id', donorId);
      }
    } else {
      const { data: existingDonor } = await db
        .from('donor_profiles')
        .select('id')
        .ilike('name', donorName)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingDonor) {
        donorId = existingDonor.id;
      } else if (donor_mobile) {
        const { data: mobDonor } = await db
          .from('donor_profiles')
          .select('id')
          .eq('mobile_number', donor_mobile)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (mobDonor) {
          donorId = mobDonor.id;
        } else {
          const { data: createdDonor, error: donorErr } = await db
            .from('donor_profiles')
            .insert({
              name: donorName,
              mobile_number: donor_mobile || `NOCELL-${Date.now()}`,
              city: donor_city || null,
              email: donor_email || null,
              pan_number: donor_pan || null,
              address_1: donor_address || null,
              project_supported: receipt.project_id,
            })
            .select()
            .single();
          if (donorErr) throw donorErr;
          donorId = createdDonor.id;
        }
      } else {
        const { data: createdDonor, error: donorErr } = await db
          .from('donor_profiles')
          .insert({
            name: donorName,
            mobile_number: `NOCELL-${Date.now()}-${workerId}`,
            city: donor_city || null,
            email: donor_email || null,
            pan_number: donor_pan || null,
            address_1: donor_address || null,
            project_supported: receipt.project_id,
          })
          .select()
          .single();
        if (donorErr) throw donorErr;
        donorId = createdDonor.id;
      }
    }

    const { data: resolvedDonor } = await db
      .from('donor_profiles')
      .select('name')
      .eq('id', donorId)
      .maybeSingle();
    const claimedDonorName = resolvedDonor?.name || donorName || 'a donor';

    // Pull the receipt's real money data onto the lead so the pending lead in
    // Lead Verification is already filled: UPI txn id, MOP, sender, PAN. The
    // FRO's explicit claim input always wins; the receipt fills the rest.
    const effectiveUpi = ((upi_transaction_id || '').trim()) || receipt.payment_id || null;
    const effectiveMode = (receipt.mode || '').trim() || null;
    const effectiveFrom = (receipt.bank_payer_name || receipt.donor_name || '').trim() || null;
    const effectivePan = (receipt.pan_number || '').trim() || null;

    try { await enrichDonorProfileFromReceipt(donorId, receipt); }
    catch (e) { console.error('Failed to enrich donor profile from suspense receipt:', e.message); }

    // Only allow claiming for a donor allotted to this FRO's station scope
    // (enforced for donors selected from the FRO's own donor search).
    if (explicitDonor) {
      const { scope: myScope, stationNames } = await getMyStationScope(workerId, froActPairs(req));
      if (stationNames.length > 0) {
        const scopePairs = new Set((myScope || []).filter(s => s.ngo_id && s.station).map(s => `${s.station}|${s.ngo_id}`));
        const { data: donorAssignments } = await db
          .from('fro_assignments')
          .select('id, station, ngo_id')
          .eq('donor_id', donorId)
          .not('status', 'eq', 'reassigned');
        const hasScoped = (donorAssignments || []).some(a => scopePairs.has(`${a.station}|${a.ngo_id}`));
        if (!hasScoped) throw Object.assign(new Error('You can only claim receipts for your allotted donors'), { status: 403 });
      }
    }

    const txDateTime = transaction_datetime
      ? new Date(transaction_datetime).toISOString()
      : (receipt.receipt_date
          ? (receipt.receipt_time
              ? new Date(`${receipt.receipt_date}T${receipt.receipt_time}`).toISOString()
              : new Date(receipt.receipt_date).toISOString())
          : null);

    // The bank audit entry for this money is the source of truth for the lead's
    // UPI id and transaction date: whatever the FRO typed or the receipt
    // carries, the audit entry's values win. The entry is also linked to the
    // claim so the audit shows this money once (with the claim) instead of a
    // separate unlinked entry. The FRO-typed UPI id is part of the lookup so
    // the entry is found even when the receipt has no payment_id/receipt_id.
    const auditEntry = await findClaimAuditEntry(receipt, claimUpiId);
    const auditUpi = auditEntry?.payment_id ? String(auditEntry.payment_id).trim() : null;
    const auditFrom = auditEntry?.payer_name ? String(auditEntry.payer_name).trim() : null;
    const auditMode = auditEntry?.mode || (auditEntry?.payment_id ? 'UPI' : (auditEntry?.check_id ? 'Cheque' : 'Bank Transfer'));
    const auditTxn = auditEntry?.transaction_date
      ? (() => {
          const d = String(auditEntry.transaction_date);
          const datePart = d.includes('T') ? d.slice(0, 10) : d;
          return auditEntry.payment_time ? `${datePart}T${auditEntry.payment_time}` : datePart;
        })()
      : null;

    const finalUpi = auditUpi || effectiveUpi;
    const finalFrom = auditFrom || effectiveFrom;
    const finalMode = auditMode || effectiveMode;
    const finalTxn = auditTxn || txDateTime;

    // Make the receipt's own payment_id point at the audit entry's id so the
    // receipt <-> entry link is durable for future lookups.
    if (auditUpi && !receipt.payment_id) {
      try {
        await db.from('receipts').update({ payment_id: auditUpi }).eq('id', receipt.id);
        receipt.payment_id = auditUpi;
      } catch (e) { console.error('Failed to backfill receipt payment id from audit entry:', e.message); }
    }

    // Dedup removed: each claimed receipt now creates its own lead in Lead
    // Verification so accounts sees every payment separately.

    // Resolve the receipt's project_id to an ngo_id first — the assignment must
    // match the receipt's NGO, not just any prior assignment for this donor.
    const { data: ngoRow } = await db
      .from('ngos')
      .select('id, name')
      .ilike('name', receipt.project_id)
      .maybeSingle();
    const receiptNgoId = ngoRow?.id || null;
    if (!receiptNgoId) throw Object.assign(new Error('Could not resolve the NGO for this receipt'), { status: 400 });

    // Attach to the donor's open assignment owned by THIS claiming FRO for THIS
    // NGO (or open a fresh one) so the created lead shows up in Lead Verification
    // and credits the claimant — never another worker's or another NGO's assignment.
    //
    // "Fresh one" must mean: no active row for this (donor, NGO) exists AT ALL.
    // Looking only at rows owned by the claimant made every claim against a donor
    // owned by someone else insert a second active row — which is how the same
    // donor ended up sitting in two stations at once. Reuse the donor's existing
    // row instead; the lead still credits the claimant because the log below
    // carries creditWorkerId, not the assignment's owner.
    let { data: assignment } = await db
      .from('fro_assignments')
      .select('id, fro_worker_id, status')
      .eq('donor_id', donorId)
      .eq('fro_worker_id', workerId)
      .eq('ngo_id', receiptNgoId)
      .neq('status', 'reassigned')
      .limit(1)
      .maybeSingle();

    let assignmentId = assignment?.id;
    if (!assignmentId) {
      const { data: anyActive } = await db
        .from('fro_assignments')
        .select('id, fro_worker_id, status')
        .eq('donor_id', donorId)
        .eq('ngo_id', receiptNgoId)
        .neq('status', 'reassigned')
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (anyActive) {
        assignment = anyActive;
        assignmentId = anyActive.id;
      } else {
        // A receipt claim is a MONEY action, never an allotment. Do not stamp
        // the claimant's station on the row it creates: getMyDonors only serves
        // rows whose station is in the FRO's scope (`.in('station', ...)`, with
        // no fallback), so a station-less row keeps this donor out of every My
        // Leads list — including later, when resetCycledDonors / the monthly
        // rollover flip lead_done back to pending. Credit is unaffected: the log
        // below carries creditWorkerId, and Lead Verification joins the
        // assignment through fro_worker_id, which still points at the claimant.
        const { data: created, error: asgErr } = await db
          .from('fro_assignments')
          .insert({
            donor_id: donorId,
            fro_worker_id: workerId,
            ngo_id: receiptNgoId,
            station: null,
            status: 'lead_done',
            assigned_at: new Date().toISOString(),
          })
          .select()
          .single();
        if (asgErr) throw asgErr;
        assignmentId = created.id;
      }
    }

    // Never collide with an explicit-id row from a data migration/import: keep
    // the id sequence ahead of the table's max id before this insert.
    await ensureLogSequenceHealth();

    const { data: log, error: logErr } = await db
      .from('fro_donor_logs')
      .insert({
        assignment_id: assignmentId,
        donor_id: donorId,
        // Both FK columns hold the covered FRO; the operator is recorded in
        // operator_id, which carries no FK (see createDonorLogHandler).
        fro_worker_id: workerId,
        operator_id: creditWorkerId === workerId ? null : creditWorkerId,
        action: 'disposition',
        disposition_detail: 'lead_done',
        amount_collected: receipt.amount,
        accounts_status: 'pending',
        payment_screenshot_url: screenshot_url || null,
        remark: notes || null,
        upi_transaction_id: finalUpi,
        payment_mode: finalMode,
        payment_from: finalFrom,
        pan_number: effectivePan,
        transaction_datetime: finalTxn,
        created_by: workerId,
      })
      .select()
      .single();
    if (logErr) throw logErr;

    const { error: updErr } = await db.from('receipts').update({ log_id: log.id, agent_name: creditWorkerName }).eq('id', receiptId);
    if (updErr) throw updErr;

    await linkClaimDonorToAuditEntry(receiptId, donorId, { donor_mobile, donor_city, donor_email, donor_pan, donor_address });
    await linkClaimAuditEntry(auditEntry, receiptId, log.id, creditWorkerId, donorId, creditWorkerName);

    // For receipt_sent entries, transition the bank_audit_entry status from
    // "receipt_sent" → "unverified" and stamp the claiming FRO's name so
    // Accounts sees it as a normal pending lead.
    if (isReceiptSent && auditEntry?.id) {
      try {
        await db.from('bank_audit_entries').update({
          status: 'unverified',
          agent_name: creditWorkerName || null,
          updated_at: new Date().toISOString(),
        }).eq('id', auditEntry.id);
      } catch (e) { console.error('Failed to update receipt_sent audit entry:', e.message); }
    }

    // Money is now confirmed (receipt linked to this donor). If the donor's
    // assignment still carries an open money-promise status, close it to
    // `donation_collected` so they stop appearing in the FRO "Promise to Pay"
    // list — otherwise the donor lands in the list permanently even though the
    // money came in. Same status semantics as the direct-donation save.
    const PROMISE_STATUSES = new Set(['promise_to_pay', 'payment_pending', 'will_donate_online', 'visit_donate', 'whatsapp_sent']);
    if (assignmentId && PROMISE_STATUSES.has(assignment?.status)) {
      try {
        await db.from('fro_assignments').update({
          status: 'donation_collected',
          last_contacted_at: new Date().toISOString(),
        }).eq('id', assignmentId);
      } catch (e) { console.error('Failed to close promise assignment on claim:', e.message); }
    }

    try {
      const { data: accounts } = await db.from('users').select('id').in('role', ['accounts', 'super_admin']);
      for (const u of (accounts || [])) {
        await db.from('notification_log').insert({
          worker_id: u.id,
          type: 'claim_requested',
          title: 'Suspense Claim',
          body: `${creditWorkerName || 'An FRO'} claimed ${receipt.donor_name || 'a receipt'} of \u20B9${Number(receipt.amount || 0).toLocaleString('en-IN')} — pending in Lead Verification.`,
          sent_at: new Date().toISOString(),
        });
      }
    } catch (e) { console.error('Claim notification error:', e.message); }

    findAutoMatches().catch((err) => console.error('Auto-match after suspense claim failed:', err.message));

    // A suspense claim is real disposition work — re-arm the human-at-the-
    // keyboard's window so it cannot time the FRO out mid-claim. Non-fatal.
    let timer = null;
    try {
      const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
      timer = await resetLiveWindow(humanCtx.id, { nowMs: Date.now(), dbg: 'claim' });
    } catch (claimTimerErr) {
      console.warn('suspense claim live window reset skipped:', claimTimerErr.message);
    }

    return res.status(201).json({ message: `Claimed for ${claimedDonorName} — pending in Lead Verification`, log_id: log.id, timer });
  } catch (error) {
    // If THIS request authored a brand-new suspense receipt for an entry- claim
    // but the claim failed, undo it so the bank-audit entry returns to a fully
    // claimable suspense row (not stuck as "Waiting for receipt number"). Only
    // touches the receipt and the entry-link created in this request.
    if (rollbackEntryId != null && createdReceiptId != null) {
      try {
        await db.from('bank_audit_entries')
          .update({ receipt_id: null, receipt_no: null, updated_at: new Date().toISOString() })
          .eq('id', rollbackEntryId);
        await db.from('receipts').delete().eq('id', createdReceiptId);
      } catch (e) { console.error('Rollback of failed suspense claim receipt failed:', e.message); }
    }
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// OR-groups matching donations / verified lead-dones on their ACTUAL collection
// date (imported receipts carry the real date in transaction_datetime; verified
// lead-dones count on verified_at), falling back to created_at — mirrors
// logCollectionDate(). Flat form (no nested or()) for the query builder.
const REACTIVATED_DATE_OR = (s, e) =>
  `and(action.eq.donation,created_at.gte.${s}${e ? `,created_at.lte.${e}` : ''}),` +
  `and(action.eq.donation,transaction_datetime.gte.${s}${e ? `,transaction_datetime.lte.${e}` : ''}),` +
  `and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified,verified_at.gte.${s}${e ? `,verified_at.lte.${e}` : ''})`;

export const getReactivatedDonors = async (req, res) => {
  try {
    const workerId = req.user.id;
    const period = req.query.period === 'month' ? 'month' : 'today';
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const nowUtc = new Date();
    const todayStart = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 0, 0, 0, 0));
    const todayEnd = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 23, 59, 59, 999));
    const fyYear = nowUtc.getMonth() < 3 ? nowUtc.getUTCFullYear() - 1 : nowUtc.getUTCFullYear();
    const fyStart = new Date(Date.UTC(fyYear, 3, 1));
    const monthStart = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1, 0, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1, 0, 23, 59, 59, 999));

    const periodStart = period === 'month' ? monthStart.toISOString() : todayStart.toISOString();
    const periodEnd = period === 'month' ? monthEnd.toISOString() : todayEnd.toISOString();
    const fyBeforeEnd = period === 'month' ? monthStart.toISOString() : todayStart.toISOString();

    const [periodDonorsRes, fyDonorsRes] = await Promise.all([
      withStationNgoPairs(db.from('fro_donor_logs')
        .select('donor_id, amount_collected, created_at, transaction_datetime, verified_at, donor_profiles!inner(name, mobile_number), fro_assignments!inner(station, ngo_id)')
        .in('fro_assignments.station', stationNames)
        .or(REACTIVATED_DATE_OR(periodStart, periodEnd)), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
      withStationNgoPairs(db.from('fro_donor_logs')
        .select('donor_id, created_at, transaction_datetime, verified_at, fro_assignments!inner(station, ngo_id)')
        .in('fro_assignments.station', stationNames)
        .or(REACTIVATED_DATE_OR(fyStart.toISOString())), myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'),
    ]);

    const periodLogs = filterByScope(periodDonorsRes.data, myScope, l => `${l.fro_assignments?.station}|${l.fro_assignments?.ngo_id}`);
    const fyLogs = filterByScope(fyDonorsRes.data, myScope, l => `${l.fro_assignments?.station}|${l.fro_assignments?.ngo_id}`);

    const fyBeforePeriodDonors = new Set();
    for (const log of fyLogs || []) {
      if (logCollectionDate(log) && logCollectionDate(log) < fyBeforeEnd) fyBeforePeriodDonors.add(log.donor_id);
    }

    const seen = new Set();
    const donors = [];
    for (const log of periodLogs || []) {
      const collectedAt = logCollectionDate(log);
      if (!log.donor_id || fyBeforePeriodDonors.has(log.donor_id) || seen.has(log.donor_id)) continue;
      if (!inRange(collectedAt, periodStart, periodEnd)) continue;
      seen.add(log.donor_id);
      donors.push({
        donor_id: log.donor_id,
        donor_name: log.donor_profiles?.name || 'Unknown',
        donor_mobile: log.donor_profiles?.mobile_number || '',
        amount: parseFloat(log.amount_collected || 0),
        date: collectedAt,
      });
    }

    donors.sort((a, b) => new Date(b.date) - new Date(a.date));
    return res.json({ donors, count: donors.length, period });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const NOT_CONNECTED_STATUSES = ['busy', 'ringing', 'call_waiting', 'unreachable', 'switched_off', 'out_of_coverage', 'wrong_number', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail'];
const CONNECTED_STATUSES = ['contacted', 'donation_collected', 'lead_done', 'done', 'follow_up', 'scheduled', 'callback', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected'];

export const getMyDonors = async (req, res) => {
  try {
    const workerId = req.user.id;
    const statusFilter = req.query.status;
    const statusGroup = req.query.status_group;

    // Read-through cache for the list view only.
    //
    // queue_current is deliberately EXCLUDED. That path is not a list, it is a
    // cursor: it reconciles work_queue, clears rows no longer eligible, marks the
    // served donor seen and returns exactly one donor plus forward-only progress.
    // Caching it would hand back an already-worked donor and let a lead reappear,
    // which is the specific thing that path exists to prevent. It also WRITES, so
    // a cached copy would skip those writes.
    const cacheable = req.query.queue_current !== 'true';
    const { l1: l1Key, l2: l2Key } = cacheable
      ? froDonorsCacheKeys(req, workerId)
      : { l1: null, l2: null };
    if (cacheable && req.query.fresh !== '1') {
      const hit = cacheGet(l1Key, FRO_DONORS_TTL_MS);
      if (hit !== undefined) return res.json(hit);

      // L2. redis.get is fail-open (null on any error) and never throws, so an
      // Upstash outage just falls through to the real query. The shape check is
      // deliberate: it stops a stale or foreign value under this key from being
      // handed to the client as if it were a lead list.
      const remote = await redis.get(l2Key);
      if (remote && typeof remote === 'object' && Array.isArray(remote.donors)) {
        cacheSet(l1Key, remote, FRO_DONORS_TTL_MS);
        return res.json(remote);
      }
    }

    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));

    let effectiveScope = myScope;
    let effectiveStations = stationNames;
    if (req.query.ngo_id) {
      // A requested NGO outside this FRO's scope must yield an empty queue —
      // never fall back to the full scope (that would leak other NGOs' leads
      // into a stale saved filter, the classic "wrong data" complaint).
      if (!allowedNgoIds.includes(req.query.ngo_id)) return res.json({ donors: [], total: 0 });
      effectiveScope = myScope.filter(s => s.ngo_id === req.query.ngo_id);
      effectiveStations = effectiveScope.map(s => s.station);
    }

    const limit = parseInt(req.query.limit, 10);
    const offset = parseInt(req.query.offset, 10);
    let assignments = null;

    // Primary: ALL available leads in the FRO's assigned (station, ngo) scope.
    // Scoped by station/ngo pair (NOT by fro_worker_id) so the FRO sees their
    // full station allotment even when individual assignment rows carry a null
    // or otherwise un-stamped fro_worker_id. Safe because each (ngo, station)
    // maps to exactly one FRO in fro_station_assignments; already-worked /
    // disposed / terminal leads are filtered out downstream by baseFiltered so
    // only unclaimed, available rows surface in the queue.
    // Narrow columns (not SELECT *): this pulls the FRO's whole station
    // scope (often thousands of rows) over mobile data on every list load.
    const ASSIGNMENT_COLS = 'id, donor_id, ngo_id, station, status, batch_type, is_new, notes, last_contacted_at, next_follow_up, assigned_at, rollover_from_status, rollover_at, ngos(name)';
    if (effectiveStations.length > 0) {
      let query = db
        .from('fro_assignments')
        .select(ASSIGNMENT_COLS)
        .in('station', effectiveStations)
        .not('status', 'eq', 'reassigned');
      query = withStationNgoPairs(query, effectiveScope);

      if (req.query.station) {
        query = query.eq('station', req.query.station);
        effectiveScope = effectiveScope.filter(s => s.station === req.query.station);
        effectiveStations = [req.query.station];
      }

      if (statusGroup === 'not_connected') {
        query = query.in('status', NOT_CONNECTED_STATUSES);
      } else if (statusGroup === 'connected') {
        query = query.in('status', CONNECTED_STATUSES);
      } else if (statusFilter) {
        query = query.eq('status', statusFilter);
      }

      let { data, error: qErr } = await query;
      if (qErr) {
        console.error('getMyDonors main query error for worker', workerId, ':', qErr.message, '| stations:', effectiveStations, '| scope:', JSON.stringify(effectiveScope));
        try {
          query = db.from('fro_assignments').select(ASSIGNMENT_COLS).in('station', effectiveStations).not('status', 'eq', 'reassigned');
          query = withStationNgoPairs(query, effectiveScope);
          const { data: retry, error: retryErr } = await query;
          if (retryErr) {
            console.error('getMyDonors retry query also failed for worker', workerId, ':', retryErr.message);
          }
          data = retry || [];
        } catch (retryEx) {
          console.error('getMyDonors retry exception for worker', workerId, ':', retryEx.message);
          data = [];
        }
      }
      assignments = data || [];
      // Robust new/old filter: handle legacy rows where batch_type is NULL.
      // New = batch_type new_data OR (null + is_new != false); Old = batch_type old_data OR (null + is_new == false)
      if (req.query.new_only === 'true') {
        assignments = assignments.filter(a => a.batch_type === 'new_data' || (a.batch_type == null && a.is_new !== false));
      } else if (req.query.old_only === 'true') {
        assignments = assignments.filter(a => a.batch_type === 'old_data' || (a.batch_type == null && (a.is_new === false || a.is_new == null)));
      }
    }

    // NO fallback. The FRO must only ever be served donors strictly within
    // their assigned (station, ngo_id) scope. If the assigned-scope query above
    // returns nothing, the queue is simply empty — we never pull in leads from
    // other stations or NGOs as a "claimable pool", because that would expose
    // donors outside the FRO's allotment.
    if (!assignments || assignments.length === 0) return res.json([]);

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const projectSet = [...new Set(assignments.map(a => (a.ngos?.name ? a.ngos.name.toLowerCase() : null)).filter(Boolean))];
    let donorIds = [...new Set(assignments.map(a => a.donor_id))];

    // Single donor_profiles read shared by the evidence builder (donor_type /
    // frequency) and the row builder below — previously this table was
    // scanned twice per request. Narrow columns: FROs are often on mobile data.
    const DONOR_COLS = 'id, name, mobile_number, city, address_1, amount, email, pan_number, project_supported, birth_date, donor_type, donation_count, total_amount, last_donation_date, first_donation_date, donation_frequency';
    const donors = await chunkedInQuery(donorIds, chunk =>
      db.from('donor_profiles').select(DONOR_COLS).in('id', chunk)
    );
    const donorMap = {};
    const donorTypeMap = {};
    for (const d of donors || []) {
      donorMap[d.id] = d;
      donorTypeMap[d.id] = d.donor_type || d.donation_frequency || '';
    }

    const evidence = await fetchScopedDonationEvidence({
      assignments,
      donorIds,
      projectSet,
      oneYearAgo: oneYearAgo.toISOString(),
      donorTypeMap,
    });

    if (req.query.verified_only === 'true' && donorIds.length > 0) {
      assignments = assignments.filter(a => evidence.verifiedAssignmentIds.has(a.id));
      donorIds = [...new Set(assignments.map(a => a.donor_id))];
    }

    const assignmentIds = assignments.map(a => a.id);
    const schedules = await chunkedInQuery(assignmentIds, chunk =>
      db.from('fro_scheduled_contacts').select('id, assignment_id, scheduled_at, notes').in('assignment_id', chunk).eq('is_completed', false)
    );

    const scheduleMap = {};
    for (const s of schedules || []) {
      if (!scheduleMap[s.assignment_id]) {
        scheduleMap[s.assignment_id] = s;
      }
    }

    // NGO-scoped flags: logs belong to the worker's assignments (which carry
    // the NGO) and receipts are matched by (donor_id, project_id) where
    // project_id = the NGO name lowercased. A donation only counts toward the
    // exact NGO the worker holds the donor in — never leaking across NGOs.
    const projectOf = a => (a.ngos?.name ? a.ngos.name.toLowerCase() : '');
    const activeSet = new Set();
    const monthDonatedSet = new Set();
    const monthVerifiedSet = new Set();
    const hasScopedSet = new Set();
    for (const a of assignments) {
      const pair = `${a.donor_id}|${projectOf(a)}`;
      if (evidence.activeAssignmentIds.has(a.id) || evidence.receiptRecentPairs.has(pair)) activeSet.add(a.id);
      if (evidence.periodDonatedAssignmentIds.has(a.id) || evidence.receiptPeriodPairs.has(pair)) monthDonatedSet.add(a.id);
      if (evidence.periodVerifiedAssignmentIds.has(a.id) || evidence.receiptPeriodPairs.has(pair)) monthVerifiedSet.add(a.id);
      if (evidence.activeAssignmentIds.has(a.id) || evidence.receiptPairs.has(pair)) hasScopedSet.add(a.id);
    }

    // Filter by active/inactive status
    if (req.query.active_only === 'true') {
      assignments = assignments.filter(a => activeSet.has(a.id));
      donorIds = [...new Set(assignments.map(a => a.donor_id))];
    } else if (req.query.inactive_only === 'true') {
      assignments = assignments.filter(a => !activeSet.has(a.id));
      donorIds = [...new Set(assignments.map(a => a.donor_id))];
    }

    // Sort assignments so completed/connected statuses come before pending
    // (dedup picks the first occurrence)
    if (req.query.verified_only === 'true') {
      const statusOrder = ['donation_collected', 'lead_done', 'follow_up', 'scheduled', 'contacted', 'callback', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'pending', 'busy', 'ringing', 'call_waiting', 'switched_off', 'out_of_coverage', 'unreachable', 'wrong_number', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail'];
      const statusRank = {};
      for (let i = 0; i < statusOrder.length; i++) statusRank[statusOrder[i]] = i;
      assignments.sort((a, b) => (statusRank[a.status] ?? 999) - (statusRank[b.status] ?? 999));
    }

    // ─── Status classification sets ───────────────────────────────────────────
    // Declared before the dedup sort so duplicate (donor_id, ngo_id) rows are
    // ranked by how terminal they are (the disposed/worked twin must win). The
    // same instances are reused by the hide-filter stage further down. 'others'
    // is a catch-all terminal disposition — a lead closed with it must leave the
    // work queue for the current month, not resurface as 'pending'.
    // Includes the grouped picker IDs (ringing_voicemail, busy_call_waiting,
    // ooc_unreachable_network) — without them a recycled lead is misclassified
    // as fresh and sorts ahead of genuinely unused pending leads every day.
    const RETRYABLE_NOT_CONNECTED_DETAILS = new Set([
      'ringing', 'unreachable', 'busy', 'out_of_coverage', 'voicemail', 'call_waiting', 'switched_off',
      'ringing_voicemail', 'busy_call_waiting', 'ooc_unreachable_network',
    ]);
    // Permanent hide for terminal not-connected dispositions (wrong_number, invalid, etc.).
    // Retryable ones above are excluded here — they go to tail instead.
    const NOT_CONNECTED_DISPOSITION_DETAILS = new Set([
      'wrong_number', 'invalid_number', 'invalid',
      'rejected', 'temporary_network_issue', 'incoming_out',
    ]);
    const MONEY_DONE_STATUSES = new Set([
      'donation_collected', 'done', 'lead_done', 'visit_donate',
      'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated',
    ]);
    const TERMINAL_DISPOSITIONS = new Set([
      'not_interested', 'not_interested_now', 'dnd', 'wrong_person', 'not_possible', 'language_barrier',
      'call_disconnected', 'email_sent', 'whatsapp_sent', 'transferred_senior',
      'query_complaint', 'receipt_request', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents',
      'office_program_visit', 'promise_pay_wa_email', 'not_interested_np',
      'others',
    ]);
    // Soft refusals. Unlike the other terminal dispositions, these are re-opened
    // by the monthly rollover's cooldown, so they must not stay "terminal forever"
    // once the assignment carries a rollover marker (see isRolloverReopenedRefusal).
    const NOT_INTERESTED_DISPOSITION_DETAILS = new Set([
      'not_interested', 'not_interested_now', 'not_interested_np',
    ]);

    // Dedup-ready ordering: within the same (donor_id, ngo_id), sort so the
    // "most terminal" row comes first and wins the keep-first dedup below. A
    // pending twin must never shadow a disposed/worked row, otherwise a lead
    // that was legally disposed (e.g. 'others') resurfaces with stale
    // 'pending' status. Rank: terminal disposition > money done
    // > not-connected terminal > everything else.
    const dedupRank = (x) => {
      if (TERMINAL_DISPOSITIONS.has(x.status)) return 0;
      if (MONEY_DONE_STATUSES.has(x.status)) return 1;
      if (NOT_CONNECTED_DISPOSITION_DETAILS.has(x.status)) return 2;
      return 3;
    };
    assignments.sort((x, y) => {
      const r = dedupRank(x) - dedupRank(y);
      if (r !== 0) return r;
      return (x.assigned_at || '').localeCompare(y.assigned_at || '');
    });

    let result = [];
    const seen = new Set();
    for (const a of assignments || []) {
      const d = donorMap[a.donor_id];
      if (!d) continue;
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = scheduleMap[a.id];
      const rawStatus = a.status || 'pending';
      // Only donation_collected should reset to pending across a donation
      // period boundary (so a recurring donor reappears to be collected again).
      // lead_done / done are terminal dispositions — once the FRO closes the
      // lead they must stay hidden, otherwise disposed leads come back again.
      const staleDoneStatus = rawStatus === 'donation_collected' && !monthDonatedSet.has(a.id);
      // A donor who has already donated in the current period has nothing left
      // to collect — drop them out of the workable (pending/not-connected) pool
      // so they stop reappearing at the top of the FRO stack. Uses monthDonatedSet
      // (verified or not) so the status matches the "already donated" banner.
      const workableStatuses = new Set(['pending', 'busy', 'ringing', 'call_waiting', 'switched_off', 'out_of_coverage', 'unreachable', 'wrong_number', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail', 'incoming_out']);
      const displayStatus = staleDoneStatus
        ? 'pending'
        : (monthDonatedSet.has(a.id) && workableStatuses.has(rawStatus) ? 'donation_collected' : rawStatus);
      result.push({
        id: a.donor_id,
        donor_id: a.donor_id,
        assignment_id: a.id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || 'Unknown',
        station: a.station || '',
        donor_mobile: d.mobile_number || '',
        donor_name: d.name || 'Unknown',
        donor_city: d.city || '',
        donor_address: d.address_1 || '',
        donor_amount: hasScopedSet.has(a.id) ? (d.amount || 0) : 0,
        donor_email: d.email || '',
        donor_pan: d.pan_number || '',
        donor_project: d.project_supported || '',
        donor_dob: d.birth_date || '',
        donor_type: d.donor_type || '',
        donation_count: hasScopedSet.has(a.id) ? (d.donation_count || 0) : 0,
        total_donated: hasScopedSet.has(a.id) ? (d.total_amount || 0) : 0,
        last_donation_date: hasScopedSet.has(a.id) ? (d.last_donation_date || null) : null,
        first_donation_date: hasScopedSet.has(a.id) ? (d.first_donation_date || null) : null,
        donor_frequency: d.donation_frequency || '',
        has_donated_current_fy: activeSet.has(a.id),
        has_donated_current_month: monthDonatedSet.has(a.id),
        has_verified_donation_current_month: monthVerifiedSet.has(a.id),
        is_active: activeSet.has(a.id),
        status: staleDoneStatus ? 'pending' : rawStatus,
        notes: a.notes || null,
        last_contacted_at: a.last_contacted_at || null,
        next_follow_up: a.next_follow_up || null,
        assigned_at: a.assigned_at || null,
        rollover_from_status: a.rollover_from_status || null,
        rollover_at: a.rollover_at || null,
        is_new: a.is_new !== false,
        batch_type: a.batch_type || null,
        next_scheduled_at: s?.scheduled_at || null,
        is_overdue: s ? new Date(s.scheduled_at) < new Date() : false,
        schedule_id: s?.id || null,
        schedule_notes: s?.notes || null,
      });
    }

    // Aggregate all NGO names per donor (since dedup by donor_id loses NGO info)
    const donorNgos = {};
    for (const a of assignments || []) {
      if (!donorNgos[a.donor_id]) donorNgos[a.donor_id] = [];
      const ngoName = a.ngos?.name;
      if (ngoName && !donorNgos[a.donor_id].includes(ngoName)) {
        donorNgos[a.donor_id].push(ngoName);
      }
    }
    for (const r of result) {
      r.ngo_names = donorNgos[r.donor_id] || [r.ngo_name];
    }

    // Attach latest accounts_status from fro_donor_logs (for verified_only view).
    // Single DISTINCT ON query instead of pulling every matching log row and
    // sorting in JS — identical result (latest log per donor), far fewer rows.
    if (req.query.verified_only === 'true' && result.length > 0) {
      const donorIdsForStatus = result.map(r => r.donor_id);
      const { rows: statusRows } = await db._pool.query(
        `SELECT DISTINCT ON (donor_id) donor_id, accounts_status
         FROM fro_donor_logs
         WHERE donor_id = ANY($1) AND accounts_status IN ('verified', 'rejected', 'pending')
         ORDER BY donor_id, created_at DESC`,
        [donorIdsForStatus]
      );
      const latestStatus = {};
      for (const log of statusRows || []) latestStatus[log.donor_id] = log.accounts_status;
      for (const r of result) {
        r.accounts_status = latestStatus[r.donor_id] || r.status;
      }
    }

    // --- Period filter ---
    const periodFilter = req.query.period;
    if (periodFilter && periodFilter !== 'all' && donorIds.length > 0) {
      let periodCutoff;
      const now = new Date();
      if (periodFilter === 'today') {
        const d = new Date(); d.setHours(0, 0, 0, 0);
        periodCutoff = d.toISOString();
      } else if (periodFilter === 'monthly') {
        periodCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      } else if (periodFilter === 'sixmonths') {
        periodCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
      } else if (periodFilter === 'yearly') {
        periodCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
      }
      if (periodCutoff) {
        const { rows: periodRows } = await db._pool.query(
          `SELECT DISTINCT donor_id FROM fro_donor_logs
           WHERE donor_id = ANY($1) AND action <> 'note' AND created_at >= $2`,
          [donorIds, periodCutoff]
        );
        const periodDonorIds = new Set((periodRows || []).map(l => l.donor_id));
        result = result.filter(r => periodDonorIds.has(r.donor_id));
      }
    }

    // --- Ordering logic ---
    // 1. New leads (is_new === true)
    // 2. Not connected (status in NOT_CONNECTED_STATUSES or 'pending')
    // 3. Connected (status in CONNECTED_STATUSES, excluding lead_done)
    // 4. Lead done from previous months (hidden for rest of current month)
    // 5. Ringing — always sinks to the very end of the queue

    const now = new Date();
    const nowISO = now.toISOString();

    // Latest disposition per donor for THIS worker via a single DISTINCT ON
    // query. Must be scoped to fro_worker_id — donor_ids are global and the
    // same donor can be allotted to several FROs/stations, so another FRO's
    // wrong_number/terminal disposition must never hide this FRO's lead.
    const notConnectedForeverIds = new Set();
    const terminalForeverIds = new Set();
    // Latest disposition detail + timestamp per donor: the detail decides whether
    // a donor is terminal-forever, and the timestamp lets a monthly rollover that
    // re-opened a soft refusal be told apart from one that is still genuinely
    // terminal.
    const latestDispByDonor = {};
    if (donorIds.length > 0) {
      const { rows: latestDisps } = await db._pool.query(
        `SELECT DISTINCT ON (donor_id) donor_id, disposition_detail, created_at
         FROM fro_donor_logs
         WHERE donor_id = ANY($1) AND action = 'disposition' AND fro_worker_id = $2
         ORDER BY donor_id, created_at DESC`,
        [donorIds, workerId]
      );
      for (const log of latestDisps || []) {
        latestDispByDonor[log.donor_id] = log;
        if (NOT_CONNECTED_DISPOSITION_DETAILS.has(log.disposition_detail)) {
          notConnectedForeverIds.add(log.donor_id);
        }
        if (TERMINAL_DISPOSITIONS.has(log.disposition_detail)) {
          terminalForeverIds.add(log.donor_id);
        }
      }
    }

    // A lead the rollover cooldown re-opened carries rollover_at; if its last
    // disposition was a soft refusal (not_interested), that disposition no longer
    // holds the lead forever — the rollover intentionally made it callable again.
    // Hard terminals (wrong_number, dnd, …) are not in the soft-refusal set, so
    // they stay blocked even if a rollover marker happens to be present.
    const isRolloverReopenedRefusal = (r) => {
      if (!r.rollover_at || !terminalForeverIds.has(r.donor_id)) return false;
      const d = latestDispByDonor[r.donor_id];
      if (d && !NOT_INTERESTED_DISPOSITION_DETAILS.has(d.disposition_detail)) return false;
      return !d || new Date(r.rollover_at) > new Date(d.created_at);
    };

    // ─── Same-day suppression (per worker + current work scope) ──────────────
    // Business rule: if the donor already has ANY disposition TODAY (IST) for
    // THIS worker, it must not be selectable again today — even for a retryable
    // disposition (ringing/busy). Tomorrow, retryability is recalculated by the
    // existing rules. Scoped to fro_worker_id (this worker) so disposing a donor
    // under FRO-1 never blocks it for FRO-2.
    const disposedTodayIds = new Set();
    if (donorIds.length > 0) {
      const { start, end } = istDayBounds();
      const { rows: todayRows } = await db._pool.query(
        `SELECT DISTINCT donor_id FROM fro_donor_logs
         WHERE donor_id = ANY($1) AND fro_worker_id = $2
           AND action = 'disposition'
           AND created_at >= $3 AND created_at < $4`,
        [donorIds, workerId, start.toISOString(), end.toISOString()]
      );
      for (const log of todayRows || []) disposedTodayIds.add(log.donor_id);
    }

    const SCHEDULE_CALLBACK_DISPOSITIONS = new Set([
      'scheduled', 'callback', 'follow_up', 'office_visit_scheduled', 'program_visit_scheduled',
    ]);

    // Statuses that are a hard "never work this donor again" so they must NEVER
    // be workable, independent of whether the matching disposition log was
    // captured. (Terminal connected dispositions like email_sent / query_complaint
    // may still need follow-up, so they are NOT excluded by status here — they are
    // already hidden via terminalForeverIds when a log exists.)
    const HARD_TERMINAL_STATUSES = new Set([
      'not_interested', 'not_interested_now', 'dnd', 'wrong_person', 'not_possible',
      'language_barrier', 'call_disconnected',
      'wrong_number', 'invalid_number', 'invalid', 'rejected', 'temporary_network_issue', 'incoming_out',
      'others',
    ]);

    // ─── Suppression flags ──────────────────────────────────────────────────
    // Suppression is now ANNOTATED, not applied by deletion. Previously this
    // block silently dropped rows (605 of Mamta Shah's 671 BOD-15 old leads were
    // removed here with no indication in the response), which is why a FRO's
    // allotment count and their visible list disagreed and nothing could explain
    // the difference.
    //
    // Every reason is computed per row and returned as is_suppressed +
    // suppress_reason so the UI can show the donor behind a "Show suppressed"
    // toggle and explain exactly why it is parked. `workableFiltered` below keeps
    // the ORIGINAL exclusion semantics for the controlled-queue path, so the
    // auto-advance cursor still never re-serves a donor who was already worked.
    const activeDndIds = await fetchActiveDndIds(effectiveScope);
    const dndKey = (r) => `${r.donor_id}|${r.ngo_id}`;

    const SUPPRESS_REASONS = {
      DND: 'dnd',
      DONATED_THIS_MONTH: 'donated_this_month',
      DISPOSED_TODAY: 'disposed_today',
      HARD_TERMINAL: 'hard_terminal',
      MONEY_DONE: 'money_done',
      SCHEDULED: 'scheduled',
      TERMINAL_FOREVER: 'terminal_forever',
      NOT_CONNECTED_FOREVER: 'not_connected_forever',
    };

    // The ONLY reasons that hide a lead by default. A donor who refused, was
    // unreachable or was already worked stays VISIBLE in My Leads — that is the
    // whole point of the "show me all my data" rule. These two are the
    // automatic holds: an explicit DND and a completed donation this month.
    // (The former third hold, a hidden_until park date, was removed in migration
    // 168; parking is no longer a thing.)
    const AUTO_HIDE_REASONS = new Set([
      SUPPRESS_REASONS.DND,
      SUPPRESS_REASONS.DONATED_THIS_MONTH,
    ]);

    let baseFiltered;
    if (req.query.verified_only === 'true') {
      baseFiltered = null;
    } else {
      baseFiltered = result.filter(r => {
        // Only two automatic suppressions remain, per the "show me all my data"
        // rule: an explicit DND mark, and a donation completed in the current
        // period (nothing left to collect). Everything else — worked,
        // terminal, scheduled — stays VISIBLE and is surfaced through the status
        // filters instead of being dropped.
        if (activeDndIds.has(dndKey(r))) return false;
        if (monthDonatedSet.has(r.assignment_id)) return false;
        return true;
      });
    }
    let filtered = baseFiltered === null ? result : baseFiltered;

    // The suppression reason for every row, including the ones just filtered
    // out above, so the client can badge them when "Show suppressed" is on.
    const suppressedReasonFor = (r) => {
      if (activeDndIds.has(dndKey(r))) return SUPPRESS_REASONS.DND;
      if (monthDonatedSet.has(r.assignment_id)) return SUPPRESS_REASONS.DONATED_THIS_MONTH;
      if (disposedTodayIds.has(r.donor_id)) return SUPPRESS_REASONS.DISPOSED_TODAY;
      if (HARD_TERMINAL_STATUSES.has(r.status)) return SUPPRESS_REASONS.HARD_TERMINAL;
      if (MONEY_DONE_STATUSES.has(r.status)) return SUPPRESS_REASONS.MONEY_DONE;
      if (SCHEDULE_CALLBACK_DISPOSITIONS.has(r.status)) return SUPPRESS_REASONS.SCHEDULED;
      if (terminalForeverIds.has(r.donor_id) && !isRolloverReopenedRefusal(r)) return SUPPRESS_REASONS.TERMINAL_FOREVER;
      if (notConnectedForeverIds.has(r.donor_id) && !MONEY_DONE_STATUSES.has(r.status)) {
        return SUPPRESS_REASONS.NOT_CONNECTED_FOREVER;
      }
      return null;
    };
    for (const r of result) {
      const reason = suppressedReasonFor(r);
      // is_suppressed drives the "Show suppressed" toggle, so it must ONLY be
      // set for the three automatic holds. A worked/closed lead keeps
      // suppress_reason for the explanatory row badge but stays in the list.
      r.suppress_reason = reason;
      r.is_suppressed = !!reason && AUTO_HIDE_REASONS.has(reason);
    }

    // include_suppressed=true serves the FULL list (allotted rows) with each
    // donor flagged, which is what "show me all my data" means. The counts in
    // the response make the split self-explanatory instead of a mystery.
    const includeSuppressed = req.query.include_suppressed === 'true';
    if (includeSuppressed && baseFiltered !== null) {
      filtered = result;
    }

    // ─── My Leads = pending work ONLY ────────────────────────────────────────
    // The list is the FRO's queue of leads still to call: pending rows plus
    // retryable not-connected rows (ringing/busy/switched-off/…), which come
    // back the day after they were dialled and sink to the tail. Any other row
    // dispositioned this month (scheduled callbacks,
    // refusals, donation-done, …) belongs in History / Callbacks / Follow-ups /
    // Overdue, not here — this month's dispositions carry their own tabs. The
    // monthly rollover resets every worked status back to 'pending', so a lead
    // disposed last month returns here when the new cycle starts. The
    // verified_only view (Donors panel) is exempt because it is a money-
    // reconciliation list, not a calling queue.
    const isQueueableStatus = (r) => r.status === 'pending' || r.status == null || r.status === ''
      || RETRYABLE_NOT_CONNECTED_DETAILS.has(r.status);
    if (req.query.verified_only !== 'true') {
      filtered = filtered.filter(r => {
        const isPendingStatus = isQueueableStatus(r);
        // A lead dispositioned today must leave Leads even when its surfaced
        // assignment row still reads 'pending' — which happens when the donor
        // has a duplicate/twin assignment row and today's disposition log was
        // written against the other row. The queue path (workableFiltered)
        // already applies this same disposedTodayIds exclusion; the list must
        // match it or a "DONE TODAY" lead keeps sitting in the Leads tab.
        if (!isPendingStatus) return false;
        if (disposedTodayIds.has(r.donor_id)) return false;
        return true;
      });
    }

    // The workable set — original exclusion semantics, preserved verbatim for the
    // controlled queue so a lead already worked today (or already terminal) can
    // never be handed back out by the auto-advance cursor. On top of that, the
    // queue now only serves PENDING leads: My Leads means "work to be done", and
    // anything already dispositioned this month lives in History / Callbacks /
    // Follow-ups / Overdue until the monthly rollover resets it to pending.
    const workableFiltered = result.filter(r => {
      // NULL/empty status rows are never-worked assignments; treat as pending.
      if (!isQueueableStatus(r)) return false;
      if (disposedTodayIds.has(r.donor_id)) return false;
      if (HARD_TERMINAL_STATUSES.has(r.status)) return false;
      if (MONEY_DONE_STATUSES.has(r.status)) return false;
      if (SCHEDULE_CALLBACK_DISPOSITIONS.has(r.status)) return false;
      if (terminalForeverIds.has(r.donor_id) && !isRolloverReopenedRefusal(r)) return false;
      if (notConnectedForeverIds.has(r.donor_id) && !MONEY_DONE_STATUSES.has(r.status)) return false;
      return true;
    });

    // Called longest ago first, most recently called last, never-called at the bottom.
    const contactedMs = (r) => (r.last_contacted_at ? new Date(r.last_contacted_at).getTime() : null);
    const byContactedAsc = (a, b) => {
      const ca = contactedMs(a);
      const cb = contactedMs(b);
      if (ca === null && cb !== null) return 1;
      if (ca !== null && cb === null) return -1;
      if (ca !== null && cb !== null && ca !== cb) return ca - cb;
      const dateA = a.assigned_at ? new Date(a.assigned_at) : new Date(0);
      const dateB = b.assigned_at ? new Date(b.assigned_at) : new Date(0);
      return dateA - dateB;
    };
    workableFiltered.sort(byContactedAsc);
    filtered.sort((a, b) => {
      if (a.is_suppressed !== b.is_suppressed) return a.is_suppressed ? 1 : -1;
      return byContactedAsc(a, b);
    });

    // ─── Backend-authoritative current donor (controlled queue) ──────────────
    // When queue_current=true the backend reconciles the ordered workable donor
    // list into work_queue and hands back exactly ONE donor (the next one the
    // FRO should work), plus durable progress. The front-end never chooses the
    // next donor itself — no client-side skip/reorder, so a lead already worked
    // can never reappear.
    if (req.query.queue_current === 'true') {
      try {
        const operatorId = req.user.impersonation && req.user.imposter_id != null ? req.user.imposter_id : null;
        const queueTab = req.query.new_only === 'true' ? 'new' : 'old';
        const queueStation = req.query.station && req.query.station !== 'all' ? req.query.station : null;
        // The queue is fed `workableFiltered`, NOT `filtered`. `filtered` now
        // serves the full allotted list when include_suppressed is set, and the
        // auto-advance cursor must never hand back a donor who was already worked
        // or already terminal — otherwise the FRO would be re-called on people
        // who refused.
        const donorObjs = workableFiltered.map(r => ({ donor_id: r.donor_id, ngo_id: r.ngo_id, id: r.donor_id }));
        await reconcileQueue({ workerId, operatorId, donors: donorObjs, station: queueStation, tab: queueTab });
        await clearActiveRowsNotIn({ workerId, donorIds: donorObjs.map(o => o.donor_id), station: queueStation, tab: queueTab });
        const activeRows = await getActiveQueueRows({ workerId, station: queueStation, tab: queueTab });
        const byId = new Map(workableFiltered.map(r => [r.donor_id, r]));

        // The cursor is STRICTLY FORWARD — no wrap-around, never `% length`, never
        // `idx<0 → idx=0`. `filtered` already excludes every donor with a
        // disposition today for this worker (see baseFiltered), and the disposed
        // donor is no longer in donorObjs, so `getActiveQueueRows` returns only
        // DONORS STILL ELIGIBLE TODAY for this scope. The next donor is therefore
        // simply the LOWEST-position remaining active row.
        //
        //   activeRows are ordered by stable position ASC. After A→RINGING:
        //     activeRows = [B,C,D], serve B → C → D → (empty) -> QUEUE COMPLETE.
        //   There is no valid path back to an earlier donor within the same day.
        let next = null;
        if (activeRows.length > 0) {
          next = activeRows[0];
        }

        const totalActive = activeRows.length;
        if (!next || !byId.has(next.donor_id)) {
          console.log('queue_current: cycle exhausted for worker', workerId, 'station', queueStation, 'tab', queueTab, 'active', totalActive);
          return res.json({ donor: null, position: -1, total: totalActive, cycle_key: cycleKey({ ngoId: null, station: queueStation, tab: queueTab }), done: true });
        }
        const r = byId.get(next.donor_id);
        await markShown({ workerId, donorId: next.donor_id, ngoId: next.ngo_id, station: queueStation, tab: queueTab, position: next.position });
        return res.json({
          donor: r,
          position: next.position,
          total: totalActive,
          cycle_key: cycleKey({ ngoId: null, station: queueStation, tab: queueTab }),
          done: false,
          queue_status: next.status,
        });
      } catch (queueErr) {
        console.error('queue_current error for worker', workerId, ':', queueErr.message);
        // Fall back to the plain list behaviour so the FRO does not dead-end.
        return res.json({ donors: workableFiltered, total: workableFiltered.length });
      }
    }

    const total = filtered.length;
    let page = filtered;
    if (Number.isFinite(limit) && limit > 0) {
      const start = (Number.isFinite(offset) && offset > 0) ? offset : 0;
      page = filtered.slice(start, start + limit);
    }

    if (total === 0 && assignments && assignments.length > 0) {
      console.warn('getMyDonors EMPTY after filters for worker', workerId,
        '| raw_assignments:', assignments.length,
        '| new_only:', req.query.new_only, '| old_only:', req.query.old_only,
        '| ngo_id:', req.query.ngo_id || 'all',
        '| station:', req.query.station || 'all',
        '| not_connected_forever:', notConnectedForeverIds.size,
        '| result_before_hide:', result.length);
    }

    // A breakdown of why rows are suppressed, so "N of M" is explainable in the
    // UI instead of the FRO guessing why their allotment is larger than the
    // list. Ordered by how many leads each reason accounts for.
    const suppressedBreakdown = {};
    for (const r of result) {
      if (r.suppress_reason) suppressedBreakdown[r.suppress_reason] = (suppressedBreakdown[r.suppress_reason] || 0) + 1;
    }

    const suppressedTotal = result.reduce((n, r) => n + (r.is_suppressed ? 1 : 0), 0);
    const workedTotal = result.reduce((n, r) => n + (!r.is_suppressed && r.suppress_reason ? 1 : 0), 0);

    // Only the list payload is cached, and only on the success path. The early
    // returns above stay uncached deliberately: the out-of-scope NGO case and the
    // empty-queue case are both cheap, and caching an "empty" would keep serving
    // it for up to the TTL after an admin widened the FRO's station scope - a
    // visible empty list for no reason the FRO could explain.
    const payload = {
      donors: page,
      total,
      counts: {
        // Raw allotment for this scope (what the dashboard reports).
        allotted: result.length,
        // Rows returned in this response.
        visible: total,
        // Held back by default: DND, donated this month, or parked.
        suppressed: suppressedTotal,
        // Leads with a status (worked/closed) — visible, just badged.
        worked: workedTotal,
        // Leads still workable right now (what the queue cursor walks).
        workable: workableFiltered.length,
        by_reason: suppressedBreakdown,
      },
      include_suppressed: includeSuppressed,
    };

    if (cacheable) {
      cacheSet(l1Key, payload);

      // L2 write is fire-and-forget so a slow Upstash never delays the FRO's
      // response. The serialize here is only for the size guard; redis.set does
      // its own stringify, which is cheap next to the 11+ queries just avoided.
      let json = null;
      try { json = JSON.stringify(payload); } catch { json = null; }
      if (json && json.length <= FRO_DONORS_REDIS_MAX_BYTES) {
        redis.set(l2Key, payload, FRO_DONORS_REDIS_TTL_S).catch(() => { });
      }
    }

    return res.json(payload);
  } catch (error) {
    console.error('getMyDonors error for worker', req.user?.id, ':', error.message, error.stack);
    return res.status(500).json({ message: error.message });
  }
};

export const getTransferredLeads = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    let effectiveScope = myScope;
    let effectiveStations = stationNames;
    if (req.query.ngo_id && allowedNgoIds.includes(req.query.ngo_id)) {
      effectiveScope = myScope.filter(s => s.ngo_id === req.query.ngo_id);
      effectiveStations = effectiveScope.map(s => s.station);
    }

    let txQuery = db
      .from('fro_assignments')
      .select('*, ngos(name)')
      .in('station', effectiveStations)
      .is('fro_worker_id', null)
      .not('status', 'eq', 'reassigned')
      .limit(200);
    txQuery = withStationNgoPairs(txQuery, effectiveScope);
    const { data: assignments } = await txQuery;

    if (!assignments || assignments.length === 0) return res.json([]);

    const donorIds = [...new Set(assignments.map(a => a.donor_id))];
    const { data: donors } = await db
      .from('donor_profiles')
      .select('*')
      .in('id', donorIds);

    const donorMap = {};
    for (const d of donors || []) donorMap[d.id] = d;

    const assignmentIds = assignments.map(a => a.id);
    const { data: schedules } = await db
      .from('fro_scheduled_contacts')
      .select('*')
      .in('assignment_id', assignmentIds)
      .eq('is_completed', false);

    const scheduleMap = {};
    for (const s of schedules || []) {
      if (!scheduleMap[s.assignment_id]) scheduleMap[s.assignment_id] = s;
    }

    const projectSet = [...new Set(assignments.map(a => (a.ngos?.name ? a.ngos.name.toLowerCase() : null)).filter(Boolean))];
    const scopedReceiptPairs = new Set();
    if (donorIds.length > 0 && projectSet.length > 0) {
      const { data: scopedReceipts } = await db
        .from('receipts')
        .select('donor_id, project_id')
        .in('donor_id', donorIds)
        .in('project_id', projectSet);
      for (const r of scopedReceipts || []) {
        scopedReceiptPairs.add(`${r.donor_id}|${(r.project_id || '').toLowerCase()}`);
      }
    }

    const result = [];
    const seen = new Set();
    for (const a of assignments || []) {
      const d = donorMap[a.donor_id];
      if (!d) continue;
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = scheduleMap[a.id];
      const pair = `${a.donor_id}|${a.ngos?.name ? a.ngos.name.toLowerCase() : ''}`;
      const hasScoped = scopedReceiptPairs.has(pair);
      result.push({
        id: a.donor_id,
        donor_id: a.donor_id,
        assignment_id: a.id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || 'Unknown',
        station: a.station || '',
        donor_mobile: d.mobile_number || '',
        donor_name: d.name || 'Unknown',
        donor_city: d.city || '',
        donor_address: d.address_1 || '',
        donor_amount: hasScoped ? (d.amount || 0) : 0,
        donor_email: d.email || '',
        donor_pan: d.pan_number || '',
        donor_project: d.project_supported || '',
        donor_dob: d.birth_date || '',
        donor_type: d.donor_type || '',
        donation_count: hasScoped ? (d.donation_count || 0) : 0,
        total_donated: hasScoped ? (d.total_amount || 0) : 0,
        status: a.status || 'pending',
        notes: a.notes || null,
        last_contacted_at: a.last_contacted_at || null,
        next_follow_up: a.next_follow_up || null,
        assigned_at: a.assigned_at || null,
        is_new: a.is_new !== false,
        next_scheduled_at: s?.scheduled_at || null,
        is_overdue: s ? new Date(s.scheduled_at) < new Date() : false,
        schedule_id: s?.id || null,
        schedule_notes: s?.notes || null,
      });
    }

    return res.json(result);
  } catch (error) {
    console.error('getTransferredLeads error for worker', req.user?.id, ':', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const updateDonorStatus = async (req, res) => {
  try {
    const workerId = req.user.id;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { status, notes, next_follow_up, ngo_id } = req.body;
    if (!status) return res.status(400).json({ message: 'status is required' });

    let assignment = await findOrCreateAssignment(donorId, workerId, ngo_id);
    if (!assignment) return res.status(404).json({ message: 'Assignment not found' });

    // Fill in station if missing (old rows created before station tracking)
    if (!assignment.station && ngo_id) {
      const { data: sa } = await db
        .from('fro_station_assignments')
        .select('station')
        .eq('fro_worker_id', workerId)
        .eq('ngo_id', ngo_id)
        .maybeSingle();
      if (sa?.station) {
        await db.from('fro_assignments').update({ station: sa.station }).eq('id', assignment.id);
        assignment.station = sa.station;
      }
    }

    const updates = { status, last_contacted_at: new Date().toISOString() };
    if (notes !== undefined) updates.notes = notes;
    if (next_follow_up !== undefined) updates.next_follow_up = next_follow_up;

    // DND via the status dropdown is a SECOND write path for the same decision
    // (the disposition modal is the first). Both must land in donor_dnd or the
    // registry silently under-reports and DND'd donors keep reappearing.
    // Switching back OFF dnd releases the mark instead of deleting the row, so
    // the audit trail survives a mistake.
    const resolvedNgo = ngo_id || assignment.ngo_id;
    if (status === 'dnd') {
      await recordDndMark({
        donorId: assignment.donor_id ?? donorId,
        ngoId: resolvedNgo,
        station: assignment.station,
        markedBy: workerId,
        reason: 'dnd',
        note: typeof notes === 'string' && notes ? notes.slice(0, 500) : null,
      });
      try {
        await removeFromQueue({ workerId, donorId });
      } catch (queueErr) {
        console.warn('DND work_queue removal skipped for donor', donorId, ':', queueErr.message);
      }
    } else {
      await releaseDndMark({ donorId: assignment.donor_id ?? donorId, ngoId: resolvedNgo, releasedBy: workerId });
    }

    const result = await updateAssignmentStatus(assignment.id, updates);
    // A status change moves the lead in/out of the workable stack and can flip
    // its suppressed flag, so the cached dashboard, target and search payloads
    // are now wrong.
    invalidateFroCaches(workerId);
    return res.json({ message: 'Status updated', data: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateDonorType = async (req, res) => {
  try {
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { donor_type, ngo_id } = req.body;
    const validTypes = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time'];
    if (!donor_type || !validTypes.includes(donor_type)) {
      return res.status(400).json({ message: 'donor_type must be one of: monthly, quarterly, yearly, one_time' });
    }

    const assignment = await getFroAssignment(donorId, req.user.id, ngo_id);
    if (!assignment) return res.status(403).json({ message: 'Access denied' });

    const { data, error } = await db
      .from('donor_profiles')
      .update({ donor_type })
      .eq('id', donorId)
      .select('id, donor_type')
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ message: 'Donor not found' });
      throw error;
    }

    return res.json({ message: 'Donor type updated', data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorLogs = async (req, res) => {
  try {
    const workerId = req.user.id;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { ngo_id } = req.query;

    const ASSIGN_COLS = 'id, ngo_id, rollover_from_status, rollover_at';
    let assignment = null;
    if (ngo_id) {
      const { data } = await db
        .from('fro_assignments')
        .select(ASSIGN_COLS)
        .eq('donor_id', donorId)
        .eq('fro_worker_id', workerId)
        .eq('ngo_id', ngo_id)
        .not('status', 'eq', 'reassigned')
        .maybeSingle();
      assignment = data;
    }
    if (!assignment) {
      const { data } = await db
        .from('fro_assignments')
        .select(ASSIGN_COLS)
        .eq('donor_id', donorId)
        .eq('fro_worker_id', workerId)
        .not('status', 'eq', 'reassigned')
        .maybeSingle();
      assignment = data;
    }

    let logs = [];
    let totalCollected = 0;
    let nextSchedule = null;
    if (assignment) {
      logs = await findLogsByAssignment(assignment.id);
      // Surface the month-boundary reset in the CRM timeline. The underlying
      // disposition logs still show the real history; this synthetic entry is
      // only the "and then the monthly rollover sent it back to pending" step,
      // carrying the status it came from. Cleared by updateAssignmentStatus once
      // the FRO dispositions the lead again, so it never lingers.
      if (assignment.rollover_at) {
        logs = [
          {
            id: 'rollover',
            assignment_id: assignment.id,
            action: 'month_reset',
            notes: `Monthly rollover: status reset from ${(assignment.rollover_from_status || 'previous').replace(/_/g, ' ')} to pending`,
            created_at: assignment.rollover_at,
          },
          ...logs,
        ];
      }
      totalCollected = await getTotalCollectedByAssignment(assignment.id);
      nextSchedule = await getScheduledByAssignment(assignment.id);
    }

    let receipts = [];
    if (assignment) {
      let project = null;
      if (assignment.ngo_id) {
        const { data: ngo } = await db
          .from('ngos')
          .select('name')
          .eq('id', assignment.ngo_id)
          .maybeSingle();
        project = ngo?.name ? ngo.name.toLowerCase() : null;
      }
      if (project) {
        const { data: scopedReceipts } = await db
          .from('receipts')
          .select('*, fro_donor_logs!receipts_log_id_fkey(transaction_datetime)')
          .eq('donor_id', donorId)
          .eq('project_id', project)
          .order('receipt_date', { ascending: false });
        receipts = scopedReceipts || [];
      }
    }

    if (receipts && receipts.length > 0) {
      const receiptLogs = receipts.map(r => {
        const linkedLog = Array.isArray(r.fro_donor_logs) ? r.fro_donor_logs[0] : r.fro_donor_logs;
        const receiptDate = r.receipt_date || linkedLog?.transaction_datetime || r.created_at;
        return {
          id: `receipt_${r.id}`,
          assignment_id: assignment?.id || null,
          amount_collected: parseFloat(r.amount || 0),
          payment_mode: r.mode || '—',
          mode: r.mode || '—',
          accounts_status: 'verified',
          created_at: receiptDate,
          upi_transaction_id: r.payment_id || null,
          payment_id: r.payment_id || null,
          receipt_no: r.receipt_no || null,
          donor_name: r.donor_name || null,
          project_id: r.project_id || null,
          action: 'donation',
          transaction_datetime: receiptDate,
          verified_at: receiptDate,
          agent_name: r.agent_name || null,
        };
      });
      if (assignment) {
        const nonDonationLogs = logs.filter(l => l.action !== 'donation' && !(l.disposition_detail === 'lead_done' && l.accounts_status === 'verified'));
        logs = [...nonDonationLogs, ...receiptLogs];
        logs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      } else {
        logs = receiptLogs;
      }
      totalCollected = receipts.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    }

    // Resolve collector names so the UI can show "Collected by <name>" — the
    // collector may differ from the assignment owner (work-as donations).
    const collectorIds = [...new Set((logs || []).map((l) => l.fro_worker_id).filter(Boolean))];
    const { data: collectors } = collectorIds.length > 0
      ? await db.from('workers').select('id, name').in('id', collectorIds)
      : { data: [] };
    const collectorMap = {};
    for (const w of collectors || []) collectorMap[w.id] = w.name;
    for (const l of logs || []) {
      // Hide the collector's identity from the impersonated FRO. The log's
      // fro_worker_id is the person who actually collected (which differs from
      // the requester when working as another FRO), so only reveal the name
      // when the requester is the collector themselves.
      if (l.fro_worker_id != null && l.fro_worker_id === workerId) {
        l.fro_worker_name = collectorMap[l.fro_worker_id] || null;
      } else {
        l.fro_worker_name = null;
      }
    }

    return res.json({ logs, total_collected: totalCollected, next_schedule: nextSchedule });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const MONEY_TERMINAL_STATUSES = new Set(['done', 'lead_done', 'donation_collected']);

// A donor whose assignment is already money-terminal is no longer workable for
// this worker in this cycle; opening it again is a duplicate/out-of-order save.
function isDisposedForWorker(assignment, detail) {
  if (!assignment) return false;
  if (assignment.status === 'reassigned') return true;
  if (!MONEY_TERMINAL_STATUSES.has(assignment.status)) return false;
  // Re-submitting the exact same money disposition is a duplicate; submitting a
  // different disposition onto a closed money lead is out-of-order.
  if (assignment.status === 'lead_done' || assignment.status === 'done') return true;
  return false;
}

export const createDonorLogHandler = async (req, res) => {
  try {
    const workerId = req.user.id;
    // When working-as another FRO, the collection credit goes to the operator
    // (imposter) while the donor/assignment stays with the impersonated FRO.
    const creditWorkerId = req.user.impersonation && req.user.imposter_id != null ? req.user.imposter_id : workerId;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { action, notes, outcome, amount_collected, disposition_category, disposition_detail, scheduled_at, payment_screenshot_url, pan_number, donor_address, donor_dob, ngo_id, project_name, remark, upi_transaction_id, transaction_datetime } = req.body;

    if (!action) return res.status(400).json({ message: 'action is required' });
    const allowedActions = ['call', 'visit', 'message', 'follow_up', 'donation', 'note', 'disposition'];
    if (!allowedActions.includes(action)) return res.status(400).json({ message: `Invalid action. Must be one of: ${allowedActions.join(', ')}` });

    const assignment = await findOrCreateAssignment(donorId, workerId, ngo_id);
    if (!assignment) return res.status(404).json({ message: 'Donor not found or no NGO assigned' });

    const logData = {
      assignment_id: assignment.id,
      donor_id: donorId,
      // fro_worker_id and created_by are both FK'd to workers(id), so they hold
      // the covered FRO. The operator goes in operator_id, which has no FK
      // because an agent's or admin's id does not exist in workers.
      fro_worker_id: workerId,
      operator_id: creditWorkerId === workerId ? null : creditWorkerId,
      action,
      notes: notes || null,
      outcome: outcome || null,
      amount_collected: amount_collected || null,
      disposition_category: disposition_category || null,
      disposition_detail: disposition_detail || null,
      scheduled_at: scheduled_at || null,
      payment_screenshot_url: payment_screenshot_url || null,
      pan_number: pan_number || null,
      remark: remark || null,
      upi_transaction_id: upi_transaction_id || null,
      transaction_datetime: (() => {
        if (!transaction_datetime) return null;
        const d = new Date(transaction_datetime);
        return isNaN(d.getTime()) ? null : d.toISOString();
      })(),
      accounts_status: null,
      created_by: workerId,
    };

    if (action === 'disposition' && disposition_detail === 'lead_done') {
      logData.accounts_status = 'pending';
    }

    // ─── Atomic, duplicate-safe disposition ──────────────────────────────────
    // The whole save (log insert + assignment status update + donor profile
    // update + queue update) runs in ONE transaction so a partial failure can
    // never leave a log without its status (or vice-versa). A per-assignment
    // advisory xact lock serializes concurrent saves (two tabs / double-click)
    // so only one wins; the DB unique index uq_fro_donor_logs_same_day_disp is
    // the final backstop against duplicate same-day disposition rows.
    const retryable = classifyDisposition(disposition_detail).retryable;
    const terminalQueued = action === 'disposition' && disposition_detail && !retryable;

    const result = await db.transaction(async () => {
      await db._pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dispose:' + assignment.id]);

      // Guard: do not let a worker re-open or duplicate a money-closed lead.
      if (action === 'disposition' && isDisposedForWorker(assignment, disposition_detail)) {
        const err = new Error('This lead is already closed (donation collected / done). Refresh to see the next donor.');
        err.code = 'LEAD_CLOSED';
        throw err;
      }

      // Same-day disposition dedup: re-saving the same detail (e.g. ringing, busy,
      // not_possible) for the same assignment refreshes today's row instead of
      // inserting a new timeline entry. Money events (done / lead_done) always insert.
      const MONEY_DETAILS = new Set(['done', 'lead_done']);
      let log;
      if (action === 'disposition' && disposition_detail && !MONEY_DETAILS.has(disposition_detail)) {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const existing = await findDispositionLogToday(assignment.id, creditWorkerId, disposition_detail, dayStart.toISOString());
        if (existing) {
          log = await updateDonorLog(existing.id, {
            notes: logData.notes,
            outcome: logData.outcome,
            amount_collected: logData.amount_collected,
            disposition_category: logData.disposition_category,
            scheduled_at: logData.scheduled_at,
            payment_screenshot_url: logData.payment_screenshot_url,
            pan_number: logData.pan_number,
            remark: logData.remark,
            upi_transaction_id: logData.upi_transaction_id,
            transaction_datetime: logData.transaction_datetime,
            // Re-attribute the refreshed row to whoever is saving now: the dedupe
            // above can match a row an agent created earlier today, and without
            // this the FRO's own save would inherit the agent's operator_id.
            fro_worker_id: logData.fro_worker_id,
            operator_id: logData.operator_id,
            created_by: logData.created_by,
            created_at: new Date().toISOString(),
          });
        } else {
          log = await createDonorLog(logData);
        }
      } else {
        log = await createDonorLog(logData);
      }

      // Any logged interaction means the worker attempted this donor — clear
      // the NEW flag so it stops counting/pinning as fresh data.
      await db.from('fro_assignments').update({ is_new: false }).eq('id', assignment.id);

      // Update donor profile fields if provided
      const updateFields = {};
      if (donor_address) updateFields.address_1 = donor_address;
      if (donor_dob) updateFields.birth_date = donor_dob;
      if (project_name) updateFields.project_supported = project_name;
      if (Object.keys(updateFields).length > 0) {
        await db.from('donor_profiles').update(updateFields).eq('id', donorId);
      }

      const now = new Date().toISOString();

      if (action === 'donation') {
        await updateAssignmentStatus(assignment.id, {
          status: 'donation_collected',
          last_contacted_at: now,
        });
      } else if (action === 'disposition' && disposition_detail) {
        await completeAllScheduledByAssignment(assignment.id);

        const statusFromDetail = dispositionDetailToStatus(disposition_detail);
        const statusUpdates = { status: statusFromDetail, last_contacted_at: now };

        if (['scheduled', 'office_visit_scheduled', 'program_visit_scheduled', 'office_program_visit', 'callback'].includes(disposition_detail) && scheduled_at) {
          await createScheduledContact({
            assignment_id: assignment.id,
            scheduled_at,
            notes: notes || null,
            created_by: workerId,
          });
          statusUpdates.next_follow_up = istDateString(scheduled_at);
        }

        if (outcome && outcome.startsWith('next_date:')) {
          statusUpdates.next_follow_up = outcome.replace('next_date:', '').trim();
        }

        await updateAssignmentStatus(assignment.id, statusUpdates);
      } else if (action === 'call' || action === 'visit') {
        await updateAssignmentStatus(assignment.id, {
          status: 'contacted',
          last_contacted_at: now,
        });
      }

      // Reflect the disposition on the controlled queue: terminal dispositions
      // mark the donor DISPOSED across all the worker's active queues (gone, so
      // it can never reappear); retryable not-connected (ringing/busy) stay
      // active so the same donor can be reworked next time.
      if (action === 'disposition' && disposition_detail) {
        try {
          await markDisposed({
            workerId,
            donorId,
            disposed: terminalQueued,
          });
        } catch (queueErr) {
          console.warn('work_queue status update skipped for assignment', assignment.id, ':', queueErr.message);
        }
      }

      // DND: record the mark in the donor_dnd registry (migration 165) instead
      // of destroying the record. This previously DELETED the assignment row,
      // its fro_donor_logs and its scheduled contacts, which meant a DND'd donor
      // left no trace anywhere — nothing to audit, explain or release, and the
      // lead simply vanished from every list (the root cause of "my data is
      // missing" reports).
      //
      // The assignment row is now KEPT so the decision stays visible and
      // reversible: status='dnd' plus the donor_dnd registry mark, which
      // suppresses the lead globally within this (donor, ngo) scope, and the FRO
      // can still see it under "Show suppressed". Removing it from the
      // controlled queue (removeFromQueue) is kept so a DND'd donor can
      // never be handed out again by the auto-advance cursor.
      if (action === 'disposition' && disposition_detail === 'dnd') {
        try {
          await recordDndMark({
            donorId: assignment.donor_id,
            ngoId: assignment.ngo_id,
            station: assignment.station,
            markedBy: workerId,
            reason: 'dnd',
            note: notes ? String(notes).slice(0, 500) : null,
          });
        } catch (dndErr) {
          console.error('Failed to record DND mark for assignment', assignment.id, ':', dndErr.message);
        }
        try {
          await removeFromQueue({ workerId, donorId: assignment.donor_id });
        } catch (queueErr) {
          console.warn('DND work_queue removal skipped for assignment', assignment.id, ':', queueErr.message);
        }
      }

      // If this assignment had a rejected lead ticket, resolve it
      try {
        const { data: logs } = await db
          .from('fro_donor_logs')
          .select('id')
          .eq('assignment_id', assignment.id)
          .eq('accounts_status', 'rejected')
          .limit(1);
        if (logs && logs.length > 0) {
          const rejectedLogIds = logs.map(l => l.id);
          await db
            .from('rejected_lead_tickets')
            .update({ status: 'resolved' })
            .in('fro_donor_log_id', rejectedLogIds)
            .eq('status', 'pending_review');
        }
      } catch (err) {
        console.error('Failed to resolve rejected lead ticket:', err.message);
      }

      return log;
    });

    // ── The 4-minute disposition window ────────────────────────────────
    // Server-authoritative rule: the window is reset ONLY by a successful,
    // backend-confirmed disposition. Mouse/keyboard/click/scroll/tab activity and
    // non-disposition logs (call, visit, message, follow_up, note, donation) do
    // NOT reset it — they are recorded work, but they do not discharge the
    // disposition the worker still owes. Runs after the transaction commits so a
    // failed save can never hand out free time.
    //
    // The row is keyed on the HUMAN at the keyboard (splitWorkerContext) — the
    // same identity the heartbeat and every status read use. Under work-as the
    // JWT's id is the covered FRO; arming the covered FRO's row instead would
    // leave the operator's own row stale with a lapsed deadline and accrue idle
    // for work they were demonstrably doing. The lead / assignment / credit
    // side above still uses the painted workerId unchanged.
    let timer = null;
    if (action === 'disposition') {
      try {
        const nowMs = Date.now();
        const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
        timer = await resetLiveWindow(humanCtx.id, { nowMs, dbg: 'disposition' });
        // Record the state-machine transition through the event resolver, not a
        // raw set. DISPOSITION_SUCCESS closes an IDLE (or WORKING) interval and
        // opens a fresh WORKING one, but is a no-op while MEETING / PAUSED /
        // INTERNET_PROBLEM is the open state — a raw transition to WORKING would
        // silently end a hold an admin set. The fresh 240s deadline is written by
        // resetLiveWindow above; this only moves the ledger in step with it.
        try {
          await applyTimeEvent(humanCtx.id, TIME_EVENTS.DISPOSITION_SUCCESS, { atMs: nowMs, reason: 'disposition', agentId: agentCtx?.id ?? null });
        } catch (_) { /* ledger absent — non-fatal */ }
      } catch (timerErr) {
        // Non-fatal: the action is already saved; the timer just keeps its
        // previous deadline and the FRO may go idle a little early.
        console.warn('live window reset skipped:', timerErr.message);
      }
    }

    // Saving a disposition is the single most frequent write in the panel and it
    // moves every number the FRO sees: connected/donated counts, target
    // collection, the workable stack and (for a donation) suppression. Drop the
    // cached reads so the refresh the client fires right after this response
    // already sees the new state rather than a pre-disposition payload.
    invalidateFroCaches(req.user.id);

    return res.json({ message: 'Log entry created', data: result, timer });
  } catch (error) {
    if (error && error.code === 'LEAD_CLOSED') {
      return res.status(409).json({ message: error.message });
    }
    if (error && error.code === '23505') {
      // Duplicate same-day disposition prevented by the DB unique index — the
      // save already happened; treat as idempotent success so the front-end
      // advances rather than erroring repeatedly. Still re-arm the human's
      // window so a suppressed duplicate cannot leave them stamped idle.
      try {
        const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
        await resetLiveWindow(humanCtx.id, { nowMs: Date.now() });
      } catch (dupTimerErr) {
        console.warn('duplicate-suppressed live window reset skipped:', dupTimerErr.message);
      }
      console.warn('duplicate same-day disposition suppressed:', error.message);
      return res.status(200).json({ message: 'Already logged — duplicate suppressed', data: null });
    }
    return res.status(500).json({ message: error.message });
  }
};

export const uploadPaymentScreenshot = async (req, res) => {
  try {
    const { file_base64, mime_type } = req.body;

    if (!file_base64) {
      return res.status(400).json({ message: 'File data is required' });
    }

    const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const contentType = mime_type || 'image/jpeg';
    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      return res.status(400).json({ message: `Invalid file type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}` });
    }
    const buffer = Buffer.from(file_base64, 'base64');
    const ext = contentType.split('/')[1] || 'jpg';
    const fileName = `payment_screenshots/${req.user.id}_${Date.now()}.${ext}`;

    let { data: uploadData, error: uploadError } = await db.storage
      .from('worker-documents')
      .upload(fileName, buffer, { contentType, upsert: true });

    if (uploadError) {
      if (uploadError.message?.includes('bucket')) {
        const { error: bucketError } = await db.storage.createBucket('worker-documents', { public: true });
        if (bucketError) {
          return res.status(500).json({ message: 'Failed to create storage bucket: ' + bucketError.message });
        }
        const { data: retryData, error: retryError } = await db.storage
          .from('worker-documents')
          .upload(fileName, buffer, { contentType, upsert: true });
        if (retryError) {
          return res.status(500).json({ message: 'Upload failed: ' + retryError.message });
        }
        uploadData = retryData;
      } else {
        return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
      }
    }

    const { data: publicUrlData } = db.storage
      .from('worker-documents')
      .getPublicUrl(fileName);

    const fileUrl = publicUrlData?.publicUrl;
    if (!fileUrl) return res.status(500).json({ message: 'Failed to get file URL' });

    return res.json({ message: 'Screenshot uploaded', file_url: fileUrl });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

function dispositionDetailToStatus(detail) {
  const map = {
    busy: 'busy',
    ringing: 'ringing',
    call_waiting: 'call_waiting',
    unreachable: 'unreachable',
    switched_off: 'switched_off',
    out_of_coverage: 'out_of_coverage',
    wrong_number: 'wrong_number',
    invalid: 'invalid_number',
    invalid_number: 'invalid_number',
    rejected: 'rejected',
    temporary_network_issue: 'temporary_network_issue',
    voicemail: 'voicemail',
    incoming_out: 'incoming_out',
    lead_done: 'lead_done',
    done: 'done',
    scheduled: 'scheduled',
    callback: 'callback',
    office_visit_scheduled: 'scheduled',
    program_visit_scheduled: 'scheduled',
    visit_donate: 'visit_donate',
    will_donate_online: 'will_donate_online',
    promise_to_pay: 'promise_to_pay',
    payment_pending: 'payment_pending',
    already_donated: 'already_donated',
    email_sent: 'email_sent',
    whatsapp_sent: 'whatsapp_sent',
    csr_inquiry: 'csr_inquiry',
    wants_80g_details: 'wants_80g_details',
    wants_trust_documents: 'wants_trust_documents',
    not_interested_now: 'not_interested_now',
    not_interested: 'not_interested',
    language_barrier: 'language_barrier',
    transferred_senior: 'transferred_senior',
    query_complaint: 'query_complaint',
    receipt_request: 'receipt_request',
    dnd: 'dnd',
    wrong_person: 'wrong_person',
    not_possible: 'not_possible',
    call_disconnected: 'call_disconnected',
    office_program_visit: 'scheduled',
    promise_pay_wa_email: 'promise_to_pay',
    not_interested_np: 'not_interested',
    busy_call_waiting: 'busy',
    ooc_unreachable_network: 'unreachable',
    ringing_voicemail: 'ringing',
    others: 'others',
  };
  return map[detail] || 'contacted';
}

export const scheduleContact = async (req, res) => {
  try {
    const workerId = req.user.id;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { scheduled_at, notes, ngo_id } = req.body;
    if (!scheduled_at) return res.status(400).json({ message: 'scheduled_at is required' });
    if (isNaN(new Date(scheduled_at).getTime())) return res.status(400).json({ message: 'scheduled_at must be a valid date' });

    const assignment = await findOrCreateAssignment(donorId, workerId, ngo_id);
    if (!assignment) return res.status(404).json({ message: 'Donor not found' });

    // Clear any existing pending schedules
    await completeAllScheduledByAssignment(assignment.id);

    const contact = await createScheduledContact({
      assignment_id: assignment.id,
      scheduled_at,
      notes: notes || null,
      created_by: workerId,
    });

    await updateAssignmentStatus(assignment.id, {
      status: 'scheduled',
      last_contacted_at: new Date().toISOString(),
      next_follow_up: istDateString(scheduled_at),
    });

    return res.json({ message: 'Contact scheduled', data: contact });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyTarget = async (req, res) => {
  try {
    const workerId = req.user.id;

    // Re-resolves the monthly target through seven read-all-then-sum helpers and
    // duplicates work getDashboard already does — and the dashboard page fires
    // both on mount. Cache it on its own TTL so a page reload or a tab bounce
    // does not pay for it twice.
    const targetKey = `fro:target:${workerId}:${req.query.month || 'cur'}`;
    const hitTarget = cacheGet(targetKey, FRO_TARGET_TTL_MS);
    if (hitTarget !== undefined) return res.json(hitTarget);

    const worker = await getWorkerBySession(req.user);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });
    const salary = await getActiveSalaryByWorker(workerId);
    const currentSalary = salary ? parseFloat(salary.salary) : 0;

    const now = new Date();
    const monthBounds = istMonthBounds(now);
    const monthStr = monthBounds.month;
    const monthStart = monthBounds.start.toISOString();
    const monthEnd = monthBounds.end.toISOString();

    const [manualTarget, priorTarget] = await Promise.all([
      getTargetByWorker(workerId, monthStr),
      getLatestTargetBeforeMonth(workerId, monthStr),
    ]);
    const resolved = resolveMonthlyTarget({
      joiningDate: worker.created_at,
      salary: currentSalary,
      currentRow: manualTarget,
      priorRow: priorTarget,
      refDate: now,
    });
    const target = resolved.target;
    const targetSource = resolved.source;
    const targetSourceMonth = resolved.sourceMonth;
    const monthsEmployed = resolved.monthsEmployed;
    const achieved_target = resolved.achievedTarget;

    const { allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    const creditWorkerId = req.user.impersonation && req.user.imposter_id ? req.user.imposter_id : workerId;
    const collected = await getTotalCollectedByWorker(creditWorkerId, monthStart, monthEnd);
    const collectedByNgo = await getCollectedByNgo(creditWorkerId, monthStart, monthEnd, allowedNgoIds);

    // Resolve NGO names for the breakdown
    const collectedNgoIds = Object.keys(collectedByNgo).filter(id => id !== 'others');
    const collectedNgoMap = {};
    if (collectedNgoIds.length > 0) {
      const { data: ngoRows } = await db.from('ngos').select('id, name').in('id', collectedNgoIds);
      for (const n of ngoRows || []) collectedNgoMap[n.id] = n.name;
    }
    const collected_by_ngo = Object.entries(collectedByNgo).map(([id, amount]) => ({
      ngo_id: id,
      ngo_name: id === 'others' ? 'Others' : (collectedNgoMap[id] || 'Unknown'),
      amount,
    })).filter(r => r.amount > 0).sort((a, b) => b.amount - a.amount);

    const stats = await getDashboardStats(workerId);

    // Incentive calculation
    let incentive = {
      totalAKI: 0,
      akiPayout: 0,
      monthlyIncentive: 0,
      totalIncentive: 0,
      targetMet: false,
      isNewJoiner: monthsEmployed <= 3,
      akiPerDay: [],
      totalCollectionAKI: 0,
    };
    try {
      const ranges = await getAKISlabs();
      const achievements = await getAchievements(creditWorkerId, monthStart, monthEnd);
      const monthlyAchievement = achievements.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
      const dailyCollection = await getDailyCollectionByWorker(creditWorkerId, monthStart, monthEnd);
      const akiPerDay = Object.entries(dailyCollection || {})
        .map(([date, collection]) => ({
          date,
          collection,
          dayName: getDayName(date),
          aki: calculateAKI(collection, getDayName(date), ranges),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const totalCollectionAKI = akiPerDay.reduce((sum, r) => sum + r.aki, 0);
      const totalAKI = achievements.reduce((sum, r) => {
        return sum + calculateAKI(parseFloat(r.amount || 0), getDayName(r.date), ranges);
      }, 0);
      const monthlyTargetMet = target > 0 && monthlyAchievement >= target;
      if (monthlyTargetMet) {
        const akiPayout = incentive.isNewJoiner ? totalAKI : Math.round(totalAKI / 2);
        const monthlyIncentive = Math.round((monthlyAchievement - target) * 0.1);
        incentive = { totalAKI, akiPayout, monthlyIncentive, totalIncentive: akiPayout + monthlyIncentive, targetMet: true, isNewJoiner: incentive.isNewJoiner, akiPerDay, totalCollectionAKI };
      } else {
        incentive.totalAKI = totalAKI;
        incentive.akiPerDay = akiPerDay;
        incentive.totalCollectionAKI = totalCollectionAKI;
      }
    } catch (err) { console.error('Incentive calculation error:', err); }

    const targetPayload = {
      month: monthStr,
      target,
      target_source: targetSource,
      target_source_month: targetSourceMonth,
      collected,
      collected_by_ngo: collected_by_ngo,
      achieved_target,
      remaining: Math.max(0, target - collected),
      salary: currentSalary,
      months_employed: monthsEmployed,
      stats,
      incentive,
    };
    cacheSet(targetKey, targetPayload);
    return res.json(targetPayload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyStations = async (req, res) => {
  try {
    const workerId = req.user.id;
    const actPairs = froActPairs(req);
    const { data: stations, error } = await db
      .from('fro_station_assignments')
      .select('station, ngo_id, ngos(name)')
      .eq('fro_worker_id', workerId)
      .order('station', { ascending: true });
    if (error) throw error;
    let mapped = (stations || []).map(s => ({
      station: s.station,
      ngo_id: s.ngo_id,
      ngo_name: s.ngos?.name || null,
    }));
    // Acting session: narrow dropdown to claimed stations only (e.g. DH-1 not FD-1)
    if (actPairs && actPairs.length > 0) {
      const allowed = new Set(actPairs.map(p => `${p.ngo_id ?? ''}|${String(p.station ?? '').trim()}`));
      mapped = mapped.filter(s => allowed.has(`${s.ngo_id ?? ''}|${String(s.station ?? '').trim()}`));
    }
    return res.json(mapped);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Read-time self-heal: builds the set of (donor, NGO-project) pairs that already
// have a confirmed receipt in the donor's CURRENT donation period. A donor who
// has already paid must not keep surfacing in reminder work lists (scheduled,
// callbacks, promises) — mirrors fetchScopedDonationEvidence. project_id = the
// NGO name lowercased so money never leaks across NGOs.
async function buildCollectedReceiptEvidence(donorIds, ngoIds) {
  const pairs = new Set();
  if ((donorIds || []).length === 0) return { hasCollected: () => false };
  const [receiptsRes, donorTypesRes] = await Promise.all([
    db.from('receipts').select('donor_id, project_id, receipt_date').in('donor_id', donorIds),
    db.from('donor_profiles').select('id, donor_type, donation_frequency').in('id', donorIds),
  ]);
  const donorTypeMap = {};
  for (const p of donorTypesRes.data || []) donorTypeMap[p.id] = p.donor_type || p.donation_frequency || '';
  const now = new Date();
  for (const r of receiptsRes.data || []) {
    if (!r.receipt_date) continue;
    const key = `${r.donor_id}|${(r.project_id || '').toLowerCase()}`;
    if (new Date(r.receipt_date) >= periodStartForType(donorTypeMap[r.donor_id] || '', now)) pairs.add(key);
  }
  const ngoProjectById = {};
  if ((ngoIds || []).length > 0) {
    const { data: ngoRows } = await db.from('ngos').select('id, name').in('id', ngoIds);
    for (const n of ngoRows || []) ngoProjectById[n.id] = (n.name || '').toLowerCase();
  }
  return {
    hasCollected: (donorId, ngoId) => {
      const project = ngoProjectById[ngoId];
      return project ? pairs.has(`${donorId}|${project}`) : false;
    },
  };
}

export const getFroScheduled = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const { data: contacts, error } = await withStationNgoPairs(
      db
        .from('fro_scheduled_contacts')
        .select('*, fro_assignments!inner(id, donor_id, ngo_id, station, fro_worker_id, ngos(name))')
        .eq('is_completed', false)
        .in('fro_assignments.station', stationNames)
        .order('scheduled_at', { ascending: true }),
      myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'
    );

    if (error) throw error;

    const scopedContacts = filterByScope(contacts, myScope, c => `${c.fro_assignments?.station}|${c.fro_assignments?.ngo_id}`);

    const keepContact = await buildFollowUpOwnerFilter(scopedContacts.map(c => c.fro_assignments).filter(Boolean), req.user);
    const personalContacts = (scopedContacts || []).filter(c => keepContact(c.fro_assignments));

    const donorIds = [...new Set((personalContacts || []).map(c => c.fro_assignments?.donor_id).filter(Boolean))];
    const ngoIds = [...new Set((scopedContacts || []).map(c => c.fro_assignments?.ngo_id).filter(Boolean))];
    const { data: donors } = donorIds.length > 0
      ? await db.from('donor_profiles').select('id, name, mobile_number').in('id', donorIds)
      : { data: [] };
    const donorMap = {};
    for (const d of donors || []) donorMap[d.id] = d;
    const ownerNameMap = await resolveWorkerNames(personalContacts.map(c => c.fro_assignments?.fro_worker_id));

    const { hasCollected } = await buildCollectedReceiptEvidence(donorIds, ngoIds);

    const seen = new Set();
    const result = [];
    for (const c of personalContacts || []) {
      const a = c.fro_assignments;
      if (!a) continue;
      const d = donorMap[a.donor_id];
      if (hasCollected(a.donor_id, a.ngo_id)) continue;
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: a.donor_id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || '',
        owner_id: a.fro_worker_id || null,
        owner_name: ownerNameMap[a.fro_worker_id] || null,
        donor_name: d?.name || 'Unknown',
        donor_mobile: d?.mobile_number || '',
        scheduled_at: c.scheduled_at,
        station: a.station || null,
        schedule_id: c.id,
        schedule_notes: c.notes,
        assignment_id: a.id,
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroCallbacks = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const { data: assignments, error } = await withStationNgoPairs(
      db
        .from('fro_assignments')
        .select('*, ngos!left(name)')
        .in('station', stationNames)
        .in('status', ['follow_up', 'callback']),
      myScope
    );

    if (error) throw error;

    const keep = await buildFollowUpOwnerFilter(assignments || [], req.user);
    const personalAssignments = (assignments || []).filter(a => keep(a));
    const assignmentIds = personalAssignments.map(a => a.id);
    const donorIds = [...new Set(personalAssignments.map(a => a.donor_id).filter(Boolean))];
    const ngoIds = [...new Set(personalAssignments.map(a => a.ngo_id).filter(Boolean))];
    const [donorsRes, schedulesRes] = await Promise.all([
      db.from('donor_profiles').select('id, name, mobile_number')
        .in('id', donorIds),
      assignmentIds.length > 0
        ? db.from('fro_scheduled_contacts').select('assignment_id, scheduled_at').in('assignment_id', assignmentIds).eq('is_completed', false)
        : { data: [] },
    ]);

    const donorMap = {};
    for (const d of donorsRes.data || []) donorMap[d.id] = d;
    const scheduleMap = {};
    for (const s of schedulesRes.data || []) {
      if (!scheduleMap[s.assignment_id]) scheduleMap[s.assignment_id] = s.scheduled_at;
    }
    const ownerNameMap = await resolveWorkerNames(personalAssignments.map(a => a.fro_worker_id));

    const { hasCollected } = await buildCollectedReceiptEvidence(donorIds, ngoIds);

    const seen = new Set();
    const result = [];
    for (const a of personalAssignments) {
      const d = donorMap[a.donor_id];
      if (!d) continue;
      if (hasCollected(a.donor_id, a.ngo_id)) continue;
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: a.donor_id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || '',
        owner_id: a.fro_worker_id || null,
        owner_name: ownerNameMap[a.fro_worker_id] || null,
        donor_name: d.name || 'Unknown',
        donor_mobile: d.mobile_number || '',
        scheduled_at: scheduleMap[a.id] || null,
        station: a.station || null,
        status: a.status,
        next_follow_up: a.next_follow_up,
        assignment_id: a.id,
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Open money-promise leads for the worker: money intent was expressed but not yet
// collected, so the FRO can keep following up. Only uncollected/available
// assignments are returned (disposed/terminal/collected rows are excluded by
// their status not being in the set). Sorted by next follow-up / due date (oldest
// first) so the most-overdue promise surfaces first.
export const getFroPromises = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const { data: assignments, error } = await withStationNgoPairs(
      db
        .from('fro_assignments')
        .select('*, ngos!left(name)')
        .in('station', stationNames)
        .in('status', ['promise_to_pay', 'payment_pending', 'will_donate_online', 'visit_donate', 'whatsapp_sent']),
      myScope
    );

    if (error) throw error;

    const keep = await buildFollowUpOwnerFilter(assignments || [], req.user);
    const personalAssignments = (assignments || []).filter(a => keep(a));

    const assignmentIds = personalAssignments.map(a => a.id);
    const donorIds = [...new Set(personalAssignments.map(a => a.donor_id).filter(Boolean))];
    const ngoIds = [...new Set(personalAssignments.map(a => a.ngo_id).filter(Boolean))];
    const [donorsRes, schedulesRes] = await Promise.all([
      db.from('donor_profiles').select('id, name, mobile_number').in('id', donorIds),
      assignmentIds.length > 0
        ? db.from('fro_scheduled_contacts').select('assignment_id, scheduled_at').in('assignment_id', assignmentIds).eq('is_completed', false)
        : { data: [] },
    ]);

    const donorMap = {};
    for (const d of donorsRes.data || []) donorMap[d.id] = d;
    const scheduleMap = {};
    for (const s of schedulesRes.data || []) {
      if (!scheduleMap[s.assignment_id]) scheduleMap[s.assignment_id] = s.scheduled_at;
    }
    const ownerNameMap = await resolveWorkerNames(personalAssignments.map(a => a.fro_worker_id));

    // Read-time self-heal: a donor only belongs in "Promise to Pay" while their
    // promise is UNCOLLECTED. If they already have a confirmed donation/receipt
    // for this NGO in the current donation period, drop the assignment so a
    // donor who has ALREADY paid stops appearing. Mirrors the receipt/donation
    // evidence used by getMyDonors (fetchScopedDonationEvidence). Uses project_id
    // = the NGO name lowercased so money never leaks across NGOs.
    const { hasCollected } = await buildCollectedReceiptEvidence(donorIds, ngoIds);

    const seen = new Set();
    const result = [];
    for (const a of personalAssignments) {
      const d = donorMap[a.donor_id];
      if (!d) continue;
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      if (hasCollected(a.donor_id, a.ngo_id)) continue;
      seen.add(key);
      result.push({
        id: a.donor_id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || '',
        owner_id: a.fro_worker_id || null,
        owner_name: ownerNameMap[a.fro_worker_id] || null,
        donor_name: d.name || 'Unknown',
        donor_mobile: d.mobile_number || '',
        scheduled_at: scheduleMap[a.id] || null,
        due_date: a.next_follow_up || scheduleMap[a.id] || null,
        station: a.station || null,
        status: a.status,
        next_follow_up: a.next_follow_up,
        assignment_id: a.id,
      });
    }
    result.sort((x, y) => {
      const tx = x.due_date ? new Date(x.due_date).getTime() : Infinity;
      const ty = y.due_date ? new Date(y.due_date).getTime() : Infinity;
      return tx - ty;
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Statuses that mean a lead is finished / not worth chasing — anything else
// Strict overdue rule (mirrors the admin Telecaller O/D split): only
// follow-up-family + promise + callback statuses with a past follow-up date
// count as overdue, no matter how far back the date goes. Leftover
// not-connected statuses (ringing, busy, …) never sit in Overdue.
const FRO_OVERDUE_OPEN_STATUSES = [
  'scheduled', 'follow_up', 'office_visit_scheduled', 'program_visit_scheduled',
  'promise_to_pay', 'will_donate_online', 'payment_pending', 'promise_pay_wa_email',
  'callback',
];

export const getFroOverdue = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const today = istDateString(new Date());
    const nowTs = Date.now();

    // A) Date-based overdues: any open lead whose follow-up date is strictly
    // before today (next_follow_up mirrors the schedule's IST date).
    const { data: dateOverdue, error } = await withStationNgoPairs(
      db
        .from('fro_assignments')
        .select('*, ngos!left(name)')
        .in('station', stationNames)
        .lt('next_follow_up', today)
        .in('status', FRO_OVERDUE_OPEN_STATUSES),
      myScope
    );

    if (error) throw error;

    // B) All un-completed schedule calls in scope. A call whose scheduled time
    // has now passed counts as overdue even when its date-only next_follow_up is
    // still today; a call still in the future means the lead was freshly
    // re-logged as a follow-up — it must NOT stay overdue (it belongs to the
    // Follow Up tab).
    const { data: schedules, error: sErr } = await withStationNgoPairs(
      db
        .from('fro_scheduled_contacts')
        .select('*, fro_assignments!inner(id, donor_id, ngo_id, station, status, fro_worker_id, next_follow_up, last_contacted_at, ngos(name))')
        .eq('is_completed', false)
        .in('fro_assignments.station', stationNames),
      myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'
    );

    if (sErr) throw sErr;

    const freshScheduleAt = new Map();
    const passedScheduleAt = new Map();
    for (const s of schedules || []) {
      const a = s.fro_assignments;
      if (!a) continue;
      const when = new Date(s.scheduled_at).getTime();
      if (when >= nowTs) {
        if (!freshScheduleAt.has(a.id)) freshScheduleAt.set(a.id, s.scheduled_at);
      } else if (!passedScheduleAt.has(a.id)) {
        passedScheduleAt.set(a.id, s.scheduled_at);
      }
    }

    const assignmentById = {};
    for (const a of dateOverdue || []) assignmentById[a.id] = a;
    for (const s of schedules || []) {
      const a = s.fro_assignments;
      if (a && passedScheduleAt.has(a.id) && FRO_OVERDUE_OPEN_STATUSES.indexOf(a.status) !== -1) {
        assignmentById[a.id] = a;
      }
    }
    const assignments = Object.values(assignmentById);

    // Same-day rework rule: an assignment worked at any point today leaves
    // Overdue immediately instead of lingering on its old past follow-up date
    // until tomorrow. Uses last_contacted_at (stamped on every disposition /
    // call / visit, IST day boundary) — immune to log-row quirks, no query.
    const istDayStart = new Date(`${istDateString(new Date())}T00:00:00+05:30`).getTime();
    const workedToday = (a) => {
      if (!a || !a.last_contacted_at) return false;
      const t = new Date(a.last_contacted_at).getTime();
      return Number.isFinite(t) && t >= istDayStart;
    };
    const openAssignments = assignments.filter(a => !workedToday(a));

    const keep = await buildFollowUpOwnerFilter(openAssignments, req.user);
    const personalAssignments = openAssignments.filter(a => keep(a));

    const donorIds = [...new Set(personalAssignments.map(a => a.donor_id).filter(Boolean))];
    const ngoIds = [...new Set(assignments.map(a => a.ngo_id).filter(Boolean))];
    const [donorsRes, receiptsRes, donorTypesRes, ngoRes] = await Promise.all([
      donorIds.length > 0
        ? db.from('donor_profiles').select('id, name, mobile_number').in('id', donorIds)
        : { data: [] },
      donorIds.length > 0
        ? db.from('receipts').select('donor_id, project_id, receipt_date').in('donor_id', donorIds)
        : { data: [] },
      donorIds.length > 0
        ? db.from('donor_profiles').select('id, donor_type, donation_frequency').in('id', donorIds)
        : { data: [] },
      ngoIds.length > 0
        ? db.from('ngos').select('id, name').in('id', ngoIds)
        : { data: [] },
    ]);

    const donorMap = {};
    for (const d of donorsRes.data || []) donorMap[d.id] = d;
    const donorTypeMap = {};
    for (const p of donorTypesRes.data || []) donorTypeMap[p.id] = p.donor_type || p.donation_frequency || '';
    const ngoProjectById = {};
    for (const n of ngoRes.data || []) ngoProjectById[n.id] = (n.name || '').toLowerCase();
    const ownerNameMap = await resolveWorkerNames(personalAssignments.map(a => a.fro_worker_id));

    // Self-heal mirroring getFroPromises: a donor whose current-period follow-up
    // has already converted to a donation/receipt should drop out of overdue.
    const now = new Date();
    const receiptPairsForPeriod = new Set();
    for (const r of receiptsRes.data || []) {
      if (!r.receipt_date) continue;
      const key = `${r.donor_id}|${(r.project_id || '').toLowerCase()}`;
      if (new Date(r.receipt_date) >= periodStartForType(donorTypeMap[r.donor_id] || '', now)) receiptPairsForPeriod.add(key);
    }
    const hasCollected = (a) => {
      const project = ngoProjectById[a.ngo_id];
      return project ? receiptPairsForPeriod.has(`${a.donor_id}|${project}`) : false;
    };

    const typeFromStatus = (status) => {
      if (['promise_to_pay', 'payment_pending', 'will_donate_online', 'visit_donate', 'whatsapp_sent'].includes(status)) return 'promise';
      if (['scheduled', 'callback', 'follow_up', 'office_visit_scheduled', 'program_visit_scheduled'].includes(status)) return 'scheduled';
      return 'callback';
    };

    const seen = new Set();
    const result = [];
    for (const a of personalAssignments) {
      if (freshScheduleAt.has(a.id)) continue; // freshly re-logged as a follow-up -> Follow Up tab, not overdue
      const d = donorMap[a.donor_id];
      if (!d) continue;
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      if (hasCollected(a)) continue;
      seen.add(key);
      const dueBy = passedScheduleAt.get(a.id) || a.next_follow_up || null;
      result.push({
        id: a.donor_id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || '',
        owner_id: a.fro_worker_id || null,
        owner_name: ownerNameMap[a.fro_worker_id] || null,
        donor_name: d.name || 'Unknown',
        donor_mobile: d.mobile_number || '',
        scheduled_at: dueBy,
        due_date: dueBy,
        station: a.station || null,
        status: a.status,
        type: typeFromStatus(a.status),
        is_overdue: true,
        assignment_id: a.id,
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyHistory = async (req, res) => {
  try {
    const workerId = req.user.id;
    // History is attributed to the OWNER of the assignment: a "work as" session
    // writes logs on the impersonated FRO's assignment, so those actions appear
    // in the owner's history (and never come back to the real operator's own
    // account after the session ends).
    // Inside a "work as" session the operator sees only the actions they
    // logged themselves, never the owner's full history.
    let historyQuery = db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(fro_worker_id, donor_id, station, ngo_id, ngos!left(name))')
      .eq('fro_assignments.fro_worker_id', workerId);
    if (req.user.impersonation && req.user.imposter_id != null) {
      historyQuery = historyQuery.or(`operator_id.eq.${realOperatorId(req.user)},fro_worker_id.eq.${realOperatorId(req.user)}`);
    }
    const { data: logs, error } = await historyQuery
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    const donorIds = [...new Set((logs || []).map(l => l.donor_id).filter(Boolean))];
    const { data: donors } = donorIds.length > 0
      ? await db.from('donor_profiles').select('id, name, mobile_number').in('id', donorIds)
      : { data: [] };
    const donorMap = {};
    for (const d of donors || []) donorMap[d.id] = d;
    const ownerNameMap = await resolveWorkerNames((logs || []).map(l => l.fro_assignments?.fro_worker_id));

    const result = (logs || []).map(l => {
      const d = donorMap[l.donor_id] || {};
      return {
        id: l.id,
        donor_id: l.donor_id,
        donor_name: d.name || 'Unknown',
        donor_mobile: d.mobile_number || '',
        action: l.action,
        disposition_category: l.disposition_category,
        disposition_detail: l.disposition_detail,
        notes: l.notes,
        amount_collected: l.amount_collected,
        created_at: l.created_at,
        outcome: l.outcome,
        accounts_status: l.accounts_status,
        ngo_id: l.fro_assignments?.ngo_id || null,
        ngo_name: l.fro_assignments?.ngos?.name || null,
        owner_id: l.fro_assignments?.fro_worker_id || null,
        owner_name: ownerNameMap[l.fro_assignments?.fro_worker_id] || null,
      };
    });
    return res.json(result.reverse());
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const requestData = async (req, res) => {
  try {
    const workerId = req.user.id;
    const ngoId = req.user.ngo_id;
    const { message } = req.body;
    const trimmed = message ? message.trim() : '';
    if (!trimmed) return res.status(400).json({ message: 'Message is required' });
    if (trimmed.length > 2000) return res.status(400).json({ message: 'Message too long (max 2000 characters)' });

    const { data, error } = await db
      .from('fro_data_requests')
      .insert([{ fro_worker_id: workerId, message: trimmed, status: 'pending', ngo_id: req.user.ngo_id || null }])
      .select()
      .single();
    if (error) throw error;

    return res.json({ message: 'Request sent successfully', data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyDataRequests = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { data, error } = await db
      .from('fro_data_requests')
      .select('*')
      .eq('fro_worker_id', workerId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFollowUps = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const { start: todayStart, end: todayEnd } = istDayBounds();

    const { data: contacts, error } = await withStationNgoPairs(
      db
        .from('fro_scheduled_contacts')
        .select('*, fro_assignments!inner(id, donor_id, ngo_id, station, fro_worker_id, ngos(name))')
        .eq('is_completed', false)
        .in('fro_assignments.station', stationNames)
        .gte('scheduled_at', todayStart.toISOString())
        .lte('scheduled_at', todayEnd.toISOString())
        .order('scheduled_at', { ascending: true }),
      myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'
    );

    if (error) throw error;

    const scopedContacts = filterByScope(contacts, myScope, c => `${c.fro_assignments?.station}|${c.fro_assignments?.ngo_id}`);

    const keepContact = await buildFollowUpOwnerFilter(scopedContacts.map(c => c.fro_assignments).filter(Boolean), req.user);
    const personalContacts = (scopedContacts || []).filter(c => keepContact(c.fro_assignments));

    const donorIds = [...new Set((personalContacts || []).map(c => c.fro_assignments?.donor_id).filter(Boolean))];
    const ngoIds = [...new Set((scopedContacts || []).map(c => c.fro_assignments?.ngo_id).filter(Boolean))];
    const { data: donors } = donorIds.length > 0
      ? await db.from('donor_profiles').select('id, name, mobile_number').in('id', donorIds)
      : { data: [] };
    const donorMap = {};
    for (const d of donors || []) donorMap[d.id] = d;

    const { hasCollected } = await buildCollectedReceiptEvidence(donorIds, ngoIds);

    const now = new Date();
    const result = (personalContacts || []).map(c => {
      const a = c.fro_assignments;
      const d = donorMap[a?.donor_id] || {};
      if (!a || hasCollected(a.donor_id, a.ngo_id)) return null;
      return {
        id: c.id,
        donor_id: a?.donor_id,
        ngo_id: a?.ngo_id,
        ngo_name: a?.ngos?.name || '',
        donor_name: d.name || 'Unknown',
        donor_mobile: d.mobile_number || '',
        scheduled_at: c.scheduled_at,
        notes: c.notes,
        assignment_id: a?.id,
        is_overdue: new Date(c.scheduled_at) < now,
      };
    }).filter(Boolean);

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Allotment summary for the logged-in FRO: every donor allotted to them (one
// row per donor, latest assignment, excluding reassigned) counted by its current
// fro_assignments.status. Optional ?month=YYYY-MM narrows to assignments made in
// that IST calendar month; otherwise it is all-time. Optional
// ?batch=new|old narrows the pool to new-data / old-data assignments (same
// batch_type + legacy is_new rule as the My Leads New/Old tabs); default is
// all batches. Powers the FRO activity modal.
export const getMyAllotmentSummary = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json({ worked: 0, by_status: [], allotted_all_time: 0, used_all_time: 0 });

    // Optional ?ngo_id / ?station narrow the pool to one NGO / station.
    // Values outside this FRO's scope yield an empty result — never fall back
    // to the full scope (that would leak other NGOs' data into stale filters).
    const EMPTY = { worked: 0, by_status: [], allotted_all_time: 0, used_all_time: 0 };
    const ngoFilter = req.query.ngo_id || null;
    if (ngoFilter && !allowedNgoIds.includes(ngoFilter)) return res.json(EMPTY);
    const stationFilter = req.query.station && req.query.station !== 'all' ? req.query.station : null;
    if (stationFilter && !stationNames.includes(stationFilter)) return res.json(EMPTY);

    // Attribution in work-as sessions: logs are credited to the acting operator
    // (imposter_id) while assignments stay with the owner. ?actor=self counts
    // only what the acting worker personally did from this data; default
    // (owner) counts everything done on the owner's pool. Outside work-as both
    // are identical.
    const isWorkAs = !!(req.user.impersonation && req.user.imposter_id != null);
    const actorSelf = req.query.actor === 'self' && isWorkAs;
    const creditId = actorSelf ? req.user.imposter_id : workerId;

    const batch = req.query.batch === 'new' ? 'new' : req.query.batch === 'old' ? 'old' : 'all';
    // Same new/old rule as the My Leads tabs: legacy rows have NULL batch_type.
    const inBatch = (row) => {
      if (batch === 'all') return true;
      if (!row) return false;
      return batch === 'new'
        ? (row.batch_type === 'new_data' || (row.batch_type == null && row.is_new !== false))
        : (row.batch_type === 'old_data' || (row.batch_type == null && row.is_new === false));
    };

    // All-time allotment: every unique donor assigned to this FRO (reassigned
    // rows excluded). This is the stable pool — monthly re-inclusion of the same
    // leads does not inflate it.
    const { data: allotRows, error: allotErr } = await withStationNgoPairs(
      db
        .from('fro_assignments')
        .select('donor_id, batch_type, is_new, station, ngo_id')
        .eq('fro_worker_id', workerId)
        .not('status', 'eq', 'reassigned'),
      myScope
    );
    if (allotErr) throw allotErr;

    const allottedIds = new Set();
    for (const r of allotRows || []) {
      if (!r.donor_id || !inBatch(r)) continue;
      if (ngoFilter && String(r.ngo_id) !== String(ngoFilter)) continue;
      if (stationFilter && r.station !== stationFilter) continue;
      allottedIds.add(r.donor_id);
    }

    // Activity is derived from disposition logs: a lead counts in the month the
    // disposition was MADE, not when the lead was allotted. fro_assignments.status
    // only holds the current status, so it can't describe past months. Pull all
    // of the FRO's dispositions once — the same rows drive the all-time "used"
    // count and (filtered) the period breakdown.
    const { data: allRows, error } = await withStationNgoPairs(
      db
        .from('fro_donor_logs')
        .select('id, donor_id, disposition_detail, created_at, fro_assignments!inner(station, ngo_id, batch_type, is_new)')
        .eq('fro_worker_id', creditId)
        .eq('action', 'disposition')
        .in('fro_assignments.station', stationNames),
      myScope,
      'fro_assignments.station',
      'fro_assignments.ngo_id'
    );
    if (error) throw error;
    const rows = (allRows || []).filter(r => {
      if (!inBatch(r.fro_assignments)) return false;
      if (ngoFilter && String(r.fro_assignments?.ngo_id) !== String(ngoFilter)) return false;
      if (stationFilter && r.fro_assignments?.station !== stationFilter) return false;
      return true;
    });

    // Used = allotted leads that have been worked at least once (any disposition,
    // even if a later month reset their status back to pending).
    const usedIds = new Set();
    for (const r of rows || []) {
      if (r.donor_id && r.disposition_detail && allottedIds.has(r.donor_id)) usedIds.add(r.donor_id);
    }

    let periodRows = rows || [];
    const { month } = req.query;
    if (month === 'today') {
      // IST day boundaries (UTC+5:30) against the timestamptz column.
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
      const start = new Date(Date.UTC(y, m, d) - 5.5 * 3600 * 1000).toISOString();
      const end = new Date(Date.UTC(y, m, d + 1) - 5.5 * 3600 * 1000).toISOString();
      periodRows = periodRows.filter(r => r.created_at && r.created_at >= start && r.created_at < end);
    } else if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      // IST month boundaries (UTC+5:30) against the timestamptz column.
      const start = new Date(Date.UTC(y, m - 1, 1) - 5.5 * 3600 * 1000).toISOString();
      const end = new Date(Date.UTC(y, m, 1) - 5.5 * 3600 * 1000).toISOString();
      periodRows = periodRows.filter(r => r.created_at && r.created_at >= start && r.created_at < end);
    }

    // One status per donor: keep each donor's latest disposition in the period so
    // the status counts always add up to the number of leads worked.
    const latestByDonor = new Map();
    for (const r of periodRows) {
      if (!r.donor_id || !r.disposition_detail) continue;
      const key = `${r.created_at || ''}|${r.id ?? 0}`;
      const prev = latestByDonor.get(r.donor_id);
      if (!prev) { latestByDonor.set(r.donor_id, r); continue; }
      const prevKey = `${prev.created_at || ''}|${prev.id ?? 0}`;
      if (key > prevKey) latestByDonor.set(r.donor_id, r);
    }

    const counts = new Map();
    for (const r of latestByDonor.values()) {
      counts.set(r.disposition_detail, (counts.get(r.disposition_detail) || 0) + 1);
    }

    const by_status = [...counts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    return res.json({
      worked: latestByDonor.size,
      by_status,
      allotted_all_time: allottedIds.size,
      used_all_time: usedIds.size,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getLeadStats = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json({ new_donors: 0, new_amount: 0, existing_donors: 0, existing_amount: 0 });

    const month = req.query.month || istMonthKey();
    const monthStart = month + '-01';
    const monthEndDate = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0);
    const monthEnd = monthEndDate.toISOString().slice(0, 10) + 'T23:59:59.999Z';

    const { data: logs, error } = await withStationNgoPairs(
      db
        .from('fro_donor_logs')
        .select('donor_id, amount_collected, fro_assignments!inner(id, station, donor_id, ngo_id)')
        .eq('action', 'donation')
        .in('fro_assignments.station', stationNames)
        .gte('created_at', monthStart)
        .lte('created_at', monthEnd),
      myScope, 'fro_assignments.station', 'fro_assignments.ngo_id'
    );

    if (error) throw error;

    const scopedLogs = filterByScope(logs, myScope, l => `${l.fro_assignments?.station}|${l.fro_assignments?.ngo_id}`);

    const donorIds = [...new Set((scopedLogs || []).map(l => l.donor_id).filter(Boolean))];
    const { data: existingDonations } = donorIds.length > 0
      ? await db
          .from('fro_donor_logs')
          .select('donor_id, amount_collected')
          .in('donor_id', donorIds)
          .eq('action', 'donation')
          .lt('created_at', monthStart)
      : { data: [] };

    const existingSet = new Set((existingDonations || []).map(e => e.donor_id));

    let newDonors = 0, newAmount = 0, existingDonors = 0, existingAmount = 0;
    const donorAmounts = new Map();
    for (const l of scopedLogs || []) {
      const did = l.donor_id;
      const amount = parseFloat(l.amount_collected) || 0;
      donorAmounts.set(did, (donorAmounts.get(did) || 0) + amount);
    }
    for (const [did, amount] of donorAmounts) {
      if (existingSet.has(did)) {
        existingDonors++;
        existingAmount += amount;
      } else {
        newDonors++;
        newAmount += amount;
      }
    }

    return res.json({ new_donors: newDonors, new_amount: newAmount, existing_donors: existingDonors, existing_amount: existingAmount });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMonthlyDonors = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    const month = req.query.month || istMonthKey();

    const monthStart = month + '-01';
    const monthEndDate = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0);
    const monthEnd = monthEndDate.toISOString().slice(0, 10) + 'T23:59:59.999Z';

    const { data: assignments, error } = await withStationNgoPairs(
      db
        .from('fro_assignments')
        .select('*, donor_profiles!inner(id, name, mobile_number, amount, total_amount, donation_count, city), ngos(name)')
        .in('station', stationNames)
        .not('status', 'eq', 'reassigned'),
      myScope
    );

    if (error) throw error;
    if (!assignments || assignments.length === 0) return res.json([]);

    const projectSet = [...new Set(assignments.map(a => (a.ngos?.name ? a.ngos.name.toLowerCase() : null)).filter(Boolean))];
    const donorIds = [...new Set(assignments.map(a => a.donor_id).filter(Boolean))];

    // Per-(donor, NGO) donation aggregates: a receipt only counts toward the
    // exact NGO it was given to, so shared donors never see another NGO's money.
    const scopedStats = new Map();
    if (donorIds.length > 0 && projectSet.length > 0) {
      const { data: scopedReceipts } = await chunkedInQuery(donorIds, chunk =>
        db
          .from('receipts')
          .select('donor_id, project_id, amount')
          .in('donor_id', chunk)
          .in('project_id', projectSet)
      );
      for (const r of scopedReceipts || []) {
        const statsKey = `${r.donor_id}|${(r.project_id || '').toLowerCase()}`;
        const cur = scopedStats.get(statsKey) || { count: 0, total: 0, max: 0 };
        const amt = Number(r.amount) || 0;
        cur.count += 1;
        cur.total += amt;
        if (amt > cur.max) cur.max = amt;
        scopedStats.set(statsKey, cur);
      }
    }

    const { data: existingDonations } = await db
      .from('fro_donor_logs')
      .select('donor_id')
      .in('donor_id', donorIds)
      .eq('action', 'donation')
      .gte('created_at', monthStart)
      .lte('created_at', monthEnd);

    const alreadyDone = new Set((existingDonations || []).map(l => l.donor_id));

    const seen = new Set();
    const result = [];
    for (const a of assignments || []) {
      const key = `${a.donor_id}-${a.ngo_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = a.donor_profiles;
      if (!d || alreadyDone.has(d.id)) continue;
      const statsKey = `${d.id}|${a.ngos?.name ? a.ngos.name.toLowerCase() : ''}`;
      const stats = scopedStats.get(statsKey);
      if (!stats || stats.count < 3) continue;
      result.push({
        donor_id: d.id,
        ngo_id: a.ngo_id,
        ngo_name: a.ngos?.name || '',
        donor_name: d.name || 'Unknown',
        donor_mobile: d.mobile_number || '',
        donor_city: d.city || '',
        amount: stats.max || 0,
        total_donated: stats.total || 0,
        donation_count: stats.count || 0,
      });
    }

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorHistory = async (req, res) => {
  try {
    const workerId = req.user.id;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const period = req.query.period || 'monthly';
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json({ donor: null, logs: [] });

    const now = new Date();
    let startDate;
    if (period === 'financial_year') {
      const year = now.getFullYear();
      startDate = now.getMonth() < 3 ? `${year - 1}-04-01` : `${year}-04-01`;
    } else {
      startDate = istMonthBounds(now).month;
    }

    const { data: checkAccess } = await withStationNgoPairs(
      db
        .from('fro_assignments')
        .select('id, ngo_id, ngos(name)')
        .eq('donor_id', donorId)
        .in('station', stationNames)
        .not('status', 'eq', 'reassigned'),
      myScope
    );
    if (!checkAccess || checkAccess.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const assignmentIds = checkAccess.map(a => a.id);
    const projectSet = [...new Set(checkAccess.map(a => (a.ngos?.name ? a.ngos.name.toLowerCase() : null)).filter(Boolean))];

    const { data: logs, error } = await db
      .from('fro_donor_logs')
      .select('*')
      .in('assignment_id', assignmentIds)
      .gte('created_at', startDate)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const { data: donors } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, amount, total_amount, donation_count, city, pan_number, email, address_1, donor_type')
      .eq('id', donorId)
      .maybeSingle();

    // Also fetch receipts linked directly via donor_id (imported receipts),
    // scoped to the (donor, NGO) assignments the worker holds for this donor.
    let receipts = [];
    if (projectSet.length > 0) {
      const { data: scopedReceipts } = await db
        .from('receipts')
        .select('*')
        .eq('donor_id', donorId)
        .in('project_id', projectSet)
        .order('receipt_date', { ascending: false });
      receipts = scopedReceipts || [];
    }

    // Resolve collector names ("Collected by <name>") on the logs.
    const collectorIds = [...new Set((logs || []).map((l) => l.fro_worker_id).filter(Boolean))];
    const { data: collectors } = collectorIds.length > 0
      ? await db.from('workers').select('id, name').in('id', collectorIds)
      : { data: [] };
    const collectorMap = {};
    for (const w of collectors || []) collectorMap[w.id] = w.name;
    for (const l of logs || []) {
      if (l.fro_worker_id != null && l.fro_worker_id === workerId) {
        l.fro_worker_name = collectorMap[l.fro_worker_id] || null;
      } else {
        l.fro_worker_name = null;
      }
    }

    return res.json({ donor: donors || null, logs: logs || [], receipts: receipts || [] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Book a worker's open idle period into today_idle_seconds and clear
// idle_since + the disposition deadline. Used when the panel's heartbeats are
// about to stop writing this worker's row — a work-as release, an explicit
// logout, or the shift-end sweep — so uncommitted idle survives the handover.
//
// Replaces an earlier hand-rolled version that only banked a stamped
// idle_since and therefore lost the time entirely when a monitor was off or the
// tab had closed (no stamp at all). This derives the period start from the
// disposition deadline, so a lapse with no client cooperation still counts.
export const bookOpenIdleStreak = (workerId) => commitIdleOnExit(String(workerId));

export const updateLiveStatus = async (req, res) => {
  try {
    // The row belongs to the HUMAN at the keyboard, not to the account painted on
    // screen. Under work-as those differ, and the old keying is the root cause of
    // every work-as reporting bug:
    //   - Priya covering Riya filed Priya's activity under Riya, so the strip
    //     showed Riya's numbers and the calls Priya actually logged (already
    //     credited to her in fro_donor_logs) were counted for nobody.
    //   - Two people on screen at once — Priya covering Riya while the real Riya
    //     works her own account — wrote to the SAME row, last write wins. The
    //     work_as_operator_id marker was cleared by the covered FRO's own
    //     heartbeat, one person's idle timer cancelled the other's, and
    //     today_calls / today_talk_seconds merged via the keep-larger rule.
    //   - It left the operator's own row stale with a lapsed disposition_due_at,
    //     which stampLapsedIdle() later backdated to the old deadline — hours of
    //     idle invented for someone who was demonstrably working.
    // Filing on the human removes all of it at the source: one row per person,
    // so nothing can overwrite anything, and the cover relationship is carried by
    // work_as_sessions instead of by a single column on the row.
    // The disposition save (createDonorLogHandler) re-arms through
    // resetLiveWindow on the SAME human id, so a disposition always refreshes
    // the row this heartbeat writes.
    const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
    const workerId = humanCtx.id;

    // Force-logout enforcement: once an admin logs the FRO out (logged_out_at
    // set), reject the heartbeat with 401 so the client's api() clears the
    // token and redirects to /login. This boots stale tabs that missed the
    // fro:force-logout socket event within the next poll / status push. Re-login
    // reopens the session (authController.touchLogin sets logged_out_at null).
    try {
      // Only a logout that happened AFTER this token was issued invalidates it.
      // A stale logged_out_at predating the token (earlier auto/manual logout on
      // the same worker) must not bounce a freshly-issued work-as session — the
      // switch reopens the covered FRO, and the iat guard is the belt-and-
      // suspenders that keeps a direct post-switch force-logout working.
      // Checked against BOTH identities: the switch reopened the covered FRO's
      // session, and a force-logout applied to the operator's own account must
      // still boot the tab driving it.
      const tokenIssuedAt = req.user.iat ? req.user.iat * 1000 : 0;
      const { rows } = await db._pool.query(
        `SELECT user_id, logged_out_at FROM auth_sessions WHERE user_id = ANY($1::text[])`,
        [[String(workerId), String(req.user.id)]]
      );
      const stamped = (rows || []).find(
        r => r.logged_out_at && new Date(r.logged_out_at).getTime() > tokenIssuedAt
      );
      if (stamped) {
        return res.status(401).json({ message: 'Session closed. Please login again.' });
      }
    } catch (e) {
      // auth_sessions may be absent until migration 125 — skip the guard.
    }

    // Agent sessions: keep the cover alive, and make revocation take effect here.
    //
    // The refresh exists because work_as_sessions expires on a fixed TTL chosen
    // for a MANUAL switch, where nobody holds a cover for a whole shift. An agent
    // is the FRO's hands until they log out, so a cover that lapsed at 14:00 on a
    // 10:00 login would stop isCovered() — the absent FRO starts accruing idle for
    // the rest of the shift — and release the station claims so somebody else can
    // cover them. Only agent sessions refresh; manual-switch behaviour is unchanged.
    //
    // The two 401s are why deactivating or reassigning an agent actually takes
    // effect. A JWT is good for 24h, so without this the agent would keep working
    // their old FRO's data until the token expired on its own, and reassignment
    // would silently not apply until then. Checking on every poll (the panel
    // heartbeats continuously) turns an admin action into something enforced
    // within seconds rather than within a day.
    if (req.user?.agent_user_id) {
      const agentRow = await getAgentById(req.user.agent_user_id).catch(() => null);
      if (!agentRow || !agentRow.is_active) {
        return res.status(401).json({ message: 'This agent login is no longer active. Please login again.' });
      }
      // A deliberate work-as switch points the token at another FRO, so
      // req.user.id is then the COVERED target, not the agent's assigned FRO.
      // The mismatch is only the reassignment kick when the session is on the
      // agent's own account; a live cover of somebody else must not be bounced.
      if (!req.user.impersonation && String(agentRow.worker_id) !== String(req.user.id)) {
        return res.status(401).json({ message: 'Your agent assignment has changed. Please login again.' });
      }
      try {
        await refreshCoverExpiry({
          operatorUserId: req.user.agent_user_id,
          targetWorkerId: req.user.id,
        });
      } catch (e) {
        console.warn('[fro] agent cover refresh skipped:', e?.message || String(e));
      }
    }

    const { status, current_donor_name, current_donor_id, today_calls, today_talk_seconds, last_activity_at, force_counters } = req.body;

    if (status && !['online', 'on_call', 'idle', 'offline', 'meeting'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status. Must be one of: online, on_call, idle, offline, meeting' });
    }
    const numericFields = { today_calls, today_talk_seconds };
    for (const [key, val] of Object.entries(numericFields)) {
      if (val !== undefined && (typeof val !== 'number' || val < 0 || !Number.isFinite(val))) {
        return res.status(400).json({ message: `${key} must be a non-negative number` });
      }
    }
    const parseTs = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString();
    };

    const payload = {
      status,
      updated_at: new Date().toISOString(),
    };
    // This row is now the operator's OWN row, so a "who is operating me" marker on
    // it would be self-referential. The cover relationship is authored once at
    // switch/exit in authController (against the covered FRO's row) and read from
    // work_as_sessions; the column is kept only so an old row written before this
    // change cannot leave a stale "being worked by" label behind forever.
    // Agent sessions file their row on the COVERED FRO, which is precisely the row
    // the cover label was authored on at login — keep it so the admin board's
    // "being worked by Agent X" marker does not flicker off on the next heartbeat.
    if (!req.user?.agent_user_id) {
      payload.work_as_operator_id = null;
      payload.work_as_operator_name = null;
    }
    if (current_donor_name !== undefined) payload.current_donor_name = current_donor_name;
    if (current_donor_id !== undefined) payload.current_donor_id = current_donor_id;
    // force_counters is a deliberate rollover/clear push from the panel.
    const forceCounters = req.body.force_counters === true;
    if (last_activity_at !== undefined) payload.last_activity_at = parseTs(last_activity_at);
    // Same-day max-keep for cumulative counters: the heartbeat blind-overwrites
    // fro_live_status, so a second tab/device (or a fresh panel that hasn't
    // hydrated yet) pushing smaller numbers would wipe the day's totals while
    // fro_daily_stats keeps the max — a split between the live and saved
    // numbers. Within the same IST day keep the larger value; a new IST day
    // starts from the client's number.
    const counterFields = { today_calls, today_talk_seconds };
    const incomingCounters = Object.entries(counterFields).filter(([, v]) => v !== undefined);
    let existing = null;
    if (incomingCounters.length > 0) {
      try {
        // The full row, not just the two counter columns. This read used to
        // select 'today_calls, today_talk_seconds, updated_at' only, and the
        // result became `row` for everything below — so whenever the client sent
        // counters, the rollover check, withoutStaleIdle() and the idle total all
        // ran against a row with no idle_since, no today_idle_seconds and no
        // status, i.e. against nothing. The day-rollover fix below is only real if
        // this read actually returns the state it is supposed to act on.
        const { data } = await db
          .from('fro_live_status')
          .select('*')
          .eq('worker_id', workerId)
          .maybeSingle();
        existing = data || null;
        const istDayOf = (v) => {
          const d = new Date(v);
          if (isNaN(d.getTime())) return null;
          return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        };
        const sameDay = existing?.updated_at && istDayOf(existing.updated_at) === istDayOf(Date.now());
        for (const [key, val] of incomingCounters) {
          if (forceCounters || !sameDay) {
            payload[key] = val;
          } else {
            const prev = Number(existing?.[key] || 0);
            payload[key] = Math.max(prev, val);
          }
        }
      } catch {
        for (const [key, val] of incomingCounters) payload[key] = val;
      }
    }

    // ── Disposition deadline → idle ──────────────────────────────────────
    // The server owns this rule. A 4-minute window starts at login and resets
    // on every recorded disposition (createDonorLogHandler). Once it lapses the
    // FRO is idle and stays idle until they press Resume — a client that keeps
    // pushing 'online' cannot dodge it. Idle only accrues inside the shift.
    const nowMs = Date.now();
    const shift = await getShiftWindowMs(workerId, nowMs);
    let row = existing;
    if (!row) {
      const { data: prev } = await db
        .from('fro_live_status')
        .select('*')
        .eq('worker_id', workerId)
        .maybeSingle();
      row = prev || null;
    }
    const inShift = withinShift(shift, nowMs);
    const shiftStartMs = shift?.startMs;
    const paused = !!(row?.is_paused);

    // Day rollover. UNCONDITIONAL, and no longer conditional on idle_since.
    //
    // The old code cleared today's counters here only when the worker happened to
    // be inside an open idle period at the boundary:
    //
    //     if (cleaned.idle_since === null && row.idle_since) payload.today_idle_seconds = 0;
    //
    // Finish a day with idle_since = NULL — resumed, signed out, or the exit path
    // already banked the period — and the reset never ran. Yesterday's committed
    // total stayed in the row, today's idle was added on top, and the daily
    // snapshot (written with GREATEST, so it can only rise) recorded the running
    // total as a single day. That is where 52h19m of idle in one row came from.
    //
    // The counters now belong to the day in stats_date, full stop. A different day
    // banks the old numbers against the old date and starts today at zero, so this
    // cannot be skipped by whatever state the worker left behind.
    const roll = await rollCountersForNewDay(workerId, row, nowMs, { dbg: 'heartbeat' });
    if (roll.rolled) {
      payload.today_idle_seconds = 0;
      payload.idle_since = null;
      payload.disposition_due_at = null;
      // Yesterday's grace is spent, and the grant below re-issues today's on the
      // same beat when the FRO is on shift. settleUntilMs already rejects a
      // previous-day value at read time, so this is hygiene rather than
      // correctness — but it keeps the row describing only the day it holds.
      payload.settle_until = null;
    }
    payload.stats_date = roll.statsDate;
    if (roll.rolled) row = { ...row, today_idle_seconds: 0, idle_since: null, disposition_due_at: null };

    // End-of-day cleanup for the interval ledger: a panel closed overnight leaves
    // HIDDEN/IDLE open, and the next reader would clip that into today — billing
    // the FRO for the hours between their shift start and their login, before they
    // were at their desk. Close anything still open from a previous IST day at that
    // day's end, so today starts from their first real beat.
    if (roll.rolled) {
      try {
        await closeSessionOpenedBeforeDay(workerId, { nowMs });
      } catch (ledgerDayErr) {
        console.warn('[fro-time] day-boundary interval close skipped:', ledgerDayErr.message);
      }
    }

    // withoutStaleIdle still clears a stale idle_since/disposition_due_at, but its
    // counter zeroing is deliberately NOT honoured: the rollover above is now the
    // only thing that resets a counter, because it is the only thing that knows
    // which day the counter belongs to. Honouring this one would drop a genuine
    // same-day total on a row whose idle_since and stats_date happen to disagree.
    const committedForToday = roll.rolled ? 0 : Number(row?.today_idle_seconds || 0) || 0;
    const cleaned = withoutStaleIdle(row, shift, nowMs);
    if (cleaned !== row) {
      if (cleaned.idle_since === null && row.idle_since) {
        payload.idle_since = null;
      }
      row = { ...cleaned, today_idle_seconds: committedForToday };
    }

    // The window is NOT armed here directly. A heartbeat is presence, not work,
    // so arming on raw presence restarted the 4 minutes seconds after login and
    // trapped the FRO in the idle overlay before they could log anything.
    //
    // What replaced it is two handshakes further down (see the settle block): a
    // one-time 3-minute grace on first presence of the day, and then the ordinary
    // window arms itself. The overlay is also no longer blocking, so the original
    // lockout no longer exists — but arming the full window immediately on login
    // would still start the clock before the FRO had settled in, which is what the
    // grace is for. From then on every disposition resets the window.

    if (status === 'on_call' && current_donor_name) {
      payload.call_started_at = new Date().toISOString();
    }
    if (status === 'online') {
      payload.call_started_at = null;
    }

    // Force idle once the deadline is gone. Paused FROs and the meeting freeze
    // are exempt — the admin is holding them, not the FRO dawdling.
    //
    // The decision uses the same "idle right now" predicate every reader answers
    // with (isIdleNow), so the header pill (status column) and the countdown
    // (is_idle / seconds_left) can never disagree. The status/idle_since fields
    // are deliberately NOT carried in the payload upsert below: resetLiveWindow()
    // re-arms the row concurrently on every disposition save, and a heartbeat
    // that read the row one moment before that reset would otherwise upsert
    // status back to 'idle' onto a freshly re-armed row — future deadline,
    // idle_since cleared — the welded state that read "status idle + timer 3:00"
    // in one response. Idle is applied by a guarded UPDATE that only matches a
    // row whose deadline is STILL in the past at write time.
    // A held row (meeting / admin pause) is frozen: the server must stop its
    // countdown exactly like the client's, never force idle, and stamp when the
    // freeze began. rowFrozen is the state we just read; nowFrozen is what THIS
    // heartbeat says, so a transition can be told apart from steady state. When
    // this heartbeat is itself the freeze signal, idle must NOT be forced — that
    // would strip the meeting status and the row would never register as held.
    const rowFrozen = (row?.is_paused === true) || (row?.status === 'meeting');
    const nowFrozen = paused || status === 'meeting';
    const idleActive = !nowFrozen && isIdleNow(row, shift, nowMs);
    let idleStartMs = NaN;
    if (idleActive) {
      delete payload.status;
      delete payload.idle_since;
      delete payload.current_donor_id;
      delete payload.call_started_at;
      // Idle starts when the 4 minutes actually ran out, not when the next
      // heartbeat noticed — otherwise every heartbeat interval goes unpaid.
      // Clamped to the shift start so a stale earlier deadline can't credit
      // time from before the FRO's day began.
      const dueMs = dispositionDueMs(row);
      idleStartMs = Number.isFinite(dueMs)
        ? (Number.isFinite(shiftStartMs) ? Math.max(dueMs, shiftStartMs) : dueMs)
        : NaN;
    } else if (payload.status === 'idle') {
      // A client claiming 'idle' without a lapsed deadline is a stale tab; let
      // Resume own the idle transition.
      payload.status = row?.idle_since ? 'idle' : (status || undefined);
      if (payload.status !== 'idle') delete payload.status;
    }

    // Freeze bookkeeping. A meeting or admin pause must freeze the SERVER's
    // countdown exactly like the client's. frozen_at marks the moment the freeze
    // began, and every read caps open idle there, so time inside the window is
    // held work time — never idle. On the heartbeat that lifts the freeze the
    // deadline is re-armed to a fresh window, so the response cannot read a
    // deadline that lapsed mid-window back as idle. frozen_at is deliberately
    // KEPT on lift: it still caps any idle that had already begun when the freeze
    // started, and is inert once that period is resolved (the cap only bites a
    // period that began at or before frozen_at).
    if (nowFrozen) {
      // Entering a freeze stamps its start, refreshed for a new freeze but never
      // slid forward while one is already in progress.
      if (!rowFrozen || !row?.frozen_at) {
        payload.frozen_at = new Date(nowMs).toISOString();
      }
    } else if (rowFrozen) {
      // The freeze lifted THIS heartbeat (the pre-read row was still held). Give
      // back a fresh window so a deadline that lapsed mid-freeze cannot read back
      // as idle. Skipped when the FRO is still carrying an idle period from
      // before the freeze: they stay idle (Resume re-arms), so a window here
      // would only paint the forbidden "idle + 4:00" state.
      payload.disposition_due_at = nextDeadline(shift, nowMs);
    }

    // Settle-in grace, then the window arms on its own.
    //
    // The window used to open only on the FRO's first recorded action, so the
    // clock stayed frozen until then and logging in to sit on the panel was free:
    // with no deadline on the row there was no lapse for any reader to derive an
    // idle period from. Three minutes to settle are granted on first presence of
    // the day, and the first heartbeat at or after they run out arms the ordinary
    // 4-minute window. Seven minutes from login before any idle can accrue.
    //
    // Placed after the freeze block so a held row is settled first: settleGrant and
    // settleWindowArm both stand down while paused or in a meeting, and the lift
    // above has already handed back a full window by then.
    //
    // The payload check covers that lift: a FRO who froze before ever being granted
    // a grace is handed a full window when the freeze lifts, so granting one here
    // would burn the day's only grace on a row that already has a clock.
    //
    // These are otherwise mutually exclusive in one heartbeat. A grant writes
    // settle_until, which settleWindowArm reads off `row` — still without it — so
    // the window cannot arm in the same beat that the grace is handed out.
    if (!nowFrozen && !payload.disposition_due_at) {
      const grant = settleGrant(row, shift, nowMs);
      if (grant) {
        payload.settle_until = grant;
      } else {
        const armed = settleWindowArm(row, shift, nowMs);
        if (armed) payload.disposition_due_at = armed;
      }
    }

    // today_idle_seconds holds COMMITTED time only. The still-running period
    // lives in idle_since (or is derivable from an already-lapsed deadline when
    // the FRO's machine is off) and is added on read (liveIdleSeconds) and when
    // it is finally committed (Resume / disposition / sign-out / auto-logout).
    // Writing the derived total here would keep the period open and the next
    // read would add it a second time. Take whichever is larger so neither the
    // server-derived open period nor a client-pushed committed value is lost.
    const derivedIdle = Math.max(
      liveIdleSeconds(row, shift, nowMs),
      Number(payload.today_idle_seconds ?? row?.today_idle_seconds ?? 0) || 0
    );

    const { error } = await db
      .from('fro_live_status')
      .upsert({ worker_id: workerId, ...payload }, { onConflict: 'worker_id' });
    if (error) throw error;

    // Apply the idle state only if the row is STILL past its deadline at write
    // time. A disposition reset (resetLiveWindow) re-arms the row concurrently:
    // when it wins this race no row matches and the client's pushed status
    // survives, so a fresh 4-minute window can never read back as idle. The
    // status/idle_since are written here (guarded), NOT in the upsert above,
    // because that upsert was built from a pre-read that the reset can invalidate
    // between read and write.
    if (idleActive) {
      const idleStartIso = Number.isFinite(idleStartMs) ? new Date(idleStartMs).toISOString() : null;
      await db._pool.query(
        `UPDATE fro_live_status
            SET status = 'idle',
                idle_since = COALESCE(idle_since, $2),
                current_donor_id = NULL,
                call_started_at = NULL,
                updated_at = now()
          WHERE worker_id = $1
            AND (status IS NULL OR status <> 'meeting')
            AND (is_paused IS NOT TRUE)
            AND (
              (disposition_due_at IS NOT NULL AND disposition_due_at <= $3)
              OR (idle_since IS NOT NULL AND idle_since <= $3)
            )`,
        [workerId, idleStartIso, new Date(nowMs).toISOString()]
      );
    }

    // Daily activity snapshot: the live row is a single "today" bucket, so the
    // previous day's totals are lost without this. Routed through the shared
    // writer so the day-attribution rule and the 24h cap apply here exactly as
    // they do on the resume and exit paths — this upsert used to be a private copy
    // that nothing else kept in step with.
    try {
      const istDay = istDateStr(new Date(nowMs));
      // Idle is authoritative from the interval ledger. `derivedIdle` is only the
      // legacy fallback for a worker whose day predates the ledger roll-out, so a
      // pre-migration panel still reports the total it always did.
      const ledgerIdle = await ledgerIdleForDate(workerId, istDay, shift);
      const daily = {
        talk_seconds: today_talk_seconds,
        calls: today_calls,
        idle_seconds: ledgerIdle != null ? ledgerIdle : derivedIdle,
      };
      if (Object.values(daily).some(v => v !== undefined)) {
        await writeDailySnapshot(workerId, istDay, daily, {
          extraCapMs: Number.isFinite(shift?.startMs) && Number.isFinite(shift?.endMs)
            ? Math.max(0, shift.endMs - shift.startMs)
            : NaN,
          dbg: 'heartbeat',
        });
      }
    } catch (e) {
      // Non-fatal: fro_daily_stats may be absent until migration 126 is applied.
    }

    // CRM presence heartbeat: any live-status write means the user is active on
    // the CRM — keep their login session fresh for Telecaller Performance. If
    // the session row is missing (e.g. a panel resumed from a saved token never
    // re-POSTs /auth/login) it is created here so presence self-heals. An
    // explicit logout is NOT auto-cleared: online is derived from the fresh
    // heartbeat too, so a logged-out session must stay auditable.
    try {
      await db._pool.query(
        `INSERT INTO auth_sessions (user_id, client, name, role, logged_in_at, last_active_at, logged_out_at)
         VALUES ($1, 'crm', $2, $3, now(), now(), NULL)
         ON CONFLICT (user_id) DO UPDATE SET last_active_at = now()`,
        [String(workerId), req.user?.name || null, req.user?.role || null]
      );
    } catch (e) {
      // Non-fatal: auth_sessions may be absent until migration 125 is applied.
    }

    // The response carries the authoritative timer state so the client's
    // countdown and idle popup never drift from what the server just decided.
    let fresh = null;
    try {
      const { data } = await db.from('fro_live_status').select('*').eq('worker_id', workerId).maybeSingle();
      fresh = data || null;
    } catch (_) { /* non-fatal: the client falls back to its local mirror */ }

    // Record the heartbeat's implied state in the authoritative interval ledger.
    // This is idempotent: a beat that reports the already-open state writes
    // nothing. Non-fatal while the ledger migration is rolling out.
    const beatState = fresh?.is_paused ? TIME_STATES.PAUSED
      : fresh?.status === 'meeting' ? TIME_STATES.MEETING
        : !withinShift(shift, Date.now()) ? TIME_STATES.OFF_SHIFT
          : isIdleNow(fresh, shift, Date.now()) ? TIME_STATES.IDLE
            : TIME_STATES.WORKING;
    try {
      await transitionTimeState(workerId, beatState, { atMs: Date.now(), reason: 'heartbeat', agentId: agentCtx?.id ?? null });
    } catch (ledgerErr) {
      // Not fatal to the heartbeat, but a failure here means the authoritative
      // ledger is not being fed. Surface it instead of swallowing it: an empty
      // fro_time_sessions should read as "broken write", not "no activity".
      console.warn('[fro-time] heartbeat ledger write skipped:', ledgerErr.message);
    }

    let timeStatus = null;
    try {
      timeStatus = await computeTimeStatus({ workerId, liveRow: fresh, shift, nowMs: Date.now(), agentId: agentCtx?.id ?? null });
    } catch (_) { /* non-fatal */ }

    return res.json({
      message: 'Status updated',
      status: fresh?.status ?? status ?? null,
      disposition_due_at: fresh?.disposition_due_at ?? null,
      seconds_left: secondsLeft(fresh, Date.now()),
      // The settle-in grace, if one is running. Informational only: it never
      // touches idle, and the client's job is just to show it counting down so
      // the FRO knows when the real window starts. settle_until comes back even
      // once it has run out, which is what stops a spent grace from being granted
      // a second time mid-session.
      settle_until: fresh?.settle_until ?? null,
      settle_seconds_left: settleSecondsLeft(fresh || {}, Date.now()),
      ...(timeStatus ? toStatusPayload(timeStatus) : {
        // Fallback if the ledger compute failed for any reason.
        is_idle: isIdleNow(fresh, shift, Date.now()),
        today_idle_seconds: liveIdleSeconds(fresh || {}, shift, Date.now()),
      }),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// resumeOwnIdle was removed along with POST /fro/status/resume-idle. It folded
// the open idle period into today and handed back a fresh 4-minute window
// without the FRO doing any work, which made idle free to shrug off: the idle
// seconds were still charged, but the cost of missing the window was a button
// press rather than a disposition. The disposition path is now the only exit and
// charges the same period, back-dating idle_since to the expired deadline so a
// late disposition is not treated more leniently than a fast one.

// ─── Progress Save/Restore ──────────────────────────────────────

// Panel progress (which tab / batch / donor index the person is on) follows the
// HUMAN, matching the live row. It is per-person view state, not the account's:
// two people working the same covered FRO's queue each keep their own cursor
// rather than overwriting one another on the shared row.
export const getMyProgress = async (req, res) => {
  try {
    const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
    const { data } = await db
      .from('fro_live_status')
      .select('new_donor_id, old_donor_id, new_donor_index, old_donor_index, data_tab, current_batch_id, station')
      .eq('worker_id', humanCtx.id)
      .maybeSingle();
    return res.json(data || {});
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const saveMyProgress = async (req, res) => {
  try {
    const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
    const workerId = humanCtx.id;
    const { new_donor_id, old_donor_id, new_donor_index, old_donor_index, data_tab, current_batch_id, station } = req.body;
    const payload = {
      current_batch_id: current_batch_id || null,
      station: station || null,
      updated_at: new Date().toISOString(),
    };
    // data_tab is optional: it is ONLY written when explicitly provided (a manual
    // tab switch). An auto-fallback Old<->New shunt omits it, so the FRO's saved
    // tab is never overwritten by an automatic switch. The *_id/_index fields are
    // written independently of data_tab so the worked tab's position is always
    // persisted regardless of which one data_tab points at.
    if (data_tab !== undefined && data_tab) payload.data_tab = data_tab;
    if (new_donor_id !== undefined) payload.new_donor_id = new_donor_id || null;
    if (new_donor_index !== undefined) payload.new_donor_index = new_donor_index ?? null;
    if (old_donor_id !== undefined) payload.old_donor_id = old_donor_id || null;
    if (old_donor_index !== undefined) payload.old_donor_index = old_donor_index ?? null;

    await db
      .from('fro_live_status')
      .upsert({ worker_id: workerId, ...payload }, { onConflict: 'worker_id' });
    return res.json({ message: 'Progress saved' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Admin (NGO admin / super admin): log out every open FRO session at once.
// Closes auth_sessions (drives "online/offline" + Logouts Today), appends a
// logout event per FRO, flips live status to offline, and broadcasts
// fro:force-logout so every open FRO panel clears its token and lands on the
// login screen. The heartbeat 401 guard (updateLiveStatus) then makes sure a
// stale tab that missed the socket event is still pushed to login within the
// next poll. Re-login reopens the session normally (authController.touchLogin).
export const logoutAllFros = async (req, res) => {
  try {
    const nowIso = new Date().toISOString();

    // Open FRO sessions: login tokens carry role 'fro'; sweep by role OR by
    // worker record (department fro) so every FRO panel is picked up regardless
    // of how its session row was written.
    let sessions = [];
    try {
      const { rows } = await db._pool.query(
        `SELECT user_id, name, role FROM auth_sessions
         WHERE logged_out_at IS NULL
           AND (role = 'fro' OR user_id IN (SELECT id::text FROM workers WHERE lower(trim(department)) = 'fro'))`
      );
      sessions = rows;
    } catch (e) {
      // auth_sessions may be absent until migration 125 is applied.
      sessions = [];
    }

    const userIds = sessions.map((s) => s.user_id).filter(Boolean);

    if (userIds.length > 0) {
      try {
        for (const s of sessions) {
          await db._pool.query(
            `INSERT INTO auth_logout_events (user_id, client, name, role, logged_out_at)
             VALUES ($1, 'crm', $2, $3, $4)`,
            [s.user_id, s.name || null, s.role || 'fro', nowIso]
          );
        }
      } catch (e) {
        // Non-fatal: logout log may be absent — presence close is the core part.
      }
      try {
        await db._pool.query(
          `UPDATE auth_sessions SET logged_out_at = $2
           WHERE logged_out_at IS NULL AND user_id = ANY($1::text[])`,
          [userIds, nowIso]
        );
      } catch (e) {
        // Non-fatal.
      }
      try {
        await db._pool.query(
          `UPDATE fro_live_status SET status = 'offline', updated_at = $2
           WHERE worker_id = ANY($1::text[])`,
          [userIds, nowIso]
        );
      } catch (e) {
        // Non-fatal: live status row may not exist for every session.
      }
      // Fold each session's open idle period into their day BEFORE marking them
      // offline. This endpoint used to stop at presence: the sessions closed but
      // the open interval and lapsed deadline stayed on the row, so the board
      // kept deriving idle for somebody who had just been logged out — the same
      // complaint as a manual sign-out that never stops.
      for (const s of sessions) {
        try {
          await commitIdleOnExit(String(s.user_id));
        } catch (e) {
          // Non-fatal: continue with the rest of the batch.
        }
      }
    }

    emitRealtime('fro:force-logout', { at: nowIso });

    return res.json({
      message: userIds.length > 0 ? `${userIds.length} FRO session(s) logged out` : 'No open FRO sessions to log out',
      loggedOut: userIds.length,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Clear Idle Time (super-admin) ─────────────────────────────────────
//
// The escape hatch for a bad disposition day: the 4-minute timer misfires, or
// the office loses connectivity long enough for every panel to stop beating, and
// the whole team shows as Idle with a salary deduction accruing. One click ends
// the still-running idle period for everyone on shift and hands each FRO a full
// fresh window.
//
// DELIBERATELY does not zero today_idle_seconds. The old button did, and it was
// two bugs in one:
//  - fro_daily_stats.idle_seconds is written with GREATEST(...), so it only ever
//    rises. Zeroing the live row could not lower the day's saved total — it just
//    made this panel disagree with the daily/monthly report it reads from.
//  - Idle that has already been banked is real, and it is what salary is
//    computed from. The problem this button solves is idle that is still
//    COUNTING, not idle that has already happened.
//
// So: committed totals are preserved, the open period is cleared. The window is
// only re-armed for FROs actually inside their shift — arming one for someone
// off-shift leaves a lapsed deadline waiting for their next login, which is the
// "signed in and instantly idle" bug this whole change set was fixing.
export const resetAllFroIdle = async (req, res) => {
  return res.status(410).json({ message: 'Idle time functionality has been removed' });
};

// FRO self-resume: a paused worker taps Play in the blocking pause popup.
// Same row update as the admin resume (plus the converging socket event).
export const resumeOwnPause = async (req, res) => {
  try {
    // The pause lives on the HUMAN's own row now — the same row the heartbeat
    // writes and getMyLiveStatus reads — so one row is the whole truth again.
    //
    // The old code cleared both the operator's and the covered FRO's rows
    // because a work-as session wrote the target's row and the read path merged
    // the two. Both halves of that are gone, so this is a single-row update and
    // the "resume runs on a loop" failure (the panel re-converging to paused
    // because the other row was still paused) cannot recur.
    const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const ids = [String(humanCtx.id)];

    // A deadline that lapsed inside the pause must not read back as idle: the
    // pause held the clock, so hand the FRO a fresh window instead of letting the
    // spent deadline decide they were idle while an admin held them. frozen_at is
    // left in place — it still caps any idle that began before the pause, and is
    // inert once that period is resolved.
    let reArmIso;
    try {
      const { data } = await db
        .from('fro_live_status')
        .select('disposition_due_at')
        .eq('worker_id', ids[0])
        .maybeSingle();
      const dueMs = dispositionDueMs(data || {});
      if (Number.isFinite(dueMs) && nowMs >= dueMs) {
        const shift = await getShiftWindowMs(ids[0], nowMs);
        reArmIso = nextDeadline(shift, nowMs);
      }
    } catch (_) {
      // Non-fatal: a missing shift just leaves the deadline as it was.
    }

    // Update, never upsert: a resume must not manufacture a live row for a
    // worker who has never opened the panel (no row already means "not paused").
    const patch = { is_paused: false, paused_at: null, paused_by: null, updated_at: nowIso };
    if (reArmIso) patch.disposition_due_at = reArmIso;
    const { error } = await db
      .from('fro_live_status')
      .update(patch)
      .in('worker_id', ids);
    if (error) throw error;

    // The admin FRO Status page is served from a 15s cached payload, so without
    // this the pill still reads "Paused" right after a successful resume — which
    // is exactly what made this look like the resume had been undone.
    bustTlCache();
    for (const id of ids) emitRealtime('fro:resume', { at: nowIso, by: 'self' }, `worker:${id}`);
    return res.json({ message: 'Resumed', paused: false });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Authoritative time-state events ─────────────────────────────
//
// The single event ingress for the server-authoritative time machine. The client
// reports discrete, meaningful events (page hidden, meeting start, pause, network
// lost, …) and the server decides the resulting interval in the ledger. Nothing
// here trusts a client clock or a client-computed duration: only the event name
// matters, and the server stamps the time.
//
// Held states (MEETING / PAUSED / INTERNET_PROBLEM) win over HIDDEN/SLEEPING, and
// OFF_SHIFT is derived from the shift window rather than reported by the client.
export const applyFroTimeEvent = async (req, res) => {
  try {
    const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
    const event = String(req.body?.event || '');
    const allowed = Object.values(TIME_EVENTS);
    if (!allowed.includes(event)) {
      return res.status(400).json({ message: `Invalid event. Expected one of: ${allowed.join(', ')}` });
    }
    const nowMs = Date.now();
    let result;
    try {
      result = await applyTimeEvent(humanCtx.id, event, { atMs: nowMs, reason: event, agentId: agentCtx?.id ?? null });
    } catch (ledgerErr) {
      // The ledger table may not be migrated yet. Fail loud so an operator sees
      // it, but do not silently drop the event onto the legacy columns either.
      console.warn('time event ledger write skipped:', ledgerErr.message);
      return res.status(503).json({ message: 'Time ledger unavailable' });
    }

    const shift = await getShiftWindowMs(humanCtx.id, nowMs);
    // Leaving a held state (internet recovered, meeting/pause ended) hands back a
    // fresh 4-minute window: the clock was paused for the duration of the hold, so
    // the old deadline must not be left lapsed and then reconciled straight to
    // IDLE on this very event. Only fires when the handler actually transitioned
    // to WORKING, so a spurious/repeat end event is a no-op.
    if (result?.changed && result.state === TIME_STATES.WORKING
      && (event === TIME_EVENTS.NETWORK_ONLINE || event === TIME_EVENTS.CONNECTIVITY_RECOVERED
        || event === TIME_EVENTS.MEETING_END || event === TIME_EVENTS.PAUSE_END)) {
      try {
        const deadline = nextDeadline(shift, nowMs);
        if (deadline) {
          await db.from('fro_live_status')
            .update({ disposition_due_at: deadline, updated_at: new Date(nowMs).toISOString() })
            .eq('worker_id', humanCtx.id);
        }
      } catch (_) { /* non-fatal: the heartbeat's own freeze-lift still re-arms */ }
    }
    let row = null;
    try {
      const { data } = await db.from('fro_live_status').select('*').eq('worker_id', humanCtx.id).maybeSingle();
      row = data || null;
    } catch (_) { /* non-fatal */ }
    // A time event is a meaningful interaction too: reconcile a lapsed deadline
    // before reporting, so a PAGE_VISIBLE that arrives after the window expired
    // cannot resurrect WORKING — only a successful disposition may clear IDLE.
    try {
      await reconcileDispositionIdle({ workerId: humanCtx.id, liveRow: row, shift, nowMs });
    } catch (_) { /* non-fatal */ }
    let timeStatus = null;
    try {
      timeStatus = await computeTimeStatus({ workerId: humanCtx.id, liveRow: row, shift, nowMs, agentId: agentCtx?.id ?? null });
    } catch (_) { /* non-fatal */ }

    return res.json({
      message: 'Time event applied',
      event,
      changed: !!result?.changed,
      ...(timeStatus ? toStatusPayload(timeStatus) : {}),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// FRO's own live status row — used to restore today's counters in memory on panel
// load (the client no longer mirrors these into localStorage).
//
// Under "work as" this is the OPERATOR's own row, not the covered FRO's: the row
// is filed on the person at the keyboard, so the timer, deadline and pause state
// returned here all belong to them.
export const getMyLiveStatus = async (req, res) => {
  try {
    // Read the human's own row — the same row updateLiveStatus() writes. Under
    // work-as this used to read the covered FRO's row, which meant the panel was
    // hydrated with another person's idle timer, disposition deadline and pause
    // state, so the Resume overlay and countdown belonged to the wrong person.
    //
    // The old "merge the operator's paused flag into the target's row" hack is
    // gone for the same reason: there is only one row now, so there is nothing
    // left to merge. A pause on the operator's row is simply read directly.
    const { human: humanCtx, agent: agentCtx } = splitWorkerContext(req.user);
    const { data } = await db
      .from('fro_live_status')
      .select('*')
      .eq('worker_id', humanCtx.id)
      .maybeSingle();
    let row = data || null;
    if (!row) return res.json(null);
    // Rehydrate the panel with the authoritative timer: the deadline, the
    // seconds left on it, and idle time including the period still running.
    const nowMs = Date.now();
    const shift = await getShiftWindowMs(humanCtx.id, nowMs);
    // Sign-in must not inherit yesterday's idle. The heartbeat drops these on
    // its first run, but the panel hydrates before that, so a stale idle_since
    // or an expired deadline would flash the Resume overlay on every login.
    // Read the row as if that heartbeat had already cleaned it.
    row = withoutStaleIdle(row, shift, nowMs);
    // Lazily reconcile the authoritative ledger: if the disposition deadline has
    // passed and the open interval is still WORKING, this read is the "meaningful
    // interaction" that moves the worker to IDLE — retrospectively from the
    // deadline, so no client heartbeat is required. Idempotent, and non-fatal
    // while the ledger migration rolls out.
    try {
      await reconcileDispositionIdle({ workerId: humanCtx.id, liveRow: row, shift, nowMs });
    } catch (_) { /* non-fatal: the legacy settle below still owns idle */ }
    // The window lapsed but nothing ever pushed the stamp, so the row's stored
    // total still disagrees with the stretch being derived from the deadline.
    // Settle it now so this panel and every stored-column reader agree. Guarded
    // locally first so the common cases cost no extra query.
    // The ledger is the authority on held states. A lapsed deadline while the
    // worker is in an approved hold (MEETING / PAUSED / INTERNET_PROBLEM) must not
    // be stamped as idle — the hold paused the clock. The live row cannot express
    // INTERNET_PROBLEM, so consult the open interval.
    let ledgerState = null;
    try {
      const open = await getOpenSession(humanCtx.id);
      ledgerState = open?.state || null;
    } catch (_) { /* non-fatal: no ledger → legacy behaviour */ }
    if (!row?.idle_since && !row?.is_paused && row?.status !== 'meeting' && !isHeldState(ledgerState)) {
      const dueNow = dispositionDueMs(row);
      if (Number.isFinite(dueNow) && nowMs >= dueNow
        && istDateStr(new Date(dueNow)) === istDateStr(new Date(nowMs))
        && withinShift(shift, nowMs)) {
        const stamped = await stampLapsedIdle(humanCtx.id, nowMs);
        if (stamped) row = { ...row, idle_since: row.disposition_due_at, status: 'idle' };
      }
    }
    // The clock is NOT armed here. This endpoint is read-only, and the panel
    // hydrates a moment before the first heartbeat anyway — which is where the
    // settle-in grace is granted and where the window arms itself once that grace
    // has run out (see updateLiveStatus). Arming on load would mean a GET decided
    // billing state. All this needs to do is report the grace truthfully so the
    // countdown is correct the instant the panel paints.
    const due = row.disposition_due_at || null;
    // The authoritative time state + day totals come from the interval ledger.
    // The legacy idle fields below are DERIVED from the same result (Q2), so
    // there is exactly one idle calculation in the system.
    let timeStatus;
    try {
      timeStatus = await computeTimeStatus({ workerId: humanCtx.id, liveRow: row, shift, nowMs, agentId: agentCtx?.id ?? null });
    } catch (timeErr) {
      console.warn('time-status compute skipped:', timeErr.message);
      timeStatus = null;
    }
    return res.json({
      ...row,
      disposition_due_at: due,
      seconds_left: secondsLeft({ disposition_due_at: due }, nowMs),
      settle_seconds_left: settleSecondsLeft(row, nowMs),
      in_shift: withinShift(shift, nowMs),
      ...(timeStatus ? toStatusPayload(timeStatus) : {}),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getLiveStatuses = async (req, res) => {
  try {
    let query = db
      .from('fro_live_status')
      .select('*, workers!inner(id, name, login_id, ngo_id, is_active, department)')
      .order('updated_at', { ascending: false });

    const { ngo_id: filterNgoId, fro_id: filterFroId, scope } = req.query;
    if (filterFroId) {
      query = query.eq('worker_id', filterFroId);
    }
    // scope=all: list every FRO across NGOs (used by the NGO-admin FRO Status
    // page). An explicit ngo_id filter still applies when given.
    if (filterNgoId && filterNgoId !== 'all') {
      query = query.eq('workers.ngo_id', filterNgoId);
    } else if (scope !== 'all' && req.user.ngo_id && req.user.role !== 'super_admin' && !filterFroId) {
      query = query.eq('workers.ngo_id', req.user.ngo_id);
    }

    const { data: liveStatuses, error } = await query;
    if (error) throw error;
    if (!liveStatuses || liveStatuses.length === 0) return res.json([]);

    const workerIds = liveStatuses.map(ls => ls.worker_id);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const todayStr = istNow.toISOString().slice(0, 10);
    const todayStart = new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 0, 0, 0, 0)).toISOString();
    const todayEnd = new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 23, 59, 59, 999)).toISOString();

    const [ngoData, attendanceData, collectionData, assignmentData] = await Promise.all([
      db
        .from('worker_ngo_allocations')
        .select('worker_id, ngos(name)')
        .in('worker_id', workerIds),
      db
        .from('attendance')
        .select('worker_id, status, punch_in_time, punch_out_time')
        .eq('date', todayStr)
        .in('worker_id', workerIds),
      db
        .from('fro_donor_logs')
        .select('amount_collected, fro_worker_id, action, disposition_detail, accounts_status, created_at, verified_at')
        .in('fro_worker_id', workerIds)
        .or(
          `and(action.eq.donation,created_at.gte.${todayStart},created_at.lte.${todayEnd}),` +
          `and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified,verified_at.gte.${todayStart},verified_at.lte.${todayEnd}),` +
          `and(disposition_detail.eq.done,action.eq.disposition,created_at.gte.${todayStart},created_at.lte.${todayEnd})`
        ),
      db
        .from('fro_assignments')
        .select('fro_worker_id, status')
        .in('fro_worker_id', workerIds),
    ]);

    const ngoMap = {};
    (ngoData.data || []).forEach(a => {
      if (a.ngos?.name) ngoMap[a.worker_id] = a.ngos.name;
    });

    const punchedInSet = new Set();
    // Per-FRO shift bounds straight from today's punch times, so the idle figure
    // shown to an admin is clamped exactly like the FRO's own. No attendance row
    // (a remote login with no punch) means no clamp here — the heartbeat path
    // still clamps what it writes using the configured shift times.
    const shiftMap = {};
    (attendanceData.data || []).forEach(a => {
      if (a.status === 'present' || a.status === 'late') punchedInSet.add(a.worker_id);
      const inMs = a.punch_in_time ? new Date(a.punch_in_time).getTime() : NaN;
      if (Number.isFinite(inMs)) {
        const outMs = a.punch_out_time ? new Date(a.punch_out_time).getTime() : NaN;
        shiftMap[a.worker_id] = { startMs: inMs, endMs: Number.isFinite(outMs) ? outMs : Infinity };
      }
    });
    const shiftFallback = { startMs: -Infinity, endMs: Infinity };

    const collectionMap = {};
    (collectionData.data || []).forEach(log => {
      const wid = log.fro_worker_id;
      if (wid) collectionMap[wid] = (collectionMap[wid] || 0) + parseFloat(log.amount_collected || 0);
    });

    const statsMap = {};
    (assignmentData.data || []).forEach(a => {
      if (!statsMap[a.fro_worker_id]) {
        statsMap[a.fro_worker_id] = { total: 0, contacted: 0, donation_collected: 0, follow_up: 0 };
      }
      const s = statsMap[a.fro_worker_id];
      s.total++;
      const status = (a.status || '').toLowerCase();
      if (['contacted', 'donation_collected', 'follow_up', 'scheduled', 'callback', 'lead_done', 'done', 'payment_pending', 'already_donated', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'not_interested', 'not_interested_now', 'dnd', 'wrong_person', 'call_disconnected'].includes(status)) {
        s.contacted++;
      }
      if (status === 'donation_collected' || status === 'lead_done' || status === 'done') {
        s.donation_collected++;
      }
      if (status === 'follow_up') {
        s.follow_up++;
      }
    });

    // Cover relationships, from work_as_sessions. This endpoint was work-as blind:
    // it read each row's own status, so an operator driving a covered panel showed
    // whatever their own row said (usually offline) while the covered FRO's stale
    // row still claimed "online". With rows filed on the human, the covered FRO's
    // row simply goes quiet — which is correct — but the screen has to say WHY,
    // and must not render a stale status as if the person were still there.
    let coversByTarget = new Map();
    try {
      coversByTarget = await getActiveCoversForTargets(workerIds);
    } catch (e) {
      // work_as_sessions unavailable — fall through to the row's display label.
    }

    const nowMs = Date.now();
    const result = liveStatuses.map(ls => {
      const stats = statsMap[ls.worker_id] || { total: 0, contacted: 0, donation_collected: 0, follow_up: 0 };
      const dataUsed = stats.contacted + stats.donation_collected;
      // Talk and Calls are "today" counters on the same row, so a row nobody has
      // logged into since yesterday is still holding yesterday's figures. liveIdleSeconds
      // now drops the idle half of that; these two need the same treatment or the
      // board mixes a stale idle with a stale talk time and the productivity share
      // is computed from two different days. Read-only: the rollover belongs to the
      // write paths, and an admin refreshing a page must not reset anyone's ledger.
      const staleDay = isCounterDayStale(ls, nowMs);
      const talkSeconds = staleDay ? 0 : (ls.today_talk_seconds || 0);
      const callCount = staleDay ? 0 : (ls.today_calls || 0);
      const productivity = talkSeconds > 0 ? 100 : null;

      const coverers = (coversByTarget.get(String(ls.worker_id)) || [])
        .map(c => c.operatorName).filter(Boolean);
      const isCoveredFro = coverers.length > 0;
      const rowFresh = ls.updated_at && (nowMs - new Date(ls.updated_at).getTime()) <= IDLE_LIVE_FRESH_MS;
      const selfOnline = isWorkerOnline(ls.worker_id);
      // A covered FRO who is not themselves present is away, not idle-and-present:
      // their row went quiet because somebody else is working their panel, and
      // rendering the frozen status would put a person in the "present" column
      // who is not at their desk.
      //
      // Being covered is not the same as being away, so this needs BOTH halves: a
      // covered FRO at their own desk keeps a fresh row, must stay idle-or-present
      // like anybody else, and is the chain case (Riya present, covering Meera).
      // Only the covered-and-quiet combination freezes.
      const staleStatus = isCoveredFro && !rowFresh && !selfOnline;
      // Their idle stops at the last moment their own row was written, so neither
      // the day total nor the running streak keeps climbing for someone who has
      // already gone home. The period itself is left on the row untouched — it is
      // their idle to claim if they come back, and the commit guards decide
      // whether it is ever banked.
      const frozenAt = staleStatus ? idleFreezeCutoffMs(ls) : NaN;
      // Idle includes the period still running, clamped to the FRO's shift —
      // same number the FRO sees, so the admin view can't disagree with them.
      const idleSeconds = liveIdleSeconds(ls, shiftMap[ls.worker_id] || shiftFallback, nowMs, frozenAt);

      return {
        id: ls.id,
        worker_id: ls.worker_id,
        // A lapsed disposition deadline means idle even if the row still says
        // otherwise, and a row still holding idle_since is idle until Resume.
        // A paused or meeting row is exempt — the admin/meeting is holding them.
        // A covered-away row is exempt too and reads offline: a lapsed deadline
        // on somebody who was never at the desk is not idle, it is the phantom
        // accrual this whole distinction exists to stop.
        status: !staleStatus && (ls.idle_since || deadlinePassed(ls, nowMs)) && !ls.is_paused && ls.status !== 'meeting'
          ? 'idle'
          : (staleStatus ? 'offline' : ls.status),
        // Who is working this person's stations, from work_as_sessions (with the
        // live row's display column as a fallback for rows predating the switch).
        work_as_operator_name: isCoveredFro
          ? coverers.join(', ')
          : (ls.work_as_operator_name || null),
        is_covered: isCoveredFro,
        // Live-socket presence (panel open right now). Admins can prefer this
        // over updated_at age for "offline?" decisions — rows only move on
        // real events now that timer heartbeats are gone.
        socket_online: selfOnline,
        is_paused: !!ls.is_paused,
        paused_by: ls.paused_by || null,
        paused_at: ls.paused_at || null,
        current_donor_name: ls.current_donor_name,
        current_donor_id: ls.current_donor_id,
        call_started_at: ls.call_started_at,
        disposition_due_at: ls.disposition_due_at || null,
        worker: {
          name: ls.workers?.name || 'Unknown',
          login_id: ls.workers?.login_id || '',
          ngo_id: ls.workers?.ngo_id,
          ngo_name: ngoMap[ls.worker_id] || '',
          is_active: ls.workers?.is_active !== false,
          is_punched_in: punchedInSet.has(ls.worker_id),
          department: ls.workers?.department || '',
        },
        performance: {
          today_calls: callCount,
          today_talk_seconds: talkSeconds,
          today_idle_seconds: idleSeconds,
          idle_minutes: Math.floor(idleSeconds / 60),
          today_collection: collectionMap[ls.worker_id] || 0,
          total_data: stats.total,
          data_used: dataUsed,
          data_unused: stats.total - dataUsed,
          data_usage_pct: stats.total > 0 ? Math.round((dataUsed / stats.total) * 100) : 0,
          productivity_pct: productivity,
        },
        computed: {
          call_duration_seconds: ls.status === 'on_call' && ls.call_started_at
            ? Math.floor((Date.now() - new Date(ls.call_started_at).getTime()) / 1000) : null,
          idle_duration_seconds: ls.idle_since
            // Clamped to the FRO's shift like every other idle figure, so a row
            // left idle overnight cannot show an absurd "48h idle" to an admin.
            ? openIdleSeconds(ls, shiftMap[ls.worker_id] || shiftFallback, nowMs, frozenAt)
            : null,
          last_seen: ls.updated_at,
        },
        updated_at: ls.updated_at,
      };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Everyone punched in through the attendance app today, scoped to the admin's
// NGO(s). Deliberately NOT derived from fro_live_status the way getLiveStatuses
// is: staff who have not opened the CRM panel have no live row at all, so
// attendance is the only roster that actually knows who is in the building.
// Each member is annotated with their CRM presence so the two views can be
// compared side by side.
export const getPresentToday = async (req, res) => {
  try {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const todayStr = new Date(Date.now() + istOffset).toISOString().slice(0, 10);

    // 1. Attendance punches for today. Same shape the FRO Status page already
    //    uses, so this stays on query patterns known to work against this DB.
    //    'half-day' counts as in: it is derived from a real punch-in (see
    //    attendanceStatus.resolveStatus), and excluding it would hide people
    //    who are standing in the office. Gating on punch_in_time being set
    //    keeps out half-days that come from approved leave with no punch.
    const { data: attendanceRows, error: attErr } = await db
      .from('attendance')
      .select('worker_id, status, punch_in_time, punch_out_time, late_minutes')
      .eq('date', todayStr)
      .in('status', ['present', 'late', 'half-day'])
      .not('punch_in_time', 'is', null);
    if (attErr) throw attErr;

    const members = attendanceRows || [];
    if (members.length === 0) {
      return res.json({ date: todayStr, total: 0, present: 0, late: 0, in_crm: 0, members: [] });
    }

    const ids = [...new Set(members.map(a => a.worker_id).filter(Boolean).map(String))];
    if (ids.length === 0) {
      return res.json({ date: todayStr, total: 0, present: 0, late: 0, in_crm: 0, members: [] });
    }

    // 2. NGO scope. Filtered here in JS (every query below is a plain
    //    .in('id'/'worker_id', ids)) so no embedded-resource filter is needed.
    let ngoIds = [];
    try {
      const access = await getUserNgoAccess(req.user.id, req.user.role);
      ngoIds = [...new Set(access.map(a => a.ngo_id).filter(Boolean).map(String))];
    } catch { /* fall back to the user's own ngo_id below */ }
    if (ngoIds.length === 0 && req.user.ngo_id) ngoIds = [String(req.user.ngo_id)];

    const { ngo_id: filterNgoId } = req.query;
    const wantsAll = filterNgoId === 'all';
    // super_admin with no allocation rows manages every NGO.
    const scopeAll = req.user.role === 'super_admin' && ngoIds.length === 0;

    const [workerRes, liveRes, allocRes] = await Promise.all([
      db.from('workers').select('id, name, login_id, department, ngo_id, is_active').in('id', ids),
      db.from('fro_live_status').select('worker_id, status, is_paused, updated_at').in('worker_id', ids),
      db.from('worker_ngo_allocations').select('worker_id, ngos(name)').in('worker_id', ids),
    ]);

    const workerMap = {};
    (workerRes.data || []).forEach(w => { workerMap[String(w.id)] = w; });
    const liveMap = {};
    (liveRes.data || []).forEach(l => { liveMap[String(l.worker_id)] = l; });
    const ngoNameMap = {};
    (allocRes.data || []).forEach(a => { if (a.ngos?.name) ngoNameMap[String(a.worker_id)] = a.ngos.name; });

    // Punch times are formatted to IST server-side: the client must not redo
    // timezone maths on a device whose clock/timezone we do not trust.
    const fmtIst = (v) => {
      if (!v) return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return null;
      const ist = new Date(d.getTime() + istOffset);
      const hh = String(ist.getUTCHours()).padStart(2, '0');
      const mm = String(ist.getUTCMinutes()).padStart(2, '0');
      const ampm = ist.getUTCHours() >= 12 ? 'PM' : 'AM';
      const h12 = ist.getUTCHours() % 12 === 0 ? 12 : ist.getUTCHours() % 12;
      return `${h12}:${mm} ${ampm}`;
    };

    const result = members
      .map((a) => {
        const key = String(a.worker_id);
        const w = workerMap[key] || null;
        const live = liveMap[key] || null;
        return {
          worker_id: a.worker_id,
          name: w?.name || 'Unknown',
          login_id: w?.login_id || '',
          department: w?.department || '',
          ngo_id: w?.ngo_id || null,
          ngo_name: ngoNameMap[key] || '',
          is_active: w?.is_active !== false,
          attendance_status: a.status,
          late_minutes: a.late_minutes || 0,
          punch_in_time: a.punch_in_time || null,
          punch_out_time: a.punch_out_time || null,
          punch_in_label: fmtIst(a.punch_in_time),
          punch_out_label: fmtIst(a.punch_out_time),
          // CRM presence, purely informational — attendance is the source of
          // truth for this list.
          in_crm: !!live,
          crm_status: live?.status || null,
          is_paused: !!live?.is_paused,
          last_crm_heartbeat: live?.updated_at || null,
        };
      })
      .filter((m) => {
        if (scopeAll || wantsAll) return true;
        if (filterNgoId) return String(m.ngo_id) === String(filterNgoId);
        return ngoIds.includes(String(m.ngo_id));
      });

    // Earliest punch-in first: that is the order the office cares about.
    result.sort((a, b) => {
      const av = a.punch_in_time ? new Date(a.punch_in_time).getTime() : Infinity;
      const bv = b.punch_in_time ? new Date(b.punch_in_time).getTime() : Infinity;
      return av - bv || a.name.localeCompare(b.name);
    });

    return res.json({
      date: todayStr,
      total: result.length,
      present: result.filter(m => m.attendance_status === 'present').length,
      late: result.filter(m => m.attendance_status === 'late').length,
      half_day: result.filter(m => m.attendance_status === 'half-day').length,
      in_crm: result.filter(m => m.in_crm).length,
      members: result,
    });
  } catch (error) {
    console.error('getPresentToday error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const searchDonors = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { q, disposed } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const searchTerm = `%${q.trim()}%`;

    // Disposed-only mode: return donors this FRO has already dispositioned.
    // FRO dispositions are written to fro_donor_logs (not donor_logs), and the
    // "disposed leads of today also" requirement means today's dispositions
    // must show up too. All dispositions (today + past) are returned, enriched
    // with station + latest disposition detail.
    if (disposed === 'true') {
      const { data: disposedLogs, error: logErr } = await db
        .from('fro_donor_logs')
        .select('donor_id, assignment_id, disposition_detail, disposition_category, created_at')
        .eq('fro_worker_id', workerId)
        .eq('action', 'disposition')
        .order('created_at', { ascending: false });
      if (logErr) throw logErr;

      const disposedDonorIds = [...new Set((disposedLogs || []).map(l => l.donor_id).filter(Boolean))];
      if (disposedDonorIds.length === 0) return res.json([]);

      const { data: donors, error } = await db
        .from('donor_profiles')
        .select('id, name, mobile_number, city, amount, total_amount, donation_count, email, pan_number, address_1, birth_date, project_supported, last_donation_date, first_donation_date, donor_type')
        .in('id', disposedDonorIds)
        .or(`name.ilike.${searchTerm},mobile_number.ilike.${searchTerm}`)
        .limit(20);
      if (error) throw error;
      if (!donors || donors.length === 0) return res.json([]);

      const matchedIds = donors.map(d => d.id);

      const { scope: myScope, stationNames } = await getMyStationScope(workerId, froActPairs(req));
      // Same station/NGO narrowing as the default branch: a disposed-lead
      // search must not surface stations the caller is not currently viewing.
      let dScope = myScope || [];
      let dStations = stationNames;
      if (req.query.station && req.query.station !== 'all') {
        dScope = dScope.filter(s => s.station === req.query.station);
        dStations = [req.query.station];
      }
      if (req.query.ngo_id) {
        dScope = dScope.filter(s => s.ngo_id === req.query.ngo_id);
        dStations = dScope.map(s => s.station);
      }
      if (dStations.length === 0) return res.json([]);
      const scopePairs = new Set(dScope.filter(s => s.ngo_id && s.station).map(s => `${s.station}|${s.ngo_id}`));

      const { data: assignments } = await db
        .from('fro_assignments')
        .select('*, ngos!inner(name)')
        .in('donor_id', matchedIds)
        .in('station', dStations)
        .not('status', 'eq', 'reassigned')
        .order('station', { ascending: true });

      const scopedAssignments = (assignments || []).filter(a => scopePairs.has(`${a.station}|${a.ngo_id}`));

      // Latest disposition per donor (from the same fro_donor_logs source so
      // today's dispositions — including lead_done/donation — are included).
      const latestDispMap = {};
      for (const dl of disposedLogs || []) {
        if (matchedIds.includes(dl.donor_id) && !latestDispMap[dl.donor_id]) {
          latestDispMap[dl.donor_id] = dl;
        }
      }

      const result = [];
      const seen = new Set();
      for (const d of donors) {
        const matchingAssignments = scopedAssignments.filter(a => a.donor_id === d.id);
        for (const a of matchingAssignments) {
          const key = `${d.id}-${a.ngo_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const disp = latestDispMap[d.id];
          result.push({
            donor_id: d.id,
            ngo_id: a.ngo_id,
            ngo_name: a.ngos?.name || 'Unknown',
            assignment_id: a.id,
            station: a.station || '',
            batch_type: a.batch_type || '',
            donor_name: d.name || 'Unknown',
            donor_mobile: d.mobile_number || '',
            donor_city: d.city || '',
            donor_amount: d.amount || 0,
            donor_email: d.email || '',
            donor_pan: d.pan_number || '',
            donor_project: d.project_supported || '',
            donor_dob: d.birth_date || '',
            donor_type: d.donor_type || '',
            donor_address: d.address_1 || '',
            donation_count: d.donation_count || 0,
            total_donated: d.total_amount || 0,
            has_donated_current_month: false,
            has_verified_donation_current_month: false,
            status: 'disposed',
            disposition_detail: disp?.disposition_detail || '',
            disposition_category: disp?.disposition_category || '',
            disposed_at: disp?.created_at || null,
          });
        }
      }
      return res.json(result);
    }

    // Default: search all donors in scope (not disposed-filtered)
    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json([]);

    // Narrow to the station/NGO the caller is actually looking at. Without this
    // the search spans EVERY station the FRO holds, so a FRO with AOD-5 and
    // AOD-7 saw each other's donors under the wrong station label. Only an
    // explicit station/ngo_id request narrows; no params = whole scope (the
    // historical behaviour, still used when the FRO views "all stations").
    let effScope = myScope || [];
    let effStations = stationNames;
    if (req.query.station && req.query.station !== 'all') {
      effScope = effScope.filter(s => s.station === req.query.station);
      effStations = [req.query.station];
    }
    if (req.query.ngo_id) {
      if (!allowedNgoIds.includes(req.query.ngo_id)) return res.json([]);
      effScope = effScope.filter(s => s.ngo_id === req.query.ngo_id);
      effStations = effScope.map(s => s.station);
    }
    if (effStations.length === 0) return res.json([]);

    const scopePairs = new Set(effScope.filter(s => s.ngo_id && s.station).map(s => `${s.station}|${s.ngo_id}`));

    // A search fires on every pause in typing, and these two reads are the
    // expensive part: the first materialises EVERY in-scope donor id into a
    // multi-thousand-element IN list, the second runs an un-indexable
    // leading-wildcard ILIKE across it. Cache the id list per scope so
    // consecutive searches skip that read entirely, and cache the finished result
    // per term so a retyped or back-spaced query is answered from memory.
    // invalidateFroCaches() drops both when the FRO's scope or leads change.
    const scopeKey = `fro:search:${workerId}:${[...scopePairs].sort().join(',')}`;
    const resultKey = `${scopeKey}:${searchTerm}`;
    const hitResult = cacheGet(resultKey, FRO_SEARCH_TTL_MS);
    if (hitResult !== undefined) return res.json(hitResult);

    let donorIdsInScope = cacheGet(scopeKey, FRO_SEARCH_SCOPE_TTL_MS);
    if (donorIdsInScope === undefined) {
      const { data: donorIdsFromStation } = await db
        .from('fro_assignments')
        .select('donor_id, ngo_id, station')
        .in('station', effStations)
        .not('status', 'eq', 'reassigned');

      donorIdsInScope = [...new Set(
        (donorIdsFromStation || [])
          .filter(a => scopePairs.has(`${a.station}|${a.ngo_id}`))
          .map(a => a.donor_id)
          .filter(Boolean)
      )];
      cacheSet(scopeKey, donorIdsInScope);
    }
    if (donorIdsInScope.length === 0) return res.json([]);

    const { data: donors, error } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, city, amount, total_amount, donation_count, email, pan_number, address_1, birth_date, project_supported, last_donation_date, first_donation_date, donor_type')
      .in('id', donorIdsInScope)
      .or(`name.ilike.${searchTerm},mobile_number.ilike.${searchTerm}`)
      .limit(20);

    if (error) throw error;
    if (!donors || donors.length === 0) {
      cacheSet(resultKey, []);
      return res.json([]);
    }

    const matchedIds = donors.map(d => d.id);

    const { data: assignments, error: asgnError } = await db
      .from('fro_assignments')
      .select('*, ngos!inner(name)')
      .in('donor_id', matchedIds)
      .in('station', effStations)
      .not('status', 'eq', 'reassigned')
      .order('station', { ascending: true });
    if (asgnError) throw asgnError;

    const scopedAssignments = (assignments || []).filter(a => scopePairs.has(`${a.station}|${a.ngo_id}`));

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const projectSet = [...new Set(scopedAssignments.map(a => (a.ngos?.name ? a.ngos.name.toLowerCase() : null)).filter(Boolean))];
    const evidence = await fetchScopedDonationEvidence({
      assignments: scopedAssignments,
      donorIds: matchedIds,
      projectSet,
      oneYearAgo: oneYearAgo.toISOString(),
    });

    const result = [];
    const seen = new Set();
    for (const d of donors) {
      const matchingAssignments = scopedAssignments.filter(a => a.donor_id === d.id);
      if (matchingAssignments.length === 0) continue;
      for (const a of matchingAssignments) {
        const key = `${d.id}-${a.ngo_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pair = `${a.donor_id}|${a.ngos?.name ? a.ngos.name.toLowerCase() : ''}`;
        const hasScoped = evidence.activeAssignmentIds.has(a.id) || evidence.receiptPairs.has(pair);
        const donatedThisPeriod = evidence.periodDonatedAssignmentIds.has(a.id) || evidence.receiptPeriodPairs.has(pair);
        const rawStatus = a.status || 'pending';
        // Same policy as getMyDonors: only donation_collected resets across a
        // period boundary; lead_done/done are terminal and stay hidden.
        const staleDoneStatus = rawStatus === 'donation_collected' && !donatedThisPeriod;
        const workableStatuses = new Set(['pending', 'busy', 'ringing', 'call_waiting', 'switched_off', 'out_of_coverage', 'unreachable', 'wrong_number', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail', 'incoming_out']);
        const displayStatus = staleDoneStatus
          ? 'pending'
          : (donatedThisPeriod && workableStatuses.has(rawStatus) ? 'donation_collected' : rawStatus);
        result.push({
          donor_id: d.id,
          ngo_id: a.ngo_id,
          ngo_name: a.ngos?.name || 'Unknown',
          assignment_id: a.id,
          station: a.station || '',
          batch_type: a.batch_type || '',
          donor_name: d.name || 'Unknown',
          donor_mobile: d.mobile_number || '',
          donor_city: d.city || '',
          donor_amount: hasScoped ? (d.amount || 0) : 0,
          donor_email: d.email || '',
          donor_pan: d.pan_number || '',
          donor_project: d.project_supported || '',
          donor_dob: d.birth_date || '',
          donor_type: d.donor_type || '',
          donor_address: d.address_1 || '',
          donation_count: hasScoped ? (d.donation_count || 0) : 0,
          total_donated: hasScoped ? (d.total_amount || 0) : 0,
          has_donated_current_month: donatedThisPeriod,
          has_verified_donation_current_month: evidence.periodVerifiedAssignmentIds.has(a.id) || evidence.receiptPeriodPairs.has(pair),
        status: displayStatus,
        });
      }
    }

    cacheSet(resultKey, result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyDisposedLeads = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { station: stationFilter, ngo_id: ngoFilter } = req.query;

    let disposedQuery = db
      .from('fro_donor_logs')
      .select('donor_id, assignment_id, disposition_detail, disposition_category, created_at, fro_assignments!inner(fro_worker_id)')
      .eq('fro_assignments.fro_worker_id', workerId);
    if (req.user.impersonation && req.user.imposter_id != null) {
      disposedQuery = disposedQuery.or(`operator_id.eq.${realOperatorId(req.user)},fro_worker_id.eq.${realOperatorId(req.user)}`);
    }
    const { data: disposedLogs, error: logErr } = await disposedQuery
      // History is scoped to THIS billing month's work. The daily rollover
      // archives the previous month's call logs out of fro_donor_logs anyway,
      // but that runs at 04:00 IST — a hard clamp here keeps the 1st-of-month
      // history clean even in the hours before the archive runs, and keeps
      // "this month's disposed" true regardless of job timing.
      .gte('created_at', istMonthBounds(new Date()).month)
      .order('created_at', { ascending: false })
      .limit(500);
    if (logErr) throw logErr;
    if (!disposedLogs || disposedLogs.length === 0) return res.json([]);

    const disposedDonorIds = [...new Set(disposedLogs.map(l => l.donor_id).filter(Boolean))];
    if (disposedDonorIds.length === 0) return res.json([]);

    const { scope: myScope, stationNames } = await getMyStationScope(workerId, froActPairs(req));
    const scopePairs = new Set((myScope || []).filter(s => s.ngo_id && s.station).map(s => `${s.station}|${s.ngo_id}`));

    let effectiveStations = stationNames;
    let effectiveScope = myScope;
    if (stationFilter && stationFilter !== 'all') {
      effectiveStations = [stationFilter];
      effectiveScope = (myScope || []).filter(s => s.station === stationFilter);
    }
    if (ngoFilter) {
      effectiveScope = effectiveScope.filter(s => String(s.ngo_id) === String(ngoFilter));
      effectiveStations = [...new Set(effectiveScope.map(s => s.station))];
    }
    if (effectiveStations.length === 0 && disposedDonorIds.length > 0) {
      // No stations — nothing in scope
      return res.json([]);
    }

    const { data: donors, error } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, city, amount, total_amount, donation_count, email, pan_number, address_1, birth_date, project_supported, last_donation_date, first_donation_date, donor_type')
      .in('id', disposedDonorIds)
      .limit(500);
    if (error) throw error;
    if (!donors || donors.length === 0) return res.json([]);

    const matchedIds = donors.map(d => d.id);

    const donorMap = {};
    for (const d of donors) donorMap[d.id] = d;

    let assignmentQuery = db
      .from('fro_assignments')
      .select('*, ngos!inner(name)')
      .in('donor_id', matchedIds)
      .in('station', effectiveStations.length > 0 ? effectiveStations : stationNames)
      .not('status', 'eq', 'reassigned');
    assignmentQuery = withStationNgoPairs(assignmentQuery, effectiveScope.length > 0 ? effectiveScope : myScope);
    const { data: assignments } = await assignmentQuery;
    const scopedAssignments = (assignments || []).filter(a => {
      const pair = `${a.station}|${a.ngo_id}`;
      return scopePairs.has(pair) || effectiveScope.some(s => s.station === a.station && String(s.ngo_id) === String(a.ngo_id));
    });

    const inScopeAssignIds = new Set(scopedAssignments.map(a => a.id));
    // Pick each donor's most recent disposition THAT WAS LOGGED IN SCOPE, not
    // simply their most recent disposition. Anchoring on the latest log globally
    // meant a donor vanished from History whenever their newest call happened at
    // another station — e.g. holding BOD-1 and BOD-5 and filtering History to
    // BOD-1, a donor whose last touch was at BOD-5 dropped out entirely even
    // though they had in-scope BOD-1 dispositions of their own. disposedLogs is
    // already newest-first, so the first in-scope log per donor wins.
    const scopedDispMap = {};
    for (const dl of disposedLogs || []) {
      if (!matchedIds.includes(dl.donor_id)) continue;
      if (!inScopeAssignIds.has(dl.assignment_id)) continue;
      if (scopedDispMap[dl.donor_id]) continue;
      scopedDispMap[dl.donor_id] = dl;
    }

    const result = [];
    const seen = new Set();
    for (const d of donors) {
      const matchingAssignments = scopedAssignments.filter(a => a.donor_id === d.id);
      // History is scoped to the FRO's allotted (station, ngo) pairs, same as
      // My Leads. Skip donors with no in-scope assignment, and donors whose call was
      // logged against an out-of-scope assignment, instead of inventing a blank
      // "Unknown" row for them: that fallback is what let 336 leads from stations
      // this FRO does not hold appear in a book that only contains BOD-1/MOD-3.
      // The search path above already behaves this way.
      if (matchingAssignments.length === 0) continue;
      if (!scopedDispMap[d.id]) continue;
      for (const a of matchingAssignments) {
        const key = `${d.id}-${a.ngo_id || 'na'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const disp = scopedDispMap[d.id];
        result.push({
          donor_id: d.id,
          ngo_id: a.ngo_id,
          ngo_name: a.ngos?.name || 'Unknown',
          assignment_id: a.id,
          station: a.station || '',
          batch_type: a.batch_type || '',
          donor_name: d.name || 'Unknown',
          donor_mobile: d.mobile_number || '',
          donor_city: d.city || '',
          donor_amount: d.amount || 0,
          donor_email: d.email || '',
          donor_pan: d.pan_number || '',
          donor_project: d.project_supported || '',
          donor_dob: d.birth_date || '',
          donor_type: d.donor_type || '',
          donor_address: d.address_1 || '',
          donation_count: d.donation_count || 0,
          total_donated: d.total_amount || 0,
          has_donated_current_month: false,
          has_verified_donation_current_month: false,
          status: 'disposed',
          disposition_detail: disp?.disposition_detail || '',
          disposition_category: disp?.disposition_category || '',
          disposed_at: disp?.created_at || null,
        });
      }
    }
    // Already ordered by disposedLogs desc via map insertion, but ensure sort
    result.sort((a, b) => new Date(b.disposed_at || 0) - new Date(a.disposed_at || 0));
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFullDonorHistory = async (req, res) => {
  try {
    const workerId = req.user.id;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const ngoId = parseInt(req.query.ngo_id) || null;
    const unlockAll = req.query.unlock_all === 'true';

    const { scope: myScope, stationNames, allowedNgoIds } = await getMyStationScope(workerId, froActPairs(req));
    if (stationNames.length === 0) return res.json({ donor: null, logs: [] });

    const { data: donor } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, amount, total_amount, donation_count, city, pan_number, email, address_1, birth_date, project_supported, last_donation_date, first_donation_date, donor_type')
      .eq('id', donorId)
      .maybeSingle();

    let query = db
      .from('fro_assignments')
      .select('id, ngo_id, ngos(name)')
      .eq('donor_id', donorId)
      .in('station', stationNames)
      .not('status', 'eq', 'reassigned');
    query = withStationNgoPairs(query, myScope);
    if (ngoId) query = query.eq('ngo_id', ngoId);

    const { data: assignments } = await query;
    if (!assignments || assignments.length === 0) return res.json({ donor, logs: [] });

    const assignmentIds = assignments.map(a => a.id);
    const projectSet = [...new Set(assignments.map(a => (a.ngos?.name ? a.ngos.name.toLowerCase() : null)).filter(Boolean))];

    let logsQuery = db
      .from('fro_donor_logs')
      .select('*')
      .in('assignment_id', assignmentIds)
      .order('created_at', { ascending: false });

    if (!unlockAll) {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      logsQuery = logsQuery.gte('created_at', twoYearsAgo.toISOString());
    }

    const { data: logs, error } = await logsQuery;
    if (error) throw error;

    // Also fetch receipts linked directly via donor_id (imported receipts),
    // scoped to the (donor, NGO) assignments the worker holds for this donor.
    let receipts = [];
    if (projectSet.length > 0) {
      const { data: scopedReceipts } = await db
        .from('receipts')
        .select('*')
        .eq('donor_id', donorId)
        .in('project_id', projectSet)
        .order('receipt_date', { ascending: false });
      receipts = scopedReceipts || [];
    }

    // Resolve collector names ("Collected by <name>") on the logs.
    const collectorIds = [...new Set((logs || []).map((l) => l.fro_worker_id).filter(Boolean))];
    const { data: collectors } = collectorIds.length > 0
      ? await db.from('workers').select('id, name').in('id', collectorIds)
      : { data: [] };
    const collectorMap = {};
    for (const w of collectors || []) collectorMap[w.id] = w.name;
    for (const l of logs || []) {
      // Hide the collector's identity from the impersonated FRO (work-as).
      if (l.fro_worker_id != null && l.fro_worker_id === workerId) {
        l.fro_worker_name = collectorMap[l.fro_worker_id] || null;
      } else {
        l.fro_worker_name = null;
      }
    }

    return res.json({ donor: donor || null, logs: logs || [], receipts: receipts || [] });
  } catch (error) {
    console.error('getFullDonorHistory error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const updateDonorFrequency = async (req, res) => {
  try {
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { frequency, ngo_id } = req.body;
    const allowed = ['monthly', 'quarterly', 'yearly', 'one_time'];
    if (!frequency || !allowed.includes(frequency)) {
      return res.status(400).json({ message: `Frequency must be one of: ${allowed.join(', ')}` });
    }
    const assignment = await getFroAssignment(donorId, req.user.id, ngo_id);
    if (!assignment) return res.status(403).json({ message: 'Access denied' });
    const { data, error } = await db
      .from('donor_profiles')
      .update({ donation_frequency: frequency })
      .eq('id', donorId)
      .select('donation_frequency')
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorDonations = async (req, res) => {
  try {
    const workerId = req.user.id;
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const { ngo_id, period = 'this_year' } = req.query;

    let assignment = null;
    if (ngo_id) {
      // A donor can hold duplicate assignment rows (same worker + NGO); picking
      // any one here is safe because NGO scope (and the donor's whole history in
      // it) is what matters for the donations read, not the specific row.
      const { data } = await db
        .from('fro_assignments')
        .select('id, ngo_id')
        .eq('donor_id', donorId)
        .eq('fro_worker_id', workerId)
        .eq('ngo_id', ngo_id)
        .not('status', 'eq', 'reassigned')
        .limit(1)
        .maybeSingle();
      assignment = data;
    } else {
      const { data } = await db
        .from('fro_assignments')
        .select('id, ngo_id')
        .eq('donor_id', donorId)
        .eq('fro_worker_id', workerId)
        .not('status', 'eq', 'reassigned')
        .limit(1)
        .maybeSingle();
      assignment = data;
    }
    if (!assignment) {
      return res.status(403).json({ message: 'Access denied' });
    }

    let project = null;
    if (assignment.ngo_id) {
      const { data: ngo } = await db
        .from('ngos')
        .select('name')
        .eq('id', assignment.ngo_id)
        .maybeSingle();
      project = ngo?.name ? ngo.name.toLowerCase() : null;
    }

    const now = new Date();
    let startDate;
    let endDate;
    if (period === 'monthly') {
      startDate = istMonthBounds(now).month;
    } else if (period === 'yearly') {
      startDate = now.getFullYear() + '-01-01';
    } else if (period === 'all') {
      startDate = null;
    } else if (period === 'this_year') {
      const year = now.getFullYear();
      startDate = now.getMonth() < 3 ? `${year - 1}-04-01` : `${year}-04-01`;
    } else if (period?.startsWith('fy_')) {
      const parts = period.split('_');
      startDate = `${parts[1]}-04-01`;
      endDate = `${parts[2]}-03-31`;
    } else {
      startDate = istMonthBounds(now).month;
    }

    // The donor's donation history lives on ANY of their assignments in this
    // NGO. Every re-allocation / monthly cycle can create a fresh
    // fro_assignments row, so a lead_done/donation taken under a previous
    // assignment was invisible when logs were fetched by the CURRENT
    // assignment.id only — which is why old donors showed "no receipts". Read
    // across all of the donor's (donor_id, ngo_id) assignments to surface that
    // history; the NGO scope mirrors how receipts are scoped below (project_id),
    // so a donation to another NGO never leaks in.
    let logs = [];
    if (assignment.ngo_id) {
      // Read the donor's WHOLE history for this NGO — including assignments
      // later marked 'reassigned', whose logs are still this donor's past
      // donations (1.4k+ logs currently hidden). Reassigned only means "now
      // owned by someone else"; the money logged under the row remains the
      // donor's. The current-assignment ownership check above still guards
      // access, and the NGO scope keeps other NGOs out.
      const { data: donorAssignments } = await db
        .from('fro_assignments')
        .select('id')
        .eq('donor_id', donorId)
        .eq('ngo_id', assignment.ngo_id);
      const assignmentIds = Array.from(new Set((donorAssignments || []).map(a => a.id)));
      logs = await chunkedInQuery(assignmentIds, chunk => {
        let q = db
          .from('fro_donor_logs')
          .select('*')
          .in('assignment_id', chunk)
          .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition)')
          .order('created_at', { ascending: false });
        if (startDate) q = q.gte('created_at', startDate);
        if (endDate) q = q.lte('created_at', endDate + 'T23:59:59Z');
        return q;
      });
    } else {
      let q = db
        .from('fro_donor_logs')
        .select('*')
        .eq('assignment_id', assignment.id)
        .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition)')
        .order('created_at', { ascending: false });
      if (startDate) q = q.gte('created_at', startDate);
      if (endDate) q = q.lte('created_at', endDate + 'T23:59:59Z');
      const { data, error } = await q;
      if (error) throw error;
      logs = data || [];
    }

    const countedLogIds = new Set((logs || []).map(l => l.id));

    // Older receipts were never stamped with donor_id (they carry donor_mobile
    // instead), so a donor_id-only match silently omits a returning donor's
    // history. Match by donor_id OR the donor's mobile (last 10 digits) so old
    // donors see their receipts immediately, and the link-backfill script makes
    // the receipts table itself consistent afterwards.
    const { data: donorRow } = await db
      .from('donor_profiles')
      .select('mobile_number')
      .eq('id', donorId)
      .maybeSingle();
    const donorMobileLast10 = String(donorRow?.mobile_number || '').replace(/\D/g, '').slice(-10);

    let receiptQuery = db
      .from('receipts')
      .select('*, fro_donor_logs!receipts_log_id_fkey(transaction_datetime)')
      .order('receipt_date', { ascending: false });
    receiptQuery = receiptQuery.or(
      donorMobileLast10.length === 10
        ? `donor_id.eq.${donorId},and(donor_mobile.ilike.%${donorMobileLast10})`
        : `donor_id.eq.${donorId}`
    );
    if (project) receiptQuery = receiptQuery.eq('project_id', project);

    if (startDate) {
      receiptQuery = receiptQuery.or(`receipt_date.gte.${startDate},receipt_date.is.null`);
    } else {
      receiptQuery = receiptQuery.or('receipt_date.gte.2000-01-01,receipt_date.is.null');
    }
    if (endDate) {
      receiptQuery = receiptQuery.lte('receipt_date', endDate);
    }

    const { data: receipts } = await receiptQuery;

    const donations = (logs || []).map(l => ({
      date: l.transaction_datetime || l.verified_at || l.created_at,
      amount: l.amount_collected || 0,
      mode: l.payment_mode || null,
      status: l.action === 'donation' ? 'verified' : (l.accounts_status || 'pending'),
      upi_transaction_id: l.upi_transaction_id || null,
      receipt_no: l.receipt_no || null,
    }));

    // A receipt linked to a log already counted above (verified lead_done or
    // donation action) represents the same donation — skip it to avoid doubles.
    const receiptDonations = (receipts || [])
      .filter(r => r.log_id == null || !countedLogIds.has(r.log_id))
      .map(r => ({
      date: r.receipt_date || (Array.isArray(r.fro_donor_logs) ? r.fro_donor_logs[0] : r.fro_donor_logs)?.transaction_datetime || r.created_at,
      amount: r.amount || 0,
      mode: r.mode || null,
      status: 'verified',
      upi_transaction_id: r.upi_transaction_id || null,
      receipt_no: r.receipt_no || null,
    }));

    const all = [...donations, ...receiptDonations];
    all.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.json(all);
  } catch (error) {
    console.error('getDonorDonations error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorReceipts = async (req, res) => {
  try {
    const donorId = parseInt(req.params.id, 10);
    if (isNaN(donorId)) return res.status(400).json({ message: 'Invalid donor ID' });
    const ngoId = req.query.ngo_id;
    if (!ngoId) return res.status(400).json({ message: 'ngo_id is required' });

    const assignment = await getFroAssignment(donorId, req.user.id, ngoId);
    if (!assignment) return res.status(403).json({ message: 'Access denied' });

    const { data: ngo } = await db
      .from('ngos')
      .select('name')
      .eq('id', ngoId)
      .maybeSingle();
    const project = ngo?.name ? ngo.name.toLowerCase() : null;

    let receipts = [];
    if (project) {
      const { data, error } = await db
        .from('receipts')
        .select('*')
        .eq('donor_id', donorId)
        .eq('project_id', project)
        .order('receipt_date', { ascending: false });
      if (error) throw error;
      receipts = data || [];
    }

    const totalAmount = receipts.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    return res.json({
      receipts: receipts || [],
      count: receipts?.length || 0,
      totalAmount,
    });
  } catch (error) {
    console.error('getDonorReceipts error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};
