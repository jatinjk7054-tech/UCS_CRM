import db, { sql } from '../config/db.js';
import { getDonorByMobile } from '../models/donorProfileModel.js';
import { getWorkerById } from '../models/workerModel.js';
import { getActiveSalaryByWorker } from '../models/salaryModel.js';
import { getUserNgoAccess } from '../models/userNgoAccessModel.js';
import { updateNewDataStatusByNgoAndMobiles } from '../models/newDataModel.js';
import {
  batchCreateAssignments,
  getActiveAssignmentDonorIds,
  findAssignmentsByNgo,
  getStationDispositionStats,
  getDonorsByStationAndStatus,
  createTemporaryTransfer,
  reverseTransfer,
} from '../models/froAssignmentModel.js';
import {
  upsertStationAssignment,
  createStation,
  getStationAssignmentsByNgo,
  deleteStationAssignment,
  getStationAssignmentByNgoAndStation,
} from '../models/froStationAssignmentModel.js';
import { upsertTarget, getTargetsByNgo, getTargetsForWorkersMonth, getTargetByWorker, updateAchievedTarget, updateIncentive, getLatestTargetsBeforeMonthForWorkers } from '../models/froTargetModel.js';
import { resolveMonthlyTarget } from '../services/froMonthlyTarget.js';
import { istMonthBounds } from '../utils/ist.js';
import { buildTeamCollection, resolveRange } from '../services/teamCollectionService.js';
import { getTotalCollectedByWorker, getVerifiedCollection, getUnverifiedCollection, getBatchCollectionStats, getRangeCollectionByWorker } from '../models/froDonorLogModel.js';
import { buildFroLeaderboard } from '../services/froRankService.js';
import { getWorkersByNgo } from '../models/workerNgoAllocationModel.js';
import { emitRealtime, isWorkerOnline } from '../socket.js';
import { FRO_IDLE_LIVE_COLS } from '../utils/froIdleCols.js';
import { dayTotalsForWorkers, dayTotalsForAgents, agentTotalKey } from '../services/froTimeSessions.js';
import { effectiveIdleSeconds, openIdleSeconds, liveIdleSeconds, istDateStr, getShiftWindowMs, getShiftWindowsMs, idleFreezeCutoffMs, deadlinePassed, dispositionDueMs, nextDeadline, IDLE_LIVE_FRESH_MS } from '../utils/froIdle.js';
import { getDayName, calculateAKI, getMonthsEmployed, getAKISlabs } from '../utils/incentive.js';
import { isCovered } from '../utils/workAs.js';
import { getActiveCoversForTargets, getActiveCoversByOperator } from '../models/workAsSessionModel.js';
import { resolveStationNgoScope, dedupeStationDonors, ngoIdsMissingNames } from '../utils/stationDonorScope.js';
// Loaded as a default import: the cache wrapper is CommonJS (redis.cjs) and
// `require` does not exist in this ESM module. Calling require() at request
// time was throwing "require is not defined" and taking the whole dashboard
// down; a static import is hoisted and safe.
import redis from '../config/redis.cjs';

// Is this live row current — written recently, or held open by a live panel
// socket? The same "fresh" test the boards use, as a module-level function so
// helpers that sit outside the big handler (the Productivity Alerts idle roll-up)
// apply exactly the same rule instead of a looser local approximation.
const isLiveFreshRow = (s, nowMs) => {
  const updated = s?.updated_at ? new Date(s.updated_at).getTime() : NaN;
  return (Number.isFinite(updated) && (nowMs - updated) <= IDLE_LIVE_FRESH_MS)
    || isWorkerOnline(s?.worker_id);
};

// FRO workers for NGO-admin reporting. Test accounts (workers.is_test) are
// excluded from all dashboard stats by default; pass { includeTest: true }
// only for pickers where test members must stay selectable.
export async function getFroWorkersByNgo(ngoId, { includeTest = false } = {}) {
  const workerIds = await getWorkersByNgo(ngoId);

  const conditions = [`ngo_id.eq.${ngoId}`];
  if (workerIds.length > 0) {
    conditions.push(`id.in.(${workerIds.join(',')})`);
  }

  let q = db
    .from('workers')
    .select('*')
    .eq('department', 'FRO')
    .or(conditions.join(','));
  if (!includeTest) q = q.eq('is_test', false);
  const { data, error } = await q;

  if (error) throw error;

  const seen = new Set();
  return (data || []).filter(w => {
    if (seen.has(w.id)) return false;
    seen.add(w.id);
    return true;
  });
}

// Stations per NGO with live activity: a station is "active" when its assigned FRO
// has a fresh (<= 2 min old) live status of online / on_call / break.
async function getStationActivityByNgo(ngoIds, ngoIdToName, now, activeDateStr) {
  const result = { per_ngo: {}, summary: { total: 0, active: 0 } };
  if (!ngoIds || ngoIds.length === 0) return result;

  const { data: stationAssigns } = await db
    .from('fro_station_assignments')
    .select('station, ngo_id, fro_worker_id, workers!fro_station_assignments_fro_worker_id_fkey(is_test)')
    .in('ngo_id', ngoIds);

  const assignedFroIds = [...new Set((stationAssigns || [])
    .filter(a => a.fro_worker_id && a.workers?.is_test !== true)
    .map(a => a.fro_worker_id))];

  // Historical date: a station was "active" that day if its assigned FRO has a
  // fro_daily_stats heartbeat row (they were on the panel). Live "Active Now"
  // (default / today) uses a fresh live-status that is <= 2 minutes old.
  let dailyActives = new Set();
  if (activeDateStr) {
    if (assignedFroIds.length > 0) {
      const { data: dailyRows } = await db
        .from('fro_daily_stats')
        .select('worker_id')
        .eq('stat_date', activeDateStr)
        .in('worker_id', assignedFroIds);
      dailyActives = new Set((dailyRows || []).map(r => r.worker_id));
    }
  } else {
    const liveCutoff = new Date(now.getTime() - 2 * 60 * 1000);
    if (assignedFroIds.length > 0) {
      const { data: liveRows } = await db
        .from('fro_live_status')
        .select('worker_id, status, updated_at')
        .in('worker_id', assignedFroIds)
        .in('status', ['online', 'on_call', 'break']);
      for (const r of liveRows || []) {
        if (r.updated_at && new Date(r.updated_at) >= liveCutoff) dailyActives.add(r.worker_id);
      }
    }
  }

  const seenPerNgo = new Set();
  const seenOverall = new Set();
  const activeStationNames = new Set();
  for (const sa of stationAssigns || []) {
    const stationName = (sa.station || '').trim();
    if (!stationName) continue;
    const ngoName = (ngoIdToName && ngoIdToName[sa.ngo_id]) || 'Unknown';
    const key = `${sa.ngo_id}:${stationName}`;
    if (seenPerNgo.has(key)) continue;
    seenPerNgo.add(key);
    if (!result.per_ngo[ngoName]) result.per_ngo[ngoName] = { total: 0, active: 0 };
    result.per_ngo[ngoName].total++;
    if (!seenOverall.has(stationName)) {
      seenOverall.add(stationName);
      result.summary.total++;
    }
    if (sa.fro_worker_id && dailyActives.has(sa.fro_worker_id)) {
      result.per_ngo[ngoName].active++;
      activeStationNames.add(stationName);
    }
  }
  result.summary.active = activeStationNames.size;
  return result;
}

async function getUserNgoIds(user) {
  const access = await getUserNgoAccess(user.id, user.role);
  const ids = access.map(a => a.ngo_id).filter(Boolean);
  if (ids.length > 0) return ids;
  if (user.ngo_id) return [user.ngo_id];
  return [];
}

// Hard ceiling on cached tl-dashboard payloads.
//
// The previous guard swept expired entries only when the map exceeded 300, and
// only deleted entries older than 120s. If the map held 301 entries that were all
// fresh — which is exactly what happens when several admins each poll with their
// own key (key = user x ngo x from x to x fro_id, and a custom date range or a
// single-FRO filter multiplies keys) — the sweep deleted nothing and the map kept
// growing. Each value is a whole dashboard payload with a `performance` row per
// FRO, so this was an unbounded leak on a 2 GB host.
//
// Eviction is now unconditional on size: oldest-inserted first, because Map
// preserves insertion order and the first key is always the least recently
// written. Entries written by cacheSet are re-inserted, so a hot key keeps its
// recency naturally.
const TL_CACHE_MAX = 60;
const _rCache = new Map();
let tlCacheGeneration = 0;
const cacheGet = (key, ttlMs) => {
  const e = _rCache.get(key);
  if (e && Date.now() - e.t < ttlMs) return e.v;
  if (e) _rCache.delete(key);
  return undefined;
};
const cacheSet = (key, v) => {
  if (_rCache.size >= TL_CACHE_MAX) {
    // Drop the oldest 25% in one pass rather than one entry per write: a burst
    // of writes should not pay a loop iteration each.
    let toDrop = Math.max(1, Math.floor(TL_CACHE_MAX * 0.25));
    for (const k of _rCache.keys()) {
      _rCache.delete(k);
      if (--toDrop <= 0) break;
    }
  }
  _rCache.set(key, { v, t: Date.now() });
};
// Drop every tl-dashboard payload so the next poll recomputes fresh. Pause and
// resume mutate is_paused, and a stale cached payload (15s TTL) flips the admin
// FRO Status pill straight back to "Paused" right after a successful resume —
// which reads as "resume is broken". Rare, admin-only actions: busting all tl:
// keys is cheap and also covers other tabs/admins watching the same FRO.
// Second-tier (Upstash) key for a dashboard payload. The payload is one whole
// NGO roll-up — every station, every FRO, collections, targets, attendance — so
// rebuilding it after a deploy or on a second instance is expensive. Keeping it
// in Redis means a cold process warms from one GET instead of re-running the
// full scan. Hashed because dashCacheKey embeds a user id and date range, which
// is too long and too raw to use as a Redis key.
const NGODASH_REDIS_PREFIX = 'v1:ngoadmin:dash:';
const NGODASH_REDIS_TTL_S = 60;
const dashRedisKey = (dashCacheKey) => NGODASH_REDIS_PREFIX + redis.hashKey(dashCacheKey);

// Stations and station stats, second tier. Same reasoning as the dashboard: both
// payloads are whole-keyspace scans (every assignment row, deduped per
// station+ngo+donor, plus a per-disposition count), and getStations had no cache
// of any kind - every poll re-ran the scan. Rebuilt on each deploy, each new
// instance and each second admin's first load, so a shared copy is worth one GET.
//
// Both are invalidated by bustStationCache() on every station mutation rather
// than being left to expire, because the mutation screens (create/delete/rename/
// transfer/upload) show their result immediately and a 60s-old count would read
// as the write having failed.
const STATION_REDIS_PREFIX = 'v1:ngoadmin:stations:';
const STATION_STATS_REDIS_PREFIX = 'v1:ngoadmin:stnstats:';
const STATION_REDIS_TTL_S = 60;
const stationRedisKey = (k) => STATION_REDIS_PREFIX + redis.hashKey(k);
const stationStatsRedisKey = (k) => STATION_STATS_REDIS_PREFIX + redis.hashKey(k);

// Everything station-shaped derives from the same assignment rows, so one
// invalidation covers both payloads and the TL/dashboard roll-ups that count
// stations. Called after a mutation commits, never before.
export const bustStationCache = () => {
  for (const k of [..._rCache.keys()]) {
    if (k.startsWith('stn:') || k.startsWith('stations:')) _rCache.delete(k);
  }
  bustTlCache();
  // Fire and forget: the response must not wait on Redis, and a failure here just
  // means the entries age out within STATION_REDIS_TTL_S.
  redis.delByPrefix(STATION_REDIS_PREFIX).catch(() => { });
  redis.delByPrefix(STATION_STATS_REDIS_PREFIX).catch(() => { });
};

export const bustTlCache = () => {
  tlCacheGeneration += 1;
  for (const k of _rCache.keys()) {
    if (k.startsWith('tl:')) _rCache.delete(k);
  }
};
const CONNECTED_STATUSES = [
  'contacted', 'donation_collected', 'lead_done', 'done', 'follow_up', 'scheduled',
  'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated',
  'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents',
  'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request',
  'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback',
];
// Donors that could not be reached / engaged. Mirrors froController.js so the
// "non-connected" pull is consistent everywhere.
const NOT_CONNECTED_STATUSES = [
  'busy', 'ringing', 'call_waiting', 'unreachable', 'switched_off',
  'out_of_coverage', 'wrong_number', 'invalid_number', 'rejected',
  'temporary_network_issue', 'voicemail',
];

export const getDonors = async (req, res) => {
  try {
    const { search, from_date, to_date, page: pageStr, page_size } = req.query;
    const page = Math.max(1, parseInt(pageStr) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(page_size) || 50));
    const offset = (page - 1) * limit;
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoNames.push(ngo.name);
      if (req.user.ngo_id) ngoIds.push(req.user.ngo_id);
    }

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        const name = ngoNames[idx];
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
        ngoNames.splice(0, ngoNames.length, name);
      }
    }

    if (ngoNames.length === 0) return res.json({ data: [], pagination: { page, pageSize: limit, total: 0, totalPages: 0 } });

    let baseQuery = db.from('donor_profiles').select('*').in('ngo', ngoNames).order('last_donation_date', { ascending: false, nullsLast: true });

    if (from_date) baseQuery = baseQuery.gte('last_donation_date', from_date);
    if (to_date) baseQuery = baseQuery.lte('last_donation_date', to_date);
    if (search) {
      const q = `%${search}%`;
      baseQuery = baseQuery.or(`name.ilike.${q},mobile_number.ilike.${q},city.ilike.${q}`);
    }

    const { data: allData, error } = await baseQuery;
    if (error) throw error;

    const groups = {};
    for (const d of allData || []) {
      const key = d.mobile_number || `no-mobile-${d.id}`;
      if (!groups[key]) {
        groups[key] = { ...d, ngos: [d.ngo], donor_ids: [d.id], total_amount_all: Number(d.total_amount || d.amount || 0), records: 1 };
      } else {
        if (!groups[key].ngos.includes(d.ngo)) groups[key].ngos.push(d.ngo);
        if (!groups[key].donor_ids.includes(d.id)) groups[key].donor_ids.push(d.id);
        groups[key].total_amount_all += Number(d.total_amount || d.amount || 0);
        groups[key].records += 1;
        if (new Date(d.last_donation_date || 0) > new Date(groups[key].last_donation_date || 0)) {
          groups[key].name = d.name;
          groups[key].city = d.city;
          groups[key].last_donation_date = d.last_donation_date;
        }
      }
    }

    const grouped = Object.values(groups);
    grouped.sort((a, b) => new Date(b.last_donation_date || 0) - new Date(a.last_donation_date || 0));

    // FRO credit map: which FRO(s) hold collected credit for each donor profile
    const allGroupedDonorIds = grouped.flatMap(g => g.donor_ids || []);
    const froCreditMap = {};
    if (allGroupedDonorIds.length > 0) {
      const { data: creditLogs } = await db
        .from('fro_donor_logs')
        .select('donor_id, fro_worker_id, amount_collected')
        .in('donor_id', allGroupedDonorIds)
        .gt('amount_collected', 0);
      const workerIds = [...new Set((creditLogs || []).map(l => l.fro_worker_id).filter(Boolean))];
      const workerNames = {};
      if (workerIds.length > 0) {
        const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
        for (const w of workers || []) workerNames[w.id] = w.name;
      }
      for (const l of creditLogs || []) {
        if (l.fro_worker_id == null) continue;
        if (!froCreditMap[l.donor_id]) froCreditMap[l.donor_id] = {};
        if (!froCreditMap[l.donor_id][l.fro_worker_id]) {
          froCreditMap[l.donor_id][l.fro_worker_id] = { fro_id: l.fro_worker_id, fro_name: workerNames[l.fro_worker_id] || 'Unknown', amount: 0 };
        }
        froCreditMap[l.donor_id][l.fro_worker_id].amount += Number(l.amount_collected) || 0;
      }
    }

    const total = grouped.length;
    const paginatedSlice = grouped.slice(offset, offset + limit);

    const allDonorIds = paginatedSlice.flatMap(g => g.donor_ids || []);
    let latestTxMap = {};
    if (allDonorIds.length > 0) {
      try {
        const { data: assignments } = await db
          .from('fro_assignments')
          .select('id, donor_id')
          .in('donor_id', allDonorIds);
        const assignIds = (assignments || []).map(a => a.id);
        if (assignIds.length > 0) {
          const { data: logs } = await db
            .from('fro_donor_logs')
            .select('amount_collected, created_at, assignment_id')
            .in('assignment_id', assignIds)
            .not('amount_collected', 'is', null)
            .order('created_at', { ascending: false });
          const assignToDonor = {};
          for (const a of assignments || []) assignToDonor[a.id] = a.donor_id;
          for (const log of logs || []) {
            const did = assignToDonor[log.assignment_id];
            if (did && (latestTxMap[did] == null)) {
              latestTxMap[did] = {
                amount: Number(log.amount_collected) || 0,
                date: log.created_at?.slice(0, 10),
              };
            }
          }
        }
      } catch (err) { console.error('Failed to fetch latest transactions:', err.message); }
    }

    const paginatedData = paginatedSlice.map(d => {
      let best = { amount: 0, date: null };
      for (const did of (d.donor_ids || [])) {
        const entry = latestTxMap[did];
        if (entry && (!best.date || entry.date > best.date)) best = entry;
      }
      const froAgg = {};
      for (const did of (d.donor_ids || [])) {
        for (const fc of Object.values(froCreditMap[did] || {})) {
          if (!froAgg[fc.fro_id]) froAgg[fc.fro_id] = { fro_id: fc.fro_id, fro_name: fc.fro_name, amount: 0 };
          froAgg[fc.fro_id].amount += fc.amount;
        }
      }
      const fro_credits = Object.values(froAgg).sort((a, b) => b.amount - a.amount);
      return {
        ...d,
        amount: d.total_amount_all,
        total_amount: d.total_amount_all,
        last_transaction_amount: best.amount,
        last_transaction_date: best.date,
        ngo_list: d.ngos,
        fro_credits,
        fro_names: fro_credits.map(f => f.fro_name),
      };
    });

    if (req.query.paginated === 'true') {
      return res.json({ data: paginatedData, pagination: { page, pageSize: limit, total, totalPages: Math.ceil(total / limit) } });
    }
    return res.json(paginatedData);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorCreditLogs = async (req, res) => {
  try {
    const { donorId } = req.params;
    const numId = parseInt(donorId, 10);
    let donorIds = [];
    if (!isNaN(numId)) {
      const { data: donor } = await db.from('donor_profiles').select('id').eq('id', numId).maybeSingle();
      if (donor) donorIds = [donor.id];
    } else {
      const { data: donors } = await db.from('donor_profiles').select('id').eq('mobile_number', donorId);
      donorIds = (donors || []).map(d => d.id);
    }
    if (donorIds.length === 0) return res.json([]);

    const { data, error } = await db
      .from('fro_donor_logs')
      .select(`
        id, amount_collected, action, disposition_detail, accounts_status,
        created_at, fro_worker_id, assignment_id,
        workers!fro_donor_logs_fro_worker_id_fkey(id, name),
        fro_assignments(ngo_id, station)
      `)
      .in('donor_id', donorIds)
      .gt('amount_collected', 0)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return res.json((data || []).map(l => ({
      id: l.id,
      amount: Number(l.amount_collected) || 0,
      collected_at: l.created_at,
      collector_name: l.workers?.name || 'Unknown',
      fro_worker_id: l.fro_worker_id,
      accounts_status: l.accounts_status,
      action: l.action,
      disposition_detail: l.disposition_detail,
      assignment_id: l.assignment_id,
      ngo_id: l.fro_assignments?.ngo_id || null,
      station: l.fro_assignments?.station || null,
    })));
  } catch (error) {
    console.error('getDonorCreditLogs error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const transferDonorCredit = async (req, res) => {
  try {
    const { logId } = req.params;
    const { target_fro_worker_id } = req.body || {};
    if (!target_fro_worker_id) {
      return res.status(400).json({ message: 'target_fro_worker_id is required' });
    }

    const targetId = parseInt(target_fro_worker_id, 10);
    if (isNaN(targetId)) {
      return res.status(400).json({ message: 'Invalid target FRO' });
    }

    let target;
    try {
      target = await getWorkerById(targetId);
    } catch (e) {
      return res.status(400).json({ message: 'Target FRO worker not found' });
    }

    const numLogId = parseInt(logId, 10);
    if (isNaN(numLogId)) {
      return res.status(400).json({ message: 'Invalid log id' });
    }

    const { data: log, error: logErr } = await db
      .from('fro_donor_logs')
      .select('id, donor_id, fro_worker_id, amount_collected')
      .eq('id', numLogId)
      .maybeSingle();
    if (logErr) throw logErr;
    if (!log) return res.status(404).json({ message: 'Credit log not found' });
    if (!log.amount_collected || Number(log.amount_collected) <= 0) {
      return res.status(400).json({ message: 'This log has no collectible credit' });
    }
    if (log.fro_worker_id === targetId) {
      return res.status(409).json({ message: 'Credit already belongs to this FRO' });
    }

    const { error: updErr } = await db
      .from('fro_donor_logs')
      .update({ fro_worker_id: targetId })
      .eq('id', numLogId);
    if (updErr) throw updErr;

    return res.json({
      message: `Credit of ₹${Number(log.amount_collected).toLocaleString('en-IN')} moved to ${target.name || 'the selected FRO'}`,
      log_id: numLogId,
      amount_moved: Number(log.amount_collected),
      target_fro_worker_id: targetId,
    });
  } catch (error) {
    console.error('transferDonorCredit error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorDetail = async (req, res) => {
  try {
    const { mobile } = req.params;
    const profile = await getDonorByMobile(mobile);
    if (!profile) {
      return res.status(404).json({ message: 'Donor not found' });
    }

    const { data: donations, error } = await db
      .from('new_data')
      .select('*')
      .eq('mobile_number', mobile)
      .order('transaction_date', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;

    return res.json({ profile, donations: donations || [] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAccessibleNgos = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const seen = new Set();
    const ngos = access.map(a => ({ id: a.ngo_id, name: a.ngo_name })).filter(n => {
      if (!n.id || seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
    return res.json(ngos);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const STANDARD_NGOS = [
  { name: 'BSCT', code: 'BSCT' },
  { name: 'AFLF', code: 'AFLF' },
  { name: 'MANN', code: 'MANN' },
];

export const ensureStandardNgos = async (_req, res) => {
  try {
    const { data: existing, error: fetchErr } = await db.from('ngos').select('id, name');
    if (fetchErr) throw fetchErr;
    const nameSet = new Set((existing || []).map(n => (n.name || '').trim().toLowerCase()));
    const missing = STANDARD_NGOS.filter(n => !nameSet.has(n.name.toLowerCase()));
    const created = [];
    for (const ngo of missing) {
      const { data, error } = await db
        .from('ngos')
        .insert({ name: ngo.name, code: ngo.code })
        .select('id, name')
        .single();
      if (error) { console.error('ensureStandardNgos insert error:', ngo.name, error.message); continue; }
      if (data) created.push(data);
    }
    const { data: all } = await db.from('ngos').select('id, name');
    return res.json({ created: created.length, ngos: all || [] });
  } catch (error) {
    console.error('ensureStandardNgos error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const getAllNgosForTabs = async (_req, res) => {
  try {
    const { data: ngos, error } = await db.from('ngos').select('id, name');
    if (error) throw error;
    return res.json(ngos || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroWorkers = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    const allWorkers = [];
    for (const ngoId of ngoIds) {
      const workers = await getFroWorkersByNgo(ngoId);
      allWorkers.push(...workers);
    }
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });

    const workerIds = froWorkers.map(w => w.id);
    let allocMap = {};
    if (workerIds.length > 0) {
      const { data: allAllocs } = await db
        .from('worker_ngo_allocations')
        .select('worker_id, ngo_id')
        .in('worker_id', workerIds);
      for (const a of allAllocs || []) {
        if (!allocMap[a.worker_id]) allocMap[a.worker_id] = [];
        allocMap[a.worker_id].push(a.ngo_id);
      }
    }

let agentLabelMap = {};
    let agentIdMap = {};
    if (workerIds.length > 0) {
      const { data: agentRows, error: agentErr } = await db
        .from('crm_agents')
        .select('id, worker_id, label')
        .in('worker_id', workerIds)
        .eq('is_active', true);
      if (agentErr) throw agentErr;
      for (const a of agentRows || []) {
        if (a.worker_id && !agentLabelMap[a.worker_id]) agentLabelMap[a.worker_id] = a.label;
        if (a.worker_id && !agentIdMap[a.worker_id]) agentIdMap[a.worker_id] = a.id;
      }
    }

    // Only FROs that actually have an agent show here. `name` stays the volunteer's
    // real name -- it used to be overwritten with the agent label, which made every
    // row read "Agent 1" and left the station picker unable to say whose account it
    // was. The label is reported as agent_label, and the agent as agent_id, so a
    // caller can show "Agent 1 -- Maya Jadhao" and assign by agent.
    const coveredFroWorkers = froWorkers.filter(w => agentLabelMap[w.id]);

    const result = await Promise.all(coveredFroWorkers.map(async (w) => {
      const salary = await getActiveSalaryByWorker(w.id);
      const agentName = agentLabelMap[w.id];
      return {
        id: w.id,
        name: w.name,
        login_id: w.login_id,
        email: w.email,
        phone: w.phone,
        gender: w.gender,
        department: w.department,
        is_active: w.is_active,
        created_at: w.created_at,
        salary: salary ? parseFloat(salary.salary) : 0,
        salary_from_month: salary ? salary.from_month : null,
        allocated_ngo_ids: allocMap[w.id] || [],
        fro_name: w.name,
        agent_label: agentName || null,
        agent_id: agentIdMap[w.id] || null,
      };
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};



export const getAssignments = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    const { status, worker_id } = req.query;
    const allAssignments = [];
    for (const ngoId of ngoIds) {
      const assignments = await findAssignmentsByNgo(ngoId, { status, worker_id });
      allAssignments.push(...assignments);
    }
    const seen = new Set();
    const unique = allAssignments.filter(a => { const k = a.id; if (seen.has(k)) return false; seen.add(k); return true; });

    const result = unique.map(a => ({
      id: a.id,
      donor_id: a.donor_id,
      donor_mobile: a.donor_profiles?.mobile_number || '',
      donor_name: a.donor_profiles?.name || 'Unknown',
      donor_city: a.donor_profiles?.city || '',
      donor_amount: a.donor_profiles?.amount || 0,
      fro_worker_id: a.fro_worker_id,
      fro_name: a.workers?.name || 'Unknown',
      status: a.status,
      notes: a.notes,
      last_contacted_at: a.last_contacted_at,
      next_follow_up: a.next_follow_up,
      assigned_at: a.assigned_at,
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};



export const setTarget = async (req, res) => {
  try {
    const { fro_worker_id, month, target_amount, ngo_id } = req.body;
    const ngoIds = await getUserNgoIds(req.user);
    if (!fro_worker_id || !month || target_amount === undefined) {
      return res.status(400).json({ message: 'fro_worker_id, month, and target_amount are required' });
    }

    const worker = await getWorkerById(fro_worker_id);
    if (!worker) {
      return res.status(404).json({ message: 'Worker not found' });
    }

    // An explicit ngo_id from the body is honoured, but only if this account may
    // write for that NGO. An UNAUTHORISED one is rejected rather than quietly
    // downgraded to a different NGO, which is what silently happened before.
    let ngoId = null;
    if (ngo_id) {
      if (!ngoIds.some(id => String(id) === String(ngo_id))) {
        return res.status(403).json({ message: 'You do not have access to that NGO' });
      }
      ngoId = ngo_id;
    } else {
      // Fall back to the FRO's OWN ngo_id. This used to fall back to ngoIds[0],
      // i.e. whichever NGO happened to sort first for this account, which wrote
      // the target against the wrong NGO for every FRO not assigned to it.
      ngoId = worker.ngo_id || ngoIds[0] || null;
    }

    if (!ngoId) {
      return res.status(400).json({ message: 'No NGO could be determined for this FRO' });
    }

    const targetMonth = new Date(month + '-01');
    const joinedAt = new Date(worker.created_at);
    const monthsEmployed = (targetMonth.getFullYear() - joinedAt.getFullYear()) * 12
      + (targetMonth.getMonth() - joinedAt.getMonth());

    // The amount the person typed is stored AS TYPED. This used to recompute the
    // auto tier for anyone inside their first three months and store that instead,
    // so an HR or Accounts user setting 20000 for a month-2 FRO got 2.5x their
    // salary written to the table and a success message naming the auto figure.
    // The auto tier is now applied at READ time by resolveMonthlyTarget for
    // display, which leaves the manual override intact - see the precedence notes
    // in services/froMonthlyTarget.js.
    const amount = Number(target_amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ message: 'target_amount must be a non-negative number' });
    }

    const result = await upsertTarget({
      fro_worker_id,
      ngo_id: ngoId,
      month: month + '-01',
      target_amount: amount,
      set_by: req.user.id,
    });

    // Reported so the UI can explain that a first-three-month FRO will now show
    // this stored figure rather than the derived one.
    const inAutoWindow = monthsEmployed < 3;

    return res.json({
      message: 'Target set successfully',
      data: result,
      auto_target: false,
      overrides_auto: inAutoWindow,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTargets = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    const { month, ngo_id } = req.query;
    const targetMonth = month ? month + '-01' : istMonthBounds().month;

    const filterNgoIds = ngo_id && ngoIds.some(id => String(id) === String(ngo_id))
      ? [ngo_id]
      : ngoIds;

    const allWorkers = [];
    for (const ngoId of filterNgoIds) {
      const workers = await getFroWorkersByNgo(ngoId);
      allWorkers.push(...workers);
    }
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });

    // One row per FRO per month is the display contract, but the table is keyed on
    // (fro_worker_id, ngo_id, month), so a worker on two NGOs holds two rows for
    // the same month. Resolve to the newest write - the same tie-break
    // getTargetByWorker uses - so this board and the FRO's own panel can never
    // show different numbers for one person.
    //
    // Fetched by worker, NOT per NGO: scoping by ngo_id hid any row saved against
    // a different NGO than the one this FRO is currently listed under, which is
    // how a set target came back as not_set and rendered as "Set target".
    const currentRowMap = await getTargetsForWorkersMonth(
      froWorkers.map(w => w.id),
      targetMonth,
    );

    const manualMap = {};
    const achievedMap = {};
    const incentiveMap = {};
    for (const [key, t] of Object.entries(Object.fromEntries(currentRowMap))) {
      manualMap[key] = parseFloat(t.target_amount);
      achievedMap[key] = t.achieved_target != null ? parseFloat(t.achieved_target) : null;
      incentiveMap[key] = t.incentive != null ? parseFloat(t.incentive) : null;
    }

    // Month 4+ FROs have no row for a brand new month. Fetch their most recent
    // earlier row in ONE query rather than one per FRO, and let the shared
    // resolver decide what that means.
    const priorRowMap = await getLatestTargetsBeforeMonthForWorkers(
      froWorkers.map(w => w.id),
      targetMonth,
    );

    const result = await Promise.all(froWorkers.map(async (w) => {
      const salary = await getActiveSalaryByWorker(w.id);
      const currentSalary = salary ? parseFloat(salary.salary) : 0;
      const key = String(w.id);
      // Tenure is still anchored to the month being viewed, not to today, so
      // reviewing a past month reproduces that month rather than today's tier.
      const resolved = resolveMonthlyTarget({
        joiningDate: w.created_at,
        salary: currentSalary,
        currentRow: currentRowMap.get(key) || null,
        priorRow: priorRowMap.get(key) || null,
        refDate: new Date(targetMonth),
      });

      return {
        id: w.id,
        name: w.name,
        login_id: w.login_id,
        // Absconding a worker sets employment_status/is_active but leaves them in
        // department 'FRO', so this list still contains them. Forwarded so the board
        // can mark and sort them out of the way instead of counting someone who left
        // as an FRO still owing a target.
        employment_status: w.employment_status || 'active',
        // Echoed so the editor can post an explicit ngo_id instead of relying on
        // the server's fallback; setTarget still falls back to the worker's own
        // ngo_id, and rejects an ngo_id this account may not write for.
        ngo_id: w.ngo_id || null,
        salary: currentSalary,
        joined_at: w.created_at,
        months_employed: resolved.monthsEmployed,
        target: resolved.target,
        target_source: resolved.source,
        target_source_month: resolved.sourceMonth,
        manual_target: manualMap[key] || null,
        achieved_target: achievedMap[key] || null,
        incentive: incentiveMap[key] || null,
      };
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDailyTarget = async (req, res) => {
  try {
    const { data: worker } = await db
      .from('workers')
      .select('daily_collection_target')
      .eq('id', req.user.id)
      .maybeSingle();
    return res.json({ daily_target: worker ? Number(worker.daily_collection_target) || 0 : 0 });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDashboard = async (req, res) => {
  try {
    // Cache is keyed by NGO AND the queried date range so switching the period
    // (Today / Yesterday / etc.) never returns a stale payload for another day.
    const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const attRange = (req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) ? req.query.to : istToday;
    const dashCacheKey = `dash:${req.user.id}:${req.query.ngo_id || 'all'}:${req.query.from || attRange}:${attRange}`;
    if (req.query.fresh !== '1') {
      const cached = cacheGet(dashCacheKey, 60000);
      if (cached) return res.json(cached);
      // Missed in-memory: try Upstash before rebuilding. fail-open, so a Redis
      // outage or an unreachable network just falls through to the DB.
      const l2 = await redis.get(dashRedisKey(dashCacheKey));
      if (l2 && typeof l2 === 'object') {
        cacheSet(dashCacheKey, l2);
        return res.json(l2);
      }
    }
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoNames.push(ngo.name);
      if (req.user.ngo_id) ngoIds.push(req.user.ngo_id);
    }

    const { ngo_id: filterNgoId } = req.query;
    const origNgoNames = [...ngoNames];
    const origNgoIds = [...ngoIds];

    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });

    const ngoHash = redis.hashKey(ngoNames.length ? ngoNames.slice().sort() : ['all']);
    const donorCountKey = `v1:newdata:distinct_count:${ngoHash}`;

    let totalDonorCount = 0;
    try {
      const cachedCount = await redis.get(donorCountKey);
      if (cachedCount !== null && !isNaN(Number(cachedCount))) {
        totalDonorCount = parseInt(cachedCount, 10);
      } else if (ngoNames.length > 0) {
        const donorCountRows = await sql(
          'SELECT COUNT(DISTINCT mobile_number) AS c FROM new_data WHERE ngo = ANY($1) AND mobile_number IS NOT NULL',
          [ngoNames]
        );
        totalDonorCount = parseInt(donorCountRows[0] ? donorCountRows[0].c : 0, 10) || 0;
        await redis.set(donorCountKey, totalDonorCount, 600);
      }
    } catch (e) {
      if (ngoNames.length > 0) {
        const donorCountRows = await sql(
          'SELECT COUNT(DISTINCT mobile_number) AS c FROM new_data WHERE ngo = ANY($1) AND mobile_number IS NOT NULL',
          [ngoNames]
        );
        totalDonorCount = parseInt(donorCountRows[0] ? donorCountRows[0].c : 0, 10) || 0;
      }
    }

    const assignmentAgg = ngoIds.length > 0
      ? await sql(
          `SELECT donor_id,
                  BOOL_OR(status <> 'reassigned') AS has_active,
                  BOOL_OR(status = 'donation_collected') AS has_collected,
                  BOOL_OR(status <> 'reassigned' AND status = ANY($2)) AS connected,
                  array_agg(DISTINCT fro_worker_id) FILTER (WHERE fro_worker_id IS NOT NULL) AS worker_ids
           FROM fro_assignments
           WHERE ngo_id = ANY($1)
           GROUP BY donor_id`,
          [ngoIds, CONNECTED_STATUSES]
        )
      : [];
    const collectedDonorCount = assignmentAgg.filter(a => a.has_collected).length;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();

    const monthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    const achievedMap = {};
    const allTargets = (await Promise.all(ngoIds.map(ngoId => getTargetsByNgo(ngoId, monthStr)))).flat();
    for (const t of allTargets) {
      if (t.achieved_target != null) achievedMap[t.fro_worker_id] = parseFloat(t.achieved_target);
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    // Batch all collection stats in a single query
    const workerIds = froWorkers.map(w => w.id);
    const batchStats = await getBatchCollectionStats(workerIds, monthStart, monthEnd, todayStart.toISOString(), todayEnd.toISOString(), ngoIds);

    let monthCollection = 0;
    for (const w of froWorkers) {
      const actual = batchStats.monthCollection[w.id] || 0;
      const achieved = achievedMap[w.id];
      monthCollection += (achieved != null && achieved > 0) ? achieved : actual;
    }

    // Data used / unused — per unique donor
    let assignedCount = 0, dataUsed = 0, dataUnused = 0;
    for (const a of assignmentAgg) {
      if (!a.has_active) continue;
      assignedCount++;
      if (a.connected) dataUsed++;
      else dataUnused++;
    }

    // Active donors: those who donated within the last 1 year
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const donorsWithRecentDonations = ngoIds.length > 0
      ? (await db
          .from('fro_donor_logs')
          .select('donor_id, fro_assignments!inner(ngo_id)')
          .in('fro_assignments.ngo_id', ngoIds)
          .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)')
          .gte('created_at', oneYearAgo.toISOString())).data || []
      : [];

    const activeDonorIds = new Set(donorsWithRecentDonations.map(d => d.donor_id).filter(Boolean));
    let activeDonors = 0, inactiveDonors = 0;
    for (const a of assignmentAgg) {
      if (!a.has_active) continue;
      if (activeDonorIds.has(a.donor_id)) activeDonors++;
      else inactiveDonors++;
    }

    let todayCollection = 0;
    for (const w of froWorkers) {
      todayCollection += batchStats.todayCollection[w.id] || 0;
    }

    let verifiedMonthAmount = 0, verifiedMonthCount = 0;
    let unverifiedMonthAmount = 0, unverifiedMonthCount = 0;
    let verifiedTodayAmount = 0, verifiedTodayCount = 0;
    let unverifiedTodayAmount = 0, unverifiedTodayCount = 0;
    for (const w of froWorkers) {
      const vm = batchStats.verifiedMonth[w.id] || { amount: 0, count: 0 };
      verifiedMonthAmount += vm.amount; verifiedMonthCount += vm.count;
      const um = batchStats.unverifiedMonth[w.id] || { amount: 0, count: 0 };
      unverifiedMonthAmount += um.amount; unverifiedMonthCount += um.count;
      const vt = batchStats.verifiedToday[w.id] || { amount: 0, count: 0 };
      verifiedTodayAmount += vt.amount; verifiedTodayCount += vt.count;
      const ut = batchStats.unverifiedToday[w.id] || { amount: 0, count: 0 };
      unverifiedTodayAmount += ut.amount; unverifiedTodayCount += ut.count;
    }

    // Reactivation metrics (same logic as FRO dashboard, scoped by NGO)
    const fyYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const fyStart = new Date(fyYear, 3, 1);

    const [fyDonorsRes, todayDonorsRes, monthDonorsRes] = ngoIds.length > 0
      ? await Promise.all([
          db.from('fro_donor_logs').select('donor_id, created_at, fro_assignments!inner(ngo_id)')
            .in('fro_assignments.ngo_id', ngoIds)
            .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)')
            .gte('created_at', fyStart.toISOString()),
          db.from('fro_donor_logs').select('donor_id, fro_assignments!inner(ngo_id)')
            .in('fro_assignments.ngo_id', ngoIds)
            .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)')
            .gte('created_at', todayStart.toISOString())
            .lte('created_at', todayEnd.toISOString()),
          db.from('fro_donor_logs').select('donor_id, fro_assignments!inner(ngo_id)')
            .in('fro_assignments.ngo_id', ngoIds)
            .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)')
            .gte('created_at', monthStart)
            .lte('created_at', monthEnd),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];

    const todayStr = todayStart.toISOString();
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

    // Attendance metrics — follow the selected dashboard date range
    // (from/to), defaulting to today. A plain YYYY-MM-DD (IST) is matched against
    // the attendance.date column which is written as an IST calendar date.
    const attendanceDate = (req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) ? req.query.to : istToday;
    const isAttendanceToday = attendanceDate === istToday;

    const activeFroIds = froWorkers.filter(w => w.is_active !== false).map(w => w.id);
    let workersPresent = 0, workersAbsent = 0, workersLate = 0, workersLeave = 0;
    if (activeFroIds.length > 0) {
      const { data: attendanceData } = await db
        .from('attendance')
        .select('status')
        .eq('date', attendanceDate)
        .in('worker_id', activeFroIds);
      workersPresent = (attendanceData || []).filter(a => a.status === 'present').length;
      workersLate = (attendanceData || []).filter(a => a.status === 'late').length;
      workersAbsent = (attendanceData || []).filter(a => a.status === 'absent').length;
      workersLeave = (attendanceData || []).filter(a => a.status === 'leave').length;
    }
    const activeFroCount = froWorkers.filter(w => w.is_active !== false).length;
    const attendancePct = activeFroCount > 0 ? Math.round(((workersPresent + workersLate) / activeFroCount) * 1000) / 10 : 0;

    const assignedWorkerIds = new Set();
    for (const a of assignmentAgg) for (const id of a.worker_ids || []) assignedWorkerIds.add(id);
    const nonTestFroIdSet = new Set(workerIds);
    const assignedFroCount = [...assignedWorkerIds].filter(id => nonTestFroIdSet.has(id)).size;

    const ngoIdToName = {};
    for (const a of access) ngoIdToName[a.ngo_id] = a.ngo_name;
    if (req.user.ngo_id && !ngoIdToName[req.user.ngo_id]) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoIdToName[req.user.ngo_id] = ngo.name;
    }

    const stationActivity = await getStationActivityByNgo(ngoIds, ngoIdToName, now, isAttendanceToday ? null : attendanceDate);
    const stationsPerNgo = stationActivity.per_ngo;

    let daily_target = 0;
    const { data: workerRec } = await db
      .from('workers')
      .select('daily_collection_target')
      .eq('id', req.user.id)
      .maybeSingle();
    if (workerRec) daily_target = Number(workerRec.daily_collection_target) || 0;

    let monthly_target = 0;
    const currentMonthStr = now.toISOString().slice(0, 7) + '-01';
    if (origNgoIds.length > 0) {
      const { data: mTargets } = await db
        .from('fro_monthly_targets')
        .select('target_amount')
        .in('ngo_id', origNgoIds)
        .eq('month', currentMonthStr);
      if (mTargets && mTargets.length > 0) {
        monthly_target = mTargets.reduce((sum, t) => sum + (parseFloat(t.target_amount) || 0), 0);
      }
    }
    if (!monthly_target && daily_target > 0) {
      monthly_target = daily_target * 26;
    }

    const noMarkCount = Math.max(0, activeFroCount - workersPresent - workersLate - workersAbsent - workersLeave);
    const workersAbsentTotal = workersAbsent + noMarkCount;

    const payload = {
      ngos: origNgoNames,
      period: {
        month: now.toISOString().slice(0, 7),
        today: todayStr,
      },
      summary: {
        donors: {
          total: totalDonorCount,
          assigned: assignedCount,
          assigned_pct: totalDonorCount > 0 ? Math.round((assignedCount / totalDonorCount) * 100) : 0,
          collected: collectedDonorCount,
          active: activeDonors,
          inactive: inactiveDonors,
        },
        collection: {
          month: {
            total: monthCollection,
            verified: { amount: verifiedMonthAmount, count: verifiedMonthCount },
            unverified: { amount: unverifiedMonthAmount, count: unverifiedMonthCount },
          },
          today: {
            total: todayCollection,
            verified: { amount: verifiedTodayAmount, count: verifiedTodayCount },
            unverified: { amount: unverifiedTodayAmount, count: unverifiedTodayCount },
          },
          daily_target,
          monthly_target,
        },
        reactivations: {
          today: reactivatedToday,
          month: reactivatedMonthly,
        },
      },
      workers: {
        fro: {
          total: froWorkers.length,
          active: activeFroCount,
          with_assignments: assignedFroCount,
          assignment_coverage_pct: activeFroCount > 0 ? Math.round((assignedFroCount / activeFroCount) * 100) : 0,
        },
        attendance: {
          present: workersPresent,
          late: workersLate,
          absent: workersAbsentTotal,
          no_mark: 0,
          pct: attendancePct,
        },
      },
      assignments: {
        total: assignedCount,
        data_connected: dataUsed,
        data_unconnected: dataUnused,
        connect_rate_pct: assignedCount > 0 ? Math.round((dataUsed / assignedCount) * 100) : 0,
      },
      stations_per_ngo: stationsPerNgo,
      stations_summary: stationActivity.summary,
    };
    cacheSet(dashCacheKey, payload);
    // Mirror into Upstash for the next cold start. Not awaited: the response
    // should not wait on the network, and a failed write is harmless.
    redis.set(dashRedisKey(dashCacheKey), payload, NGODASH_REDIS_TTL_S).catch(() => { });
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroWiseCollection = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoNames.push(ngo.name);
      if (req.user.ngo_id) ngoIds.push(req.user.ngo_id);
    }

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });

    const period = req.query.period || 'month';
    const now = new Date();
    let startDate, endDate;

    if (period === 'today') {
      startDate = new Date(); startDate.setHours(0, 0, 0, 0);
      endDate = new Date(); endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const achievedMap = {};
    if (period === 'month') {
      const monthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
      const allTargets = (await Promise.all(ngoIds.map(ngoId => getTargetsByNgo(ngoId, monthStr)))).flat();
      for (const t of allTargets) {
        if (t.achieved_target != null) achievedMap[t.fro_worker_id] = parseFloat(t.achieved_target);
      }
    }

    const workerAmounts = await Promise.all(froWorkers.map(w =>
      getTotalCollectedByWorker(w.id, startDate.toISOString(), endDate.toISOString())
    ));
    const result = froWorkers.map((w, i) => {
      const amount = workerAmounts[i];
      const achieved = achievedMap[w.id];
      return {
        fro_id: w.id,
        fro_name: w.name || w.login_id || 'Unknown',
        collection_amount: achieved != null && achieved > 0 ? achieved : amount,
        ...(achieved != null && achieved > 0 ? { is_achieved: true } : {}),
      };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroPerformance = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    let ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) { ngoIds.splice(0, ngoIds.length, ngoIds[idx]); }
    }

    if (ngoIds.length === 0) return res.json([]);

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; }).filter(w => w.is_active !== false);

    const { from, to } = req.query;
    const period = req.query.period || 'month';
    const now = new Date();
    let startDate, endDate;
    let isTodayRange = false;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    if (from || to) {
      startDate = from ? new Date(`${from}T00:00:00`) : todayStart;
      endDate = to ? new Date(`${to}T23:59:59.999`) : todayEnd;
    } else if (period === 'today') {
      startDate = todayStart;
      endDate = todayEnd;
      isTodayRange = true;
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }
    const includesToday = startDate <= todayEnd && endDate >= todayStart;

    // Every day boundary below is an IST calendar day. `attendance.date` is
    // written in IST (attendanceController / selfiePunch use istDateStr), so
    // deriving these from the process's local zone made every lookup miss
    // between 00:00 and 05:30 IST on a UTC host: the local calendar was still
    // on the previous day, nothing matched `date = <today>`, and the whole
    // High/Low board came back empty. `from`/`to` already arrive as IST days
    // (Dashboard.jsx toIstDate) and are used verbatim; only the fallbacks are
    // computed here, and they are computed in IST.
    const todayStr = istDateStr(now);
    const monthDayStr = todayStr.slice(0, 7);
    const monthStartDay = `${monthDayStr}-01`;
    const monthEndDay = `${monthDayStr}-${String(new Date(Number(monthDayStr.slice(0, 4)), Number(monthDayStr.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
    const rangeStartDay = from || (isTodayRange ? todayStr : monthStartDay);
    const rangeEndDay = to || (isTodayRange ? todayStr : monthEndDay);

    const workerIds = froWorkers.map(w => w.id);
    // Collection stats are always paced against the current calendar month
    // (matching the monthly target / working-day calculation below), regardless
    // of the selected from/to period.
    const monthStartDate = new Date(`${monthStartDay}T00:00:00`);
    const monthEndDate = new Date(`${monthEndDay}T23:59:59.999`);
    const batchStats = await getBatchCollectionStats(workerIds, monthStartDate.toISOString(), monthEndDate.toISOString(), todayStart.toISOString(), todayEnd.toISOString(), ngoIds);

    // Shared leaderboard: rank + period performance come from one service so the
    // admin High/Low tables and the FRO My-Leads strip always agree.
    const leaderboard = await buildFroLeaderboard({ startDay: rangeStartDay, endDay: rangeEndDay });
    const lbById = new Map(leaderboard.map(p => [String(p.id), p]));

    const isSingleDay = isTodayRange || (!!from && !!to && from === to);
    const attendanceMap = {};
    const punchedInSet = new Set();
    if (workerIds.length > 0) {
      if (isSingleDay) {
        const dayStr = isTodayRange ? todayStr : from;
        const { data: att } = await db.from('attendance').select('worker_id, status, punch_in_time').eq('date', dayStr).in('worker_id', workerIds);
        for (const a of att || []) {
          attendanceMap[a.worker_id] = a.status === 'present' || a.status === 'late' ? 100 : a.status === 'absent' ? 0 : null;
          // Status alone decides presence. Requiring punch_in_time as well hid
          // anyone marked present by a supervisor or an attendance correction
          // that never stamped a punch — they read 100% attendance yet fell out
          // of the High/Low board entirely.
          if (a.status === 'present' || a.status === 'late') punchedInSet.add(a.worker_id);
        }
      } else {
        const startStr = rangeStartDay;
        const endStr = rangeEndDay;
        const { data: att } = await db.from('attendance').select('worker_id, status, punch_in_time').gte('date', startStr).lte('date', endStr).in('worker_id', workerIds);
        const counts = {};
        for (const a of att || []) {
          if (!counts[a.worker_id]) counts[a.worker_id] = { present: 0, total: 0 };
          counts[a.worker_id].total++;
          if (a.status === 'present' || a.status === 'late') {
            counts[a.worker_id].present++;
            punchedInSet.add(a.worker_id);
          }
        }
        for (const [wid, c] of Object.entries(counts)) {
          attendanceMap[wid] = c.total > 0 ? Math.round((c.present / c.total) * 1000) / 10 : null;
        }
      }
    }

    const liveStatusMap = {};
    if (workerIds.length > 0) {
      const { data: live } = await db.from('fro_live_status').select('worker_id, today_talk_seconds').in('worker_id', workerIds);
      for (const l of live || []) liveStatusMap[l.worker_id] = l.today_talk_seconds || 0;
    }

    const { data: faRows } = await db
      .from('fro_assignments')
      .select('status, fro_worker_id')
      .in('ngo_id', ngoIds);
    const connectedStatuses = new Set(['contacted', 'donation_collected', 'lead_done', 'done', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback']);
    const workerAssignments = {};
    for (const a of faRows || []) {
      if (a.status === 'reassigned') continue;
      if (!workerAssignments[a.fro_worker_id]) workerAssignments[a.fro_worker_id] = { connected: 0, total: 0 };
      workerAssignments[a.fro_worker_id].total++;
      if (connectedStatuses.has(a.status)) workerAssignments[a.fro_worker_id].connected++;
    }

    const performance = froWorkers.map(w => {
      const bs = batchStats;
      const lb = lbById.get(String(w.id)) || {};
      const leads = (bs.verifiedMonth[w.id]?.count || 0) + (bs.unverifiedMonth[w.id]?.count || 0);
      const talkSec = includesToday ? (liveStatusMap[w.id] || 0) : 0;
      const wa = workerAssignments[w.id] || { connected: 0, total: 0 };
      const attPct = attendanceMap[w.id] != null ? attendanceMap[w.id] : null;
      return {
        fro_id: w.id,
        fro_name: w.name || w.login_id || 'Unknown',
        collection_amount: lb.collection_amount || 0,
        today_collection: lb.today_collection || 0,
        period_collection: lb.period_collection || 0,
        period_target: lb.period_target || 0,
        lead_done_count: leads,
        avg_talk_seconds: talkSec,
        data_used: wa.connected,
        data_total: wa.total,
        attendance_pct: attPct,
        punched_in: punchedInSet.has(w.id),
        monthly_target: lb.monthly_target || 0,
        achieved_target: lb.achieved_target || 0,
        working_days: lb.working_days || 0,
        worked_days: lb.worked_days || 0,
        remaining_working_days: lb.remaining_working_days || 0,
        per_day_collection: lb.per_day_collection || 0,
        remaining_target: lb.remaining_target || 0,
        average_collection: lb.average_collection || 0,
        performance_pct: lb.performance_pct || 0,
        rank: lb.rank ?? null,
      };
    });

    performance.sort((a, b) => a.performance_pct - b.performance_pct);
    return res.json(performance);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Per-FRO activity for one IST day, from the fro_daily_stats snapshot written on
// every heartbeat. Powers the Productivity Alerts view for a past date and
// includes that day's rank (verified collection that day vs the per-day target).
export const getFroDailyStats = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    let ngoIds = access.map(a => a.ngo_id).filter(Boolean);
    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId, date } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) ngoIds = [ngoIds[idx]];
    }
    if (ngoIds.length === 0) return res.json([]);

    const now = new Date();
    const statDate = date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers
      .filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .filter(w => w.is_active !== false);
    const workerIds = froWorkers.map(w => w.id);
    if (workerIds.length === 0) return res.json([]);

    const { data: rows } = await db
      .from('fro_daily_stats')
      .select('worker_id, stat_date, calls, talk_seconds, idle_seconds')
      .eq('stat_date', statDate)
      .in('worker_id', workerIds);
    const statById = {};
    for (const r of rows || []) statById[r.worker_id] = r;

    // Today is still accruing, so the saved snapshot lags the open idle period.
    // Add it back for the selected day or the panel shows 0m for an FRO who is
    // sitting idle right now.
    const liveIdleById = {};
    if (statDate === istDateStr(new Date())) {
      try {
        const { data: liveRows } = await db
          .from('fro_live_status')
          .select(FRO_IDLE_LIVE_COLS)
          .in('worker_id', workerIds);
        // Covers decide which of these rows may keep accruing. A covered-away FRO
        // is frozen at the last moment their own row was written, so this panel
        // cannot show a day total still climbing for somebody who is already
        // being covered — which is how a covered-away FRO ended up at the top of
        // the very list meant to nudge idle people back to work.
        const coversByTarget = await getActiveCoversForTargets(workerIds);
        const nowMs = Date.now();
        for (const ls of liveRows || []) {
          const shift = { startMs: -Infinity, endMs: Infinity };
          const coveredAway = isCovered(coversByTarget, ls.worker_id) && !isLiveFreshRow(ls, nowMs);
          liveIdleById[ls.worker_id] = liveIdleSeconds(
            ls,
            shift,
            nowMs,
            coveredAway ? idleFreezeCutoffMs(ls) : NaN
          );
        }
      } catch (_) {
        // fro_live_status may be unreadable — the saved snapshot still stands.
      }
    }

    // Only FROs who actually punched in on this day should surface in the
    // Productivity Alerts list, so carry the punch-in flag through.
    const punchedInSet = new Set();
    {
      const { data: att } = await db
        .from('attendance')
        .select('worker_id, status, punch_in_time')
        .eq('date', statDate)
        .in('worker_id', workerIds);
      for (const a of att || []) {
        if ((a.status === 'present' || a.status === 'late') && a.punch_in_time) punchedInSet.add(a.worker_id);
      }
    }

    // Same working-day rule as getFroPerformance: every Sunday off except the month's last.
    const monthLastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    let lastSunday = 0;
    for (let day = monthLastDay; day >= 1; day--) {
      if (new Date(now.getFullYear(), now.getMonth(), day).getDay() === 0) { lastSunday = day; break; }
    }
    let workingDays = 0;
    for (let day = 1; day <= monthLastDay; day++) {
      const sunday = new Date(now.getFullYear(), now.getMonth(), day).getDay() === 0;
      if (!sunday || day === lastSunday) workingDays++;
    }
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const { data: monthlyTargets } = await db
      .from('fro_monthly_targets')
      .select('fro_worker_id, target_amount')
      .in('ngo_id', ngoIds)
      .eq('month', monthStartStr);
    const targetMap = {};
    for (const t of monthlyTargets || []) {
      const cur = targetMap[t.fro_worker_id];
      const amount = Number(t.target_amount || 0);
      if (cur == null || amount > cur) targetMap[t.fro_worker_id] = amount;
    }

    const dayCollection = await getRangeCollectionByWorker(workerIds, statDate, statDate);
    const ranked = workerIds
      .filter(id => (targetMap[id] || 0) > 0)
      .map(id => {
        const perDay = workingDays > 0 ? targetMap[id] / workingDays : 0;
        return { id, pct: perDay > 0 ? (Number(dayCollection[id] || 0) / perDay) * 100 : 0 };
      })
      .sort((a, b) => b.pct - a.pct || String(a.id).localeCompare(String(b.id)));
    const rankMap = {};
    ranked.forEach((r, i) => { rankMap[r.id] = i + 1; });

    return res.json(froWorkers.map(w => ({
      fro_id: w.id,
      fro_name: w.name || w.login_id || 'Unknown',
      calls: statById[w.id]?.calls || 0,
      talk_seconds: statById[w.id]?.talk_seconds || 0,
      idle_seconds: liveIdleById[w.id] ?? statById[w.id]?.idle_seconds ?? 0,
      rank: rankMap[w.id] || null,
      punched_in: punchedInSet.has(w.id),
      date: statDate,
    })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setAchievedTarget = async (req, res) => {
  try {
    const { fro_worker_id, month, achieved_amount, ngo_id } = req.body;
    const ngoIds = await getUserNgoIds(req.user);
    const ngoId = ngo_id && ngoIds.some(id => String(id) === String(ngo_id)) ? ngo_id : ngoIds[0];

    if (!fro_worker_id || !month || achieved_amount === undefined) {
      return res.status(400).json({ message: 'fro_worker_id, month, and achieved_amount are required' });
    }
    if (!ngoId) {
      return res.status(400).json({ message: 'No NGO assigned to your account' });
    }

    const result = await updateAchievedTarget(fro_worker_id, ngoId, month + '-01', parseFloat(achieved_amount) || 0);

    return res.json({ message: 'Achieved target saved successfully', data: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setIncentive = async (req, res) => {
  try {
    const { fro_worker_id, month, incentive_amount, ngo_id } = req.body;
    const ngoIds = await getUserNgoIds(req.user);
    const ngoId = ngo_id && ngoIds.some(id => String(id) === String(ngo_id)) ? ngo_id : ngoIds[0];

    if (!fro_worker_id || !month) {
      return res.status(400).json({ message: 'fro_worker_id and month are required' });
    }
    if (!ngoId) {
      return res.status(400).json({ message: 'No NGO assigned to your account' });
    }

    const amount = incentive_amount != null && incentive_amount !== '' ? parseFloat(incentive_amount) : null;
    const result = await updateIncentive(fro_worker_id, ngoId, month + '-01', amount);

    return res.json({ message: 'Incentive saved successfully', data: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Accounts Panel ----

export const getAccountsPending = async (req, res) => {
  try {
    const { status } = req.query;
    const statusFilter = status || 'pending';

    const { data, error } = await db
      .from('fro_donor_logs')
      .select(`
        id, action, disposition_category, disposition_detail, amount_collected,
        payment_screenshot_url, accounts_status, pan_number, notes, remark, created_at,
        assignment_id, fro_worker_id,
        fro_assignments!inner(
          id,
          donor_id,
          fro_worker_id,
          status,
          donor_profiles!inner(id, name, mobile_number, city, pan_number),
          workers!inner(id, name, login_id)
        ),
        workers!fro_donor_logs_fro_worker_id_fkey(id, name, login_id)
      `)
      .eq('action', 'disposition')
      .eq('disposition_detail', 'lead_done')
      .eq('accounts_status', statusFilter)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const result = (data || []).map(r => ({
      log_id: r.id,
      amount: r.amount_collected,
      screenshot_url: r.payment_screenshot_url,
      accounts_status: r.accounts_status,
      pan_number: r.pan_number,
      notes: r.notes,
      remark: r.remark,
      created_at: r.created_at,
      assignment_id: r.assignment_id,
      assignment_status: r.fro_assignments?.status || 'lead_done',
      donor_id: r.fro_assignments?.donor_id,
      donor_name: r.fro_assignments?.donor_profiles?.name || 'Unknown',
      donor_mobile: r.fro_assignments?.donor_profiles?.mobile_number || '',
      donor_city: r.fro_assignments?.donor_profiles?.city || '',
      donor_pan: r.fro_assignments?.donor_profiles?.pan_number || '',
      worker_id: r.fro_worker_id,
      worker_name: r.workers?.name || 'Unknown',
      worker_login: r.workers?.login_id || '',
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const verifyLeadDone = async (req, res) => {
  try {
    const { logId } = req.params;
    const { pan_number, notes } = req.body;
    const ngoIds = await getUserNgoIds(req.user);

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, fro_worker_id, donor_id, status, ngo_id, donor_profiles!inner(id, name, mobile_number))')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    const assignmentNgoId = log.fro_assignments?.ngo_id;
    if (assignmentNgoId && !ngoIds.includes(Number(assignmentNgoId))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (log.accounts_status !== 'pending') {
      return res.status(400).json({ message: `This lead has already been ${log.accounts_status || 'processed'}` });
    }

    const assignmentId = log.fro_assignments?.id;
    if (!assignmentId) {
      return res.status(400).json({ message: 'Associated assignment not found' });
    }

    // Update log: verified (atomic check via .eq('accounts_status', 'pending'))
    const { data: updatedLog, error: updateLogError } = await db
      .from('fro_donor_logs')
      .update({
        accounts_status: 'verified',
        verified_at: new Date().toISOString(),
        verified_by: req.user.id,
        pan_number: pan_number || log.pan_number || null,
        notes: notes || log.notes || null,
      })
      .eq('id', logId)
      .eq('accounts_status', 'pending')
      .select('id');

    if (updateLogError) throw updateLogError;
    if (!updatedLog || updatedLog.length === 0) {
      return res.status(400).json({ message: 'This lead has already been processed (concurrent request)' });
    }

    // Update assignment: donation_collected
    const { error: updateAsgnError } = await db
      .from('fro_assignments')
      .update({
        status: 'donation_collected',
        last_contacted_at: new Date().toISOString(),
      })
      .eq('id', assignmentId);

    if (updateAsgnError) throw updateAsgnError;

    // Station membership is unchanged, but the disposition roll-up is grouped by
    // assignment status and this flipped one to donation_collected.
    bustStationCache();

    return res.json({ message: 'Lead verified, amount added to target' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Station Management ----

export const getStations = async (req, res) => {
  try {
    const { ngo_id } = req.query;

    let targetNgoIds;
    if (ngo_id) {
      targetNgoIds = [ngo_id];
    } else {
      const access = await getUserNgoAccess(req.user.id, req.user.role);
      targetNgoIds = access.map(a => a.ngo_id).filter(Boolean);
      if (targetNgoIds.length === 0 && req.user.ngo_id) {
        targetNgoIds.push(req.user.ngo_id);
      }
      if (targetNgoIds.length === 0) return res.json([]);
    }

    // This endpoint scans every assignment row in the NGOs in scope and dedupes
    // per (station, ngo, donor) to build the donor_count map - the most expensive
    // read on the stations screen, and it was previously uncached, so each poll
    // paid it in full. Key on the resolved NGO set rather than the raw query, so
    // an admin and a super-admin looking at the same stations share one entry.
    //
    // The view mode is part of the key, not just the NGO set: the payload below
    // differs by mode even for an identical set. Without ngo_id the station list
    // also folds in null-NGO rows (getStationAssignmentsByNgo's second argument)
    // and takes names from the access list, while an explicit ngo_id takes only
    // that NGO and looks its name up directly. A single-NGO admin hits exactly
    // that overlap, so keying on the set alone would hand them the wrong list.
    const stationCacheKey = `stations:${ngo_id ? 'one' : 'all'}:${targetNgoIds.slice().sort().join(',')}`;
    if (req.query.fresh !== '1') {
      const cached = cacheGet(stationCacheKey, 60000);
      if (cached) return res.json(cached);
      const l2 = await redis.get(stationRedisKey(stationCacheKey));
      if (Array.isArray(l2)) {
        cacheSet(stationCacheKey, l2);
        return res.json(l2);
      }
    }

    // Get station assignments — only include null-NGO rows in the "all" view (no ngo_id filter)
    const assignments = await getStationAssignmentsByNgo(targetNgoIds, !ngo_id);

    // Get donor counts per station from fro_assignments (deduplicated by donor_id)
    const { data: faData, error: faErr } = await db
      .from('fro_assignments')
      .select('donor_id, station, ngo_id, fro_worker_id, assigned_at')
      .in('ngo_id', targetNgoIds)
      .not('station', 'is', null)
      .not('status', 'eq', 'reassigned')
      .order('assigned_at', { ascending: false });

    if (faErr) throw faErr;

    // Build total donor count per station PER NGO and per-FRO count
    const totalDonorCount = {}; // { station: { ngo_id: count } }
    const froDonorCount = {};
    const seen = new Set();
    for (const d of faData || []) {
      const s = d.station.trim();
      // Dedupe per (station, ngo), NOT on donor_id alone. donor_id is the same
      // person in every NGO they are assigned to, and faData is ordered by
      // assigned_at DESC, so a set keyed on donor_id attributed each donor to
      // whichever of their rows came first - usually an assignment in a
      // different NGO - and then skipped them everywhere else. That is why the
      // AOD-11 row read "AFLF: 755" while its donor list held 1819: all 1819
      // of those donors are also active in another NGO, so the other NGO's row
      // claimed each of them first.
      //
      // Keyed per station the count is exactly "distinct donors assigned here",
      // which is what donors-by-station returns for the same (station, ngo) -
      // so the pill and the list it opens can no longer disagree.
      const key = `${s}::${d.ngo_id}::${d.donor_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!totalDonorCount[s]) totalDonorCount[s] = {};
      totalDonorCount[s][d.ngo_id] = (totalDonorCount[s][d.ngo_id] || 0) + 1;
      if (d.fro_worker_id) {
        const froKey = `${s}_${d.fro_worker_id}`;
        froDonorCount[froKey] = (froDonorCount[froKey] || 0) + 1;
      }
    }

    const ngoIdToName = {};
    if (ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', ngo_id).single();
      if (ngo) ngoIdToName[ngo_id] = ngo.name;
    } else {
      const access = await getUserNgoAccess(req.user.id, req.user.role);
      for (const a of access) {
        ngoIdToName[a.ngo_id] = a.ngo_name;
      }
      if (req.user.ngo_id && !ngoIdToName[req.user.ngo_id]) {
        const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
        if (ngo) ngoIdToName[req.user.ngo_id] = ngo.name;
      }
    }

    // Group by station name — one row per station
    const stationMap = {};
    const displayFroId = (a) => (a.fro_worker_id && a.workers?.is_test !== true) ? a.fro_worker_id : null;
    // Agent labels replace the FRO's raw name in station views.
    //
    // The label comes from the station's OWN agent of record (crm_agent_id), not
    // from asking which agent covers the worker today. A station belongs to a
    // seat, not to a person: moving that FRO to another agent must not change
    // who owns the station. The worker_id lookup is kept only as the fallback for
    // rows written before the column existed.
    const assignmentWorkerIds = [...new Set(assignments.map((a) => a.fro_worker_id).filter(Boolean))];
    const assignmentAgentIds = [...new Set(assignments.map((a) => a.crm_agent_id).filter(Boolean))];
    let stationAgentLabelMap = {};
    if (assignmentWorkerIds.length > 0 || assignmentAgentIds.length > 0) {
      const byWorker = assignmentWorkerIds.length > 0
        ? db.from('crm_agents').select('worker_id, label, id').in('worker_id', assignmentWorkerIds).eq('is_active', true)
        : null;
      const byAgent = assignmentAgentIds.length > 0
        ? db.from('crm_agents').select('id, label').in('id', assignmentAgentIds)
        : null;
      const [byWorkerRes, byAgentRes] = await Promise.all([
        byWorker || Promise.resolve({ data: [] }),
        byAgent || Promise.resolve({ data: [] }),
      ]);
      if (byWorkerRes.error) console.error('[stations] agent label load failed:', byWorkerRes.error.message);
      if (byAgentRes.error) console.error('[stations] station agent load failed:', byAgentRes.error.message);
      for (const a of byAgentRes.data || []) {
        if (a.id && !stationAgentLabelMap[a.id]) stationAgentLabelMap[a.id] = a.label;
      }
      for (const a of byWorkerRes.data || []) {
        if (a.worker_id && !stationAgentLabelMap[a.worker_id]) stationAgentLabelMap[a.worker_id] = a.label;
      }
    }
    // Two lookups, and the order is the requirement: the station's own record
    // first, the worker's current agent only when the station has none.
    const agentLabelFor = (a) => (a.crm_agent_id && stationAgentLabelMap[a.crm_agent_id])
      || (displayFroId(a) && stationAgentLabelMap[displayFroId(a)])
      || null;
    // The station row now reports the FRO of record and the agent of record
    // as separate fields, so the agent label is no longer substituted into
    // fro_worker_name here.

    for (const a of assignments) {
      const s = a.station.trim();
      const agentLabel = agentLabelFor(a);
      if (!stationMap[s]) {
        stationMap[s] = {
          station: s,
          ngos: [],
          fro_worker_id: displayFroId(a),
          // The volunteer's own name. The agent label is reported separately as
          // agent_label, because "who sits here" and "who owns this seat" are
          // different questions now that the two can move independently.
          fro_worker_name: a.workers?.name || null,
          crm_agent_id: a.crm_agent_id || null,
          agent_label: agentLabel,
        };
      }
      stationMap[s].ngos.push({
        ngo_id: a.ngo_id,
        ngo_name: ngoIdToName[a.ngo_id] || 'Unknown',
        assignment_id: a.id,
      });
      // Update FRO if this assignment has one (first non-null wins)
      if (!stationMap[s].fro_worker_id && displayFroId(a)) {
        stationMap[s].fro_worker_id = displayFroId(a);
        stationMap[s].fro_worker_name = a.workers?.name || null;
      }
      if (!stationMap[s].crm_agent_id && a.crm_agent_id) {
        stationMap[s].crm_agent_id = a.crm_agent_id;
      }
      if (!stationMap[s].agent_label && agentLabel) {
        stationMap[s].agent_label = agentLabel;
      }
    }

    // Also add stations from donor_profiles not in fro_station_assignments
    for (const s of Object.keys(totalDonorCount)) {
      if (!stationMap[s]) {
        stationMap[s] = {
          station: s,
          ngos: [],
          fro_worker_id: null,
          fro_worker_name: null,
          crm_agent_id: null,
          agent_label: null,
        };
      }
    }

    const result = Object.values(stationMap).map(s => ({
      ...s,
      donor_count: totalDonorCount[s.station] || {}, // { ngo_id: count }
      fro_donor_count: s.fro_worker_id ? (froDonorCount[`${s.station}_${s.fro_worker_id}`] || 0) : 0,
    }));

    result.sort((a, b) => {
      const parseStation = (s) => {
        const idx = s.lastIndexOf('-');
        if (idx === -1) return [s, 0];
        const prefix = s.slice(0, idx);
        const num = parseInt(s.slice(idx + 1), 10);
        return [prefix, isNaN(num) ? 0 : num];
      };
      const [pA, nA] = parseStation(a.station);
      const [pB, nB] = parseStation(b.station);
      if (pA !== pB) return pA.localeCompare(pB);
      return nA - nB;
    });

    cacheSet(stationCacheKey, result);
    redis.set(stationRedisKey(stationCacheKey), result, STATION_REDIS_TTL_S).catch(() => { });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const saveStationAssignment = async (req, res) => {
  try {
    const { station, fro_worker_id } = req.body;
    if (!station) {
      return res.status(400).json({ message: 'station is required' });
    }

    const trimmedStation = station.trim();
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    let ngoId;
    if (ngoNames.length > 0) {
      const { data: donorStation } = await db
        .from('donor_profiles')
        .select('ngo')
        .eq('station', trimmedStation)
        .in('ngo', ngoNames)
        .limit(1)
        .maybeSingle();

      if (donorStation) {
        const idx = ngoNames.indexOf(donorStation.ngo);
        if (idx !== -1) ngoId = ngoIds[idx];
      }
    }

    if (!ngoId) ngoId = ngoIds[0] || req.user.ngo_id || null;
    if (!ngoId) return res.status(400).json({ message: 'No NGO assigned to your account' });

    const result = await upsertStationAssignment(fro_worker_id || null, ngoId, trimmedStation, req.user.id);
    // The stations screen renders this station's FRO and donor count straight
    // after the save, so the cached copy has to go or the write looks ignored.
    bustStationCache();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeStationAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const ngoIds = await getUserNgoIds(req.user);
    const { data: existing } = await db
      .from('fro_station_assignments')
      .select('ngo_id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ message: 'Station assignment not found' });
    if (!ngoIds.includes(existing.ngo_id)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    await deleteStationAssignment(id);
    bustStationCache();
    return res.json({ message: 'Station assignment removed' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeStationByName = async (req, res) => {
  try {
    const { station } = req.params;
    if (!station) return res.status(400).json({ message: 'Station name is required' });
    const { ngo_id } = req.query;
    const ngoIds = await getUserNgoIds(req.user);

    const delNgoId = ngo_id || null;
    if (delNgoId && !ngoIds.some(id => String(id) === String(delNgoId))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    let delQuery = db
      .from('fro_station_assignments')
      .delete()
      .eq('station', station.trim());
    if (delNgoId) {
      delQuery = delQuery.eq('ngo_id', delNgoId);
    } else {
      delQuery = delQuery.in('ngo_id', ngoIds);
    }

    const { error } = await delQuery;
    if (error) throw error;

    bustStationCache();
    return res.json({ message: 'Station deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createStationHandler = async (req, res) => {
  try {
    const { station, ngo_id } = req.body;
    if (!station) {
      return res.status(400).json({ message: 'station name is required' });
    }
    const ngoIds = await getUserNgoIds(req.user);
    if (ngo_id && !ngoIds.some(id => String(id) === String(ngo_id))) {
      return res.status(403).json({ message: 'Access denied for this NGO' });
    }

    const stationName = station.trim();

    const { data: existing } = await db
      .from('fro_station_assignments')
      .select('id')
      .eq('station', stationName)
      .eq('ngo_id', ngo_id || null)
      .maybeSingle();
    if (existing) {
      return res.json({ message: 'already exists' });
    }

    const { data, error } = await db
      .from('fro_station_assignments')
      .insert([{ station: stationName, ngo_id: ngo_id || null, assigned_by: req.user.id }])
      .select();
    if (error) throw error;
    bustStationCache();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// The station row is the relationship of record for NGO + Station -> Agent.
// Every donor sitting in that station must therefore show that agent as its
// current FRO, which is what every read path (donor detail, FRO lists,
// dashboards, filters, search, credit/salary) resolves through
// fro_assignments.fro_worker_id. Updating the station row alone would only
// change the station page.
//
// The pre-existing FRO is parked in original_fro_worker_id on the first
// change only, so history survives but can never override the station agent.
const syncStationAgentToFro = async (client, ngoId, station, agentId) => {
  const PAGE = 1000;
  for (;;) {
    const { data: pending, error: selErr } = await client
      .from('fro_assignments')
      .select('id, fro_worker_id')
      .eq('ngo_id', ngoId)
      .eq('station', station)
      .not('status', 'eq', 'reassigned')
      .is('original_fro_worker_id', null)
      .not('fro_worker_id', 'is', null)
      .limit(PAGE);
    if (selErr) throw selErr;
    const rows = (pending || []).filter(r => r.fro_worker_id);
    if (rows.length === 0) break;

    const byWorker = {};
    for (const r of rows) (byWorker[r.fro_worker_id] ||= []).push(r.id);
    for (const [wid, ids] of Object.entries(byWorker)) {
      const { error } = await client
        .from('fro_assignments')
        .update({ original_fro_worker_id: wid })
        .in('id', ids);
      if (error) throw error;
    }
    if (rows.length < PAGE) break;
  }

  const { error } = await client
    .from('fro_assignments')
    .update({ fro_worker_id: agentId })
    .eq('ngo_id', ngoId)
    .eq('station', station)
    .not('status', 'eq', 'reassigned');
  if (error) throw error;
};

export const updateStationNgos = async (req, res) => {
  try {
    const { station } = req.params;
    const { ngo_id, fro_worker_id } = req.body;
    const trimmed = station.trim();

    // A station is assigned by AGENT (the seat), not by the person currently
    // sitting in it. Resolving the agent first means fro_worker_id is derived
    // and always tracks whichever FRO that agent covers, instead of being
    // frozen at assignment time and going stale after the next reassignment.
    let resolvedAgentId = null;
    let resolvedWorkerId = fro_worker_id || null;
    const requestedAgentId = req.body?.crm_agent_id ? String(req.body.crm_agent_id) : null;
    if (requestedAgentId) {
      const { data: agentRow, error: agentErr } = await db
        .from('crm_agents')
        .select('id, worker_id, label')
        .eq('id', requestedAgentId)
        .maybeSingle();
      if (agentErr) throw agentErr;
      if (!agentRow) return res.status(404).json({ message: 'Agent not found' });
      resolvedAgentId = agentRow.id;
      resolvedWorkerId = agentRow.worker_id;
    }

    // Look up the existing station assignment to preserve its ngo_id.
    // Prefer the exact (station, ngo) row so an agent edit on a station that
    // happens to exist under another NGO cannot resolve to the wrong row, then
    // fall back to a station-only lookup so a bare NGO change still behaves
    // the way it always has.
    let lookup = db
      .from('fro_station_assignments')
      .select('id, ngo_id')
      .eq('station', trimmed);
    if (ngo_id) lookup = lookup.eq('ngo_id', ngo_id);
    let { data: existing } = await lookup.limit(1).maybeSingle();
    if (!existing && ngo_id) {
      ({ data: existing } = await db
        .from('fro_station_assignments')
        .select('id, ngo_id')
        .eq('station', trimmed)
        .limit(1)
        .maybeSingle());
    }

    const resolvedNgoId = existing?.ngo_id || ngo_id || null;

    const { error: upsertErr } = await db
      .from('fro_station_assignments')
      .upsert({
        station: trimmed,
        ngo_id: resolvedNgoId,
        assigned_by: req.user.id,
        fro_worker_id: resolvedWorkerId || null,
        crm_agent_id: resolvedAgentId,
      }, { onConflict: 'station,ngo_id' });
    if (upsertErr) throw upsertErr;

    // Only an explicit assignment rewrites donor FROs. handleNgoChange sends
    // ngo_id alone, and moving a station between NGOs must not wipe agents.
    if ((Object.prototype.hasOwnProperty.call(req.body, 'fro_worker_id') || requestedAgentId) && resolvedNgoId) {
      await syncStationAgentToFro(db, resolvedNgoId, trimmed, resolvedWorkerId || null);
    }

    bustStationCache();
    return res.json({ message: 'Station updated' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const reassignStationFro = async (req, res) => {
  try {
    const { id } = req.params;
    const { fro_worker_id } = req.body;
    if (!fro_worker_id) {
      return res.status(400).json({ message: 'fro_worker_id is required' });
    }

    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);
    const ngoId = ngoIds[0] || req.user.ngo_id;
    if (!ngoId) return res.status(400).json({ message: 'No NGO assigned' });

    // Get station info
    const { data: stationAssign } = await db
      .from('fro_station_assignments')
      .select('station')
      .eq('id', id)
      .single();
    if (!stationAssign) return res.status(404).json({ message: 'Station assignment not found' });

    // Update station assignment
    await upsertStationAssignment(fro_worker_id, ngoId, stationAssign.station, req.user.id);

    // Reassign donors in this station
    const { reassignStationDonors } = await import('../models/froAssignmentModel.js');
    const newAssignments = await reassignStationDonors(ngoId, stationAssign.station, fro_worker_id, req.user.id);

    // Moves every donor in the station, so both the station list and the
    // disposition roll-up are now wrong, not just the FRO label.
    bustStationCache();

    return res.json({
      message: `Station reassigned. ${newAssignments.length} donors assigned to new FRO.`,
      count: newAssignments.length,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getStationStats = async (req, res) => {
  try {
    const stationCacheKey = `stn:${req.user.id}:${req.query.ngo_id || 'all'}:${req.query.from || ''}:${req.query.to || ''}`;
    if (req.query.fresh !== '1') {
      const cached = cacheGet(stationCacheKey, 60000);
      if (cached) return res.json(cached);
      // Missed in-memory: this rolls up disposition counts for every station, so
      // warm it from Redis rather than re-running the per-NGO stats queries.
      const l2 = await redis.get(stationStatsRedisKey(stationCacheKey));
      if (l2 && typeof l2 === 'object') {
        cacheSet(stationCacheKey, l2);
        return res.json(l2);
      }
    }
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId, from, to } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    if (ngoIds.length === 0) return res.json({ stations: {}, summary: {} });

    const stationMap = {};

    const allStats = await Promise.all(ngoIds.map(ngoId => getStationDispositionStats(ngoId, from, to)));
    for (const stats of allStats) {
      for (const [station, statuses] of Object.entries(stats)) {
        if (!stationMap[station]) stationMap[station] = {};
        for (const [status, count] of Object.entries(statuses)) {
          stationMap[station][status] = (stationMap[station][status] || 0) + count;
        }
      }
    }

    const summaryRows = await sql(
      `SELECT status, COUNT(*) AS c
       FROM (SELECT DISTINCT donor_id, status FROM fro_assignments WHERE ngo_id = ANY($1) AND station IS NOT NULL AND status <> 'reassigned') t
       GROUP BY status`,
      [ngoIds]
    );
    const summary = {};
    for (const r of summaryRows) summary[r.status] = parseInt(r.c, 10) || 0;

    // Get all stations for this NGO (including empty ones)
    const stationAssigns = await getStationAssignmentsByNgo(ngoIds);
    for (const sa of stationAssigns) {
      if (!stationMap[sa.station]) {
        stationMap[sa.station] = {};
      }
    }

    const stationPayload = { stations: stationMap, summary };
    cacheSet(stationCacheKey, stationPayload);
    redis.set(stationStatsRedisKey(stationCacheKey), stationPayload, STATION_REDIS_TTL_S).catch(() => { });
    return res.json(stationPayload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};



export const getDonorsByStation = async (req, res) => {
  try {
    const { station, status, ngo_id } = req.query;
    if (!station) {
      return res.status(400).json({ message: 'station query param is required' });
    }

    const access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoIds.length === 0 && req.user.ngo_id) {
      ngoIds.push(req.user.ngo_id);
    }

    if (ngoIds.length === 0) {
      return res.json([]);
    }

    // WHY ngo_id EXISTS. A station NAME is not unique to an NGO. The same name is
    // reused across NGOs and only the displayed code differs: 'DH-5' is BOD-15 for
    // BSCT, AOD-15 for AFLF and MOD-15 for MANN (StationManagement.jsx:19-42).
    // An NGO admin's access resolves to *every* NGO (getUserNgoAccess: role
    // 'admin' short-circuits to all NGOs), so looking a station up by name alone
    // silently unions unrelated stations together.
    //
    // That produced two visible bugs. The station row's donor count is per
    // (station, ngo) - donor_count is a { ngo_id: count } map (getStations:1800)
    // - so MANN's MOD-15 showed 754 while this endpoint reported 1824 for the very
    // same station. And the cross-NGO dedupe below kept only the first row per
    // donor_id, so a donor present in several NGOs was rendered with another
    // NGO's FRO, status and dates: an FRO name that has nothing to do with the
    // station being viewed.
    //
    // Callers that mean one station pass ngo_id and get exactly that station.
    // Omitting it keeps the cross-NGO union for the surfaces that genuinely want
    // it (super-admin Dashboard, accounts Old Data), which is why ngo_id is
    // optional rather than required - but every row now carries its own
    // ngo_id / ngo_name so a union can never be mistaken for a single station.
    //
    // One code path covers both cases: no ngo_id leaves ngoIds as the union, an
    // ngo_id the caller may not access is refused rather than widened.
    const scope = resolveStationNgoScope(ngoIds, ngo_id);
    if (!scope.ok) return res.status(403).json({ message: scope.message });
    ngoIds = scope.ids;

    // Names come from the access rows, but an NGO resolved from req.user.ngo_id
    // (the fallback above, when access is empty) has none, and a blank ngo_name
    // is exactly what makes a unioned row unattributable. Fill those in.
    const ngoNameById = new Map(access.map(a => [String(a.ngo_id), a.ngo_name]));
    const unnamedIds = ngoIdsMissingNames(access, ngoIds);
    if (unnamedIds.length > 0) {
      const { data: ngos } = await db.from('ngos').select('id, name').in('id', unnamedIds);
      for (const n of ngos || []) ngoNameById.set(String(n.id), n.name);
    }

    const allDonors = [];
    for (const ngoId of ngoIds) {
      const donors = await getDonorsByStationAndStatus(ngoId, station, status || null);
      allDonors.push(...donors);
    }

    const unique = dedupeStationDonors(allDonors);

    const result = unique.map(a => ({
      id: a.id,
      donor_id: a.donor_id,
      // Which NGO this assignment actually belongs to. Required, not decorative:
      // without it a cross-NGO response is indistinguishable from one station's
      // list, which is exactly the confusion being fixed here.
      ngo_id: a.ngo_id,
      ngo_name: ngoNameById.get(String(a.ngo_id)) || '',
      donor_mobile: a.donor_profiles?.mobile_number || '',
      donor_mobile_2: a.donor_profiles?.mobile_2 || '',
      donor_name: a.donor_profiles?.name || 'Unknown',
      donor_city: a.donor_profiles?.city || '',
      data_category: a.donor_profiles?.data_category || '',
      amount: a.donor_profiles?.amount || 0,
      fro_worker_id: a.fro_worker_id,
      fro_name: a.workers?.name || 'Unassigned',
      status: a.status,
      station: a.station || '',
      notes: a.notes || '',
      last_contacted_at: a.last_contacted_at,
      next_follow_up: a.next_follow_up,
      assigned_at: a.assigned_at,
      raw_data: a.donor_profiles?.raw_data || null,
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorsByFro = async (req, res) => {
  try {
    const { fro_worker_id, status, period, from, to } = req.query;
    if (!fro_worker_id) {
      return res.status(400).json({ message: 'fro_worker_id query param is required' });
    }
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);
    if (ngoIds.length === 0 && req.user.ngo_id) ngoIds.push(req.user.ngo_id);
    if (ngoIds.length === 0) return res.json([]);

    const hasRange = Boolean(from || to || (period && period !== 'all'));
    let startDate, endDate;
    if (from || to) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      startDate = from ? new Date(`${from}T00:00:00`) : todayStart;
      endDate = to ? new Date(`${to}T23:59:59.999`) : todayEnd;
    } else if (period && period !== 'all') {
      const now = new Date();
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      if (period === 'today') {
        startDate = todayStart; endDate = todayEnd;
      } else if (period === 'week') {
        const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
        startDate = weekStart; endDate = todayEnd;
      } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      }
    }

    if (startDate && endDate) {
      const { data: logs, error: logErr } = await db
        .from('fro_donor_logs')
        .select('donor_id, assignment_id, disposition_detail, disposition_category, remark, notes, created_at')
        .eq('fro_worker_id', fro_worker_id)
        .gte('created_at', startDate.toISOString())
        .lte('created_at', endDate.toISOString())
        .order('created_at', { ascending: false });

      if (logErr) throw logErr;

      const donorIds = [...new Set((logs || []).map(l => l.donor_id).filter(Boolean))];
      if (donorIds.length === 0) return res.json([]);

      const logStatusMap = {};
      const logCategoryMap = {};
      const logRemarkMap = {};
      const donorAssignmentMap = {};
      for (const l of logs || []) {
        if (l.disposition_detail && !logStatusMap[l.donor_id]) {
          logStatusMap[l.donor_id] = l.disposition_detail;
          logCategoryMap[l.donor_id] = String(l.disposition_category || '').toLowerCase();
        }
        const rm = (l.remark && String(l.remark).trim()) || (l.notes && String(l.notes).trim()) || '';
        if (rm && !logRemarkMap[l.donor_id]) logRemarkMap[l.donor_id] = rm;
        if (l.assignment_id && !donorAssignmentMap[l.donor_id]) donorAssignmentMap[l.donor_id] = l.assignment_id;
      }

      // Work-as rows: fro_donor_logs.fro_worker_id is the operator (credit)
      // while the assignment stays with the impersonated FRO. Fetch
      // assignments by donor within NGO scope — WITHOUT the ownership filter —
      // so work-as activity is visible; each donor is matched to the
      // assignment their latest log was actually made on.
      const { data, error } = await db
        .from('fro_assignments')
        .select('*, donor_profiles(*), workers!fro_assignments_fro_worker_id_fkey(id, name, login_id)')
        .in('ngo_id', ngoIds)
        .in('donor_id', donorIds);
      if (error) throw error;

      const byDonor = new Map();
      for (const a of data || []) {
        if (!byDonor.has(a.donor_id)) byDonor.set(a.donor_id, []);
        byDonor.get(a.donor_id).push(a);
      }

      // One row per donor (matches the dashboard count, which counts DISTINCT
      // donors by their latest disposition). Donors appear latest-activity
      // first because logs are ordered created_at DESC.
      const result = [];
      for (const donorId of donorIds) {
        const list = byDonor.get(donorId);
        if (!list || list.length === 0) continue;
        const wanted = donorAssignmentMap[donorId];
        const a = (wanted && list.find(x => String(x.id) === String(wanted))) || list[0];
        result.push({
          id: a.id,
          donor_id: a.donor_id,
          donor_mobile: a.donor_profiles?.mobile_number || '',
          donor_name: a.donor_profiles?.name || 'Unknown',
          donor_city: a.donor_profiles?.city || '',
          status: a.status,
          call_status: logStatusMap[a.donor_id] || a.status,
          call_category: logCategoryMap[a.donor_id] || '',
          call_remark: logRemarkMap[a.donor_id] || a.notes || '',
          station: a.station || '',
          notes: a.notes || '',
          next_follow_up: a.next_follow_up,
          assigned_at: a.assigned_at,
          owner_name: a.workers?.name || '',
        });
      }

      const finalRows = status
        ? result.filter(r => r.call_status === status || (MERGED_DISPOSITION_GROUPS[status] || []).includes(r.call_status))
        : result;

      return res.json(finalRows);
    }

    if (!hasRange) {
      let query = db
      .from('fro_assignments')
      .select('*, donor_profiles(*), workers!fro_assignments_fro_worker_id_fkey(id, name, login_id)')
      .in('ngo_id', ngoIds)
      .eq('fro_worker_id', fro_worker_id)
      .not('status', 'eq', 'reassigned');

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    const result = (data || []).map(a => ({
      id: a.id,
      donor_id: a.donor_id,
      donor_mobile: a.donor_profiles?.mobile_number || '',
      donor_name: a.donor_profiles?.name || 'Unknown',
      donor_city: a.donor_profiles?.city || '',
      status: a.status,
      station: a.station || '',
      notes: a.notes || '',
      next_follow_up: a.next_follow_up,
      assigned_at: a.assigned_at,
    }));

      return res.json(result);
    }

    return res.json([]);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getNewData = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    let ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames = [ngo.name]; ngoIds = [req.user.ngo_id]; }
    }

    const { ngo_id: filterNgoId, page: pageStr, per_page: perPageStr, category: categoryFilter } = req.query;
    const pageNum = Math.max(1, parseInt(pageStr) || 1);
    const perPage = Math.min(5000, Math.max(10, parseInt(perPageStr) || 500));
    const normalizedCategory = categoryFilter ? String(categoryFilter).trim() : '';

    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        const name = ngoNames[idx];
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
        ngoNames.splice(0, ngoNames.length, name);
      }
    }

    if (ngoNames.length === 0) {
      return res.json({ unassigned: [], ngo_data: [], total: 0, page: pageNum, per_page: perPage });
    }

    // 1. new_data for admin's NGOs that are still pending conversion
    const FETCH_LIMIT = 25000;
    const { data: importedRows, error: iErr } = await db
      .from('new_data')
      .select('name, mobile_number, category, data_category, amount, created_at, ngo')
      .in('ngo', ngoNames)
      .not('mobile_number', 'is', null)
      .or('status.eq.pending,status.is.null')
      .order('created_at', { ascending: false })
      .limit(FETCH_LIMIT);

    if (iErr) throw iErr;

    let unassigned = [];
    if (importedRows && importedRows.length > 0) {
      const latest = {};
      for (const row of importedRows) {
        const key = `${row.mobile_number}||${row.ngo}`;
        if (!latest[key]) latest[key] = row;
      }
      const entries = Object.values(latest);

      // Safety check: exclude only if donor_profile exists FOR THE SAME NGO (per-NGO isolation)
      // Group mobiles by NGO, then check donor_profiles with ngo filter
      const mobilesByNgo = {};
      for (const e of entries) {
        if (!mobilesByNgo[e.ngo]) mobilesByNgo[e.ngo] = [];
        mobilesByNgo[e.ngo].push(e.mobile_number);
      }

      const existingMobilesByNgo = {};
      const BATCH_SIZE = 500;
      for (const [ngo, mobiles] of Object.entries(mobilesByNgo)) {
        const existingMobiles = new Set();
        const batchQueries = [];
        for (let i = 0; i < mobiles.length; i += BATCH_SIZE) {
          const batch = mobiles.slice(i, i + BATCH_SIZE);
          batchQueries.push(
            db.from('donor_profiles').select('mobile_number').in('mobile_number', batch).eq('ngo', ngo)
          );
        }
        const batchResults = await Promise.allSettled(batchQueries);
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value.data) {
            r.value.data.forEach(p => existingMobiles.add(p.mobile_number));
          }
        }
        existingMobilesByNgo[ngo] = existingMobiles;
      }

      unassigned = entries.filter(e => !existingMobilesByNgo[e.ngo]?.has(e.mobile_number));
    }

    // 2. NGO's donor_profiles not yet FRO-assigned
    let ngoData = [];
    const { data: ngoProfiles, error: npErr } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, category, data_category, amount, first_imported_at, ngo')
      .in('ngo', ngoNames)
      .order('first_imported_at', { ascending: false });

    if (npErr) throw npErr;

    if (ngoProfiles && ngoProfiles.length > 0) {
      const profileIds = ngoProfiles.map(p => p.id);
      const { data: froAsgn } = await db
        .from('fro_assignments')
        .select('donor_id')
        .in('donor_id', profileIds);

      const assignedIds = new Set(froAsgn ? froAsgn.map(a => a.donor_id) : []);
      ngoData = ngoProfiles.filter(p => !assignedIds.has(p.id)).map(p => ({
        ...p,
        created_at: p.first_imported_at,
      }));
    }

    // Helper to extract category name from a record
    const getRowCategory = (r) => String(r?.data_category || r?.category || '').trim();

    // Category-wise filter (by data_category or category, case-insensitive)
    if (normalizedCategory) {
      unassigned = unassigned.filter(e => getRowCategory(e).toLowerCase() === normalizedCategory.toLowerCase());
      ngoData = ngoData.filter(e => getRowCategory(e).toLowerCase() === normalizedCategory.toLowerCase());
    }

    // Distinct data categories for the filter dropdown (across new_data + donor_profiles, NGO-scoped)
    const categorySet = new Set();
    const { data: newDataCats } = await db
      .from('new_data')
      .select('data_category, category')
      .in('ngo', ngoNames)
      .or('status.eq.pending,status.is.null');
    for (const c of newDataCats || []) {
      const cat = getRowCategory(c);
      if (cat) categorySet.add(cat);
    }
    const { data: profileCats } = await db
      .from('donor_profiles')
      .select('data_category, category')
      .in('ngo', ngoNames);
    for (const c of profileCats || []) {
      const cat = getRowCategory(c);
      if (cat) categorySet.add(cat);
    }
    const categoryOptions = [...categorySet].sort((a, b) => a.localeCompare(b));

    const total = unassigned.length;
    const start = (pageNum - 1) * perPage;
    const pagedUnassigned = unassigned.slice(start, start + perPage);

    return res.json({ unassigned: pagedUnassigned, ngo_data: ngoData, category_options: categoryOptions, total, page: pageNum, per_page: perPage });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};



export const distributeNewData = async (req, res) => {
  try {
    const { stations: selectedStations, ngo_id: filterNgoId, category } = req.body;
    const normalizedCategory = category ? String(category).trim() : '';
    let access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: req.user.ngo_id, ngoName: ngo.name });
    }
    // Filter to specific NGO if provided (match by ID or name)
    if (filterNgoId) {
      ngoEntries = ngoEntries.filter(e => String(e.ngoId) === String(filterNgoId) || String(e.ngoName).toLowerCase() === String(filterNgoId).toLowerCase());
    }
    if (ngoEntries.length === 0) {
      return res.json({ message: 'No NGO assigned to your account', count: 0 });
    }
    console.log('--- distributeNewData start ---');
    console.log('ngoEntries:', JSON.stringify(ngoEntries), normalizedCategory ? `category: ${normalizedCategory}` : 'all categories');

    let totalAssigned = 0;
    let totalConverted = 0;
    let skippedNgos = [];
    const messages = [];

    for (const { ngoId, ngoName } of ngoEntries) {
      try {
      const batchId = crypto.randomUUID();
      console.log(`[${ngoName}] === Processing NGO: ${ngoName} (id=${ngoId}) ===`);
      // Step 1: Create donor_profiles from new_data (fetch ALL rows, paginated)
      const PAGE = 10000;
      let importedRows = [];
      let offset = 0;
      for (;;) {
        let query = db
          .from('new_data')
          .select('name, mobile_number, category, amount, data_category')
          .eq('ngo', ngoName)
          .not('mobile_number', 'is', null)
          .or('status.eq.pending,status.is.null')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });

        if (normalizedCategory) {
          query = query.or(`data_category.eq.${normalizedCategory},category.eq.${normalizedCategory}`);
        }

        const { data, error } = await query.range(offset, offset + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        importedRows = importedRows.concat(data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      console.log(`[${ngoName}] importedRows count:`, importedRows.length, normalizedCategory ? `(category: ${normalizedCategory})` : '');

      let newProfileIds = [];
      let allMobiles = [];
      if (importedRows && importedRows.length > 0) {
        const latest = {};
        for (const row of importedRows) {
          if (!latest[row.mobile_number]) latest[row.mobile_number] = row;
        }
        const mobiles = Object.keys(latest);

        // Batch existing profile check to avoid 414, run in parallel
        const existingMap = {};
        const BATCH = 500;
        const batchQueries = [];
        for (let i = 0; i < mobiles.length; i += BATCH) {
          const batch = mobiles.slice(i, i + BATCH);
          batchQueries.push(
            db.from('donor_profiles').select('id, mobile_number').in('mobile_number', batch)
          );
        }
        const batchResults = await Promise.allSettled(batchQueries);
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value.data) {
            for (const p of r.value.data) existingMap[p.mobile_number] = p.id;
          }
        }

        const toInsert = [];
        for (const mobile of mobiles) {
          if (!existingMap[mobile]) {
            const row = latest[mobile];
            toInsert.push({
              mobile_number: mobile,
              name: row.name || null,
              category: row.category || '',
              amount: parseFloat(row.amount) || 0,
              total_amount: parseFloat(row.amount) || 0,
              donation_count: 1,
              ngo: ngoName,
              data_category: row.data_category || normalizedCategory || null,
            });
          }
        }

        if (toInsert.length > 0) {
          let allProfiles = [];
          for (let i = 0; i < toInsert.length; i += 500) {
            const batch = toInsert.slice(i, i + 500);
            const { data: newProfiles } = await db
              .from('donor_profiles')
              .insert(batch)
              .select('id');
            if (newProfiles) allProfiles = allProfiles.concat(newProfiles);
          }
          newProfileIds = allProfiles.map(p => p.id);
          totalConverted += toInsert.length;
          messages.push(`${toInsert.length} new donors converted to profiles (${ngoName})`);
        }
        allMobiles = mobiles;
      }

      // Step 2: Determine which stations to use
      const stationAssigns = await getStationAssignmentsByNgo([ngoId]);
      console.log(`[${ngoName}] stationAssigns:`, stationAssigns.length, stationAssigns.map(s => s.station).join(', '), 'fro_ids:', stationAssigns.map(s => s.fro_worker_id).join(','));

      let targetStations;
      if (selectedStations && selectedStations.length > 0) {
        targetStations = stationAssigns.filter(sa => selectedStations.includes(sa.station));
        console.log(`[${ngoName}] filtered by selectedStations:`, targetStations.length);
      } else {
        targetStations = stationAssigns;
      }

      // If no stations exist, auto-create U-stations based on active FROs
      if (targetStations.length === 0) {
        const allFroWorkers = await getFroWorkersByNgo(ngoId);
        const activeWorkers = allFroWorkers.filter(w => w.is_active !== false);
        console.log(`[${ngoName}] no stations, FRO workers:`, activeWorkers.length);
        if (activeWorkers.length === 0) {
          console.log(`[${ngoName}] SKIP — no active FRO workers`);
          skippedNgos.push(ngoName);
          continue;
        }
        for (let i = 0; i < activeWorkers.length; i++) {
          await upsertStationAssignment(activeWorkers[i].id, ngoId, `U-${i + 1}`, req.user.id);
        }
        targetStations = await getStationAssignmentsByNgo([ngoId]);
      }

      if (targetStations.length === 0) {
        console.log(`[${ngoName}] SKIP — targetStations still empty`);
        skippedNgos.push(ngoName);
        continue;
      }
      console.log(`[${ngoName}] targetStations:`, targetStations.length, targetStations.map(s => s.station).join(', '));

      // Step 3: Find unassigned donor profiles for this NGO
      let existingProfileIds = [];
      if (allMobiles.length > 0) {
        const BATCH = 500;
        const batchQueries = [];
        for (let i = 0; i < allMobiles.length; i += BATCH) {
          const batch = allMobiles.slice(i, i + BATCH);
          batchQueries.push(
            db.from('donor_profiles').select('id').in('mobile_number', batch)
          );
        }
        const batchResults = await Promise.allSettled(batchQueries);
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value.data) {
            existingProfileIds.push(...r.value.data.map(p => p.id));
          }
        }
      }
      const allIds = [...new Set([...newProfileIds, ...existingProfileIds])];
      console.log(`[${ngoName}] newProfileIds:`, newProfileIds.length, 'existingProfileIds:', existingProfileIds.length, 'allIds:', allIds.length);
      if (allIds.length === 0) { console.log(`[${ngoName}] SKIP — allIds empty`); continue; }

      const assignedSet = await getActiveAssignmentDonorIds(ngoId, allIds);

      // Rule: never create a second assignment for the same (donor, NGO) pair —
      // whether the donor already has an old-data OD assignment or an earlier
      // fresh distribution for this NGO, it must NOT be assigned again.
      const idsToAssign = allIds.filter(id => !assignedSet.has(id));

      console.log(`[${ngoName}] alreadyAssigned:`, assignedSet.size, 'idsToAssign:', idsToAssign.length);
      if (idsToAssign.length === 0) { console.log(`[${ngoName}] SKIP — all already assigned`); continue; }

      // Step 4: Assign stations round-robin to donors
      const shuffled = [...idsToAssign];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const base = Math.floor(shuffled.length / targetStations.length);
      const remainder = shuffled.length % targetStations.length;

      const stationNames = targetStations.map(sa => sa.station);
      const stationFroMap = {};
      for (const sa of targetStations) {
        stationFroMap[sa.station] = sa.fro_worker_id;
      }

      const donorStationMap = {};
      let donorIdx = 0;
      for (let i = 0; i < targetStations.length; i++) {
        const count = base + (i < remainder ? 1 : 0);
        for (let j = 0; j < count; j++) {
          donorStationMap[shuffled[donorIdx++]] = stationNames[i];
        }
      }

      // Step 5: Create FRO assignments for each donor (with station, even if no FRO)
      const newAssignments = [];
      for (const [donorId, station] of Object.entries(donorStationMap)) {
        const workerId = stationFroMap[station];
        newAssignments.push({
          donor_id: parseInt(donorId),
          fro_worker_id: workerId || null,
          ngo_id: ngoId,
          station: station,
          status: 'pending',
          assigned_at: new Date().toISOString(),
          batch_id: batchId,
          batch_type: 'new_data',
        });
      }

      if (newAssignments.length > 0) {
        console.log(`[${ngoName}] creating ${newAssignments.length} fro_assignments`);
        await batchCreateAssignments(newAssignments);
        totalAssigned += newAssignments.length;
        // Mark as converted only AFTER assignments succeed
        if (allMobiles.length > 0) {
          await updateNewDataStatusByNgoAndMobiles(ngoName, allMobiles, 'converted');
        }
        console.log(`[${ngoName}] batchCreateAssignments OK`);
      } else {
        console.log(`[${ngoName}] no newAssignments to create`);
      }

      const stationCounts = {};
      for (const st of Object.values(donorStationMap)) {
        stationCounts[st] = (stationCounts[st] || 0) + 1;
      }
      const perStation = Object.entries(stationCounts)
        .map(([st, cnt]) => `${cnt} → ${st}`)
        .join(', ');
      messages.push(`Distributed ${Object.keys(donorStationMap).length} donors${normalizedCategory ? ` [Category: ${normalizedCategory}]` : ''}: ${perStation} (${ngoName})`);
      console.log(`[${ngoName}] DONE — ${Object.keys(donorStationMap).length} donors distributed`);
      } catch (err) {
        console.error(`[${ngoName}] distribution error:`, err.message);
        messages.push(`Error for ${ngoName}: ${err.message}`);
      }
    }

    console.log('--- distributeNewData end ---');
    console.log('messages:', messages.join('; '));
    console.log('skippedNgos:', skippedNgos);
    let finalMessage = messages.join('; ');
    if (skippedNgos.length > 0) {
      finalMessage += `; ${skippedNgos.join(', ')} skipped (no stations).`;
    }

    if (totalConverted === 0 && totalAssigned === 0) {
      return res.json({ message: 'No unassigned data found for your NGOs', count: 0 });
    }
    return res.json({ message: finalMessage, count: totalAssigned, converted: totalConverted });
  } catch (error) {
    console.error('distributeNewData ERROR:', error);
    return res.status(500).json({ message: error.message });
  }
};

export const cleanupNewData = async (req, res) => {
  try {
    let access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: req.user.ngo_id, ngoName: ngo.name });
    }
    const { ngo_id: filterNgoId, category } = req.body;
    const normalizedCategory = category ? String(category).trim() : '';
    if (filterNgoId) {
      ngoEntries = ngoEntries.filter(e => String(e.ngoId) === String(filterNgoId) || String(e.ngoName).toLowerCase() === String(filterNgoId).toLowerCase());
    }
    if (ngoEntries.length === 0) {
      return res.json({ message: 'No NGO assigned to your account', deleted: 0 });
    }

    let totalDeleted = 0;
    const messages = [];

    for (const { ngoName } of ngoEntries) {
      // Only delete undistributed records (status is null or pending)
      let ngoDeleted = 0;

      // Delete where status IS NULL
      let q1 = db
        .from('new_data')
        .delete({ count: 'exact' })
        .eq('ngo', ngoName)
        .is('status', null);
      if (normalizedCategory) {
        q1 = q1.or(`data_category.eq.${normalizedCategory},category.eq.${normalizedCategory}`);
      }
      const r1 = await q1;
      if (r1.error) {
        messages.push(`Error (null) for ${ngoName}: ${r1.error.message}`);
      } else {
        ngoDeleted += r1.count || 0;
      }

      // Delete where status = 'pending'
      let q2 = db
        .from('new_data')
        .delete({ count: 'exact' })
        .eq('ngo', ngoName)
        .eq('status', 'pending');
      if (normalizedCategory) {
        q2 = q2.or(`data_category.eq.${normalizedCategory},category.eq.${normalizedCategory}`);
      }
      const r2 = await q2;
      if (r2.error) {
        messages.push(`Error (pending) for ${ngoName}: ${r2.error.message}`);
      } else {
        ngoDeleted += r2.count || 0;
      }

      if (ngoDeleted > 0 || (!r1.error && !r2.error)) {
        totalDeleted += ngoDeleted;
        messages.push(`${ngoDeleted} undistributed records deleted (${ngoName})${normalizedCategory ? ` [Category: ${normalizedCategory}]` : ''}`);
      }
    }

    return res.json({
      message: messages.join('; ') || 'No data to cleanup',
      deleted: totalDeleted,
    });
  } catch (error) {
    console.error('cleanupNewData ERROR:', error);
    return res.status(500).json({ message: error.message });
  }
};

export const resetFreshData = async (req, res) => {
  try {
    let access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: req.user.ngo_id, ngoName: ngo.name });
    }
    const { ngo_id: filterNgoId } = req.body;
    if (filterNgoId) {
      ngoEntries = ngoEntries.filter(e => String(e.ngoId) === String(filterNgoId) || String(e.ngoName).toLowerCase() === String(filterNgoId).toLowerCase());
    }
    if (ngoEntries.length === 0) {
      return res.json({ message: 'No NGO assigned to your account', deleted: 0 });
    }

    let totalDeleted = 0;
    const messages = [];

    for (const { ngoId, ngoName } of ngoEntries) {
      let ngoFroDeleted = 0;
      let ngoDataDeleted = 0;

      // Step 1: Delete fro_assignments on FD stations for this NGO
      const { count: froCount, error: froErr } = await db
        .from('fro_assignments')
        .delete({ count: 'exact' })
        .eq('ngo_id', ngoId)
        .like('station', 'FD-%');
      if (froErr) {
        messages.push(`FRO error for ${ngoName}: ${froErr.message}`);
      } else {
        ngoFroDeleted = froCount || 0;
      }

      // Step 2: Delete ALL new_data rows for this NGO (distributed + undistributed)
      const { count: dataCount, error: dataErr } = await db
        .from('new_data')
        .delete({ count: 'exact' })
        .eq('ngo', ngoName);
      if (dataErr) {
        messages.push(`Data error for ${ngoName}: ${dataErr.message}`);
      } else {
        ngoDataDeleted = dataCount || 0;
      }

      totalDeleted += ngoFroDeleted + ngoDataDeleted;
      messages.push(`${ngoName}: ${ngoFroDeleted} FD assignments removed, ${ngoDataDeleted} new_data deleted`);
    }

    // The reset removed FD assignments, so the station donor counts and the
    // disposition roll-up just lost rows.
    if (totalDeleted > 0) bustStationCache();
    return res.json({
      message: messages.join('; ') || 'No fresh data to reset',
      deleted: totalDeleted,
    });
  } catch (error) {
    console.error('resetFreshData ERROR:', error);
    return res.status(500).json({ message: error.message });
  }
};

// ── Non-connected fresh-data pull ─────────────────────────────────────────────
// GET  /api/ngo-admin/non-connected-fresh   – preview list + summary + options
// POST /api/ngo-admin/non-connected-fresh/delete – delete matching new_data rows
// ─────────────────────────────────────────────────────────────────────────────

export const getNonConnectedFresh = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: req.user.ngo_id, ngoName: ngo.name });
    }
    if (ngoEntries.length === 0) {
      return res.json({ donors: [], summary: { total: 0, by_station: {}, by_category: {}, by_fro: {} }, category_options: [], station_options: [], status_options: [] });
    }

    let ngoIds = ngoEntries.map(e => e.ngoId);
    const { ngo_id: filterNgoId, station, status, category } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
    }

    const normalizedCategory = category ? String(category).trim() : '';

    const params = [ngoIds, NOT_CONNECTED_STATUSES];
    const conds = [
      'fa.ngo_id = ANY($1)',
      'fa.status = ANY($2)',
      '(fa.batch_type = \'new_data\' OR fa.station ILIKE \'%FD-%\')',
    ];
    if (station && station !== 'all') {
      params.push(station);
      conds.push(`fa.station = $${params.length}`);
    }
    if (status && status !== 'all') {
      params.push(status);
      conds.push(`fa.status = $${params.length}`);
    }
    if (normalizedCategory) {
      params.push(normalizedCategory);
      conds.push(`(LOWER(dp.data_category) = LOWER($${params.length}) OR LOWER(dp.category) = LOWER($${params.length}))`);
    }

    const rows = await sql(`
      SELECT fa.donor_id, fa.ngo_id, fa.station, fa.status,
             fa.batch_type, fa.last_contacted_at, fa.assigned_at,
             dp.id AS donor_profile_id, dp.name, dp.mobile_number,
             dp.data_category, dp.category, dp.city,
             w.name AS fro_name
      FROM fro_assignments fa
      JOIN donor_profiles dp ON dp.id = fa.donor_id
      LEFT JOIN workers w ON w.id = fa.fro_worker_id
      WHERE ${conds.join(' AND ')}
      ORDER BY fa.last_contacted_at ASC NULLS LAST, fa.assigned_at ASC NULLS LAST
      LIMIT 20000
    `, params);

    const donors = rows.map(r => ({
      donor_profile_id: r.donor_profile_id,
      donor_id: r.donor_id,
      name: r.name || 'Unknown',
      mobile_number: r.mobile_number || '',
      category: String(r.data_category || r.category || '').trim(),
      station: r.station || '',
      status: r.status,
      fro_name: r.fro_name || 'Unassigned',
      last_contacted_at: r.last_contacted_at,
      assigned_at: r.assigned_at,
    }));

    const byStation = {};
    const byCategory = {};
    const byFro = {};
    for (const d of donors) {
      byStation[d.station] = (byStation[d.station] || 0) + 1;
      const cat = d.category || '(none)';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      byFro[d.fro_name] = (byFro[d.fro_name] || 0) + 1;
    }

    return res.json({
      donors,
      summary: { total: donors.length, by_station: byStation, by_category: byCategory, by_fro: byFro },
      category_options: Object.keys(byCategory).sort(),
      station_options: Object.keys(byStation).sort(),
      status_options: [...new Set(donors.map(d => d.status))].sort(),
    });
  } catch (error) {
    console.error('getNonConnectedFresh ERROR:', error);
    return res.status(500).json({ message: error.message });
  }
};

export const deleteNonConnectedFresh = async (req, res) => {
  try {
    const { ngo_id: filterNgoId, donor_profile_ids, category } = req.body || {};
    const dryRun = req.query.dry_run === 'true';

    let access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: req.user.ngo_id, ngoName: ngo.name });
    }
    if (filterNgoId && filterNgoId !== 'all') {
      ngoEntries = ngoEntries.filter(e => String(e.ngoId) === String(filterNgoId) || String(e.ngoName).toLowerCase() === String(filterNgoId).toLowerCase());
    }
    if (ngoEntries.length === 0) {
      return res.status(403).json({ message: 'No NGO access', deleted: 0 });
    }

    const ids = Array.isArray(donor_profile_ids)
      ? donor_profile_ids.map(Number).filter(Boolean)
      : [];
    if (ids.length === 0) {
      return res.status(400).json({ message: 'donor_profile_ids array is required', deleted: 0 });
    }

    const normalizedCategory = category ? String(category).trim() : '';

    // Fetch donor profiles to get mobile numbers
    const { data: profiles, error: pErr } = await db
      .from('donor_profiles')
      .select('id, mobile_number')
      .in('id', ids);
    if (pErr) throw pErr;
    const mobiles = (profiles || []).map(p => p.mobile_number).filter(Boolean);
    if (mobiles.length === 0) {
      return res.json({ deleted: 0, skipped: ids.length, message: 'No matching donor profiles' });
    }

    // Resolve NGO name(s) to delete against
    const ngoNameSet = new Set();
    for (const e of ngoEntries) {
      if (e.ngoName) {
        ngoNameSet.add(e.ngoName);
      } else {
        const { data: ngo } = await db.from('ngos').select('name').eq('id', e.ngoId).single();
        if (ngo?.name) ngoNameSet.add(ngo.name);
      }
    }

    // Preview: match new_data rows to get per-category counts
    const perCategory = {};
    let totalMatched = 0;
    for (const ngoName of ngoNameSet) {
      let pq = db
        .from('new_data')
        .select('id, data_category, category, status')
        .eq('ngo', ngoName)
        .in('mobile_number', mobiles);
      if (normalizedCategory) {
        pq = pq.or(`data_category.eq.${normalizedCategory},category.eq.${normalizedCategory}`);
      }
      const { data: matched } = await pq;
      for (const m of matched || []) {
        const cat = String(m.data_category || m.category || '').trim() || '(none)';
        perCategory[cat] = (perCategory[cat] || 0) + 1;
        totalMatched++;
      }
    }

    if (dryRun) {
      const previewRows = [];
      for (const ngoName of ngoNameSet) {
        let pr = db
          .from('new_data')
          .select('id, name, mobile_number, data_category, category, status, station, ngo, created_at')
          .eq('ngo', ngoName)
          .in('mobile_number', mobiles)
          .order('created_at', { ascending: false })
          .limit(2000);
        if (normalizedCategory) {
          pr = pr.or(`data_category.eq.${normalizedCategory},category.eq.${normalizedCategory}`);
        }
        const { data: rows } = await pr;
        if (rows && rows.length) previewRows.push(...rows);
      }
      return res.json({
        dry_run: true,
        matched: totalMatched,
        per_category: perCategory,
        rows: previewRows,
        truncated: previewRows.length < totalMatched,
        message: `Dry run — ${totalMatched} fresh-data record(s) located`,
      });
    }

    // Delete new_data rows
    const perNgoDeleted = [];
    let totalDeleted = 0;
    for (const ngoName of ngoNameSet) {
      let dq = db
        .from('new_data')
        .delete()
        .eq('ngo', ngoName)
        .in('mobile_number', mobiles);
      if (normalizedCategory) {
        dq = dq.or(`data_category.eq.${normalizedCategory},category.eq.${normalizedCategory}`);
      }
      const { data: deletedRows, error: delErr } = await dq.select('id');
      if (delErr) throw delErr;
      const deleted = Array.isArray(deletedRows) ? deletedRows.length : 0;
      totalDeleted += deleted;
      perNgoDeleted.push({ ngo: ngoName, deleted });
    }

    console.log(`[NCF] deleteNonConnectedFresh user=${req.user.id} matched=${totalMatched} deleted=${totalDeleted} mobiles=${mobiles.length} ngo=${[...ngoNameSet]} category=${normalizedCategory || 'all'}`);

    return res.json({
      deleted: totalDeleted,
      matched: totalMatched,
      per_category: perCategory,
      per_ngo: perNgoDeleted,
      message: totalDeleted > 0
        ? `${totalDeleted} fresh-data record${totalDeleted === 1 ? '' : 's'} deleted`
        : 'No matching fresh-data records to delete',
    });
  } catch (error) {
    console.error('deleteNonConnectedFresh ERROR:', error);
    return res.status(500).json({ message: error.message });
  }
};

// ─── Station donor removal (NGO admin) ──────────────────────────────────────
//
// Clears a wrongly-duplicated donor off a station so the number becomes free to
// be assigned again inside that NGO. The rule this serves is the partial unique
// index uq_fro_assignments_active_donor_ngo (backend/scripts/
// add_assignment_dedup_index.sql): one ACTIVE fro_assignments row per
// (donor_id, ngo_id). The DB enforces it, so the only way to clear a duplicate is
// to retire one of the two rows — which is exactly what this does.
//
// WHY THIS HARD DELETES, given the DND history. Migration 165 is explicit that
// the DND disposition used to DELETE the assignment and its logs, that this left
// a donor "with no trace anywhere: the lead could not be explained, audited or
// released", and that it produced "where did my data go" reports — so DND was
// moved to a soft-mark plus a donor_dnd registry row (froController.js keeps the
// assignment for exactly that reason). The admin path is a different kind of
// operation: a low-frequency, deliberate cleanup of a lead the admin believes was
// duplicated onto the station in the first place, and the guard below refuses any
// donor carrying collected money or a receipt. But it is still a delete, so every
// removal writes a station_donor_deletions audit row (migration 174) naming who
// removed what, from which station, and how much was cascaded. That audit insert
// is deliberately inside the same transaction as the delete: if the table is
// missing the whole operation fails closed rather than deleting unrecorded.
//
// The cascade order and membership are taken verbatim from migration 107, which
// did this same cascade in SQL for the DND cleanup:
//   rejected_lead_tickets -> fro_scheduled_contacts -> work_queue
//   -> fro_donor_logs -> fro_assignments
// Tickets go first because they reference the logs. work_queue goes explicitly
// because it has NO FK to either table (107:17), so nothing else would clear it
// and the removed donor would keep being handed out by the auto-advance cursor.
// donor_profiles, receipts and donor_dnd are left untouched (107:19).
export const deleteStationDonors = async (req, res) => {
  try {
    const { assignment_ids } = req.body || {};
    const dryRun = req.query.dry_run === 'true';

    const ids = [...new Set((Array.isArray(assignment_ids) ? assignment_ids : []).map(Number).filter(Boolean))];
    if (ids.length === 0) {
      return res.status(400).json({ message: 'assignment_ids array is required', deleted: 0 });
    }
    // Bounded so one request cannot fan out into an unbounded cascade. A station
    // holds hundreds of donors, but an admin removing a duplicate touches a few.
    if (ids.length > 500) {
      return res.status(400).json({ message: 'Too many assignments in one request (max 500)', deleted: 0 });
    }

    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);
    if (ngoIds.length === 0) {
      return res.status(403).json({ message: 'No NGO access', deleted: 0 });
    }

    // One row per assignment the caller may touch, carrying both the money guard
    // inputs and the cascade tallies the preview renders. Written as LATERALs
    // rather than four round trips so the guard cannot be evaluated against a
    // different snapshot than the counts shown to the admin.
    //
    // Restricted to ACTIVE rows the caller's NGOs own. A 'reassigned' row is
    // already retired, and an id outside the caller's scope is not even
    // acknowledged: returning 200 for it would confirm an existence this admin
    // has no right to report.
    const targets = await sql(`
      SELECT fa.id AS assignment_id,
             fa.donor_id,
             fa.ngo_id,
             fa.station,
             fa.fro_worker_id,
             fa.status,
             fa.batch_type,
             dp.name AS donor_name,
             dp.mobile_number,
             dp.data_category,
             EXISTS (
               SELECT 1 FROM donor_dnd d
               WHERE d.donor_id = fa.donor_id
                 AND d.ngo_id = fa.ngo_id
                 AND d.released_at IS NULL
             ) AS had_dnd_mark,
             COALESCE(m.money_log_count, 0)  AS money_log_count,
             COALESCE(m.collected_amount, 0) AS collected_amount,
             COALESCE(m.verified_amount, 0)  AS verified_amount,
             COALESCE(m.pending_amount, 0)   AS pending_amount,
             COALESCE(rc.receipt_count, 0)  AS receipt_count,
             COALESCE(rc.receipt_amount, 0) AS receipt_amount,
             COALESCE(c.log_count, 0)        AS log_count,
             COALESCE(c.schedule_count, 0)   AS schedule_count,
             COALESCE(c.ticket_count, 0)     AS ticket_count,
             COALESCE(c.queue_count, 0)      AS queue_count
        FROM fro_assignments fa
        JOIN donor_profiles dp ON dp.id = fa.donor_id
        LEFT JOIN LATERAL (
          -- A donor counts as having given money if EITHER the log is marked
          -- verified/pending OR it carries a positive amount. Keying this on
          -- accounts_status alone let a log with amount_collected > 0 and a null
          -- / unverified status slip through and get its assignment deleted.
          SELECT COUNT(*) FILTER (WHERE l.accounts_status IN ('verified', 'pending')
                                      OR COALESCE(l.amount_collected, 0) > 0) AS money_log_count,
                 COALESCE(SUM(l.amount_collected) FILTER (WHERE l.amount_collected > 0), 0) AS collected_amount,
                 COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified'), 0) AS verified_amount,
                 COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'pending'), 0) AS pending_amount
            FROM fro_donor_logs l
           WHERE l.assignment_id = fa.id
        ) m ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS receipt_count, COALESCE(SUM(r.amount), 0) AS receipt_amount
            FROM receipts r
            JOIN fro_donor_logs l2 ON l2.id = r.log_id
           WHERE l2.assignment_id = fa.id
        ) rc ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            (SELECT COUNT(*) FROM fro_donor_logs l3
              WHERE l3.assignment_id = fa.id) AS log_count,
            (SELECT COUNT(*) FROM fro_scheduled_contacts s
              WHERE s.assignment_id = fa.id) AS schedule_count,
            (SELECT COUNT(*) FROM rejected_lead_tickets t
              JOIN fro_donor_logs l4 ON l4.id = t.fro_donor_log_id
             WHERE l4.assignment_id = fa.id) AS ticket_count,
            -- Scoped to this (worker, donor, ngo) rather than the bare pair used by
            -- migration 107: the same donor may legitimately be queued at another
            -- NGO on the same worker, and deleting that would be collateral damage.
            -- Unattributed rows (ngo_id IS NULL) still go, since nothing else would
            -- ever attribute them and they would keep the donor in the cursor.
            (SELECT COUNT(*) FROM work_queue w
              WHERE w.worker_id = fa.fro_worker_id
                AND w.donor_id = fa.donor_id
                AND (w.ngo_id = fa.ngo_id OR w.ngo_id IS NULL)) AS queue_count
        ) c ON TRUE
       WHERE fa.id = ANY($1)
         AND fa.ngo_id = ANY($2)
         AND (fa.status IS NULL OR fa.status <> 'reassigned')
    `, [ids, ngoIds]);

    const notFound = ids.length - targets.length;
    if (targets.length === 0) {
      return res.status(404).json({
        message: 'No active station assignments matched those ids for your NGOs',
        deleted: 0,
      });
    }

    // ── The money guard ────────────────────────────────────────────────────
    // A donor who has actually given money, or for whom a receipt exists, is
    // reconciled financial history. Removing their assignment would strip the
    // collection from the station while the money stays banked, so those are
    // refused outright rather than warned about. Same predicate the dedup repair
    // scripts use to decide which assignment of a duplicate group to keep
    // (repair_active_dups_all_ngos.sql:39-46).
    const blocked = [];
    for (const t of targets) {
      const reasons = [];
      if (Number(t.receipt_count) > 0) {
        reasons.push(Number(t.receipt_amount) > 0
          ? `receipt of ₹${Number(t.receipt_amount).toLocaleString('en-IN')} linked`
          : 'receipt linked');
      }
      if (Number(t.money_log_count) > 0) {
        const bits = [];
        if (Number(t.verified_amount) > 0) bits.push(`₹${Number(t.verified_amount).toLocaleString('en-IN')} verified`);
        if (Number(t.pending_amount) > 0) bits.push(`₹${Number(t.pending_amount).toLocaleString('en-IN')} pending`);
        // Money can be present without a verified/pending status, so fall back to
        // the plain collected total rather than saying nothing was recorded.
        if (bits.length === 0 && Number(t.collected_amount) > 0) {
          bits.push(`₹${Number(t.collected_amount).toLocaleString('en-IN')} collected`);
        }
        reasons.push(bits.length ? `collected money (${bits.join(', ')})` : 'collected money logged');
      }
      if (reasons.length === 0) continue;
      blocked.push({
        assignment_id: t.assignment_id,
        donor_id: t.donor_id,
        donor_name: t.donor_name || 'Unknown',
        mobile_number: t.mobile_number || '',
        station: t.station || '',
        reason: reasons.join('; '),
      });
    }

    const deletable = targets.filter(t => !blocked.some(b => b.assignment_id === t.assignment_id));
    const totals = targets.reduce((acc, t) => ({
      logs: acc.logs + Number(t.log_count || 0),
      schedules: acc.schedules + Number(t.schedule_count || 0),
      tickets: acc.tickets + Number(t.ticket_count || 0),
      queue_rows: acc.queue_rows + Number(t.queue_count || 0),
    }), { logs: 0, schedules: 0, tickets: 0, queue_rows: 0 });

    const previewRow = (t) => ({
      assignment_id: t.assignment_id,
      donor_id: t.donor_id,
      ngo_id: t.ngo_id,
      donor_name: t.donor_name || 'Unknown',
      mobile_number: t.mobile_number || '',
      data_category: t.data_category || '',
      station: t.station || '',
      status: t.status,
      log_count: Number(t.log_count || 0),
      schedule_count: Number(t.schedule_count || 0),
      ticket_count: Number(t.ticket_count || 0),
      queue_count: Number(t.queue_count || 0),
      had_dnd_mark: !!t.had_dnd_mark,
    });

    if (dryRun) {
      return res.json({
        dry_run: true,
        matched: targets.length,
        deletable: deletable.map(previewRow),
        deletable_count: deletable.length,
        blocked,
        totals,
        not_found: notFound,
        message: `Dry run — ${deletable.length} of ${targets.length} assignment(s) can be deleted`,
      });
    }

    // All-or-nothing. A partial delete would leave the admin believing a duplicate
    // was cleared when one of the pair is still live, which is the exact state
    // this endpoint exists to remove. The UI offers a re-run over the remainder.
    if (blocked.length > 0) {
      return res.status(409).json({
        message: `${blocked.length} of ${targets.length} donor(s) cannot be deleted — nothing was deleted`,
        deleted: 0,
        blocked,
        deletable_count: deletable.length,
      });
    }

    const targetIds = targets.map(t => t.assignment_id);

    let counts;
    try {
      counts = await db.transaction(async ({ from }) => {
        // 1. Rejected-lead tickets first — they point at the logs in step 4.
        const { data: logRows, error: logErr } = await from('fro_donor_logs')
          .select('id')
          .in('assignment_id', targetIds);
        if (logErr) throw new Error(logErr.message);
        const logIds = (logRows || []).map(r => r.id);

        let ticketsDeleted = 0;
        if (logIds.length > 0) {
          const { data: tRows, error: tErr } = await from('rejected_lead_tickets')
            .delete()
            .in('fro_donor_log_id', logIds)
            .select('id');
          if (tErr) throw new Error(tErr.message);
          ticketsDeleted = (tRows || []).length;
        }

        // 2. Scheduled contacts reference the assignment directly.
        const { data: sRows, error: sErr } = await from('fro_scheduled_contacts')
          .delete()
          .in('assignment_id', targetIds)
          .select('id');
        if (sErr) throw new Error(sErr.message);
        const schedulesDeleted = (sRows || []).length;

        // 3. work_queue — raw SQL because the (worker, donor, ngo) triple has no
        //    expressible form in the query builder. No FK cascade exists here
        //    (migration 087 creates the table with FKs only on worker/donor), so
        //    skipping this would leave the removed donor in the FRO's cursor.
        const queueRows = await sql(`
          DELETE FROM work_queue w
           USING fro_assignments fa
           WHERE fa.id = ANY($1)
             AND w.worker_id = fa.fro_worker_id
             AND w.donor_id = fa.donor_id
             AND (w.ngo_id = fa.ngo_id OR w.ngo_id IS NULL)
          RETURNING 1
        `, [targetIds]);

        // 4. The disposition/call logs themselves.
        const { data: dRows, error: dErr } = await from('fro_donor_logs')
          .delete()
          .in('assignment_id', targetIds)
          .select('id');
        if (dErr) throw new Error(dErr.message);
        const logsDeleted = (dRows || []).length;

        // 5. The station's assignment row.
        const { data: aRows, error: aErr } = await from('fro_assignments')
          .delete()
          .in('id', targetIds)
          .select('id');
        if (aErr) throw new Error(aErr.message);
        const assignmentsDeleted = (aRows || []).length;

        // 6. Audit, inside the same transaction as the delete it describes. If
        //    migration 174 has not been applied this insert fails, the
        //    transaction rolls back, and the removal does not happen unrecorded.
        //
        //    The actor is stored as text plus a name/role snapshot, not as a
        //    users FK: an NGO admin's token carries a workers.id (and the env
        //    super admin carries the literal 0), so a users FK would reject every
        //    real deletion. See migration 174 for the full reasoning.
        const actorId = req.user?.id == null ? null : String(req.user.id);
        const { error: auditErr } = await from('station_donor_deletions').insert(targets.map(t => ({
          assignment_id: t.assignment_id,
          donor_id: t.donor_id,
          ngo_id: t.ngo_id,
          station: t.station || null,
          fro_worker_id: t.fro_worker_id || null,
          donor_name: t.donor_name || null,
          mobile_number: t.mobile_number || null,
          data_category: t.data_category || null,
          status_at_delete: t.status || null,
          batch_type: t.batch_type || null,
          logs_deleted: Number(t.log_count || 0),
          schedules_deleted: Number(t.schedule_count || 0),
          tickets_deleted: Number(t.ticket_count || 0),
          queue_rows_deleted: Number(t.queue_count || 0),
          had_dnd_mark: !!t.had_dnd_mark,
          deleted_by: actorId,
          deleted_by_name: req.user?.name || null,
          deleted_by_role: req.user?.role || null,
          deleted_by_email: req.user?.email || null,
        })));
        if (auditErr) throw new Error(auditErr.message);

        return { logsDeleted, schedulesDeleted, ticketsDeleted, queueRowsDeleted: queueRows.length, assignmentsDeleted };
      });
    } catch (txErr) {
      // 42P01 = undefined_table. The most likely cause by far is migration 174
      // not yet applied, and the answer is to apply it rather than to retry, so
      // say that instead of surfacing a raw Postgres message.
      if (txErr && (txErr.code === '42P01' || /station_donor_deletions/i.test(txErr.message || ''))) {
        console.error('[station-donors] delete aborted: station_donor_deletions is missing — apply migration 174');
        return res.status(503).json({
          message: 'Station donor deletion audit table is missing. Apply migration 174_station_donor_deletion_audit.sql, then retry. Nothing was deleted.',
          deleted: 0,
        });
      }
      throw txErr;
    }

    // Station/donor counts are cached for the TL dashboard (bustTlCache), and the
    // removal is exactly the kind of change a stale cache would misreport.
    // bustStationCache covers the TL cache too, plus the station list and the
    // disposition roll-up, all of which just lost rows.
    bustStationCache();

    console.log(
      `[station-donors] user=${req.user.id} assignments=${counts.assignmentsDeleted} `
      + `logs=${counts.logsDeleted} schedules=${counts.schedulesDeleted} `
      + `tickets=${counts.ticketsDeleted} queue=${counts.queueRowsDeleted}`
      + ` station=${targets[0]?.station || '(mixed)'} ngo=${targets[0]?.ngo_id || '(mixed)'}`
    );

    const dndFlagged = targets.filter(t => t.had_dnd_mark).length;

    return res.json({
      deleted: counts.assignmentsDeleted,
      per_donor: targets.map(previewRow),
      blocked: [],
      totals: {
        logs: counts.logsDeleted,
        schedules: counts.schedulesDeleted,
        tickets: counts.ticketsDeleted,
        queue_rows: counts.queueRowsDeleted,
      },
      dnd_marked: dndFlagged,
      // Ids that were requested but matched nothing: another admin already
      // removed them, they were already 'reassigned', or they belong to an NGO
      // this caller cannot touch. Reported so a bulk delete never looks
      // complete when it silently covered fewer rows than were ticked.
      not_found: notFound,
      message: `${counts.assignmentsDeleted} donor(s) removed from ${targets[0]?.station || 'the station'}`
        + (notFound > 0 ? ` (${notFound} of ${ids.length} requested were no longer active)` : '')
        + (dndFlagged > 0
          ? ` — ${dndFlagged} still carry an active DND mark for this NGO, so the number stays suppressed until it is released`
          : ''),
    });
  } catch (error) {
    console.error('deleteStationDonors ERROR:', error);
    return res.status(500).json({ message: error.message });
  }
};

export const getAlerts = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json({ alerts: [] });

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    const results = [];
    const workerNameMap = {};
    const allWorkerIds = new Set();

    for (const ngoId of ngoIds) {
      const workers = await getFroWorkersByNgo(ngoId);
      for (const w of workers) {
        workerNameMap[w.id] = w.name || 'Unknown';
        allWorkerIds.add(w.id);
      }
    }

    if (allWorkerIds.size > 0) {
      const { data: requests } = await db
        .from('fro_data_requests')
        .select('*')
        .in('fro_worker_id', [...allWorkerIds])
        .order('created_at', { ascending: false })
        .limit(100);
      if (requests) {
        for (const r of requests) {
          results.push({
            id: `dr_${r.id}`,
            type: 'data_request',
            title: 'Data Request',
            description: r.message,
            fro_name: workerNameMap[r.fro_worker_id] || 'Unknown',
            created_at: r.created_at,
            acknowledged: r.status !== 'pending',
          });
        }
      }
    }

    try {
      const { data: alerts } = await db
        .from('alerts')
        .select('*')
        .in('ngo_id', ngoIds)
        .order('created_at', { ascending: false })
        .limit(100);
      if (alerts) results.push(...alerts);
    } catch (err) { console.error('Failed to fetch alerts:', err.message); }

    results.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.json({ alerts: results.slice(0, 100) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getRejectedLeads = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    let data = [];
    try {
      const result = await db
        .from('rejected_lead_tickets')
        .select('*')
        .in('ngo_id', ngoIds)
        .order('created_at', { ascending: false })
        .limit(200);
      if (result.error) throw result.error;
      data = result.data || [];
    } catch (dbErr) {
      console.error('rejected_lead_tickets query failed:', dbErr.message);
      return res.json([]);
    }

    const workerIds = [...new Set(data.map(t => t.fro_worker_id).filter(Boolean))];
    const workerMap = {};
    if (workerIds.length > 0) {
      const { data: workers, error: wErr } = await db.from('workers').select('id, name').in('id', workerIds);
      if (wErr) { console.error('workers query failed:', wErr.message); }
      else if (workers) for (const w of workers) workerMap[w.id] = w.name;
    }

    const result = data.map(t => ({ ...t, fro_name: workerMap[t.fro_worker_id] || 'Unknown' }));
    return res.json(result);
  } catch (error) {
    console.error('getRejectedLeads error:', error);
    return res.status(500).json({ message: error.message });
  }
};

export const acknowledgeRejectedLead = async (req, res) => {
  try {
    const { id } = req.params;
    const ngoIds = await getUserNgoIds(req.user);

    let ticket;
    try {
      const result = await db
        .from('rejected_lead_tickets')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (result.error) throw result.error;
      ticket = result.data;
    } catch (dbErr) {
      console.error('rejected_lead_tickets query failed:', dbErr.message);
      return res.status(404).json({ message: 'Ticket not found' });
    }

    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!ngoIds.includes(ticket.ngo_id)) return res.status(403).json({ message: 'Access denied' });

    await db
      .from('rejected_lead_tickets')
      .update({ status: 'acknowledged', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);

    return res.json({ message: 'Ticket acknowledged' });
  } catch (error) {
    console.error('acknowledgeRejectedLead error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const acknowledgeAlert = async (req, res) => {
  try {
    const rawId = req.params.id;
    const ngoIds = await getUserNgoIds(req.user);

    if (typeof rawId === 'string' && rawId.startsWith('dr_')) {
      const realId = parseInt(rawId.replace('dr_', ''));
      const { data: reqData, error: reqErr } = await db
        .from('fro_data_requests')
        .select('id, fro_worker_id')
        .eq('id', realId)
        .maybeSingle();
      if (reqErr || !reqData) return res.status(404).json({ message: 'Request not found' });

      const { data: worker } = await db
        .from('workers')
        .select('ngo_id')
        .eq('id', reqData.fro_worker_id)
        .maybeSingle();
      if (!worker || !ngoIds.includes(worker.ngo_id)) return res.status(403).json({ message: 'Access denied' });

      await db.from('fro_data_requests').update({ status: 'acknowledged' }).eq('id', realId);
      return res.json({ message: 'Request acknowledged' });
    }

    const alertId = parseInt(rawId);
    const { data: alert } = await db
      .from('alerts')
      .select('ngo_id')
      .eq('id', alertId)
      .maybeSingle();

    if (!alert) return res.status(404).json({ message: 'Alert not found' });
    if (!ngoIds.includes(alert.ngo_id)) return res.status(403).json({ message: 'Access denied' });

    const { error } = await db
      .from('alerts')
      .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
      .eq('id', alertId);

    if (error) throw error;
    return res.json({ message: 'Alert acknowledged' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorTransactions = async (req, res) => {
  try {
    const { id } = req.params;
    const { page: pageStr, page_size } = req.query;
    const pg = Math.max(1, parseInt(pageStr) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(page_size) || 20));
    const offset = (pg - 1) * limit;

    const numId = parseInt(id);
    let donor;
    if (!isNaN(numId)) {
      const { data } = await db.from('donor_profiles').select('id, mobile_number').eq('id', numId).maybeSingle();
      donor = data;
    }
    if (!donor) {
      const { data } = await db.from('donor_profiles').select('id, mobile_number').eq('mobile_number', id).maybeSingle();
      donor = data;
    }
    if (!donor) return res.json({ data: [], pagination: { page: pg, pageSize: limit, total: 0, totalPages: 0 } });

    const [donationsRes, receiptsRes, importRes] = await Promise.all([
      db.from('fro_donor_logs')
        .select('id, amount_collected, payment_mode, accounts_status, created_at, action, disposition_detail, notes, fro_assignments!inner(donor_id)')
        .eq('fro_assignments.donor_id', donor.id)
        .gt('amount_collected', 0)
        .order('created_at', { ascending: false }),
      db.from('receipts')
        .select('id, amount, receipt_no, mode, created_at')
        .eq('donor_mobile', donor.mobile_number)
        .order('created_at', { ascending: false }),
      db.from('new_data')
        .select('id, amount, transaction_date, category, bank_donor_name, created_at')
        .eq('mobile_number', donor.mobile_number)
        .order('created_at', { ascending: false }),
    ]);

    const mapStatus = (s) => {
      if (s === 'verified') return 'verified';
      if (s === 'pending') return 'pending';
      return 'imported';
    };

    const transactions = [
      ...(donationsRes.data || []).map(d => ({
        date: d.created_at, type: 'Donation', amount: d.amount_collected || 0,
        ref: String(d.id), mode: d.payment_mode || d.disposition_detail || d.action,
        status: mapStatus(d.accounts_status), source: 'FRO Log',
      })),
      ...(receiptsRes.data || []).map(r => ({
        date: r.created_at, type: 'Receipt', amount: r.amount || 0,
        ref: r.receipt_no || `REC-${r.id}`, mode: r.mode || '',
        status: 'verified', source: 'Receipt',
      })),
      ...(importRes.data || []).map(n => ({
        date: n.created_at || n.transaction_date, type: 'Import', amount: n.amount || 0,
        ref: String(n.id), mode: n.category || n.bank_donor_name || '',
        status: 'imported', source: 'Import',
      })),
    ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    const seen = new Set();
    const unique = transactions.filter(t => {
      const key = `${t.date?.slice(0, 10)}-${t.amount}-${t.mode}-${t.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const total = unique.length;
    const paginated = unique.slice(offset, offset + limit);
    return res.json({
      data: paginated,
      pagination: { page: pg, pageSize: limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDataRequests = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    const { data, error } = await db
      .from('fro_data_requests')
      .select('*, workers(name, login_id)')
      .in('ngo_id', ngoIds)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const result = (data || []).map(r => ({
      id: r.id,
      fro_worker_id: r.fro_worker_id,
      worker_name: r.workers?.name || 'Unknown',
      worker_login: r.workers?.login_id || '',
      message: r.message,
      status: r.status,
      admin_response: r.admin_response,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const resolveDataRequest = async (req, res) => {
  try {
    const requestId = parseInt(req.params.id);
    const ngoIds = await getUserNgoIds(req.user);

    const { data: request } = await db
      .from('fro_data_requests')
      .select('ngo_id')
      .eq('id', requestId)
      .maybeSingle();

    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (!ngoIds.includes(request.ngo_id)) return res.status(403).json({ message: 'Access denied' });

    const { response } = req.body;
    const { error } = await db
      .from('fro_data_requests')
      .update({
        status: 'resolved',
        admin_response: response || null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', requestId);

    if (error) throw error;
    return res.json({ message: 'Request resolved' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const CONNECTED_DISPOSITIONS = ['contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'callback', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'office_program_visit', 'promise_pay_wa_email', 'not_interested_np', 'office_visit_scheduled', 'program_visit_scheduled', 'not_possible', 'resolved_suspense'];
const NOT_CONNECTED_DISPOSITIONS = ['busy', 'ringing', 'call_waiting', 'unreachable', 'switched_off', 'out_of_coverage', 'wrong_number', 'invalid', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail', 'busy_call_waiting', 'ooc_unreachable_network', 'ringing_voicemail', 'incoming_out'];

// Three-tier classifier: known disposition set first, then disposition_category
// (every FRO save carries it), else unclassified. Mirrors fro/dispositions.js.
// The donation funnel only ever needs four DISTINCT DONOR counts per NGO, but it
// was computing them by pulling every matching fro_donor_logs row into Node and
// building four Sets. That is ~205k rows per request for the current data size,
// and the per-NGO variant did it once per NGO in a loop.
//
// This reduces in the database instead: collapse the log rows to one row per
// (ngo, donor) first, then count. Same numbers, three rows out.
//
// The CASE is a deliberate mirror of classifyLogSide(), including the fall
// through to disposition_category when disposition_detail is NULL. Writing it as
// "NOT (detail = ANY(not_connected)) AND category = 'connected'" looks
// equivalent but silently drops the NULL-detail rows, which is what
// classifyLogSide() counts as connected. Verified against the JS on live data.
const FUNNEL_INTERESTED_DISPOSITIONS = ['lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending'];

// combinedOnly skips the per-NGO roll-up for callers that only need the
// selection-wide totals, which is the NGO Admin dashboard. Grouping by ngo_id
// there is pure overhead: those numbers are computed and then thrown away.
export async function getDonationFunnelCounts(ngoIds, { combinedOnly = false } = {}) {
  const empty = { assignments: new Map(), logs: new Map(), combined: null };
  if (!ngoIds || ngoIds.length === 0) return empty;

  const perNgoSql = combinedOnly ? '' : `
     assigned AS (
       SELECT ngo_id, count(*) AS assigned
         FROM (SELECT DISTINCT ON (ngo_id, donor_id) ngo_id, donor_id
                 FROM fro_assignments
                WHERE status <> 'reassigned'
                  AND donor_id IS NOT NULL
                  AND ngo_id = ANY($1::uuid[])) d
        GROUP BY ngo_id
     ),
     per_ngo AS (
       SELECT coalesce(a.ngo_id, p.ngo_id) AS ngo_id,
              coalesce(a.assigned, 0)    AS assigned,
              coalesce(p.called, 0)      AS called,
              coalesce(p.connected, 0)   AS connected,
              coalesce(p.interested, 0)  AS interested,
              coalesce(p.received, 0)    AS received
         FROM assigned a
         FULL OUTER JOIN (
           SELECT ngo_id,
                  count(*) AS called,
                  count(*) FILTER (WHERE connected)  AS connected,
                  count(*) FILTER (WHERE interested) AS interested,
                  count(*) FILTER (WHERE received)  AS received
             FROM per_donor GROUP BY ngo_id
         ) p ON p.ngo_id = a.ngo_id
     ),`;

  const perNgoSelect = combinedOnly ? '' : `
     SELECT ngo_id, assigned, called, connected, interested, received FROM per_ngo
     UNION ALL`;

  const { rows } = await db._pool.query(
    `WITH per_donor AS (
       SELECT e.ngo_id,
              l.donor_id,
              bool_or(CASE
                WHEN l.disposition_detail = ANY($2::text[]) THEN true
                WHEN l.disposition_detail = ANY($3::text[]) THEN false
                ELSE lower(coalesce(l.disposition_category, '')) = 'connected'
              END) AS connected,
              bool_or(l.disposition_detail = ANY($4::text[])) AS interested,
              bool_or(l.accounts_status = 'verified') AS received
         FROM fro_donor_logs l
         JOIN fro_assignments e ON e.id = l.assignment_id
        WHERE l.donor_id IS NOT NULL
          AND e.ngo_id = ANY($1::uuid[])
        GROUP BY e.ngo_id, l.donor_id
     ),${perNgoSql}
     combined AS (
       -- A donor working two of the selected NGOs must still count once, so the
       -- roll-up de-duplicates donor_id before counting rather than summing the
       -- per-NGO rows.
       SELECT NULL::uuid AS ngo_id,
              (SELECT count(*) FROM (SELECT DISTINCT donor_id FROM fro_assignments
                                       WHERE status <> 'reassigned'
                                         AND donor_id IS NOT NULL
                                         AND ngo_id = ANY($1::uuid[])) x) AS assigned,
              count(*) AS called,
              count(*) FILTER (WHERE connected)  AS connected,
              count(*) FILTER (WHERE interested) AS interested,
              count(*) FILTER (WHERE received)  AS received
         FROM (SELECT donor_id,
                      bool_or(connected)  AS connected,
                      bool_or(interested) AS interested,
                      bool_or(received)  AS received
                 FROM per_donor GROUP BY donor_id) d
     )${perNgoSelect}
     SELECT ngo_id, assigned, called, connected, interested, received FROM combined`,
    [ngoIds, CONNECTED_DISPOSITIONS, NOT_CONNECTED_DISPOSITIONS, FUNNEL_INTERESTED_DISPOSITIONS]
  );

  const assignments = new Map();
  const logs = new Map();
  let combined = null;
  for (const r of rows) {
    if (r.ngo_id === null) {
      combined = {
        assigned: Number(r.assigned),
        called: Number(r.called),
        connected: Number(r.connected),
        interested: Number(r.interested),
        received: Number(r.received),
      };
      continue;
    }
    assignments.set(r.ngo_id, Number(r.assigned));
    logs.set(r.ngo_id, {
      called: Number(r.called),
      connected: Number(r.connected),
      interested: Number(r.interested),
      received: Number(r.received),
    });
  }
  return { assignments, logs, combined };
}

export function classifyLogSide(l) {
  const detail = l?.disposition_detail || '';
  if (CONNECTED_DISPOSITIONS.includes(detail)) return 'connected';
  if (NOT_CONNECTED_DISPOSITIONS.includes(detail)) return 'not_connected';
  const cat = String(l?.disposition_category || '').toLowerCase();
  if (cat === 'connected') return 'connected';
  if (cat === 'not_connected') return 'not_connected';
  return 'unclassified';
}

const MERGED_DISPOSITION_GROUPS = {
  office_program_visit: ['office_visit_scheduled', 'program_visit_scheduled', 'office_program_visit'],
  promise_pay_wa_email: ['promise_to_pay', 'whatsapp_sent', 'email_sent', 'promise_pay_wa_email'],
  not_interested_np: ['not_interested', 'call_disconnected', 'not_possible', 'not_interested_np'],
  busy_call_waiting: ['busy', 'call_waiting', 'busy_call_waiting'],
  ooc_unreachable_network: ['out_of_coverage', 'unreachable', 'temporary_network_issue', 'ooc_unreachable_network'],
  ringing_voicemail: ['ringing', 'voicemail', 'ringing_voicemail'],
};

function mergedGroupOf(detail) {
  for (const [group, members] of Object.entries(MERGED_DISPOSITION_GROUPS)) {
    if (members.includes(detail)) return group;
  }
  return null;
}

export const masterSearch = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ donors: [], fros: [], stations: [] });

    const term = `%${q.trim()}%`;
    const ngoIds = await getUserNgoIds(req.user);
    const ngoFilter = ngoIds.length > 0 ? ngoIds : null;

    const [donorsRes, frosRes, stationsRes] = await Promise.all([
      // Search donors
      (async () => {
        let query = db
          .from('donor_profiles')
          .select('id, name, mobile_number, city, amount, total_amount, donation_count, pan_number, email, address_1, birth_date, project_supported, last_donation_date')
          .or(`name.ilike.${term},mobile_number.ilike.${term},pan_number.ilike.${term},city.ilike.${term}`)
          .limit(15);
        if (ngoFilter) {
          const { data: ngoDonors } = await db
            .from('fro_assignments')
            .select('donor_id')
            .in('ngo_id', ngoFilter)
            .not('status', 'eq', 'reassigned');
          const ids = [...new Set((ngoDonors || []).map(d => d.donor_id).filter(Boolean))];
          if (ids.length > 0) query = query.in('id', ids);
          else return [];
        }
        const { data } = await query;
        return data || [];
      })(),
      // Search FRO workers
      (async () => {
        let query = db
          .from('workers')
          .select('id, name, login_id, ngo_id, is_active, created_at, ngos!left(name)')
          .eq('department', 'FRO')
          .or(`name.ilike.${term},login_id.ilike.${term}`)
          .limit(10);
        if (ngoFilter) {
          query = query.in('ngo_id', ngoFilter);
        }
        const { data } = await query;
        return data || [];
      })(),
      // Search stations
      (async () => {
        try {
          let query = db
            .from('fro_station_assignments')
            .select('station, ngo_id, fro_worker_id, workers!left(name, login_id)')
            .ilike('station', term)
            .limit(10);
          if (ngoFilter) {
            const { data: ngoStations } = await db
              .from('fro_station_assignments')
              .select('station')
              .in('ngo_id', ngoFilter);
            const stationNames = [...new Set((ngoStations || []).map(s => s.station).filter(Boolean))];
            if (stationNames.length > 0) query = query.in('station', stationNames);
            else return [];
          }
          const { data, error } = await query;
          if (error) {
            // Fallback: query without workers join if FK fails
            const { data: fallback } = await db
              .from('fro_station_assignments')
              .select('station, ngo_id, fro_worker_id')
              .ilike('station', term)
              .limit(10);
            return (fallback || []).map(s => ({ ...s, workers: null }));
          }
          return data || [];
        } catch {
          return [];
        }
      })(),
    ]);

    // Enrich donors with FRO/station assignment info
    let donors = donorsRes;
    if (donors.length > 0) {
      const donorIds = donors.map(d => d.id);
      const { data: assignments } = await db
        .from('fro_assignments')
        .select('donor_id, ngo_id, station, status, workers!left(name, login_id)')
        .in('donor_id', donorIds)
        .not('status', 'eq', 'reassigned');
      const asgnMap = {};
      for (const a of assignments || []) {
        if (!asgnMap[a.donor_id]) asgnMap[a.donor_id] = [];
        asgnMap[a.donor_id].push(a);
      }
      donors = donors.map(d => ({
        ...d,
        assignments: asgnMap[d.id] || [],
      }));
    }

    // Enrich stations with donor count
    let stations = stationsRes;
    if (stations.length > 0) {
      const stationNames = [...new Set(stations.map(s => s.station).filter(Boolean))];
      const { data: counts } = await db
        .from('fro_assignments')
        .select('station, id', { count: 'exact', head: false })
        .in('station', stationNames)
        .not('status', 'eq', 'reassigned');
      const countMap = {};
      for (const c of counts || []) {
        countMap[c.station] = (countMap[c.station] || 0) + 1;
      }
      stations = stations.map(s => ({
        ...s,
        donor_count: countMap[s.station] || 0,
      }));
    }

    return res.json({ donors, fros: frosRes, stations });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getCallAnalytics = async (req, res) => {
  try {
    const { ngo_id, station, fro_id, from, to } = req.query;
    const ngoIds = await getUserNgoIds(req.user);
    const effectiveNgoId = ngo_id || (ngoIds.length === 1 ? ngoIds[0] : null);

    const fromDate = from || new Date(new Date().setHours(0,0,0,0)).toISOString();
    const toDate = to || new Date().toISOString();

    // Build base filter
    let logQuery = db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(donor_id, ngo_id, station, fro_worker_id), workers!fro_donor_logs_fro_worker_id_fkey(name, login_id)')
      .gte('created_at', fromDate)
      .lte('created_at', toDate);

    if (effectiveNgoId) {
      logQuery = logQuery.eq('fro_assignments.ngo_id', effectiveNgoId);
    } else if (ngoIds.length > 0) {
      logQuery = logQuery.in('fro_assignments.ngo_id', ngoIds);
    }
    if (station) logQuery = logQuery.eq('fro_assignments.station', station);
    if (fro_id) logQuery = logQuery.eq('fro_worker_id', fro_id);

    const { data: logs, error } = await logQuery;
    if (error) throw error;

    const classification = (logs || []).map(l => ({ log: l, side: classifyLogSide(l) }));
    const connected = classification.filter(x => x.side === 'connected').map(x => x.log);
    const notConnected = classification.filter(x => x.side === 'not_connected').map(x => x.log);
    const totalTalkSeconds = (logs || []).reduce((s, l) => s + (parseInt(l.call_duration_seconds) || 0), 0);

    // Per FRO breakdown
    const froMap = {};
    for (const l of logs || []) {
      const wid = l.fro_worker_id;
      if (!wid) continue;
      if (!froMap[wid]) {
        froMap[wid] = {
          fro_worker_id: wid,
          fro_name: l.workers?.name || 'Unknown',
          login_id: l.workers?.login_id || '',
          total: 0, connected: 0, not_connected: 0, talk_seconds: 0,
        };
      }
      froMap[wid].total++;
      const side = classifyLogSide(l);
      if (side === 'connected') froMap[wid].connected++;
      if (side === 'not_connected') froMap[wid].not_connected++;
      froMap[wid].talk_seconds += parseInt(l.call_duration_seconds) || 0;
    }

    // Per station breakdown
    const stationMap = {};
    for (const l of logs || []) {
      const st = l.fro_assignments?.station;
      if (!st) continue;
      if (!stationMap[st]) {
        stationMap[st] = { station: st, total: 0, connected: 0, not_connected: 0 };
      }
      stationMap[st].total++;
      const side = classifyLogSide(l);
      if (side === 'connected') stationMap[st].connected++;
      if (side === 'not_connected') stationMap[st].not_connected++;
    }

    // Per disposition breakdown
    const dispMap = {};
    for (const l of logs || []) {
      const d = l.disposition_detail || 'unknown';
      if (!dispMap[d]) dispMap[d] = 0;
      dispMap[d]++;
    }

    // Daily trend
    const dailyMap = {};
    for (const l of logs || []) {
      const day = l.created_at?.slice(0, 10) || 'unknown';
      if (!dailyMap[day]) dailyMap[day] = { date: day, connected: 0, not_connected: 0, total: 0 };
      dailyMap[day].total++;
      const side = classifyLogSide(l);
      if (side === 'connected') dailyMap[day].connected++;
      if (side === 'not_connected') dailyMap[day].not_connected++;
    }

    return res.json({
      summary: {
        total_calls: (logs || []).length,
        connected: connected.length,
        not_connected: notConnected.length,
        connection_rate: (logs || []).length > 0 ? Math.round((connected.length / (logs || []).length) * 100) + '%' : '0%',
        total_talk_seconds: totalTalkSeconds,
        total_talk_time: `${Math.floor(totalTalkSeconds / 3600)}h ${Math.floor((totalTalkSeconds % 3600) / 60)}m`,
        avg_call_duration: (logs || []).length > 0
          ? `${Math.floor(totalTalkSeconds / (logs || []).length / 60)}m ${Math.round((totalTalkSeconds / (logs || []).length) % 60)}s`
          : '0m 0s',
      },
      by_fro: Object.values(froMap).sort((a, b) => b.total - a.total),
      by_station: Object.values(stationMap).sort((a, b) => b.total - a.total),
      by_disposition: Object.entries(dispMap).map(([disposition, count]) => ({ disposition, count })).sort((a, b) => b.count - a.count),
      daily_trend: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Station Transfers ----

export const transferStationData = async (req, res) => {
  try {
    const { station } = req.params;
    const { target_station, donor_count } = req.body;
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.status(400).json({ message: 'No NGO assigned' });

    if (!target_station || !donor_count) {
      return res.status(400).json({ message: 'target_station and donor_count are required' });
    }

    const { data: sourceAssigns } = await db
      .from('fro_station_assignments')
      .select('fro_worker_id, ngo_id')
      .in('ngo_id', ngoIds)
      .eq('station', station.trim())
      .not('fro_worker_id', 'is', null)
      .limit(1);

    const sourceAssign = sourceAssigns?.[0];
    if (!sourceAssign) {
      return res.status(400).json({ message: 'No FRO assigned to source station' });
    }

    if (target_station.trim() === station.trim()) {
      return res.status(400).json({ message: 'Target station must be different from source station' });
    }

    const autoReturnAt = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    const result = await createTemporaryTransfer(
      sourceAssign.fro_worker_id, ngoIds,
      station.trim(), target_station.trim(), donor_count, autoReturnAt, req.user.id
    );

    // Moved donors between two stations, so both stations' counts and the
    // disposition roll-up change.
    bustStationCache();

    return res.json({
      message: `Transferred ${result.transferred} donors to ${target_station}`,
      transfer: result.transfer,
      transferred: result.transferred,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const returnTransferEarly = async (req, res) => {
  try {
    const { id } = req.params;
    const ngoIds = await getUserNgoIds(req.user);
    const { data: transfer } = await db.from('fro_transfers').select('ngo_id').eq('id', id).maybeSingle();
    if (transfer && transfer.ngo_id && !ngoIds.some(id => String(id) === String(transfer.ngo_id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const count = await reverseTransfer(id);
    // reverseTransfer marks the transferred rows 'reassigned' and re-inserts them
    // under the original station, which both station roll-ups count. No rows moved
    // means nothing to invalidate.
    if (count > 0) bustStationCache();
    return res.json({
      message: `Returned ${count} donors to original FRO`,
      returned: count,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTransferHistory = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    const { data: transfers, error } = await db
      .from('fro_transfers')
      .select('*')
      .in('ngo_id', ngoIds)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const froIds = [...new Set((transfers || []).map(t => t.source_fro_worker_id).filter(Boolean))];
    let froNameMap = {};
    if (froIds.length > 0) {
      const { data: workers } = await db
        .from('workers')
        .select('id, name')
        .in('id', froIds);
      for (const w of workers || []) froNameMap[w.id] = w.name;
    }

    const result = (transfers || []).map(t => ({
      id: t.id,
      station: t.station,
      target_station: t.target_station,
      donor_count: t.donor_count,
      donor_ids: t.donor_ids || [],
      source_fro_name: froNameMap[t.source_fro_worker_id] || 'Unknown',
      auto_return_at: t.auto_return_at,
      returned: !!t.returned,
      returned_at: t.returned_at,
      created_at: t.created_at,
    }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTransferDonors = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    const { id } = req.params;

    const { data: transfer, error: tErr } = await db
      .from('fro_transfers')
      .select('*')
      .eq('id', id)
      .in('ngo_id', ngoIds)
      .single();

    if (tErr || !transfer) {
      return res.status(404).json({ message: 'Transfer not found' });
    }

    const donorIds = transfer.donor_ids || [];

    if (donorIds.length === 0) return res.json([]);

    // Fetch donor details from donors table (or new_data table as fallback)
    const { data: donors } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, pan_number')
      .in('id', donorIds);

    if (donors && donors.length > 0) {
      return res.json(donors);
    }

    // Fallback: try new_data table
    const { data: newDonors } = await db
      .from('new_data')
      .select('id, name, mobile, status')
      .in('id', donorIds);

    const fallback = (newDonors || []).map(d => ({
      id: d.id, name: d.name, mobile: d.mobile, lead_status: d.status,
    }));

    return res.json(fallback);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getIncentives = async (req, res) => {
  try {
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    const allWorkers = [];
    for (const ngoId of ngoIds) {
      const workers = await getFroWorkersByNgo(ngoId);
      allWorkers.push(...workers);
    }

    const workerIds = allWorkers.map(w => w.id);
    if (workerIds.length === 0) return res.json([]);

    const offset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(Date.now() + offset);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const startDate = `${y}-${m}-01`;
    const lastDay = new Date(Date.UTC(y, parseInt(m), 0)).getUTCDate();
    const endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;

    const ranges = await getAKISlabs();

    const { data: allAchievements } = await db
      .from('daily_achievements')
      .select('*')
      .in('worker_id', workerIds)
      .gte('date', startDate)
      .lte('date', endDate);

    const achievementsByWorker = {};
    if (allAchievements) {
      for (const a of allAchievements) {
        if (!achievementsByWorker[a.worker_id]) achievementsByWorker[a.worker_id] = [];
        achievementsByWorker[a.worker_id].push(a);
      }
    }

    const { data: incentiveTargets } = await db
      .from('incentive_targets')
      .select('*')
      .in('worker_id', workerIds)
      .eq('month', startDate);

    const targetByWorker = {};
    if (incentiveTargets) {
      for (const t of incentiveTargets) {
        targetByWorker[t.worker_id] = t;
      }
    }

    const results = [];
    for (const worker of allWorkers) {
      const workerAchs = achievementsByWorker[worker.id] || [];
      const monthlyAchievement = workerAchs.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

      const target = targetByWorker[worker.id];
      if (!target) {
        results.push({
          worker_id: worker.id,
          name: worker.name,
          totalIncentive: 0,
          akiPayout: 0,
          monthlyIncentive: 0,
          monthlyAchievement,
          monthlyTarget: 0,
          hasTarget: false,
        });
        continue;
      }

      const monthlyTarget = parseFloat(target.target_amount);
      const totalAKI = workerAchs.reduce((sum, r) => {
        const dayName = getDayName(r.date);
        return sum + calculateAKI(parseFloat(r.amount), dayName, ranges);
      }, 0);

      const monthsEmployed = getMonthsEmployed(worker.created_at);
      const isNewJoiner = monthsEmployed <= 3;
      const monthlyTargetMet = monthlyAchievement >= monthlyTarget;

      let akiPayout = 0;
      let monthlyIncentive = 0;
      let totalIncentive = 0;

      if (monthlyTargetMet) {
        const overage = monthlyAchievement - monthlyTarget;
        monthlyIncentive = Math.round(overage * 0.1);
        akiPayout = isNewJoiner ? totalAKI : Math.round(totalAKI / 2);
        totalIncentive = akiPayout + monthlyIncentive;
      }

      results.push({
        worker_id: worker.id,
        name: worker.name,
        totalIncentive,
        akiPayout,
        monthlyIncentive,
        monthlyAchievement,
        monthlyTarget,
        totalAKI,
        hasTarget: true,
      });
    }

    return res.json(results);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getVerificationFroWise = async (req, res) => {
  try {
    const { status, period } = req.query;
    if (!status || !period) {
      return res.status(400).json({ message: 'status and period are required' });
    }
    if (!['verified', 'unverified'].includes(status)) {
      return res.status(400).json({ message: 'status must be verified or unverified' });
    }
    if (!['month', 'today'].includes(period)) {
      return res.status(400).json({ message: 'period must be month or today' });
    }

    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();

    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });
    if (froWorkers.length === 0) return res.json([]);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const startDate = period === 'month' ? monthStart : todayStart.toISOString();
    const endDate = period === 'month' ? monthEnd : todayEnd.toISOString();

    const collectionFn = status === 'verified' ? getVerifiedCollection : getUnverifiedCollection;

    const results = await Promise.all(froWorkers.map(async (w) => {
      const { amount, count } = await collectionFn(w.id, startDate, endDate);
      return { fro_id: w.id, fro_name: w.name, amount, count };
    }));

    return res.json(results);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---- Donor CRM ----

export const listLeads = async (req, res) => {
  try {
    const { search, status, from_date, to_date, page: pageStr, page_size } = req.query;
    const page = Math.max(1, parseInt(pageStr) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(page_size) || 50));
    const offset = (page - 1) * limit;

    // Only show telecaller-created leads (not recruiter leads)
    const { data: telecallerUsers } = await db
      .from('users')
      .select('id')
      .eq('role', 'telecaller');
    const telecallerIds = (telecallerUsers || []).map(u => u.id);
    if (telecallerIds.length === 0) {
      return res.json({ data: [], pagination: { page, pageSize: limit, total: 0, totalPages: 0 } });
    }

    let countQuery = db.from('leads').select('id', { count: 'exact', head: true }).in('created_by', telecallerIds);
    let dataQuery = db.from('leads').select('*, users(name)').in('created_by', telecallerIds).order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    if (status) { countQuery = countQuery.eq('status', status); dataQuery = dataQuery.eq('status', status); }
    if (from_date) { countQuery = countQuery.gte('created_at', from_date + 'T00:00:00'); dataQuery = dataQuery.gte('created_at', from_date + 'T00:00:00'); }
    if (to_date) { countQuery = countQuery.lte('created_at', to_date + 'T23:59:59'); dataQuery = dataQuery.lte('created_at', to_date + 'T23:59:59'); }

    if (search) {
      const q = `%${search}%`;
      countQuery = countQuery.or(`name.ilike.${q},phone.ilike.${q},email.ilike.${q}`);
      dataQuery = dataQuery.or(`name.ilike.${q},phone.ilike.${q},email.ilike.${q}`);
    }

    const [{ count }, { data, error }] = await Promise.all([countQuery, dataQuery]);
    if (error) throw error;

    const total = count || 0;
    return res.json({
      data: data || [],
      pagination: { page, pageSize: limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createLead = async (req, res) => {
  try {
    const { name, mobile, email, address, city, state, pan, aadhaar, birthday, anniversary, language, notes } = req.body;
    if (!name || !mobile) {
      return res.status(400).json({ message: 'Name and mobile are required' });
    }

    const { data, error } = await db
      .from('leads')
      .insert({
        name,
        phone: mobile,
        email: email || null,
        notes: [address, city, state, pan, aadhaar, birthday, anniversary, language].filter(Boolean).join(' | ') || null,
        created_by: req.user.id,
        source: 'admin',
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const importLeads = async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const file = req.files.file;

    const XLSX = await import('xlsx');
    const workbook = XLSX.read(file.data, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const leads = rows.map(row => ({
      name: row.name || row.Name || '',
      phone: String(row.mobile || row.Mobile || row.phone || row.Phone || ''),
      email: row.email || row.Email || null,
      created_by: req.user.id,
      source: 'import',
      status: 'pending',
    })).filter(l => l.name && l.phone);

    if (leads.length === 0) {
      return res.status(400).json({ message: 'No valid leads found in file' });
    }

    const { data, error } = await db.from('leads').insert(leads).select();
    if (error) throw error;

    return res.json({ message: `${leads.length} leads imported`, count: leads.length, data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const assignLeads = async (req, res) => {
  try {
    const { lead_ids, fro_worker_id } = req.body;
    if (!lead_ids || !lead_ids.length || !fro_worker_id) {
      return res.status(400).json({ message: 'lead_ids array and fro_worker_id are required' });
    }

    const { data: leads, error: lErr } = await db
      .from('leads')
      .select('id, phone, name')
      .in('id', lead_ids);
    if (lErr) throw lErr;

    const now = new Date().toISOString();
    const assignments = leads.map(lead => ({
      lead_id: lead.id,
      fro_worker_id: parseInt(fro_worker_id),
      assigned_by: req.user.id,
      assigned_at: now,
      status: 'assigned',
    }));

    const { error: aErr } = await db.from('lead_assignments').insert(assignments);
    if (aErr) throw aErr;

    await db.from('leads').update({ status: 'assigned', assigned_to: parseInt(fro_worker_id) }).in('id', lead_ids);

    return res.json({ message: `${leads.length} leads assigned`, count: leads.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const transferLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { target_fro_worker_id, target_station } = req.body;
    if (!target_fro_worker_id && !target_station) {
      return res.status(400).json({ message: 'target_fro_worker_id or target_station required' });
    }

    const ngoIds = await getUserNgoIds(req.user);
    const { data: lead } = await db.from('leads').select('id').eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const updateData = {};
    if (target_fro_worker_id) updateData.assigned_to = parseInt(target_fro_worker_id);
    if (target_station) updateData.station = target_station;
    updateData.status = 'transferred';

    const { error } = await db.from('leads').update(updateData).eq('id', id);
    if (error) throw error;

    return res.json({ message: 'Lead transferred successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getLeadHistory = async (req, res) => {
  try {
    const { lead_id } = req.query;
    const ngoIds = await getUserNgoIds(req.user);

    let query = db
      .from('lead_assignments')
      .select('*, leads(name, phone, assigned_to), workers!fro_worker_id(name, ngo_id)')
      .order('assigned_at', { ascending: false });

    if (lead_id) query = query.eq('lead_id', lead_id);

    const { data, error } = await query;
    if (error) throw error;

    const result = (data || [])
      .filter(h => {
        if (ngoIds.length === 0) return true;
        const workerNgo = h.workers?.ngo_id;
        const leadAssignedTo = h.leads?.assigned_to;
        if (workerNgo && ngoIds.includes(Number(workerNgo))) return true;
        return false;
      })
      .map(h => ({
        id: h.id,
        lead_id: h.lead_id,
        lead_name: h.leads?.name || 'Unknown',
        lead_phone: h.leads?.phone || '',
        fro_name: h.workers?.name || 'Unknown',
        assigned_by: h.assigned_by,
        status: h.status || 'assigned',
        assigned_at: h.assigned_at,
      }));

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDuplicateLeads = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);
    if (ngoIds.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) ngoNames.push(ngo.name);
    }
    if (ngoNames.length === 0) return res.json([]);

    const { data, error } = await db
      .from('donor_profiles')
      .select('id, name, mobile_number, city, amount, last_donation_date, pan_number')
      .in('ngo', ngoNames)
      .order('mobile_number');

    if (error) throw error;

    const grouped = {};
    for (const d of data || []) {
      const key = d.mobile_number || d.name || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(d);
    }

    const duplicates = Object.values(grouped).filter(g => g.length > 1);
    return res.json(duplicates);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFullDonorDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const numId = parseInt(id);
    const ngoIds = await getUserNgoIds(req.user);

    let profile;
    const { data: donor, error } = await db
      .from('donor_profiles')
      .select('*')
      .eq('id', numId)
      .single();

    if (error || !donor) {
      const { data: mobileDonor } = await db
        .from('donor_profiles')
        .select('*')
        .eq('mobile_number', id)
        .maybeSingle();
      if (!mobileDonor) return res.status(404).json({ message: 'Donor not found' });
      profile = mobileDonor;
    } else {
      profile = donor;
    }

    const { data: accessCheck } = await db
      .from('fro_assignments')
      .select('id')
      .eq('donor_id', profile.id)
      .in('ngo_id', ngoIds)
      .not('status', 'eq', 'reassigned')
      .limit(1);
    if (!accessCheck || accessCheck.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { data: donations } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(donor_id)')
      .eq('fro_assignments.donor_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(50);

    return res.json({ profile, donations: donations || [] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorReceipts = async (req, res) => {
  try {
    const { id } = req.params;
    const ngoIds = await getUserNgoIds(req.user);

    let donorMobile;
    const numId = parseInt(id);
    if (!isNaN(numId)) {
      const { data: donor } = await db.from('donor_profiles').select('mobile_number, ngo').eq('id', numId).maybeSingle();
      if (donor) {
        donorMobile = donor.mobile_number;
        if (ngoIds.length > 0 && donor.ngo) {
          const { data: ngo } = await db.from('ngos').select('name').eq('id', ngoIds[0]).maybeSingle();
          if (ngo && donor.ngo !== ngo.name && !ngoIds.includes(Number(donor.ngo))) {
            return res.status(403).json({ message: 'Access denied' });
          }
        }
      }
    } else {
      donorMobile = id;
    }

    if (!donorMobile) return res.json([]);

    const { data, error } = await db
      .from('receipts')
      .select('*')
      .eq('donor_mobile', donorMobile)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorFollowups = async (req, res) => {
  try {
    const { id } = req.params;
    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.json([]);

    let donorId;
    const numId = parseInt(id);
    if (!isNaN(numId)) {
      const { data: fa } = await db
        .from('fro_assignments')
        .select('id, ngo_id')
        .eq('donor_id', numId)
        .maybeSingle();
      if (fa && ngoIds.includes(fa.ngo_id)) donorId = fa.id;
    }

    if (!donorId) return res.json([]);

    const { data, error } = await db
      .from('fro_scheduled_contacts')
      .select('*, workers!created_by(name)')
      .eq('assignment_id', donorId)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createFollowup = async (req, res) => {
  try {
    const { donor_id, fro_worker_id, scheduled_at, notes } = req.body;
    if (!donor_id || !scheduled_at) {
      return res.status(400).json({ message: 'donor_id and scheduled_at are required' });
    }

    const ngoIds = await getUserNgoIds(req.user);
    const { data: assignment } = await db
      .from('fro_assignments')
      .select('id, ngo_id')
      .eq('donor_id', donor_id)
      .maybeSingle();

    if (!assignment) {
      return res.status(400).json({ message: 'No assignment found for this donor' });
    }
    if (assignment.ngo_id && !ngoIds.some(id => String(id) === String(assignment.ngo_id))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { data, error } = await db
      .from('fro_scheduled_contacts')
      .insert({
        assignment_id: assignment.id,
        scheduled_at: scheduled_at,
        notes: notes || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroSummary = async (req, res) => {
  try {
    const froId = req.params.id;
    if (!froId) return res.status(400).json({ message: 'Invalid FRO ID' });

    const ngoIds = await getUserNgoIds(req.user);
    if (ngoIds.length === 0) return res.status(403).json({ message: 'Access denied' });

    const { data: worker } = await db
      .from('workers')
      .select('id, ngo_id')
      .eq('id', froId)
      .maybeSingle();
    if (!worker || !ngoIds.includes(worker.ngo_id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const [logsRes, asgnRes] = await Promise.all([
      db
        .from('fro_donor_logs')
        .select('amount_collected, disposition_detail, action, accounts_status, created_at, call_duration_seconds')
        .eq('fro_worker_id', froId)
        .gte('created_at', todayStart.toISOString())
        .lte('created_at', todayEnd.toISOString()),
      db
        .from('fro_assignments')
        .select('status')
        .eq('fro_worker_id', froId)
        .not('status', 'eq', 'reassigned'),
    ]);

    const logs = logsRes.data || [];
    const assignments = asgnRes.data || [];

    const todayCollection = logs.reduce((s, l) => {
      const amt = parseFloat(l.amount_collected || 0);
      if (l.action === 'donation') return s + amt;
      if (l.action === 'disposition' && (l.disposition_detail === 'lead_done' || l.disposition_detail === 'done')) return s + amt;
      return s;
    }, 0);

    const talkSeconds = logs.reduce((s, l) => s + (parseInt(l.call_duration_seconds) || 0), 0);

    const dispositionBreakdown = {};
    for (const l of logs) {
      const d = l.disposition_detail || 'unknown';
      dispositionBreakdown[d] = (dispositionBreakdown[d] || 0) + 1;
    }

    const statusBreakdown = {};
    for (const a of assignments) {
      statusBreakdown[a.status] = (statusBreakdown[a.status] || 0) + 1;
    }

    return res.json({
      todayCollection,
      todayCalls: logs.length,
      talkSeconds,
      dispositionBreakdown,
      totalAssigned: assignments.length,
      statusBreakdown,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const DEFAULT_STATION_NAMES = ['ND-1','ND-2','ND-3','ND-4','ND-5','ND-6','ND-7','ND-8','DH-1','DH-2','DH-3','DH-4','DH-5','DH-6','DH-7','DH-8','DH-9','DH-10','DH-11','DH-12','DH-13','DH-14'];
const FRESH_STATION_NAMES = Array.from({ length: 23 }, (_, i) => `FD-${i + 1}`);
const STATION_NAMES = process.env.STATION_NAMES
  ? process.env.STATION_NAMES.split(',').map(s => s.trim())
  : DEFAULT_STATION_NAMES;

export const seedStations = async (req, res) => {
  try {
    const { ngo_id, fresh } = req.body || {};
    const stationList = fresh ? FRESH_STATION_NAMES : STATION_NAMES;

    let ngoEntries;
    if (ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name, id').eq('id', ngo_id).single();
      if (!ngo) return res.status(400).json({ message: 'NGO not found' });
      ngoEntries = [{ ngoId: ngo.id, ngoName: ngo.name }];
    } else {
      const access = await getUserNgoAccess(req.user.id, req.user.role);
      ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
      if (ngoEntries.length === 0 && req.user.ngo_id) {
        const { data: ngo } = await db.from('ngos').select('name, id').eq('id', req.user.ngo_id).single();
        if (ngo) ngoEntries.push({ ngoId: ngo.id, ngoName: ngo.name });
      }
    }

    if (!ngoEntries || ngoEntries.length === 0) {
      return res.status(400).json({ message: 'No NGOs found' });
    }

    let totalCreated = 0;
    const results = [];
    for (const { ngoId, ngoName } of ngoEntries) {
      let created = 0;
      for (const station of stationList) {
        const existing = await getStationAssignmentByNgoAndStation(ngoId, station);
        if (!existing) {
          await createStation(ngoId, station, req.user.id);
          created++;
        }
      }
      totalCreated += created;
      results.push({ ngo: ngoName, created });
    }

    if (totalCreated > 0) bustStationCache();
    return res.json({ message: `${totalCreated} stations created`, details: results });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const cleanupOrphanedStations = async (req, res) => {
  try {
    const { ngo_id } = req.body || {};
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const allowedNgoIds = new Set(access.map(a => a.ngo_id).filter(Boolean));

    let targetNgoIds;
    if (ngo_id) {
      if (![...allowedNgoIds].some(id => String(id) === String(ngo_id))) {
        return res.status(403).json({ message: 'You do not have access to this NGO' });
      }
      targetNgoIds = [ngo_id];
    } else {
      targetNgoIds = [...allowedNgoIds];
    }

    const { data: orphaned, error: fetchErr } = await db
      .from('fro_station_assignments')
      .select('id, station, ngo_id')
      .in('ngo_id', targetNgoIds)
      .is('fro_worker_id', null);

    if (fetchErr) throw fetchErr;

    if (!orphaned || orphaned.length === 0) {
      return res.json({ message: 'No orphaned stations found', deleted: 0 });
    }

    const ids = orphaned.map(r => r.id);
    const { error: delErr } = await db
      .from('fro_station_assignments')
      .delete()
      .in('id', ids);

    if (delErr) throw delErr;

    bustStationCache();

    return res.json({
      message: `${ids.length} orphaned station(s) deleted`,
      deleted: ids.length,
      stations: orphaned.map(r => ({ station: r.station, ngo_id: r.ngo_id })),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadOldData = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const XLSX = await import('xlsx');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ message: 'No sheets found in file' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ message: 'No data found in file' });
    }

    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name, id').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: ngo.id, ngoName: ngo.name });
    }
    if (ngoEntries.length === 0) {
      return res.status(400).json({ message: 'No NGOs assigned to your account' });
    }

    const bodyDataCategory = req.body.data_category || null;

    const normalizedRows = rows.map(row => ({
      mobile: String(row.moblie || row.Moblie || row.MOBLIE || row.mobile || row.Mobile || row.mobile_number || row.MobileNumber || row['Mobile Number'] || row['Mobile No'] || row['Moblie No'] || row['MOBLIE No'] || '').trim(),
      name: String(row.name || row.Name || row['Donor Name'] || row.donor_name || row.donorname || '').trim(),
      amount: parseFloat(row.amount || row.Amount || row.donation_amount || row.DonationAmount || 0) || 0,
      city: String(row.city || row.City || row.city_name || row.CityName || '').trim(),
      station: String(row.station || row.Station || row.station_name || row.StationName || '').trim().toUpperCase(),
      data_category: String(row['Data Category'] || row['Data category'] || row.data_category || bodyDataCategory || '').trim() || null,
    })).filter(r => r.mobile && r.station);

    const validStations = new Set(STATION_NAMES);
    const batchId = crypto.randomUUID();
    let createdProfiles = 0;
    let createdAssignments = 0;
    let skippedDuplicate = 0;
    let invalidStation = 0;
    const errors = [];

    for (const row of normalizedRows) {
      if (!validStations.has(row.station)) {
        invalidStation++;
        errors.push(`Invalid station "${row.station}" for mobile ${row.mobile}`);
        continue;
      }

      // Upsert donor_profile
      const { data: existingProfile } = await db
        .from('donor_profiles')
        .select('id')
        .eq('mobile_number', row.mobile)
        .maybeSingle();

      let donorId;
      if (existingProfile) {
        donorId = existingProfile.id;
        const updateFields = {};
        if (row.name) updateFields.name = row.name;
        if (row.city) updateFields.city = row.city;
        if (row.data_category) updateFields.data_category = row.data_category;
        if (Object.keys(updateFields).length > 0) {
          await db.from('donor_profiles').update(updateFields).eq('id', donorId);
        }
      } else {
        const { data: newProfile } = await db
          .from('donor_profiles')
          .insert([{ mobile_number: row.mobile, name: row.name || null, amount: row.amount, total_amount: row.amount, donation_count: 1, city: row.city || null, data_category: row.data_category || null }])
          .select('id')
          .single();
        if (newProfile) {
          donorId = newProfile.id;
          createdProfiles++;
        }
      }
      if (!donorId) continue;

      // Create assignment per NGO
      for (const { ngoId, ngoName } of ngoEntries) {
        const { data: existingAsgn } = await db
          .from('fro_assignments')
          .select('id')
          .eq('donor_id', donorId)
          .eq('ngo_id', ngoId)
          .not('status', 'eq', 'reassigned')
          .maybeSingle();

        if (existingAsgn) {
          skippedDuplicate++;
          continue;
        }

        const stationAssign = await getStationAssignmentByNgoAndStation(ngoId, row.station);

        const { error: asgnErr } = await db
          .from('fro_assignments')
          .insert([{
            donor_id: donorId,
            fro_worker_id: stationAssign?.fro_worker_id || null,
            ngo_id: ngoId,
            station: row.station,
            status: 'pending',
            assigned_at: new Date().toISOString(),
            batch_id: batchId,
            batch_type: 'old_data',
          }]);
        if (asgnErr) {
          errors.push(`Failed to create assignment for ${row.mobile} in ${ngoName}: ${asgnErr.message}`);
        } else {
          createdAssignments++;
        }
      }
    }

    // Same effect as uploadOldDataForStation, which is the station-scoped
    // sibling of this endpoint: it inserts assignments into existing stations.
    if (createdAssignments > 0 || createdProfiles > 0) bustStationCache();

    return res.json({
      message: `${createdAssignments} assignments created across ${ngoEntries.length} NGO(s)`,
      total_rows: normalizedRows.length,
      created_profiles: createdProfiles,
      created_assignments: createdAssignments,
      skipped_duplicate_assignments: skippedDuplicate,
      invalid_stations: invalidStation,
      ngo_count: ngoEntries.length,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadOldDataForStation = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const station = req.params.station?.trim().toUpperCase();
    if (!station) {
      return res.status(400).json({ message: 'Station is required' });
    }

    const XLSX = await import('xlsx');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ message: 'No sheets found in file' });
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

    if (rawRows.length === 0) {
      return res.status(400).json({ message: 'No data found in file' });
    }

    // Find the actual header row (contains "Sr. No." or "Donor Name" or "Mobile")
    let headerIdx = -1;
    let headerRow = null;
    const headerKeywords = ['sr.no', 'sr no', 'sr.', 'donor name', 'mobile', 'agent name'];
    for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
      const row = rawRows[i].map(c => String(c).toLowerCase().trim());
      if (headerKeywords.some(k => row.some(c => c.includes(k)))) {
        headerIdx = i;
        headerRow = rawRows[i];
        break;
      }
    }
    if (headerIdx < 0) {
      return res.status(400).json({ message: 'Could not find header row. Ensure file has Sr. No., Donor Name, or Mobile column.' });
    }

    // Parse rows after header as objects using headerRow as keys
    const rows = [];
    for (let i = headerIdx + 1; i < rawRows.length; i++) {
      const row = rawRows[i];
      const firstVal = String(row[0] || '').trim();
      if (!firstVal || firstVal === '') continue; // skip empty rows
      const obj = {};
      for (let j = 0; j < headerRow.length; j++) {
        const key = String(headerRow[j] || '').trim();
        if (key) obj[key] = row[j] != null ? String(row[j]).trim() : '';
      }
      if (Object.keys(obj).length > 0) rows.push(obj);
    }

    if (rows.length === 0) {
      return res.status(400).json({ message: 'No data rows found after header' });
    }

    const access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name, id').eq('id', req.user.ngo_id).single();
      if (ngo) ngoEntries.push({ ngoId: ngo.id, ngoName: ngo.name });
    }

    // Filter by selected NGO if provided
    const { ngo_id } = req.body;
    const bodyDataCategory = req.body.data_category || null;
    if (ngo_id) {
      ngoEntries = ngoEntries.filter(e => String(e.ngoId) === String(ngo_id));
    }

    if (ngoEntries.length === 0) {
      return res.status(400).json({ message: 'No NGOs assigned to your account or selected NGO not found' });
    }

    const normalizedRows = rows.map(row => ({
      mobile: String(row.Mobile || row.mobile || row['Max of Mobile no.'] || row['Mobile No'] || row['Mobile Number'] || row['Mobile no'] || row.mobile_number || row['Max of Mobile no'] || '').trim(),
      name: String(row['Donor Name'] || row['Donor name'] || row['donor name'] || row['donor_name'] || row.Name || row.name || '').trim(),
      amount: parseFloat(row['Max of Amt'] || row['Max Amt'] || row.amount || row.Amount || row['Max of amt'] || 0) || 0,
      city: String(row.City || row.city || '').trim(),
      mobile_2: String(row['Max of Mobile no.2'] || row['Mobile 2'] || row['Mobile No 2'] || row.mobile_2 || '').trim(),
      data_category: String(row['Data Category'] || row['Data category'] || row.data_category || '').trim() || bodyDataCategory || null,
      agent_name: String(row['Agent Name'] || row['Agent name'] || row['agent name'] || row.agent_name || row.fro_name || '').trim(),
      raw_data: row,
    })).filter(r => r.mobile);

    let createdProfiles = 0;
    let createdAssignments = 0;
    let skippedDuplicate = 0;
    const errors = [];
    const now = new Date().toISOString();
    const batchId = crypto.randomUUID();

    // Batch 1: Get existing profiles by mobile
    const mobiles = normalizedRows.map(r => r.mobile);
    const { data: existingProfiles } = await db
      .from('donor_profiles')
      .select('id, mobile_number')
      .in('mobile_number', mobiles);
    const existingMobiles = new Set((existingProfiles || []).map(p => p.mobile_number));

    // Batch 2: Insert new profiles (all fields), Upsert existing profiles (safe fields only)
    const toInsert = [];
    const toUpdate = [];
    for (const row of normalizedRows) {
      if (existingMobiles.has(row.mobile)) {
        toUpdate.push({ mobile_number: row.mobile, name: row.name || null, city: row.city || null, mobile_2: row.mobile_2 || null, data_category: row.data_category || null, raw_data: row.raw_data });
      } else {
        toInsert.push({ mobile_number: row.mobile, name: row.name || null, amount: row.amount, total_amount: row.amount, donation_count: 1, city: row.city || null, mobile_2: row.mobile_2 || null, data_category: row.data_category || null, raw_data: row.raw_data });
      }
    }

    let donorIds = [];
    const profileMap = {};
    for (const p of existingProfiles || []) profileMap[p.mobile_number] = p.id;

    if (toInsert.length > 0) {
      const { data: newP } = await db.from('donor_profiles').insert(toInsert).select('id, mobile_number');
      for (const p of newP || []) {
        profileMap[p.mobile_number] = p.id;
        donorIds.push(p.id);
        createdProfiles++;
      }
    }
    if (toUpdate.length > 0) {
      const { data: updP } = await db.from('donor_profiles').upsert(toUpdate, { onConflict: 'mobile_number' }).select('id, mobile_number');
      for (const p of updP || []) {
        if (!profileMap[p.mobile_number]) profileMap[p.mobile_number] = p.id;
        donorIds.push(p.id);
      }
    }
    donorIds = [...new Set(donorIds)];

    // Batch 3: Get existing assignments for all donor+ngo combos
    const existingAssignmentKeys = new Set();
    if (donorIds.length > 0) {
      for (const { ngoId } of ngoEntries) {
        const assignedSet = await getActiveAssignmentDonorIds(ngoId, donorIds);
        for (const donorId of assignedSet) {
          existingAssignmentKeys.add(`${donorId}-${ngoId}`);
        }
      }
    }

    // Batch 4: Get station assignments
    const stationAssignMap = {};
    for (const { ngoId } of ngoEntries) {
      const sa = await getStationAssignmentByNgoAndStation(ngoId, station);
      stationAssignMap[ngoId] = sa?.fro_worker_id || null;
    }

    // Batch 5: Create missing assignments
    const assignmentsToInsert = [];
    for (const did of donorIds) {
      for (const { ngoId, ngoName } of ngoEntries) {
        if (existingAssignmentKeys.has(`${did}-${ngoId}`)) {
          skippedDuplicate++;
          continue;
        }
        assignmentsToInsert.push({ donor_id: did, fro_worker_id: stationAssignMap[ngoId], ngo_id: ngoId, station, status: 'pending', assigned_at: now, batch_id: batchId, batch_type: 'old_data' });
      }
    }
    if (assignmentsToInsert.length > 0) {
      const { error: batchErr } = await db.from('fro_assignments').insert(assignmentsToInsert);
      if (batchErr) errors.push(`Batch insert error: ${batchErr.message}`);
      else createdAssignments = assignmentsToInsert.length;
    }

    // The upload adds donors to this station, so its cached donor_count and the
    // disposition roll-up are stale the moment the insert commits.
    if (createdAssignments > 0 || createdProfiles > 0) bustStationCache();

    return res.json({
      message: `${createdAssignments} assignments created for station ${station} (${ngoEntries.map(e => e.ngoName).join(', ')})`,
      total_rows: normalizedRows.length,
      created_profiles: createdProfiles,
      created_assignments: createdAssignments,
      skipped_duplicate_assignments: skippedDuplicate,
      ngo_count: ngoEntries.length,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDataOverview = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoEntries = access.map(a => ({ ngoId: a.ngo_id, ngoName: a.ngo_name })).filter(e => e.ngoId);
    if (ngoEntries.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('id, name').eq('id', req.user.ngo_id).maybeSingle();
      if (ngo) ngoEntries.push({ ngoId: ngo.id, ngoName: ngo.name });
    }

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      ngoEntries = ngoEntries.filter(e => String(e.ngoId) === String(filterNgoId));
    }
    if (ngoEntries.length === 0) return res.json([]);

    const minimal = req.query.minimal === 'true';
    const perStationLimit = Math.min(500, Math.max(1, parseInt(req.query.per_station) || 100));

    const result = [];
    for (const { ngoId, ngoName } of ngoEntries) {
      const [stationAssignsRes, assignmentsRes] = await Promise.all([
        db.from('fro_station_assignments')
          .select('id, station, fro_worker_id, workers!fro_station_assignments_fro_worker_id_fkey(id, name)')
          .eq('ngo_id', ngoId)
          .order('station', { ascending: true }),
        db.from('fro_assignments')
          .select('id, donor_id, station, fro_worker_id, status, batch_type, is_new, assigned_at, ngo_id')
          .eq('ngo_id', ngoId)
          .not('status', 'eq', 'reassigned'),
      ]);
      if (stationAssignsRes.error) throw stationAssignsRes.error;

      const stationRows = stationAssignsRes.data || [];
      const assignments = assignmentsRes.data || [];

      const workerNameMap = {};
      for (const sa of stationRows) {
        const wid = sa.fro_worker_id;
        if (wid && !workerNameMap[wid]) workerNameMap[wid] = sa.workers?.name || 'Unknown';
      }
      const stationIdMap = {};
      for (const sa of stationRows) stationIdMap[sa.station] = sa.id;

      const buckets = {};
      const getFro = (wid) => wid || 'UNASSIGNED';
      for (const a of assignments) {
        const froKey = getFro(a.fro_worker_id);
        if (!buckets[froKey]) buckets[froKey] = { new: {}, old: {} };
        const side = a.batch_type === 'new_data' ? 'new' : 'old';
        const st = a.station || 'UNKNOWN';
        if (!buckets[froKey][side][st]) buckets[froKey][side][st] = [];
        buckets[froKey][side][st].push(a);
      }

      let donorIds = [];
      if (!minimal) donorIds = [...new Set(assignments.map(a => a.donor_id).filter(Boolean))];

      const donorMap = {};
      if (!minimal && donorIds.length > 0) {
        const { data: donors } = await db.from('donor_profiles')
          .select('id, name, mobile_number, amount, city')
          .in('id', donorIds);
        for (const d of donors || []) donorMap[d.id] = d;
      }

      const knownFroIds = new Set(Object.keys(workerNameMap));
      const froKeys = new Set([...Object.keys(buckets), ...knownFroIds]);

      const froAssignments = [];
      for (const froKey of froKeys) {
        const isUnassigned = froKey === 'UNASSIGNED';
        const froId = isUnassigned ? null : froKey;
        const froName = isUnassigned ? 'Unassigned' : (workerNameMap[froKey] || 'Unknown');
        const buildSide = (side) => {
          const stationBuckets = (buckets[froKey] && buckets[froKey][side]) || {};
          const stations = Object.keys(stationBuckets).sort();
          return stations.map(st => {
            const list = stationBuckets[st] || [];
            const data = minimal ? [] : list.slice(0, perStationLimit).map(a => {
              const d = donorMap[a.donor_id] || {};
              return {
                id: a.id,
                assignment_id: a.id,
                donor_id: a.donor_id,
                name: d.name || 'Unknown',
                mobile: d.mobile_number || '',
                amount: d.amount || 0,
                city: d.city || '',
                status: a.status || 'pending',
                is_new: a.is_new !== false,
                batch_type: a.batch_type || null,
                assigned_at: a.assigned_at || null,
              };
            });
            return {
              stationId: stationIdMap[st] || null,
              stationName: st,
              count: list.length,
              data,
            };
          });
        };
        froAssignments.push({
          froId,
          froName,
          new: { stations: buildSide('new') },
          old: { stations: buildSide('old') },
        });
      }

      result.push({ ngoId, ngoName, froAssignments });
    }

    return res.json(result);
  } catch (error) {
    console.error('getDataOverview error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

// ==================== NEW DASHBOARD APIs ====================

// Combined TL Dashboard Summary
export const getTLDashboard = async (req, res) => {
  try {
    const requestGeneration = tlCacheGeneration;
    const tlCacheKey = `tl:${req.user.id}:${req.query.ngo_id || 'all'}:${req.query.from || ''}:${req.query.to || ''}:${req.query.fro_id || ''}`;
    if (req.query.fresh !== '1') {
      const cached = cacheGet(tlCacheKey, 15000);
      if (cached) return res.json(cached);
    }
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId, from, to, fro_id } = req.query;
    const origNgoNames = [...ngoNames];
    const origNgoIds = [...ngoIds];

    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    if (ngoIds.length === 0) return res.json({ 
      kpis: { total_fros: 0, calling: 0, meeting: 0, idle: 0, offline: 0, total_calls: 0, connected: 0, interested: 0, received_amount: 0, followups_due: 0, target_pct: 0, unclassified: 0, suspenses: 0 },
      idle_alerts: [],
      collections_per_ngo: [],
      funnel: [],
      hourly: [],
      top_performers: [],
      bottom_performers: [],
      stations_per_ngo: {},
      stations_summary: { total: 0, active: 0 },
    });

    // Get all FRO workers
    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    let froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; }).filter(w => w.is_active !== false);
    if (fro_id) froWorkers = froWorkers.filter(w => String(w.id) === String(fro_id));
    const workerIds = froWorkers.map(w => w.id);

    const now = new Date();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();

    // Effective date range for KPIs/analytics (default = today)
    let rangeStart = from ? new Date(from) : todayStart;
    let rangeEnd = to ? new Date(to) : todayEnd;
    if (from && from.length <= 10) rangeStart = new Date(`${from}T00:00:00`);
    if (to && to.length <= 10) rangeEnd = new Date(`${to}T23:59:59.999`);
    if (isNaN(rangeStart.valueOf())) rangeStart = todayStart;
    if (isNaN(rangeEnd.valueOf())) rangeEnd = todayEnd;

    // 1. Live status counts — driven by LOGIN PRESENCE (auth_sessions) plus the
    //    current call state. An FRO is present while they hold an open CRM login
    //    session (logged_out_at NULL), a recently-written live row, or an open
    //    panel socket (socket presence replaced timer heartbeats).
    // Single source of truth for the liveness window (was a local duplicate of
    // the same 3 minutes; two constants that must stay equal is how the read
    // paths drifted apart in the first place).
    const LIVE_FRESH_MS = IDLE_LIVE_FRESH_MS;
    // stats_date is not optional here: it is the authoritative answer to "which day
    // do this row's today-counters belong to", and without it the stale-idle test
    // has to fall back to updated_at. That fallback happens to work for a row nobody
    // has touched since yesterday, but it cannot tell a row that was written today
    // while still holding yesterday's numbers.
    //
    // frozen_at was missing here, as it was on the FRO's own strip, which let this
    // table and the FRO's panel timer show two different idle totals for the same
    // person at the same moment: the panel caps an already-open period at the
    // moment a meeting or admin pause began, and these two reads did not.
    //
    // Now shared, so the three surfaces cannot drift apart again.
    // idle_since drives the idle status pill and KPI count on this board, and
    // today_idle_seconds is the committed day total the IDLE cell falls back to.
    const liveCols = `${FRO_IDLE_LIVE_COLS}, idle_since, today_idle_seconds`;
    // One row per worker, and that row belongs to the worker themselves: a
    // covering operator writes their own row, so the extra "fetch rows whose
    // work_as_operator_id is in scope" query this used to run is no longer
    // needed. It existed only to find the operator via the covered row.
    const { data: liveStatus } = await db.from('fro_live_status').select(liveCols).in('worker_id', workerIds);
    const liveFreshCutoff = new Date(now.getTime() - LIVE_FRESH_MS);
    // Fresh = recently-written row OR an open panel socket.
    const isLiveFresh = (s) =>
      (s.updated_at && new Date(s.updated_at) >= liveFreshCutoff) ||
      isWorkerOnline(s.worker_id);
    const liveRowByWorker = new Map((liveStatus || []).map(s => [String(s.worker_id), s]));

    // Cover relationships come from work_as_sessions, not from the live row.
    //
    // Every live row is now the OWNING HUMAN's row (updateLiveStatus files it
    // on the person at the keyboard), so a covered FRO's row is no longer
    // refreshed by the operator working their panel, and an operator has a real
    // row of their own. The old inference — "a fresh row carrying
    // work_as_operator_id means the operator is working" — depended on the
    // operator writing the covered FRO's row and is therefore no longer true.
    //
    // work_as_sessions is one row per (operator, covered target) and is already
    // the authoritative store: it holds a chain, allows several operators on one
    // target, expires on its own, and is released on exit. Reading it here also
    // fixes the reported symptom directly — a covered-away FRO's stale row no
    // longer decides that the operator is "offline".
    let coversByTarget = new Map();
    let coversByOperator = new Map();
    try {
      coversByTarget = await getActiveCoversForTargets(workerIds);
      coversByOperator = await getActiveCoversByOperator(workerIds);
    } catch (e) {
      // work_as_sessions unavailable — fall back to the row's display label so
      // the board still renders rather than 500ing.
    }
    // Is this worker currently covering anybody?
    const activeCoverTargets = (wid) => coversByOperator.get(String(wid)) || [];
    const hasActiveCover = (wid) => activeCoverTargets(wid).length > 0;
    // Who is covering this worker (may be several)?
    const operatorsCovering = (wid) => (coversByTarget.get(String(wid)) || []).map(c => c.operatorName).filter(Boolean);
    // A covered FRO is one somebody else is working, so their own row going quiet
    // means "away", not "not covered any more".
    const isWorkAsRow = (s) => isCovered(coversByTarget, s?.worker_id);
    // Being covered and being away are NOT the same thing, and conflating them
    // hides a person who is sitting at their own desk.
    //
    // The row is now the OWNING human's, so "covering this FRO" says nothing at
    // all about whether they are present — they are frequently present, working
    // their own account while somebody else runs a station of theirs. Away means
    // their own row has gone quiet: no recent write and no open socket.
    const isCoveredAway = (s) => isWorkAsRow(s) && !isLiveFresh(s);
    // A covered-away FRO is not "idle" and not "online" — they are off the floor,
    // which the offline bucket already covers. Excluding them from livePresent
    // keeps them out of the calling/idle/online tallies instead of letting a
    // lapsed deadline push them into the idle count.
    const isWorkAs = (s) => isCoveredAway(s);
    // An operator is actively working when they are driving a panel: their own
    // row is fresh, their socket is open, or they hold a cover whose operator is
    // connected. The last case covers a non-FRO operator (an admin id with no
    // worker row of its own), who still has to be recognised as working.
    const isOperatorActive = (wid) => {
      if (hasActiveCover(wid) && isWorkerOnline(wid)) return true;
      const lrow = liveRowByWorker.get(String(wid));
      return !!(lrow && isLiveFresh(lrow));
    };
    // The row that represents what this operator is doing right now: their own
    // live row. Replaces buildWorkAsByOp's covered-row proxy, which handed the
    // operator another person's counters.
    const workAsByOp = new Map();
    for (const s of liveStatus || []) {
      if (isLiveFresh(s)) workAsByOp.set(String(s.worker_id), s);
    }

    // Login presence: auth_sessions rows recorded on every UCS CRM login and
    // closed on explicit logout. Presence = an open session OR a fresh
    // heartbeat — a panel resumed from a saved token never re-POSTs /auth/login,
    // so the session row can be missing or stale while the FRO is actively
    // working. The freshness gate below still drops sleeping/closed panels.
    const sessionByUser = {};
    let useLoginPresence = true;
    try {
      const { data: sessions } = await db.from('auth_sessions').select('user_id, last_active_at, logged_out_at').in('user_id', workerIds);
      for (const s of sessions || []) sessionByUser[String(s.user_id)] = s;
    } catch (e) {
      useLoginPresence = false; // auth_sessions missing → legacy stale-based logic
    }
    const isPresent = (wid) => {
      if (!useLoginPresence) return true;
      const s = sessionByUser[String(wid)];
      if (s && !s.logged_out_at) return true;
      const lrow = liveRowByWorker.get(String(wid));
      return !!lrow && isLiveFresh(lrow);
    };

    // Logout counts: today (IST) and all-time, from explicit logout events.
    const logoutCounts = {};
    try {
      if (workerIds.length > 0) {
        const nowIst = new Date(now.getTime() + 5.5 * 3600 * 1000);
        const istTodayStart = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()));
        const logoutRows = await sql(
          `SELECT user_id,
                  COUNT(*) FILTER (WHERE logged_out_at >= $1::timestamptz) AS today,
                  COUNT(*) AS total
           FROM auth_logout_events
           WHERE user_id = ANY($2::text[])
           GROUP BY user_id`,
          [istTodayStart.toISOString(), workerIds.map(String)]
        );
        for (const r of logoutRows) logoutCounts[r.user_id] = { today: Number(r.today || 0), total: Number(r.total || 0) };
      }
    } catch (e) { /* auth_logout_events missing until migration 125 */ }

    const livePresent = (s) => isLiveFresh(s) && !isWorkAs(s) && isPresent(s.worker_id);
    const callingRows = (liveStatus || []).filter(s => s.status === 'on_call' && livePresent(s));
    // Meeting mode: FROs pushed status 'meeting' during a company-wide meeting.
    // They remain present but never count as calling/online/offline.
    const meetingRows = (liveStatus || []).filter(s => s.status === 'meeting' && livePresent(s));
    // An operator mid-call on a covered station counts as calling. Their own row
    // carries that call state, so this no longer needs a separate "the covered
    // row says on_call" proxy — and adding both would double-count one person,
    // since the operator's own row is in callingRows already.
    const opCalling = froWorkers.filter(w => {
      const row = workAsByOp.get(String(w.id));
      return row && row.status === 'on_call' && hasActiveCover(w.id)
        && !callingRows.some(s => String(s.worker_id) === String(w.id));
    });
    const calling = callingRows.length + opCalling.length;
    const meeting = meetingRows.length;
    // Idle: the disposition timer lapsed and they haven't pressed Resume. An open
    // idle_since is the authoritative signal — the row may still say 'online'
    // until the FRO's next heartbeat.
    const idleRows = (liveStatus || []).filter(s => s.idle_since && livePresent(s) && !s.is_paused);
    const idle = idleRows.length;
    // FROs whose panel is being operated by another worker (work-as) are treated
    // as absent today: the covering operator carries the online/calling state.
    // Driven by work_as_sessions, so a covered FRO is recognised even though
    // nobody refreshes their row while the cover is running.
    const coveredOnly = (wid) => isCovered(coversByTarget, wid) && !isOperatorActive(wid);
    // Online requires freshness (recent row write or open panel socket) on
    // top of presence — a machine that is asleep, shut down, or a tab that was
    // closed drops its socket and goes offline within seconds.
    const online = useLoginPresence
      ? froWorkers.filter(w => {
          const lrow = liveRowByWorker.get(String(w.id));
          const liveHere = isOperatorActive(w.id) || (isPresent(w.id) && !!lrow && isLiveFresh(lrow));
          return !coveredOnly(String(w.id)) && liveHere
            && !callingRows.some(s => String(s.worker_id) === String(w.id))
            && !meetingRows.some(s => String(s.worker_id) === String(w.id))
            && !idleRows.some(s => String(s.worker_id) === String(w.id))
            && !opCalling.some(o => String(o.id) === String(w.id));
        }).length
      : (liveStatus || []).filter(s => s.status === 'online' && isLiveFresh(s) && !isWorkAs(s) && !s.idle_since).length;
    const offline = Math.max(0, froWorkers.length - calling - meeting - idle - online);

    // 2. Call analytics for the selected range
    let callLogsQuery = db
      .from('fro_donor_logs')
      .select('disposition_detail, disposition_category, accounts_status, amount_collected, fro_assignments!inner(ngo_id)')
      .in('fro_assignments.ngo_id', ngoIds)
      .gte('created_at', rangeStart.toISOString())
      .lte('created_at', rangeEnd.toISOString());
    if (fro_id) callLogsQuery = callLogsQuery.eq('fro_worker_id', fro_id);
    const { data: callLogs } = await callLogsQuery;

    const connectedStatuses = new Set(CONNECTED_DISPOSITIONS);
    const interestedStatuses = new Set(['lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending']);
    const notConnectedStatuses = new Set(NOT_CONNECTED_DISPOSITIONS);

    const totalCalls = (callLogs || []).length;
    const connected = (callLogs || []).filter(l => classifyLogSide(l) === 'connected').length;
    const notConnected = (callLogs || []).filter(l => classifyLogSide(l) === 'not_connected').length;
    const unclassified = (callLogs || []).filter(l => classifyLogSide(l) === 'unclassified').length;
    const interested = (callLogs || []).filter(l => interestedStatuses.has(l.disposition_detail)).length;
    const donations = (callLogs || []).filter(l => l.accounts_status === 'verified').length;
    const connectionRate = totalCalls > 0 ? Math.round((connected / totalCalls) * 100) : 0;

    // Per-NGO collection split (Collection card) — attributed by RECEIPT DATE
    // via the receipts table (receipts.log_id -> fro_donor_logs -> fro_assignments.ngo_id),
    // matching the Accounts panel totals instead of the call-log timestamp.
    const rangeFromDay = from && String(from).length <= 10 ? String(from).slice(0, 10) : todayStart.toISOString().slice(0, 10);
    const rangeToDay = to && String(to).length <= 10 ? String(to).slice(0, 10) : todayEnd.toISOString().slice(0, 10);
    const ngoNameById = {};
    for (const a of access) ngoNameById[String(a.ngo_id)] = a.ngo_name;
    const perNgoCollectionMap = {};
    const recParams = [rangeFromDay, rangeToDay, ngoIds];
    let recSql = `SELECT fa.ngo_id, COALESCE(SUM(r.amount),0) AS total
                  FROM receipts r
                  LEFT JOIN fro_donor_logs l ON l.id = r.log_id
                  LEFT JOIN fro_assignments fa ON fa.id = l.assignment_id
                  WHERE r.receipt_date >= ($1::date AT TIME ZONE 'Asia/Kolkata')
                    AND r.receipt_date < (($2::date + 1) AT TIME ZONE 'Asia/Kolkata')
                    AND fa.ngo_id = ANY($3)`;
    if (fro_id) {
      recParams.push(fro_id);
      recSql += ` AND l.fro_worker_id = $${recParams.length}`;
    }
    recSql += ` GROUP BY fa.ngo_id`;
    const receiptRows = await sql(recSql, recParams);
    for (const row of receiptRows) {
      const nid = row.ngo_id;
      if (nid == null) continue;
      perNgoCollectionMap[String(nid)] = (perNgoCollectionMap[String(nid)] || 0) + parseFloat(row.total || 0);
    }
    const collections_per_ngo = (origNgoIds && origNgoIds.length ? origNgoIds : ngoIds).map(nid => ({
      ngo_id: nid,
      ngo_name: ngoNameById[String(nid)] || `NGO-${nid}`,
      amount: Math.round(perNgoCollectionMap[String(nid)] || 0),
    }));
    // Collection card headline: sum of the per-NGO receipt-date totals across the active range.
    const receivedAmount = Object.values(perNgoCollectionMap).reduce((s, a) => s + (a || 0), 0);

    // Connected / non-connected reason breakdowns
    const connectedBreakdownMap = {};
    const notConnectedBreakdownMap = {};
    for (const l of callLogs || []) {
      const d = l.disposition_detail || 'unknown';
      const side = classifyLogSide(l);
      if (side === 'connected') connectedBreakdownMap[d] = (connectedBreakdownMap[d] || 0) + 1;
      else if (side === 'not_connected') notConnectedBreakdownMap[d] = (notConnectedBreakdownMap[d] || 0) + 1;
    }
    const connectedBreakdown = Object.entries(connectedBreakdownMap).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
    const notConnectedBreakdown = Object.entries(notConnectedBreakdownMap).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);

    // 3. Follow-ups due (global KPI + per-FRO overdue split for the
    // Telecaller Performance table, by IST date). Strict buckets: FU O/D counts
    // follow-up-family + promise statuses, CB O/D counts callbacks only — any
    // other past-due status counts in neither. Promises drop out automatically
    // once collected (receipt check / closed status).
    const FU_OVERDUE_STATUSES = new Set(['scheduled', 'follow_up', 'office_visit_scheduled', 'program_visit_scheduled', 'promise_to_pay', 'will_donate_online', 'payment_pending', 'promise_pay_wa_email']);
    const CB_OVERDUE_STATUSES = new Set(['callback']);
    let followupsQuery = db
      .from('fro_assignments')
      .select('id, next_follow_up, fro_worker_id, status')
      .in('ngo_id', ngoIds)
      .not('status', 'in', '("reassigned", "donation_collected")')
      .not('next_follow_up', 'is', null);
    if (fro_id) followupsQuery = followupsQuery.eq('fro_worker_id', fro_id);
    const { data: followups } = await followupsQuery;
    const istTodayStr = new Date(now.getTime() + ((5 * 60) + 30) * 60000).toISOString().slice(0, 10);
    const followupsDue = (followups || []).filter(f => f.next_follow_up && new Date(f.next_follow_up) <= todayEnd).length;
    // Per-FRO overdue keyed by worker id: past-due (next_follow_up strictly
    // before IST today), split into callback-type vs follow-up-type so the
    // performance table can show both columns. Mirrors the Follow-up
    // Management convention (promise statuses are not counted as overdue).
    const overdueByWorker = {};
    for (const f of followups || []) {
      const nd = f.next_follow_up ? String(f.next_follow_up).slice(0, 10) : null;
      if (!nd || nd >= istTodayStr || !f.fro_worker_id) continue;
      const wid = String(f.fro_worker_id);
      if (!overdueByWorker[wid]) overdueByWorker[wid] = { calls: 0, followups: 0 };
      if (CB_OVERDUE_STATUSES.has(f.status)) overdueByWorker[wid].calls++;
      else if (FU_OVERDUE_STATUSES.has(f.status)) overdueByWorker[wid].followups++;
    }

    // 4. Target achievement
    const monthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    let targetsQuery = db.from('fro_targets').select('target_amount, achieved_target').in('ngo_id', ngoIds).eq('month', monthStr);
    if (fro_id) targetsQuery = targetsQuery.eq('fro_worker_id', fro_id);
    const { data: targets } = await targetsQuery;
    const totalTarget = (targets || []).reduce((sum, t) => sum + parseFloat(t.target_amount || 0), 0);
    const totalAchieved = (targets || []).reduce((sum, t) => sum + parseFloat(t.achieved_target || 0), 0);
    const targetPct = totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0;

    // 5. Donation Funnel
    // The roll-up counts distinct donors across the whole selection, so a donor
    // attached to two of the chosen NGOs counts once. Summing the per-NGO rows
    // would double count them.
    const { combined: funnelTotals } = await getDonationFunnelCounts(ngoIds, { combinedOnly: true });
    const totals = funnelTotals || { assigned: 0, called: 0, connected: 0, interested: 0, received: 0 };
    const funnelPct = (n) => (totals.assigned > 0 ? Math.round((n / totals.assigned) * 100) : 0);
    const funnel = [
      { stage: 'Assigned', count: totals.assigned, pct: 100 },
      { stage: 'Called', count: totals.called, pct: funnelPct(totals.called) },
      { stage: 'Connected', count: totals.connected, pct: funnelPct(totals.connected) },
      { stage: 'Interested', count: totals.interested, pct: funnelPct(totals.interested) },
      { stage: 'Received', count: totals.received, pct: funnelPct(totals.received) },
    ];

    // 6. Hourly Performance
    const { data: hourlyLogs } = await db
      .from('fro_donor_logs')
      .select('created_at, disposition_detail, disposition_category, accounts_status, amount_collected, fro_assignments!inner(ngo_id)')
      .in('fro_assignments.ngo_id', ngoIds)
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString());

    const hourlyMap = {};
    for (let h = 9; h <= 20; h++) {
      const hourStr = `${String(h).padStart(2, '0')}:00-${String(h+1).padStart(2, '0')}:00`;
      hourlyMap[hourStr] = { hour: hourStr, calls: 0, connected: 0, interested: 0, donations: 0, amount: 0 };
    }

    for (const l of hourlyLogs || []) {
      const hour = new Date(l.created_at).getHours();
      if (hour < 9 || hour > 20) continue;
      const hourStr = `${String(hour).padStart(2, '0')}:00-${String(hour+1).padStart(2, '0')}:00`;
      if (!hourlyMap[hourStr]) continue;
      hourlyMap[hourStr].calls++;
      if (classifyLogSide(l) === 'connected') hourlyMap[hourStr].connected++;
      if (interestedStatuses.has(l.disposition_detail)) hourlyMap[hourStr].interested++;
      if (l.accounts_status === 'verified') {
        hourlyMap[hourStr].donations++;
        hourlyMap[hourStr].amount += parseFloat(l.amount_collected || 0);
      }
    }
    const hourly = Object.values(hourlyMap);

    // 7. FRO Performance for Top/Bottom
    const batchStats = await getBatchCollectionStats(workerIds, monthStart, monthEnd, todayStart.toISOString(), todayEnd.toISOString(), ngoIds);
    
    const { data: faRows } = await db
      .from('fro_assignments')
      .select('status, fro_worker_id')
      .in('ngo_id', ngoIds)
      .neq('status', 'reassigned');

    const workerAssignments = {};
    for (const a of faRows || []) {
      if (!workerAssignments[a.fro_worker_id]) workerAssignments[a.fro_worker_id] = { connected: 0, total: 0 };
      workerAssignments[a.fro_worker_id].total++;
      if (connectedStatuses.has(a.status)) workerAssignments[a.fro_worker_id].connected++;
    }

    // Live status map for status (use liveStatus from earlier)
    const liveStatusMap = {};
    for (const ls of liveStatus || []) {
      liveStatusMap[ls.worker_id] = ls;
    }

    // Claim status per FRO
    const { data: claimLogs } = await db
      .from('fro_donor_logs')
      .select('fro_worker_id, accounts_status, fro_assignments!inner(ngo_id)')
      .in('fro_assignments.ngo_id', ngoIds)
      .in('fro_worker_id', workerIds);
    
    const claimStatusMap = {};
    for (const log of claimLogs || []) {
      if (!claimStatusMap[log.fro_worker_id]) {
        claimStatusMap[log.fro_worker_id] = { pending: 0, verified: 0, rejected: 0 };
      }
      if (log.accounts_status === 'pending') claimStatusMap[log.fro_worker_id].pending++;
      else if (log.accounts_status === 'verified') claimStatusMap[log.fro_worker_id].verified++;
      else if (log.accounts_status === 'rejected') claimStatusMap[log.fro_worker_id].rejected++;
    }

    // Actual call counts per FRO (today, week, month, selected range). Calls,
    // donations and interested stay per-log; connected / non-connected and the
    // per-disposition columns count DISTINCT donors by their LATEST disposition
    // in each window so table cells match the donor popup exactly.
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0,0,0,0);
    const monthStartDate = new Date(monthStart);
    const monthEndDate = new Date(monthEnd);
    const logsFrom = new Date(Math.min(monthStartDate.getTime(), rangeStart.getTime()));
    const logsTo = new Date(Math.max(monthEndDate.getTime(), rangeEnd.getTime()));
    const { data: callCountLogs } = await db
      .from('fro_donor_logs')
      .select('fro_worker_id, donor_id, created_at, disposition_detail, disposition_category, accounts_status, amount_collected, fro_assignments!inner(ngo_id)')
      .in('fro_assignments.ngo_id', ngoIds)
      .in('fro_worker_id', workerIds)
      .gte('created_at', logsFrom.toISOString())
      .lte('created_at', logsTo.toISOString());
    
    const callCounts = {};
    const donorLatest = {};
    const touchDonor = (fid, period, donorId, logDate, log) => {
      if (!donorId || !log.disposition_detail) return;
      if (!donorLatest[fid]) donorLatest[fid] = {};
      if (!donorLatest[fid][period]) donorLatest[fid][period] = {};
      const cur = donorLatest[fid][period][donorId];
      if (!cur || logDate > cur.at) {
        donorLatest[fid][period][donorId] = { at: logDate, detail: log.disposition_detail, category: log.disposition_category };
      }
    };
    for (const log of callCountLogs || []) {
      if (!callCounts[log.fro_worker_id]) {
        callCounts[log.fro_worker_id] = {
          month: 0, today: 0, week: 0, range: 0,
          monthConnected: 0, todayConnected: 0, weekConnected: 0, rangeConnected: 0,
          monthInterested: 0, todayInterested: 0, weekInterested: 0, rangeInterested: 0,
          monthNonConnected: 0, todayNonConnected: 0, weekNonConnected: 0, rangeNonConnected: 0,
          monthDonations: 0, todayDonations: 0, weekDonations: 0, rangeDonations: 0,
          rangeAmount: 0,
          connectedStatuses_month: {},
          connectedStatuses_today: {},
          connectedStatuses_week: {},
          connectedStatuses_range: {},
          notConnectedStatuses_month: {},
          notConnectedStatuses_today: {},
          notConnectedStatuses_week: {},
          notConnectedStatuses_range: {},
        };
      }
      const logDate = new Date(log.created_at);
      const isToday = logDate >= todayStart && logDate <= todayEnd;
      const isWeek = logDate >= weekStart && logDate <= todayEnd;
      const isMonth = logDate >= monthStartDate && logDate <= monthEndDate;
      const isRange = logDate >= rangeStart && logDate <= rangeEnd;
      if (isMonth) callCounts[log.fro_worker_id].month++;
      if (isToday) callCounts[log.fro_worker_id].today++;
      if (isWeek) callCounts[log.fro_worker_id].week++;
      if (isRange) callCounts[log.fro_worker_id].range++;
      if (log.accounts_status === 'verified') {
        if (isMonth) callCounts[log.fro_worker_id].monthDonations++;
        if (isToday) callCounts[log.fro_worker_id].todayDonations++;
        if (isWeek) callCounts[log.fro_worker_id].weekDonations++;
        if (isRange) {
          callCounts[log.fro_worker_id].rangeDonations++;
          callCounts[log.fro_worker_id].rangeAmount += parseFloat(log.amount_collected || 0);
        }
      }
      if (isMonth) touchDonor(log.fro_worker_id, 'month', log.donor_id, logDate, log);
      if (isToday) touchDonor(log.fro_worker_id, 'today', log.donor_id, logDate, log);
      if (isWeek) touchDonor(log.fro_worker_id, 'week', log.donor_id, logDate, log);
      if (isRange) touchDonor(log.fro_worker_id, 'range', log.donor_id, logDate, log);
      if (interestedStatuses.has(log.disposition_detail)) {
        if (isMonth) callCounts[log.fro_worker_id].monthInterested++;
        if (isToday) callCounts[log.fro_worker_id].todayInterested++;
        if (isWeek) callCounts[log.fro_worker_id].weekInterested++;
        if (isRange) callCounts[log.fro_worker_id].rangeInterested++;
      }
    }

    for (const [fid, periods] of Object.entries(donorLatest)) {
      const cc = callCounts[fid];
      if (!cc) continue;
      for (const [period, donors] of Object.entries(periods)) {
        for (const { detail, category } of Object.values(donors)) {
          const side = classifyLogSide({ disposition_detail: detail, disposition_category: category });
          if (side === 'connected') {
            cc[`${period}Connected`]++;
            const bucket = mergedGroupOf(detail) || detail;
            cc[`connectedStatuses_${period}`][bucket] = (cc[`connectedStatuses_${period}`][bucket] || 0) + 1;
          } else if (side === 'not_connected') {
            cc[`${period}NonConnected`]++;
            const ncBucket = mergedGroupOf(detail) || detail;
            cc[`notConnectedStatuses_${period}`][ncBucket] = (cc[`notConnectedStatuses_${period}`][ncBucket] || 0) + 1;
          }
        }
      }
    }

    // Station info per FRO
    const { data: froStationData } = await db
      .from('fro_station_assignments')
      .select('fro_worker_id, station')
      .in('ngo_id', ngoIds);
    const froStationMap = {};
    for (const row of froStationData || []) {
      if (row.fro_worker_id && row.station) {
        if (!froStationMap[row.fro_worker_id]) froStationMap[row.fro_worker_id] = [];
        if (!froStationMap[row.fro_worker_id].includes(row.station)) {
          froStationMap[row.fro_worker_id].push(row.station);
        }
      }
    }

    // Per-FRO shift windows so each row's idle total is clamped to that FRO's
    // own working hours, not to an open-ended range. Built once for the board.
    // Batched: the per-FRO getShiftWindowMs version cost ~5 queries each (two of
    // them re-fetching the same worker row), which on a 50-FRO board was ~250
    // round-trips through a 5-connection pool on every poll. This is 3 queries
    // for the whole board. A worker missing from the map keeps the open-ended
    // fallback, exactly as the old per-FRO try/catch produced.
    const shiftMap = await getShiftWindowsMs(froWorkers.map((w) => w.id), now.getTime());

    // Day idle totals from the authoritative fro_time_sessions ledger. The live
    // row no longer carries the banked idle columns, so deriving the total from
    // it only ever showed the current stretch and dropped back to 0 after every
    // disposition.
    let ledgerTotals = new Map();
    try {
      ledgerTotals = await dayTotalsForWorkers(froWorkers.map((w) => w.id), {
        nowMs: now.getTime(),
        shiftFor: (id) => shiftMap[String(id)] || null,
        nowFor: (id) => {
          const row = liveStatusMap[id] || {};
          return isCoveredAway(row) ? idleFreezeCutoffMs(row) : NaN;
        },
      });
    } catch (ledgerErr) {
      console.error('tl-dashboard ledger idle read failed:', ledgerErr.message);
    }

    // Whose idle the IDLE cell should show when somebody else is at the keyboard.
    //
    // An agent covering a FRO files their own time against that FRO's stations, and
    // the covered FRO's own strip shows the AGENT's figure (they are the one at the
    // panel). Showing the FRO's own banked idle here instead left the two screens
    // disagreeing for the same row — a covered FRO read 44m on this board while the
    // panel in front of the agent read 2m, and neither number was wrong; they were
    // two different people. This row belongs to whoever is actually working it, so
    // while a cover is live the agent's own today-idle is what this cell reports.
    const coveringAgentByTarget = new Map();
    for (const [targetId, covers] of coversByTarget.entries()) {
      const withLabel = (covers || []).filter((c) => c?.operatorUserId);
      if (withLabel.length > 0) coveringAgentByTarget.set(String(targetId), withLabel);
    }
    let agentTotals = new Map();
    try {
      // Keyed by (covered FRO, agent) and clamped to that FRO's shift, because
      // that is exactly what the agent's own strip does — see dayTotalsForAgents.
      const pairs = [...coveringAgentByTarget.entries()].flatMap(([targetId, list]) =>
        list.map((c) => ({ workerId: targetId, agentId: c.operatorUserId })));
      agentTotals = await dayTotalsForAgents(pairs, {
        nowMs: now.getTime(),
        shiftFor: (id) => shiftMap[String(id)] || null,
      });
    } catch (agentLedgerErr) {
      console.error('tl-dashboard agent idle read failed:', agentLedgerErr.message);
    }

    // Collection/target figures for the Telecaller Performance board, from the
    // SAME leaderboard that backs /ngo-admin/fro-performance and the High/Low
    // Performance cards. Resolved here rather than in the browser joining two
    // endpoints on fro_id: that join silently produced an all-zero COLLECTION
    // block whenever the second fetch failed (its .catch() swallowed the error),
    // and a column that is quietly wrong is worse than one that is absent.
    // buildFroLeaderboard returns every FRO globally; we index it and pick out
    // this board's workers.
    const targetByFro = new Map();
    try {
      const lbRows = await buildFroLeaderboard({ startDay: rangeFromDay, endDay: rangeToDay });
      for (const r of lbRows || []) targetByFro.set(String(r.id), r);
    } catch (e) {
      // Non-fatal: the board still renders, only the target columns stay 0.
      console.error('getTLDashboard leaderboard failed:', e?.message || String(e));
    }

    const performance = froWorkers.map(w => {
      const bs = batchStats;
      const coll = bs.monthCollection[w.id] || 0;
      const lb = targetByFro.get(String(w.id)) || null;
      const leads = (bs.verifiedMonth[w.id]?.count || 0) + (bs.unverifiedMonth[w.id]?.count || 0);
      const wa = workerAssignments[w.id] || { connected: 0, total: 0 };
      const conversion = wa.total > 0 ? Math.round((wa.connected / wa.total) * 1000) / 10 : 0;
      const target = (targets || []).find(t => t.fro_worker_id === w.id);
      const targetAmt = target ? parseFloat(target.target_amount) : 0;
      const achievedAmt = target ? parseFloat(target.achieved_target) : coll;
      const targetPct = targetAmt > 0 ? Math.round((achievedAmt / targetAmt) * 100) : 0;

      const ls = liveStatusMap[w.id] || {};
      const claims = claimStatusMap[w.id] || { pending: 0, verified: 0, rejected: 0 };
      const lsFresh = (ls.updated_at && (now - new Date(ls.updated_at)) <= LIVE_FRESH_MS) ||
        isWorkerOnline(w.id);
      // Work-as label, from work_as_sessions first (authoritative, survives a
      // chain, never flickers) with the live row's display column as a fallback
      // for rows written before the switch started recording it.
      const coverers = operatorsCovering(w.id);
      const workAsName = coverers.length > 0
        ? coverers.join(', ')
        : ((ls.work_as_operator_id && ls.work_as_operator_name) ? ls.work_as_operator_name : null);
      // This worker's OWN live row, now that rows are filed on the human rather
      // than on the account being covered. It is the authoritative source for
      // their status, idle and pause — no other person's row is consulted.
      const acting = workAsByOp.get(String(w.id));
      // Only label a row as "being worked by" when this person is not themselves
      // the one at the keyboard covering somebody.
      const workAsLabel = (acting || isOperatorActive(w.id)) ? null : workAsName;
      // Streak portion only — drives the "Idle Xm" pill. Derived from the
      // server's own disposition deadline rather than from heartbeat freshness,
      // so a FRO whose monitor is off or whose tab was closed still shows the
      // time they have been sitting idle, and a period left over from a previous
      // IST day reads as 0.
      const ownShift = shiftMap[String(w.id)] || null;
      // A covered-away FRO's idle stops accruing at the last moment their own row
      // was written. Both figures below take that cutoff, so the pill, the day
      // total and the ledger all agree instead of the number quietly climbing for
      // somebody who has already gone home.
      const frozenAt = isCoveredAway(ls) ? idleFreezeCutoffMs(ls) : NaN;
      const idleStreakSeconds = openIdleSeconds(ls, ownShift, now.getTime(), frozenAt);
      // Every row renders ITS OWN committed counter and streak — nothing is
      // inherited from a work-as covered row.
      //
      // It used to be: acting ? coveredRow's total : isWorkAs(ls) ? 0 : own.
      // work_as_operator_id is only cleared by a normal heartbeat from the
      // covered FRO, so the flag outlives the coverage indefinitely (14 of 17
      // live rows had no matching work_as_sessions row at all). While such a
      // stale row was fresh, the "acting" branch handed its operator the COVERED
      // FRO's counter: a FRO who had just logged in (counter 0) silently
      // rendered whoever they covered at 0 idle, and the number jumped again
      // whenever another covered row became fresh. One person's login was
      // resetting someone else's IDLE HR. Attribution is storage-layer
      // bookkeeping, not a display concern — each row owns its number.
      //
      // The total now comes from the shared effectiveIdleSeconds() rather than
      // being re-derived here: this screen is the one place that used to keep
      // its own copy of the rule, which is how IDLE HR could disagree with the
      // super-admin list for the same FRO at the same moment. The shift is
      // passed so idle accrued outside this FRO's own working hours is not
      // displayed as working-time idle.
      const ledgerDay = ledgerTotals.get(String(w.id));
      const rowIdleSeconds = ledgerDay
        ? ledgerDay.idle_seconds
        : effectiveIdleSeconds(ls, ownShift, now.getTime(), frozenAt);
      // A fallback that cannot see banked idle silently reads as zero. That is
      // what today_idle_seconds IS — the committed total — and the shared column
      // list omits it, so any FRO without a ledger row for today (no panel yet, or
      // a day before the roll-out) had only the still-open streak to show and
      // their IDLE cell looked like they had never been idle at all.
      const idleDisplaySeconds = ledgerDay
        ? rowIdleSeconds
        : Math.max(rowIdleSeconds, Number(ls.today_idle_seconds || 0) || 0);
      // A live cover wins the IDLE cell: the person at the keyboard is the agent,
      // and their panel shows this same figure, so the board and the strip agree.
      const activeCover = coveringAgentByTarget.get(String(w.id))?.[0] || null;
      const coveringIdle = activeCover ? agentTotals.get(agentTotalKey(w.id, activeCover.operatorUserId)) : null;
      const idleAttributedTo = activeCover ? (activeCover.operatorName || 'an agent') : null;

      // Presence-driven status: an operator actively working a covered panel
      // mirrors that panel's call state. Otherwise online requires presence (an
      // open CRM session OR a fresh heartbeat) plus a fresh self heartbeat. A
      // FRO covered by another operator (work-as) with no panel of their own is
      // absent from the field — show them offline; the covering operator carries
      // the presence.
      // Presence, decided on this worker's OWN row. `ls` is theirs by
      // construction now, so there is no covered-row branch to take and no way
      // for one person's login to overwrite another's figures.
      let status = 'offline';
      if (acting) {
        // Same rule as the FRO board: idle if there is an idle stamp OR the
        // disposition deadline has lapsed, except while paused / in a meeting.
        status = acting.status === 'on_call' ? 'on_call'
          : ((acting.idle_since || deadlinePassed(acting, now.getTime())) && !acting.is_paused && acting.status !== 'meeting')
            ? 'idle'
            : (acting.status || 'online');
      } else if (isPresent(w.id) && lsFresh) {
        // Presence is decided on this worker's OWN row and a FRESH one, so a
        // covered FRO who is actually at their desk reads as online. The old
        // `!isWorkAsRow(ls)` guard here blanked EVERY covered FRO regardless of
        // whether they were present — a person covering somebody and working
        // their own account vanished from the board, which is precisely the chain
        // case (Riya present, covering Meera) this whole change exists to support.
        // A covered-away FRO is not fresh, so it never reaches this branch and
        // stays offline.
        //
        // A paused or meeting row keeps its own status — the admin/meeting is
        // holding the FRO, so it must not read as idle on the admin board.
        //
        // No freeze check is needed here: reaching this branch means the row is
        // fresh, and a frozen (covered-away) row is by definition not fresh.
        if (ls.idle_since && !ls.is_paused && ls.status !== 'meeting') status = 'idle';
        else if (ls.is_paused) status = 'meeting';
        else status = ls.status === 'on_call' && lsFresh ? 'on_call' : 'online';
      }
      const lc = logoutCounts[String(w.id)] || { today: 0, total: 0 };

      return {
        fro_id: w.id,
        fro_name: w.name || w.login_id || 'Unknown',
        fro_login_id: w.login_id || '',
        calls: callCounts[w.id]?.month || 0,
        calls_today: callCounts[w.id]?.today || 0,
        calls_week: callCounts[w.id]?.week || 0,
        calls_range: callCounts[w.id]?.range || 0,
        connected: callCounts[w.id]?.monthConnected || 0,
        connected_today: callCounts[w.id]?.todayConnected || 0,
        connected_week: callCounts[w.id]?.weekConnected || 0,
        connected_range: callCounts[w.id]?.rangeConnected || 0,
        non_connected: callCounts[w.id]?.monthNonConnected || 0,
        non_connected_today: callCounts[w.id]?.todayNonConnected || 0,
        non_connected_week: callCounts[w.id]?.weekNonConnected || 0,
        non_connected_range: callCounts[w.id]?.rangeNonConnected || 0,
        interested: callCounts[w.id]?.monthInterested || 0,
        interested_today: callCounts[w.id]?.todayInterested || 0,
        interested_week: callCounts[w.id]?.weekInterested || 0,
        interested_range: callCounts[w.id]?.rangeInterested || 0,
        donations: callCounts[w.id]?.monthDonations || 0,
        donations_today: callCounts[w.id]?.todayDonations || 0,
        donations_week: callCounts[w.id]?.weekDonations || 0,
        donations_range: callCounts[w.id]?.rangeDonations || 0,
        receivedAmount_range: callCounts[w.id]?.rangeAmount || 0,
        connect_rate_range: (callCounts[w.id]?.range || 0) > 0 ? Math.round((callCounts[w.id]?.rangeConnected / callCounts[w.id].range) * 100) : 0,
        connectedStatuses: callCounts[w.id]?.connectedStatuses_month || {},
        connectedStatuses_today: callCounts[w.id]?.connectedStatuses_today || {},
        connectedStatuses_week: callCounts[w.id]?.connectedStatuses_week || {},
        connectedStatuses_month: callCounts[w.id]?.connectedStatuses_month || {},
        connectedStatuses_range: callCounts[w.id]?.connectedStatuses_range || {},
        notConnectedStatuses: callCounts[w.id]?.notConnectedStatuses_month || {},
        notConnectedStatuses_today: callCounts[w.id]?.notConnectedStatuses_today || {},
        notConnectedStatuses_week: callCounts[w.id]?.notConnectedStatuses_week || {},
        notConnectedStatuses_month: callCounts[w.id]?.notConnectedStatuses_month || {},
        notConnectedStatuses_range: callCounts[w.id]?.notConnectedStatuses_range || {},
        stations: froStationMap[w.id] || [],
        receivedDonors: leads,
        receivedAmount: coll,
        receivedAmount_today: bs.todayCollection[w.id] || 0,
        receivedAmount_week: bs.weekCollection[w.id] || 0,
        targetPct: targetPct,
        target_amount: targetAmt,
        target_pct: targetPct,
        status,
        work_as_operator_name: workAsLabel,
        idleMinutes: Math.floor(idleStreakSeconds / 60),
        // The IDLE column is TODAY's total. idleMinutes above is a different
        // thing — only the stretch running right now — so the two legitimately
        // disagree while somebody is working; both are shown, they answer
        // different questions.
        today_idle_seconds: coveringIdle != null ? coveringIdle : idleDisplaySeconds,
        // Whose time the figure above belongs to, when that is not the FRO. Null
        // whenever the FRO's own figures are being shown.
        idle_attributed_to: coveringIdle != null ? idleAttributedTo : null,
        // `ls` is the worker's own row, so these need no "acting" branch.
        is_paused: !!ls.is_paused,
        paused_by: ls.paused_by || null,
        // The admin card renders "Paused 12m" from paused_at. It is already
        // selected in liveCols above but was dropped here, so the duration only
        // survived a refresh for a pause this browser had just applied (via the
        // local optimistic row) and read as blank for everyone else — including
        // after a reload, or when a different admin did the pausing.
        paused_at: ls.paused_at || null,
        overdue_calls: (overdueByWorker[String(w.id)] || {}).calls || 0,
        overdue_followups: (overdueByWorker[String(w.id)] || {}).followups || 0,
        logout_today: lc.today,
        logout_total: lc.total,
        claims_pending: claims.pending,
        claims_verified: claims.verified,
        claims_rejected: claims.rejected,
        data_connected: wa.connected,
        data_total: wa.total,
        conversion_pct: conversion,
        collection_amount: coll,
        collection_amount_today: bs.todayCollection[w.id] || 0,
        collection_amount_week: bs.weekCollection[w.id] || 0,
        // COLLECTION block for the board. Non-colliding names on purpose:
        // collection_amount / today_collection above already exist here with a
        // different basis, and reusing those keys would make the board's
        // "Collected" disagree with the High/Low card for the same FRO.
        monthly_target: lb?.monthly_target ?? 0,
        collected_amount: lb?.collection_amount ?? 0,
        remaining_target: lb?.remaining_target ?? 0,
        period_target: lb?.period_target ?? 0,
        period_today: lb?.today_collection ?? 0,
        // 'auto' = derived from salary (new hire, first 3 months), 'manual' = the
        // stored fro_monthly_targets row, 'not_set' = neither.
        target_source: lb?.target_source ?? 'not_set',
        lead_done_count: leads,
      };
    });

    const topByAmount = [...performance].filter(p => p.collection_amount > 0).sort((a, b) => b.collection_amount - a.collection_amount).slice(0, 10);
    const topByDonors = [...performance].filter(p => p.lead_done_count > 0).sort((a, b) => b.lead_done_count - a.lead_done_count).slice(0, 10);
    const topByConv = [...performance].filter(p => p.data_total > 0).sort((a, b) => b.conversion_pct - a.conversion_pct).slice(0, 10);
    const bottomByTarget = [...performance].filter(p => p.target_amount > 0).sort((a, b) => a.target_pct - b.target_pct).slice(0, 10);

    // 9. Stations activity (total + currently active, respects the NGO filter)
    const tlNgoIdToName = {};
    for (const a of access) tlNgoIdToName[a.ngo_id] = a.ngo_name;
    if (req.user.ngo_id && !tlNgoIdToName[req.user.ngo_id]) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) tlNgoIdToName[req.user.ngo_id] = ngo.name;
    }
    const stationActivity = await getStationActivityByNgo(ngoIds, tlNgoIdToName, now);

// Suspense count: bank-audit entries awaiting NGO-admin resolution (all NGOs,
    // matching the admin Suspense page list so the KPI card is consistent).
    const { count: suspenseCount, error: suspenseErr } = await db
      .from('bank_audit_entries')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to_ngo_admin', true)
      .is('donor_id', null)
      .neq('status', 'verified');
    if (suspenseErr) throw suspenseErr;

    const tlPayload = {
      kpis: {
        total_fros: froWorkers.length,
        calling,
        meeting,
        idle,
        online,
        offline,
        logouts_today: Object.values(logoutCounts).reduce((s, c) => s + c.today, 0),
        logouts_total: Object.values(logoutCounts).reduce((s, c) => s + c.total, 0),
        total_calls: totalCalls,
        connected,
        not_connected: notConnected,
        unclassified,
        connect_rate: connectionRate,
        interested,
        donations,
        received_amount: receivedAmount,
        followups_due: followupsDue,
        target_pct: targetPct,
        suspenses: suspenseCount || 0,
      },
      connected_breakdown: connectedBreakdown,
      not_connected_breakdown: notConnectedBreakdown,
      range: {
        from: rangeStart.toISOString(),
        to: rangeEnd.toISOString(),
      },
      funnel,
      hourly,
      performance,  // Add full performance array for telecaller table
      collections_per_ngo,
      top_performers: {
        amount: topByAmount,
        donors: topByDonors,
        conversion: topByConv,
      },
      bottom_performers: {
        target: bottomByTarget,
      },
      stations_per_ngo: stationActivity.per_ngo,
      stations_summary: stationActivity.summary,
      // FROs sitting idle right now, worst first — drives the banner so a TL can
      // chase them. Only open idle_since counts; a stale row from a closed tab
      // has already been cleared by its last heartbeat.
      idle_alerts: performance
        .filter(p => p.status === 'idle' && !p.is_paused)
        .map(p => ({
          fro_id: p.fro_id,
          fro_name: p.fro_name,
          idle_minutes: p.idleMinutes || 0,
          idle_seconds: p.today_idle_seconds || 0,
        }))
        .sort((a, b) => b.idle_minutes - a.idle_minutes),
    };
    if (requestGeneration === tlCacheGeneration) cacheSet(tlCacheKey, tlPayload);
    return res.json(tlPayload);
  } catch (error) {
    console.error('getTLDashboard error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

// Donation Funnel
export const getDonationFunnel = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    if (ngoIds.length === 0) return res.json([]);

    const { assignments: assignedByNgo, logs: logsByNgo } = await getDonationFunnelCounts(ngoIds);

    // Iterate the requested NGO ids rather than the aggregate's rows, so an NGO
    // with no activity still reports its five zeroed stages exactly as before.
    const allFunnel = ngoIds.map((ngoId) => {
      const assignedDonorCount = assignedByNgo.get(ngoId) || 0;
      const counts = logsByNgo.get(ngoId) || { called: 0, connected: 0, interested: 0, received: 0 };
      const pct = (n) => (assignedDonorCount > 0 ? Math.round((n / assignedDonorCount) * 100) : 0);
      return {
        ngo_id: ngoId,
        stages: [
          { stage: 'Assigned', count: assignedDonorCount, pct: 100 },
          { stage: 'Called', count: counts.called, pct: pct(counts.called) },
          { stage: 'Connected', count: counts.connected, pct: pct(counts.connected) },
          { stage: 'Interested', count: counts.interested, pct: pct(counts.interested) },
          { stage: 'Received', count: counts.received, pct: pct(counts.received) },
        ],
      };
    });

    return res.json(allFunnel);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Hourly Performance
export const getHourlyPerformance = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId, date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const todayStart = new Date(targetDate); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(targetDate); todayEnd.setHours(23, 59, 59, 999);

    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    if (ngoIds.length === 0) return res.json([]);

    const connectedStatuses = new Set(['contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback']);
    const interestedStatuses = new Set(['lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending']);

    const { data: logs } = await db
      .from('fro_donor_logs')
      .select('created_at, disposition_detail, accounts_status, amount_collected, fro_assignments!inner(ngo_id)')
      .in('fro_assignments.ngo_id', ngoIds)
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString());

    const hourlyMap = {};
    for (let h = 9; h <= 20; h++) {
      const hourStr = `${String(h).padStart(2, '0')}:00-${String(h+1).padStart(2, '0')}:00`;
      hourlyMap[hourStr] = { hour: hourStr, calls: 0, connected: 0, interested: 0, donations: 0, amount: 0 };
    }

    for (const l of logs || []) {
      const hour = new Date(l.created_at).getHours();
      if (hour < 9 || hour > 20) continue;
      const hourStr = `${String(hour).padStart(2, '0')}:00-${String(hour+1).padStart(2, '0')}:00`;
      if (!hourlyMap[hourStr]) continue;
      hourlyMap[hourStr].calls++;
      if (classifyLogSide(l) === 'connected') hourlyMap[hourStr].connected++;
      if (interestedStatuses.has(l.disposition_detail)) hourlyMap[hourStr].interested++;
      if (l.accounts_status === 'verified') {
        hourlyMap[hourStr].donations++;
        hourlyMap[hourStr].amount += parseFloat(l.amount_collected || 0);
      }
    }

    return res.json(Object.values(hourlyMap));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Follow-ups
export const getFollowups = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId, bucket, date } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    if (ngoIds.length === 0) return res.json([]);

    const now = new Date();
    const istDateOf = (value) => {
      const d = new Date(value);
      if (isNaN(d.getTime())) return null;
      return new Date(d.getTime() + ((5 * 60) + 30) * 60000).toISOString().slice(0, 10);
    };
    const todayStr = istDateOf(now);
    const tomorrowStr = istDateOf(now.getTime() + 24 * 60 * 60 * 1000);
    const daywiseDate = date ? String(date).slice(0, 10) : null;

    // IST week (Mon–Sun) + month boundaries for the week/month buckets
    const istNow = new Date(now.getTime() + ((5 * 60) + 30) * 60000);
    const mondayOffset = (istNow.getUTCDay() + 6) % 7;
    const mondayStr = istDateOf(now.getTime() - mondayOffset * 24 * 60 * 60 * 1000);
    const sundayStr = istDateOf(now.getTime() + (6 - mondayOffset) * 24 * 60 * 60 * 1000);
    const monthStr = (todayStr || '').slice(0, 7);

    let query = db
      .from('fro_assignments')
      .select(`
        id, status, next_follow_up, fro_worker_id, donor_id,
        workers!fro_assignments_fro_worker_id_fkey(name, is_test),
        donor_profiles!inner(name, mobile_number)
      `)
      .in('ngo_id', ngoIds)
      .not('status', 'in', '("reassigned", "donation_collected")')
      .not('next_follow_up', 'is', null)
      .order('next_follow_up', { ascending: true });

    const { data, error } = await query;
    if (error) throw error;

    // Test FROs never appear in the admin panel — drop their pending follow-ups.
    const rows = (data || []).filter(f => f.workers?.is_test !== true);

    // Day-wise mode: return records due / scheduled for one day, tagged
    // follow_up or callback (callback = donor asked for a call-back or has an
    // incomplete scheduled contact that day). No double counting.
    if (daywiseDate) {
      const assignments = rows;
      const ids = assignments.map(a => a.id);
      const scheduleMap = {};
      if (ids.length > 0) {
        const { data: sched, error: schedErr } = await db
          .from('fro_scheduled_contacts')
          .select('assignment_id, scheduled_at')
          .in('assignment_id', ids)
          .eq('is_completed', false);
        if (schedErr) throw schedErr;
        for (const s of sched || []) {
          if (!scheduleMap[s.assignment_id]) scheduleMap[s.assignment_id] = s.scheduled_at;
        }
      }

      const callbackStatuses = new Set(['callback', 'scheduled', 'office_visit_scheduled', 'program_visit_scheduled', 'visit_donate']);
      const results = [];
      for (const f of assignments) {
        const scheduled_at = scheduleMap[f.id] || null;
        const scheduledDay = scheduled_at ? istDateOf(scheduled_at) : null;
        const assignedDay = f.next_follow_up ? String(f.next_follow_up).slice(0, 10) : null;
        if (assignedDay !== daywiseDate && scheduledDay !== daywiseDate) continue;

        const isCallback = callbackStatuses.has(f.status) || scheduledDay === daywiseDate;
        results.push({
          assignment_id: f.id,
          assignmentId: f.id,
          telecaller: f.workers?.name || 'Unknown',
          fro_worker_id: f.fro_worker_id,
          donor_name: f.donor_profiles?.name || 'Unknown',
          mobile: f.donor_profiles?.mobile_number || '',
          followup_date: f.next_follow_up,
          scheduled_at,
          status: f.status || null,
          type: isCallback ? 'callback' : 'follow_up',
        });
      }

      results.sort((a, b) => {
        if ((a.telecaller || '') !== (b.telecaller || '')) return (a.telecaller || '').localeCompare(b.telecaller || '');
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return (a.donor_name || '').localeCompare(b.donor_name || '');
      });
      return res.json(results);
    }

    // Existing bucket mode — every row gets a primary date bucket plus optional
    // week/month membership, and a callback/follow_up type (same rules as day-wise).
    const idsForBuckets = rows.map(a => a.id);
    const scheduleMap = {};
    if (idsForBuckets.length > 0) {
      const { data: sched, error: schedErr } = await db
        .from('fro_scheduled_contacts')
        .select('assignment_id, scheduled_at')
        .in('assignment_id', idsForBuckets)
        .eq('is_completed', false);
      if (schedErr) throw schedErr;
      for (const s of sched || []) {
        if (!scheduleMap[s.assignment_id]) scheduleMap[s.assignment_id] = s.scheduled_at;
      }
    }

    const monthPrefix = (d) => String(d).slice(0, 7);
    const callbackStatuses = new Set(['callback', 'scheduled', 'office_visit_scheduled', 'program_visit_scheduled', 'visit_donate']);

    const followups = rows.map(f => {
      const nd = f.next_follow_up ? String(f.next_follow_up).slice(0, 10) : null;
      const buckets = [];
      if (!nd) buckets.push('future');
      else if (nd < todayStr) buckets.push('overdue');
      else if (nd === todayStr) buckets.push('today');
      else if (nd === tomorrowStr) buckets.push('tomorrow');
      else buckets.push('future');
      if (nd && nd >= mondayStr && nd <= sundayStr) buckets.push('week');
      if (nd && monthPrefix(nd) === monthStr) buckets.push('month');

      const scheduled_at = scheduleMap[f.id] || null;
      const scheduledDay = scheduled_at ? istDateOf(scheduled_at) : null;
      const isCallback = callbackStatuses.has(f.status) || (nd && scheduledDay === nd);

      return {
        assignment_id: f.id,
        assignmentId: f.id,
        telecaller: f.workers?.name || 'Unknown',
        fro_worker_id: f.fro_worker_id,
        donor_name: f.donor_profiles?.name || 'Unknown',
        mobile: f.donor_profiles?.mobile_number || '',
        expected_amount: 0, // Would need additional query
        followup_date: f.next_follow_up,
        scheduled_at,
        status: f.status || null,
        type: isCallback ? 'callback' : 'follow_up',
        bucket: buckets[0],
        buckets,
      };
    });

    if (bucket) {
      const filtered = followups.filter(f => (f.buckets || [f.bucket]).includes(bucket));
      filtered.sort((a, b) => {
        if ((a.telecaller || '') !== (b.telecaller || '')) return (a.telecaller || '').localeCompare(b.telecaller || '');
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return (a.donor_name || '').localeCompare(b.donor_name || '');
      });
      return res.json(filtered);
    }
    return res.json(followups);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const reassignFollowup = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { new_fro_worker_id, new_followup_date } = req.body;
    
    const ngoIds = await getUserNgoIds(req.user);
    const { data: existing } = await db.from('fro_assignments').select('ngo_id').eq('id', assignmentId).maybeSingle();
    if (!existing || !ngoIds.includes(existing.ngo_id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const updates = {};
    if (new_fro_worker_id) updates.fro_worker_id = new_fro_worker_id;
    if (new_followup_date) updates.next_follow_up = new_followup_date;
    
    const { error } = await db.from('fro_assignments').update(updates).eq('id', assignmentId);
    if (error) throw error;

    // Moving an assignment to a different FRO changes the per-FRO donor counts the
    // stations screen shows, even though the station totals do not move.
    if (updates.fro_worker_id) bustStationCache();

    return res.json({ message: 'Follow-up reassigned successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateFollowupDate = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { followup_date } = req.body;
    
    const ngoIds = await getUserNgoIds(req.user);
    const { data: existing } = await db.from('fro_assignments').select('ngo_id').eq('id', assignmentId).maybeSingle();
    if (!existing || !ngoIds.includes(existing.ngo_id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { error } = await db.from('fro_assignments').update({ next_follow_up: followup_date }).eq('id', assignmentId);
    if (error) throw error;

    return res.json({ message: 'Follow-up date updated' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Nudge an FRO who is sitting idle. Bell + realtime + FCM so it lands on the
// phone too — the whole point is they are away from the desk.
export const notifyFroHandler = async (req, res) => {
  try {
    const { workerId, message } = req.body;
    if (!workerId) return res.status(400).json({ message: 'workerId is required' });
    const { data: worker } = await db
      .from('workers')
      .select('id, name, ngo_id')
      .eq('id', workerId)
      .maybeSingle();
    if (!worker) return res.status(404).json({ message: 'FRO not found' });
    // Scope to the admin's NGO(s) — an ngo_admin must not be able to push alerts
    // to FROs outside their own NGO just by guessing a worker UUID.
    const adminNgoIds = await getUserNgoIds(req.user);
    if (!adminNgoIds.some((ngoId) => String(worker.ngo_id) === String(ngoId))) {
      return res.status(403).json({ message: 'Worker not in your NGO(s)' });
    }

    const name = worker.name || 'Telecaller';
    const alertBody = (typeof message === 'string' && message.trim())
      ? message.trim()
      : `${name}, your disposition timer ran out. Please resume your work.`;
    try {
      const { notifyWorker } = await import('../services/fcmService.js');
      await notifyWorker(
        workerId,
        'You are idle',
        alertBody,
        'idle_alert',
        String(workerId)
      );
    } catch (pushErr) {
      // Push is best-effort — the socket notification below is the guaranteed path.
      console.warn('idle alert push failed:', pushErr.message);
    }
    emitRealtime('fro:action', {
      type: 'idle_alert',
      title: 'You are idle',
      body: alertBody,
      sent_at: new Date().toISOString(),
    }, `worker:${workerId}`);
    return res.json({ message: `Idle alert sent to ${name}` });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Pause/resume must work for an FRO who has never opened the CRM panel, i.e.
// who has no fro_live_status row yet. A bare upsert INSERTs a partial row for
// those people, which can fail outright on a NOT NULL column — and when it
// didn't fail it left a half-built row behind. That is the "pause sometimes
// works" report: it only ever worked for FROs who already had a live row.
// Update the existing row; create one only when genuinely missing, and then
// with every presence column given a safe default so the insert is always
// valid. status 'offline' keeps a row we invented out of the "online" counts.
const setFroPaused = async (workerId, paused, by = null) => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const patch = {
    is_paused: !!paused,
    paused_at: paused ? nowIso : null,
    paused_by: paused ? by : null,
    updated_at: nowIso,
  };

  // Freeze bookkeeping, mirroring the heartbeat. Pausing marks the freeze start;
  // resuming re-arms the deadline if it lapsed while the pause held it, so the
  // held stretch is never read back as idle. An existing frozen_at is preserved
  // both ways — a pause during a meeting must not slide the freeze forward, and
  // the value keeps capping any idle that began before the freeze.
  let existing = null;
  try {
    const { data } = await db
      .from('fro_live_status')
      .select('frozen_at, disposition_due_at')
      .eq('worker_id', workerId)
      .maybeSingle();
    existing = data || null;
  } catch (_) {
    // Non-fatal: without the read we simply keep the plain pause patch.
  }
  if (paused) {
    if (!existing?.frozen_at) patch.frozen_at = nowIso;
  } else {
    const dueMs = dispositionDueMs(existing || {});
    if (Number.isFinite(dueMs) && nowMs >= dueMs) {
      try {
        const shift = await getShiftWindowMs(workerId, nowMs);
        const nd = nextDeadline(shift, nowMs);
        if (nd) patch.disposition_due_at = nd;
      } catch (_) { /* non-fatal: leave the deadline as it was */ }
    }
  }

  const { data, error } = await db
    .from('fro_live_status')
    .update(patch)
    .eq('worker_id', workerId)
    .select('worker_id');
  if (error) throw error;
  if (data && data.length > 0) return;

  const { error: insErr } = await db.from('fro_live_status').insert({
    worker_id: workerId,
    status: 'offline',
    today_calls: 0,
    today_talk_seconds: 0,
    ...patch,
  });
  if (insErr) throw insErr;
};

/** POST /ngo-admin/fro/:id/pause
 *  Freeze an FRO's panel like meeting mode: all their timers stop and a
 *  blocking popup appears that only an admin resume can lift. Scoped to the
 *  admin's NGO(s). The panel learns it via the targeted fro:pause socket
 *  event (worker room) or on next hydrate via is_paused.
 */
export const pauseFro = async (req, res) => {
  try {
    const froId = req.params.id;
    if (!froId) return res.status(400).json({ message: 'FRO id is required' });

    const adminNgoIds = await getUserNgoIds(req.user);
    const { data: worker } = await db
      .from('workers')
      .select('id, name, login_id, is_active, ngo_id')
      .eq('id', froId)
      .single();
    if (!worker) return res.status(404).json({ message: 'Worker not found' });
    if (worker.is_test === true) return res.status(403).json({ message: 'Cannot pause test worker' });
    if (!adminNgoIds.some((ngoId) => String(worker.ngo_id) === String(ngoId))) {
      return res.status(403).json({ message: 'Worker not in your NGO(s)' });
    }
    if (worker.is_active === false) return res.status(403).json({ message: 'Cannot pause inactive worker' });

    const by = req.user.name || req.user.email || 'Admin';
    const nowIso = new Date().toISOString();
    await setFroPaused(froId, true, by);
    bustTlCache();
    emitRealtime('fro:pause', { at: nowIso, by }, `worker:${froId}`);
    return res.json({ message: 'FRO paused', paused: true });
  } catch (error) {
    console.error('pauseFro error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

/** POST /ngo-admin/fro/:id/resume — lift an admin pause (the "play" button). */
export const resumeFro = async (req, res) => {
  try {
    const froId = req.params.id;
    if (!froId) return res.status(400).json({ message: 'FRO id is required' });

    const adminNgoIds = await getUserNgoIds(req.user);
    const { data: worker } = await db
      .from('workers')
      .select('id, name, login_id, is_active, ngo_id')
      .eq('id', froId)
      .single();
    if (!worker) return res.status(404).json({ message: 'Worker not found' });
    if (!adminNgoIds.some((ngoId) => String(worker.ngo_id) === String(ngoId))) {
      return res.status(403).json({ message: 'Worker not in your NGO(s)' });
    }

    const nowIso = new Date().toISOString();
    await setFroPaused(froId, false);
    bustTlCache();
    emitRealtime('fro:resume', { at: nowIso }, `worker:${froId}`);
    return res.json({ message: 'FRO resumed', paused: false });
  } catch (error) {
    console.error('resumeFro error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

// Top/Bottom Performers
export const getTopPerformers = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) {
        ngoNames.splice(0, ngoNames.length, ngoNames[idx]);
        ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
      }
    }

    if (ngoIds.length === 0) return res.json({ amount: [], donors: [], conversion: [] });

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });
    const workerIds = froWorkers.map(w => w.id);

    const monthStr = new Date().toISOString().slice(0, 7) + '-01';
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const batchStats = await getBatchCollectionStats(workerIds, monthStart, monthEnd, todayStart.toISOString(), todayEnd.toISOString(), ngoIds);
    
    const { data: faRows } = await db
      .from('fro_assignments')
      .select('status, fro_worker_id')
      .in('ngo_id', ngoIds)
      .neq('status', 'reassigned');

    const connectedStatuses = new Set(['contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback']);
    const workerAssignments = {};
    for (const a of faRows || []) {
      if (!workerAssignments[a.fro_worker_id]) workerAssignments[a.fro_worker_id] = { connected: 0, total: 0 };
      workerAssignments[a.fro_worker_id].total++;
      if (connectedStatuses.has(a.status)) workerAssignments[a.fro_worker_id].connected++;
    }

    const { data: targets } = await db.from('fro_targets').select('fro_worker_id, target_amount, achieved_target').in('ngo_id', ngoIds).eq('month', monthStr);

    const performance = froWorkers.map(w => {
      const bs = batchStats;
      const coll = bs.monthCollection[w.id] || 0;
      const leads = bs.monthCollection[w.id] ? (bs.verifiedMonth[w.id]?.count || 0) + (bs.unverifiedMonth[w.id]?.count || 0) : 0;
      const wa = workerAssignments[w.id] || { connected: 0, total: 0 };
      const conversion = wa.total > 0 ? Math.round((wa.connected / wa.total) * 1000) / 10 : 0;
      const target = (targets || []).find(t => t.fro_worker_id === w.id);
      const targetAmt = target ? parseFloat(target.target_amount) : 0;
      const achievedAmt = target ? parseFloat(target.achieved_target || 0) : coll;
      const targetPct = targetAmt > 0 ? Math.round((achievedAmt / targetAmt) * 100) : 0;
      
      return {
        fro_id: w.id,
        fro_name: w.name || w.login_id || 'Unknown',
        collection_amount: coll,
        lead_done_count: leads,
        data_connected: wa.connected,
        data_total: wa.total,
        conversion_pct: conversion,
        target_amount: targetAmt,
        target_pct: targetPct,
      };
    }).filter(p => p.collection_amount > 0 || p.lead_done_count > 0 || p.data_total > 0);

    const topByAmount = [...performance].filter(p => p.collection_amount > 0).sort((a, b) => b.collection_amount - a.collection_amount).slice(0, 10);
    const topByDonors = [...performance].filter(p => p.lead_done_count > 0).sort((a, b) => b.lead_done_count - a.lead_done_count).slice(0, 10);
    const topByConv = [...performance].filter(p => p.data_total > 0).sort((a, b) => b.conversion_pct - a.conversion_pct).slice(0, 10);

    return res.json({
      amount: topByAmount,
      donors: topByDonors,
      conversion: topByConv,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBottomPerformers = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoIds.length === 0 && req.user.ngo_id) {
      ngoIds.push(req.user.ngo_id);
    }

    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) ngoIds.splice(0, ngoIds.length, ngoIds[idx]);
    }

    if (ngoIds.length === 0) return res.json({ target: [] });

    const allWorkers = (await Promise.all(ngoIds.map(ngoId => getFroWorkersByNgo(ngoId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers.filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; });
    const workerIds = froWorkers.map(w => w.id);

    const monthStr = new Date().toISOString().slice(0, 7) + '-01';
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const batchStats = await getBatchCollectionStats(workerIds, monthStart, monthEnd, todayStart.toISOString(), todayEnd.toISOString(), ngoIds);
    
    const { data: faRows } = await db
      .from('fro_assignments')
      .select('status, fro_worker_id')
      .in('ngo_id', ngoIds)
      .neq('status', 'reassigned');

    const connectedStatuses = new Set(['contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback']);
    const workerAssignments = {};
    for (const a of faRows || []) {
      if (!workerAssignments[a.fro_worker_id]) workerAssignments[a.fro_worker_id] = { connected: 0, total: 0 };
      workerAssignments[a.fro_worker_id].total++;
      if (connectedStatuses.has(a.status)) workerAssignments[a.fro_worker_id].connected++;
    }

    const { data: targets } = await db.from('fro_targets').select('fro_worker_id, target_amount, achieved_target').in('ngo_id', ngoIds).eq('month', monthStr);

    const performance = froWorkers.map(w => {
      const bs = batchStats;
      const coll = bs.monthCollection[w.id] || 0;
      const wa = workerAssignments[w.id] || { connected: 0, total: 0 };
      const target = (targets || []).find(t => t.fro_worker_id === w.id);
      const targetAmt = target ? parseFloat(target.target_amount) : 0;
      const achievedAmt = target ? parseFloat(target.achieved_target || 0) : coll;
      const targetPct = targetAmt > 0 ? Math.round((achievedAmt / targetAmt) * 100) : 0;
      
      return {
        fro_id: w.id,
        fro_name: w.name || w.login_id || 'Unknown',
        collection_amount: coll,
        target_amount: targetAmt,
        target_pct: targetPct,
      };
    }).filter(p => p.target_amount > 0);

    const bottomByTarget = [...performance].sort((a, b) => a.target_pct - b.target_pct).slice(0, 10);

    return res.json({ target: bottomByTarget });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Assigned Data - Station Performance
export const getAssignedData = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    const ngoNames = access.map(a => a.ngo_name).filter(Boolean);
    const ngoIds = access.map(a => a.ngo_id).filter(Boolean);

    if (ngoNames.length === 0 && req.user.ngo_id) {
      const { data: ngo } = await db.from('ngos').select('name').eq('id', req.user.ngo_id).single();
      if (ngo) { ngoNames.push(ngo.name); ngoIds.push(req.user.ngo_id); }
    }

    const { ngo_id: filterNgoId, period, from, to } = req.query;
    let targetNgoIds = filterNgoId && filterNgoId !== 'all' ? [filterNgoId] : ngoIds;
    if (targetNgoIds.length === 0) return res.json({ summary: {}, stations: [] });

    const now = new Date();
    let startDate, endDate;
    if (period === 'today') {
      startDate = new Date(); startDate.setHours(0, 0, 0, 0);
      endDate = new Date(); endDate.setHours(23, 59, 59, 999);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (from && to) {
      startDate = new Date(from);
      endDate = new Date(to);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();

    // Get station stats with dispositions
    const { data: stationStats } = await db.rpc('get_station_disposition_stats', {
      p_ngo_id: targetNgoIds[0],
      p_from: startISO,
      p_to: endISO,
    });

    // Get station assignments for FRO/NGO info
    const { data: stationAssigns } = await db
      .from('fro_station_assignments')
      .select('station, ngo_id, fro_worker_id, workers!left(name)')
      .in('ngo_id', targetNgoIds);

    // Get NGO names
    const { data: ngos } = await db.from('ngos').select('id, name').in('id', targetNgoIds);
    const ngoMap = Object.fromEntries((ngos || []).map(n => [n.id, n.name]));

    // Get donor counts per station
    const { data: donorCounts } = await db
      .from('fro_assignments')
      .select('donor_id, station, ngo_id, fro_worker_id')
      .in('ngo_id', targetNgoIds)
      .not('station', 'is', null)
      .not('status', 'eq', 'reassigned');

    const connectedStatuses = new Set(['contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback']);
    const nonConnectedStatuses = new Set(['busy', 'ringing', 'call_waiting', 'unreachable', 'switched_off', 'out_of_coverage', 'wrong_number', 'invalid', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail']);
    const leadDoneStatuses = new Set(['donation_collected', 'lead_done', 'done']);

    const stationMap = {};
    for (const row of stationStats || []) {
      const station = row.station || 'Unassigned';
      if (!stationMap[station]) {
        stationMap[station] = { station, donors: 0, connected: 0, non_connected: 0, lead_done: 0, ngos: [], fro_name: null };
      }
      const status = row.status;
      const count = parseInt(row.count, 10);
      stationMap[station].donors += count;
      if (connectedStatuses.has(status)) stationMap[station].connected += count;
      if (nonConnectedStatuses.has(status)) stationMap[station].non_connected += count;
      if (leadDoneStatuses.has(status)) stationMap[station].lead_done += count;
    }

    // Add NGO and FRO info
    for (const sa of stationAssigns || []) {
      if (stationMap[sa.station]) {
        if (!stationMap[sa.station].ngos.includes(sa.ngo_id)) {
          stationMap[sa.station].ngos.push(sa.ngo_id);
        }
        if (sa.fro_worker_id && !stationMap[sa.station].fro_name) {
          stationMap[sa.station].fro_name = sa.workers?.name || 'Unknown';
        }
      }
    }

    // Add stations that only exist in assignments but not in stats
    for (const dc of donorCounts || []) {
      if (!stationMap[dc.station]) {
        stationMap[dc.station] = { station: dc.station, donors: 0, connected: 0, non_connected: 0, lead_done: 0, ngos: [], fro_name: null };
      }
      if (!stationMap[dc.station].ngos.includes(dc.ngo_id)) {
        stationMap[dc.station].ngos.push(dc.ngo_id);
      }
    }

    const result = Object.values(stationMap).map(s => ({
      station: s.station,
      donors: s.donors,
      connected: s.connected,
      non_connected: s.non_connected,
      lead_done: s.lead_done,
      ngos: s.ngos.map(id => ({ id, name: ngoMap[id] })),
      fro_name: s.fro_name,
    }));

    // Summary
    const summary = {
      total_stations: result.length,
      total_donors: result.reduce((sum, s) => sum + s.donors, 0),
      total_connected: result.reduce((sum, s) => sum + s.connected, 0),
      total_non_connected: result.reduce((sum, s) => sum + s.non_connected, 0),
      total_lead_done: result.reduce((sum, s) => sum + s.lead_done, 0),
    };

    return res.json({ summary, stations: result });
  } catch (error) {
    console.error('getAssignedData error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

// Restore wrong cross-FRO assignments: find fro_assignments where station IS NULL
// and the donor has another assignment with station IS NOT NULL for the same ngo_id.
export const restoreWrongAssignments = async (req, res) => {
  try {
    // Find all assignments with station NULL (manually created, potentially wrong)
    const { data: nullStationAsns } = await db
      .from('fro_assignments')
      .select('id, donor_id, fro_worker_id, ngo_id, station, status')
      .is('station', null)
      .not('status', 'eq', 'reassigned');

    if (!nullStationAsns || nullStationAsns.length === 0) {
      return res.json({ restored: 0, details: [] });
    }

    const details = [];
    let restoredCount = 0;

    for (const asn of nullStationAsns) {
      // Check if this donor has another assignment with station for the same ngo_id
      const { data: correctAsns } = await db
        .from('fro_assignments')
        .select('id, fro_worker_id, station')
        .eq('donor_id', asn.donor_id)
        .eq('ngo_id', asn.ngo_id)
        .not('id', 'eq', asn.id)
        .not('status', 'eq', 'reassigned')
        .not('station', 'is', null);

      if (correctAsns && correctAsns.length > 0) {
        // This is a wrong assignment — delete it and its fro_donor_logs
        const { data: logs } = await db
          .from('fro_donor_logs')
          .select('id, amount_collected')
          .eq('assignment_id', asn.id);

        // Delete fro_donor_logs first
        if (logs && logs.length > 0) {
          await db.from('fro_donor_logs').delete().eq('assignment_id', asn.id);
        }

        // Delete the wrong assignment
        await db.from('fro_assignments').delete().eq('id', asn.id);

        restoredCount++;
        details.push({
          assignment_id: asn.id,
          donor_id: asn.donor_id,
          fro_worker_id: asn.fro_worker_id,
          ngo_id: asn.ngo_id,
          logs_deleted: logs?.length || 0,
          correct_assignment_id: correctAsns[0]?.id,
        });
      }
    }

    // Wrong assignments were deleted above, so the station they belonged to just
    // lost donors.
    if (restoredCount > 0) bustStationCache();
    return res.json({ restored: restoredCount, details });
  } catch (error) {
    console.error('restoreWrongAssignments error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

// FRO-level Hourly Performance (IST working window 09:00-21:00)
export const getFroHourlyPerformance = async (req, res) => {
  try {
    const { ngo_id, from, to } = req.query;
    const ngoIds = await getUserNgoIds(req.user);
    const effectiveNgoId = ngo_id || (ngoIds.length === 1 ? ngoIds[0] : null);

    // All boundaries and hour buckets are computed in IST (UTC+5:30)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const istDayStart = (day) => new Date(`${day}T00:00:00.000+05:30`).toISOString();
    const istDayEnd = (day) => new Date(`${day}T23:59:59.999+05:30`).toISOString();
    const istHourOf = (iso) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).getUTCHours();

    const fromDay = (from && !from.includes('T')) ? from : istToday();
    const toDay = (to && !to.includes('T')) ? to : istToday();
    const fromDate = (from && from.includes('T')) ? from : istDayStart(fromDay);
    const toDate = (to && to.includes('T')) ? to : istDayEnd(toDay);

    let logQuery = db
      .from('fro_donor_logs')
      .select('created_at, disposition_detail, disposition_category, accounts_status, amount_collected, fro_worker_id, fro_assignments!inner(ngo_id), workers!fro_donor_logs_fro_worker_id_fkey(id, name, login_id, is_test)')
      .gte('created_at', fromDate)
      .lte('created_at', toDate);

    if (effectiveNgoId) {
      logQuery = logQuery.eq('fro_assignments.ngo_id', effectiveNgoId);
    } else if (ngoIds.length > 0) {
      logQuery = logQuery.in('fro_assignments.ngo_id', ngoIds);
    }

    const { data: logs, error } = await logQuery;
    if (error) throw error;

    const interestedStatuses = new Set(['lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending']);
    const statusKeyOf = (detail) => mergedGroupOf(detail) || detail;

    // Build FRO-hourly map
    const froHourlyMap = {};
    for (const l of logs || []) {
      const wid = l.fro_worker_id;
      if (!wid) continue;
      if (l.workers?.is_test === true) continue; // never show test workers
      const wname = l.workers?.name || 'Unknown';
      const wlogin = l.workers?.login_id || '';
      const hour = istHourOf(l.created_at);
      if (hour < 9 || hour > 20) continue;
      const hourStr = `${String(hour).padStart(2, '0')}:00-${String(hour+1).padStart(2, '0')}:00`;

      const key = `${wid}|${hourStr}`;
      if (!froHourlyMap[key]) {
        froHourlyMap[key] = {
          fro_worker_id: wid,
          fro_name: wname,
          fro_login_id: wlogin,
          hour: hourStr,
          calls: 0,
          connected: 0,
          non_connected: 0,
          interested: 0,
          donations: 0,
          amount: 0,
          connected_statuses: {},
          non_connected_statuses: {},
        };
      }
      const entry = froHourlyMap[key];
      entry.calls++;
      const side = classifyLogSide(l);
      if (side === 'connected') {
        entry.connected++;
        const sk = statusKeyOf(l.disposition_detail);
        entry.connected_statuses[sk] = (entry.connected_statuses[sk] || 0) + 1;
      } else if (side === 'not_connected') {
        entry.non_connected++;
        const sk = statusKeyOf(l.disposition_detail);
        entry.non_connected_statuses[sk] = (entry.non_connected_statuses[sk] || 0) + 1;
      }
      if (interestedStatuses.has(l.disposition_detail)) entry.interested++;
      if (l.accounts_status === 'verified') {
        entry.donations++;
        entry.amount += parseFloat(l.amount_collected || 0);
      }
    }

    // Ensure all active FROs are represented across working hours
    const targetNgos = effectiveNgoId ? [effectiveNgoId] : ngoIds;
    const allWorkers = (await Promise.all(targetNgos.map(nId => getFroWorkersByNgo(nId)))).flat();
    const seen = new Set();
    const froWorkers = allWorkers
      .filter(w => { const k = w.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .filter(w => w.is_active !== false);

    const allHours = Array.from({ length: 12 }, (_, i) => 
      `${String(9+i).padStart(2, '0')}:00-${String(10+i).padStart(2, '0')}:00`
    );

    for (const w of froWorkers) {
      for (const h of allHours) {
        const key = `${w.id}|${h}`;
        if (!froHourlyMap[key]) {
          froHourlyMap[key] = {
            fro_worker_id: w.id,
            fro_name: w.name || w.login_id || 'Unknown',
            fro_login_id: w.login_id || '',
            hour: h,
            calls: 0,
            connected: 0,
            non_connected: 0,
            interested: 0,
            donations: 0,
            amount: 0,
            connected_statuses: {},
            non_connected_statuses: {},
          };
        }
      }
    }

    const result = Object.values(froHourlyMap)
      .sort((a, b) => {
        if (a.fro_name !== b.fro_name) return a.fro_name.localeCompare(b.fro_name);
        return a.hour.localeCompare(b.hour);
      });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// STATION-WISE COLLECTION
//
// Answers "which station brings in the most money", which nothing on the
// dashboard could answer before. The Collection card splits only by NGO, and
// the station_performance view counts DONORS, not rupees.
//
// WHY receipts, NOT amount_collected on fro_donor_logs. Those are different
// numbers: amount_collected is what an FRO logged at the moment of asking for
// money, receipts.amount is what was actually received. The existing TL
// dashboard already reports revenue from receipts so that it ties out with the
// Accounts panel, and this card follows the same convention deliberately rather
// than disagreeing with the total shown directly above it. The join and the
// IST date boundaries are copied from getTLDashboard's collections_per_ngo for
// the same reason.
//
// WHY THE STATION COMES VIA THE ASSIGNMENT rather than receipts.station. A
// receipt's own station column is written at receipt time and can hold a
// pre-rename code ("M-2", "ND-1") or nothing at all, whereas the assignment
// row is what the bulk station rename rewrote. Following the receipt back
// through fro_donor_logs to fro_assignments therefore resolves current codes
// for history that receipts.station cannot.
//
// Receipts that resolve to a legacy or unrecognised station code ("M-2",
// "ND-1", "Ajay 16", "AJ") are reported as `other`; receipts whose assignment
// carries no station at all are reported as `unattributed`. Both stay in
// `total`, because the set of rows this query returns is identical to the one
// behind the Collection card, so excluding either bucket would make the two
// cards report different money. Neither is a station, so the client keeps them
// out of the station ranking and shows them as labelled rows at the foot.
//
// Query params:
//   ngo_id  - a specific NGO, or 'all' (default) for every NGO the caller may see
//   month   - 'YYYY-MM'; defaults to the current IST month
// ---------------------------------------------------------------------------

// The six station families the dashboard groups by. Anything outside these is
// surfaced as `other` instead of being folded into a family it isn't part of.
const STATION_FAMILIES = ['BOD', 'AOD', 'MOD', 'BFD', 'AFD', 'MFD'];

const stationFamilyOf = (code) => {
  const prefix = String(code || '').trim().split('-')[0].toUpperCase();
  return STATION_FAMILIES.includes(prefix) ? prefix : null;
};

// 'YYYY-MM' -> the first and last calendar day of that month, so the caller
// can pass the IST date boundaries the receipts query needs.
function monthBounds(monthParam) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthParam || '').trim());
  const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  let year, mon;
  if (m) {
    year = Number(m[1]);
    mon = Number(m[2]);
    if (mon < 1 || mon > 12) return null;
  } else {
    year = nowIst.getFullYear();
    mon = nowIst.getMonth() + 1;
  }
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(mon)}-01`,
    to: `${year}-${pad(mon)}-${pad(lastDay)}`,
    month: `${year}-${pad(mon)}`,
  };
}

export const getStationWiseCollection = async (req, res) => {
  try {
    const access = await getUserNgoAccess(req.user.id, req.user.role);
    let ngoIds = access.map(a => a.ngo_id).filter(Boolean);
    if (ngoIds.length === 0 && req.user.ngo_id) ngoIds = [req.user.ngo_id];

    // Same scoping rule as every other ngo-admin endpoint: a caller may narrow
    // to one NGO, but only to one they already have access to.
    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const idx = ngoIds.findIndex(id => String(id) === String(filterNgoId));
      if (idx !== -1) { ngoIds.splice(0, ngoIds.length, ngoIds[idx]); }
    }

    if (ngoIds.length === 0) {
      return res.json({ month: monthBounds(req.query.month)?.month || null, from: null, to: null, stations: [], other: { amount: 0, count: 0 }, unattributed: { amount: 0, count: 0 }, total: 0 });
    }

    const bounds = monthBounds(req.query.month);
    if (!bounds) return res.status(400).json({ message: 'month must be YYYY-MM' });

    // Identical shape to getTLDashboard's collections_per_ngo, with the GROUP BY
    // moved from fa.ngo_id to fa.station. receipt_date is a timestamptz, so the
    // boundaries are converted from IST calendar days exactly as there.
    const rows = await sql(
      `SELECT fa.station AS station,
              COALESCE(SUM(r.amount), 0) AS total,
              COUNT(*)::int AS receipts
         FROM receipts r
         LEFT JOIN fro_donor_logs l ON l.id = r.log_id
         LEFT JOIN fro_assignments fa ON fa.id = l.assignment_id
        WHERE r.receipt_date >= ($1::date AT TIME ZONE 'Asia/Kolkata')
          AND r.receipt_date <  (($2::date + 1) AT TIME ZONE 'Asia/Kolkata')
          AND fa.ngo_id = ANY($3)
        GROUP BY fa.station`,
      [bounds.from, bounds.to, ngoIds]
    );

    const stations = [];
    let otherAmount = 0;
    let otherCount = 0;
    let unattributedAmount = 0;
    let unattributedCount = 0;
    for (const row of rows) {
      const amount = Math.round(parseFloat(row.total || 0));
      const count = Number(row.receipts || 0);
      if (row.station == null) {
        // The assignment resolved (the WHERE already guarantees fa.ngo_id) but
        // carries no station, so the receipt cannot be credited to one. Kept in
        // the total because the Collection card counts it too.
        unattributedAmount += amount;
        unattributedCount += count;
      } else if (stationFamilyOf(row.station)) {
        // Guard against a duplicated station code folding to two rows: the GROUP
        // BY already does that, so this is just a safe accumulate.
        const existing = stations.find(s => s.station === row.station);
        if (existing) { existing.amount += amount; existing.receipts += count; }
        else stations.push({ station: String(row.station), family: stationFamilyOf(row.station), amount, receipts: count });
      } else {
        // A real station value that is a pre-rename or legacy code ("M-2",
        // "ND-1", "Ajay 16"). Money is genuinely attributed, so it stays in the
        // reconciled total and shows under Other.
        otherAmount += amount;
        otherCount += count;
      }
    }

    stations.sort((a, b) => b.amount - a.amount || a.station.localeCompare(b.station));

    // stations + other + unattributed, i.e. EVERY row the query above returns.
    // That set is identical to getTLDashboard's collections_per_ngo set, so this
    // total ties out with the Collection card directly above it. Verified against
    // production: excluding `unattributed` showed a shortfall equal to it exactly.
    const total = stations.reduce((s, r) => s + r.amount, 0) + otherAmount + unattributedAmount;

    return res.json({
      month: bounds.month,
      from: bounds.from,
      to: bounds.to,
      stations,
      other: { amount: otherAmount, count: otherCount },
      unattributed: { amount: unattributedAmount, count: unattributedCount },
      total,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// TEAM-WISE COLLECTION (admin)
//
// Scoping and access only - the board itself is built by
// services/teamCollectionService.js, which the FRO panel's Collection Race popup
// calls too. Two panels render this board, so they share one query rather than
// each carrying a copy; otherwise the same leaderboard would eventually quote two
// different totals on two screens.
//
// Same scoping rule as getStationWiseCollection (narrow to one NGO you already
// have), except an explicitly-requested NGO you do NOT have access to is refused
// instead of silently falling back to everything you can see - that fallback would
// answer "show me BSCT" with every NGO's numbers.
// ---------------------------------------------------------------------------

export const getTeamWiseCollection = async (req, res) => {
  try {
    const range = resolveRange({ from: req.query.from, to: req.query.to, strict: true });
    if (!range) return res.status(400).json({ message: 'from and to are required as YYYY-MM-DD' });

    let ngoIds = await getUserNgoIds(req.user);
    const { ngo_id: filterNgoId } = req.query;
    if (filterNgoId && filterNgoId !== 'all') {
      const match = ngoIds.find(id => String(id) === String(filterNgoId));
      if (!match) return res.status(403).json({ message: 'No access to that NGO' });
      ngoIds = [match];
    }

    return res.json(await buildTeamCollection({
      from: range.from,
      to: range.to,
      ngoIds,
      froId: req.query.fro_id,
    }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// BULK STATION RENAME
//
// Rewrites a station code in place across every table that stores it, scoped
// per NGO so one old code can become different new codes per NGO (e.g.
// M-2 -> BOD-1 / AOD-1 / MOD-1). Rows are only relabelled — donors stay
// assigned to the same FRO, NGO and status; nothing is moved or deleted.
// Old codes are erased everywhere and the mapping is preserved in
// station_rename_log.
//
// Body: { renames: [{ ngo_name, old_station, new_station }], dry_run, confirm }
//   dry_run (default true)  -> validate + per-table affected counts, no writes
//   dry_run false + confirm -> apply everything inside ONE transaction with a
//                              post-verify (any leftover old code rolls back)
//
// donor_profiles rows whose old code is shared across multiple NGOs (NGO
// attribution is ambiguous there) are skipped and reported — their
// fro_assignments are still renamed correctly per NGO.
// ---------------------------------------------------------------------------

let _renameLogTableReady = false;
async function ensureStationRenameLogTable() {
  if (_renameLogTableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS station_rename_log (
      id             bigserial PRIMARY KEY,
      ngo_id         uuid,
      ngo_name       text,
      old_station    text NOT NULL,
      new_station    text NOT NULL,
      counts         jsonb NOT NULL DEFAULT '{}',
      skipped_donors integer NOT NULL DEFAULT 0,
      performed_by   text,
      performed_at   timestamptz NOT NULL DEFAULT now(),
      batch_id       uuid
    )`);
  // Self-heal installs created before batch_id existed (e.g. production).
  await sql(`ALTER TABLE station_rename_log ADD COLUMN IF NOT EXISTS batch_id uuid`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_station_rename_log_ngo_time ON station_rename_log(ngo_id, performed_at DESC)`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_station_rename_log_old_station ON station_rename_log(old_station)`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_station_rename_log_batch ON station_rename_log(batch_id)`);
  _renameLogTableReady = true;
}

// Per-table affected-row counts for all valid rows in one query each, via
// unnest arrays: (ord, ngo_id, old_station).
async function countRenameImpact(okRows) {
  if (okRows.length === 0) return new Map();
  const ords = okRows.map((_, i) => i);
  const ngoIds = okRows.map(r => r.ngo_id);
  const olds = okRows.map(r => r.old_station);
  const params = [ords, ngoIds, olds];
  // ngo_id columns are NOT uniform across these tables (some uuid, some text —
  // they predate the tracked migrations), so compare as text everywhere.
  const unnest = 'unnest($1::int[], $2::text[], $3::text[]) AS t(ord, ngo_id, station)';

  const [reg, assign, transfer, queue, sessions] = await Promise.all([
    sql(`SELECT t.ord, COUNT(x.id)::int AS cnt FROM ${unnest}
         LEFT JOIN fro_station_assignments x ON x.ngo_id::text = t.ngo_id AND x.station = t.station
         GROUP BY t.ord`, params),
    sql(`SELECT t.ord, COUNT(x.id)::int AS cnt FROM ${unnest}
         LEFT JOIN fro_assignments x ON x.ngo_id::text = t.ngo_id AND x.station = t.station
         GROUP BY t.ord`, params),
    sql(`SELECT t.ord, COUNT(x.id)::int AS cnt FROM ${unnest}
         LEFT JOIN fro_transfers x ON x.ngo_id::text = t.ngo_id AND (x.station = t.station OR x.target_station = t.station)
         GROUP BY t.ord`, params),
    sql(`SELECT t.ord, COUNT(x.id)::int AS cnt FROM ${unnest}
         LEFT JOIN work_queue x ON x.ngo_id::text = t.ngo_id AND x.station = t.station
         GROUP BY t.ord`, params),
    sql(`SELECT t.ord, COUNT(x.id)::int AS cnt FROM ${unnest}
         LEFT JOIN work_as_sessions x
           ON x.stations @> jsonb_build_array(jsonb_build_object('ngo_id', t.ngo_id, 'station', t.station))
         GROUP BY t.ord`, params),
  ]);

  const byOrd = (list) => {
    const m = new Map();
    for (const r of list) m.set(r.ord, r.cnt);
    return m;
  };
  const regM = byOrd(reg), assignM = byOrd(assign), transferM = byOrd(transfer);
  const queueM = byOrd(queue), sessM = byOrd(sessions);

  const counts = new Map();
  okRows.forEach((r, i) => {
    counts.set(i, {
      fro_station_assignments: regM.get(i) || 0,
      fro_assignments: assignM.get(i) || 0,
      fro_transfers: transferM.get(i) || 0,
      work_queue: queueM.get(i) || 0,
      work_as_sessions: sessM.get(i) || 0,
    });
  });
  return counts;
}

// Donor-profile classification per DISTINCT old station code, computed BEFORE
// the assignments are renamed (the NGO attribution comes from fro_assignments
// rows that still carry the old code). Returns:
//   Map<oldStation, [{ id, name, ngos: string[] | null }]>
async function classifyDonorProfiles(oldStations) {
  if (oldStations.length === 0) return new Map();
  const rows = await sql(
    `SELECT dp.id, dp.name, dp.station,
            (SELECT array_agg(DISTINCT fa.ngo_id::text)
               FROM fro_assignments fa
              WHERE fa.donor_id = dp.id AND fa.station = dp.station) AS ngos
       FROM donor_profiles dp
      WHERE dp.station = ANY($1::text[])`,
    [oldStations]
  );
  const byStation = new Map();
  for (const r of rows) {
    if (!byStation.has(r.station)) byStation.set(r.station, []);
    byStation.get(r.station).push({ id: r.id, name: r.name, ngos: r.ngos || null });
  }
  return byStation;
}

export const bulkRenameStations = async (req, res) => {
  try {
    const renames = Array.isArray(req.body?.renames) ? req.body.renames : null;
    const dryRun = req.body?.dry_run !== false;
    const confirmed = req.body?.confirm === true;

    if (!renames || renames.length === 0) {
      return res.status(400).json({ message: 'No renames provided' });
    }
    if (renames.length > 500) {
      return res.status(400).json({ message: 'Too many renames (max 500 per batch)' });
    }
    if (!dryRun && !confirmed) {
      return res.status(400).json({ message: 'Confirmation required: send confirm: true to apply' });
    }

    // ---- Normalize input -------------------------------------------------
    const rows = renames.map(r => ({
      ngo_name: String(r?.ngo_name ?? '').trim(),
      old_station: String(r?.old_station ?? '').trim(),
      new_station: String(r?.new_station ?? '').trim(),
    }));
    for (const r of rows) {
      if (!r.ngo_name || !r.old_station || !r.new_station) {
        return res.status(400).json({ message: 'Each rename needs ngo_name, old_station and new_station' });
      }
      if (r.old_station === r.new_station) {
        return res.status(400).json({ message: `old_station and new_station must differ (${r.old_station})` });
      }
    }

    // ---- Resolve NGO names -> ids ----------------------------------------
    const ngoNames = [...new Set(rows.map(r => r.ngo_name.toLowerCase()))];
    const ngoRows = await sql(`SELECT id, name FROM ngos WHERE lower(name) = ANY($1::text[])`, [ngoNames]);
    const ngoByName = new Map(ngoRows.map(n => [n.name.toLowerCase(), n]));
    const missing = ngoNames.filter(n => !ngoByName.has(n));
    if (missing.length > 0) {
      return res.status(400).json({ message: `Unknown NGO(s): ${missing.join(', ')}` });
    }

    // ---- Access: every NGO in the batch must be accessible to the caller --
    const isSuperAdmin = req.user?.role === 'super_admin';
    if (!isSuperAdmin) {
      const allowed = new Set((await getUserNgoIds(req.user)).map(String));
      for (const n of ngoNames) {
        if (!allowed.has(String(ngoByName.get(n).id))) {
          return res.status(403).json({ message: `Access denied for NGO ${ngoByName.get(n).name}` });
        }
      }
    }

    // ---- Validate against the live station registry -----------------------
    const involvedNgoIds = [...new Set(ngoRows.map(n => String(n.id)))];
    const registry = await sql(
      `SELECT ngo_id::text AS ngo_id, station FROM fro_station_assignments WHERE ngo_id::text = ANY($1::text[])`,
      [involvedNgoIds]
    );
    const registryKeys = new Set(registry.map(s => `${s.ngo_id}|${s.station}`));

    const results = rows.map(r => {
      const ngo = ngoByName.get(r.ngo_name.toLowerCase());
      return {
        ngo_name: ngo.name,
        ngo_id: ngo.id,
        old_station: r.old_station,
        new_station: r.new_station,
      };
    });

    // All (ngo, old) pairs in the batch — used to detect chained renames
    // (A -> B while B itself is being renamed), which are not allowed.
    const oldKeys = new Set(results.map(r => `${r.ngo_id}|${r.old_station}`));
    const seenOld = new Set();
    const seenNew = new Set();
    for (const r of results) {
      const oldKey = `${r.ngo_id}|${r.old_station}`;
      const newKey = `${r.ngo_id}|${r.new_station}`;
      r.status = 'ok';
      r.reason = null;
      if (!registryKeys.has(oldKey)) {
        r.status = 'old_not_found'; r.reason = `Station "${r.old_station}" is not registered for ${r.ngo_name}`;
      } else if (registryKeys.has(newKey)) {
        r.status = oldKeys.has(newKey) ? 'chain' : 'new_taken';
        r.reason = oldKeys.has(newKey)
          ? `"${r.new_station}" is itself being renamed — chained renames are not allowed`
          : `Station "${r.new_station}" already exists for ${r.ngo_name}`;
      } else if (seenOld.has(oldKey)) {
        r.status = 'duplicate'; r.reason = `Duplicate rename for ${r.ngo_name} ${r.old_station}`;
      } else if (seenNew.has(newKey)) {
        r.status = 'duplicate'; r.reason = `Duplicate target "${r.new_station}" for ${r.ngo_name}`;
      }
      if (r.status === 'ok') { seenOld.add(oldKey); seenNew.add(newKey); }
    }

    const okRows = results.filter(r => r.status === 'ok');
    const ready = okRows.length > 0 && results.every(r => r.status === 'ok');

    // ---- DRY RUN: counts only, no writes ----------------------------------
    if (dryRun) {
      const impact = await countRenameImpact(okRows);
      const oldStations = [...new Set(okRows.map(r => r.old_station))];
      const donorMap = await classifyDonorProfiles(oldStations);
      // Claim logic mirrors the apply path: a profile is renamable when it is
      // attributable to exactly one NGO that has a rename row for that code.
      // Donors owned by another NGO in the same batch (shared old codes, e.g.
      // M-2 for all three NGOs) are NOT ambiguous — that NGO's row renames them.
      const ngosByOld = new Map();
      for (const r of okRows) {
        if (!ngosByOld.has(r.old_station)) ngosByOld.set(r.old_station, new Set());
        ngosByOld.get(r.old_station).add(String(r.ngo_id));
      }
      okRows.forEach((r) => {
        const c = impact.get(results.indexOf(r)) || {};
        const donors = donorMap.get(r.old_station) || [];
        const batchNgos = ngosByOld.get(r.old_station) || new Set();
        const claimed = (d) => !!(d.ngos && d.ngos.length === 1 && batchNgos.has(d.ngos[0]));
        r.counts = {
          ...c,
          donor_profiles_renamable: donors.filter(d => claimed(d) && d.ngos[0] === String(r.ngo_id)).length,
          donor_profiles_ambiguous: donors.filter(d => !claimed(d)).length,
        };
      });
      return res.json({ dry_run: true, ready, rows: results });
    }

    if (okRows.length === 0) {
      return res.status(400).json({ message: 'No valid renames to apply — fix the flagged rows and retry' });
    }
    if (!ready) {
      return res.status(400).json({ message: 'Cannot apply while some renames are flagged — remove the flagged rows and retry' });
    }

    // ---- APPLY: one transaction, all-or-nothing ---------------------------
    const performedBy = String(req.user?.email || req.user?.id || 'unknown');
    const batchId = crypto.randomUUID();
    const summary = await db.transaction(async () => {
      await ensureStationRenameLogTable();

      const ngoIds = okRows.map(r => r.ngo_id);
      const olds = okRows.map(r => r.old_station);
      const news = okRows.map(r => r.new_station);
      const upd = [ngoIds, olds, news];
      const unnestUpd = 'unnest($1::text[], $2::text[], $3::text[]) AS t(ngo_id, old_station, new_station)';

      // Donor classification must run BEFORE assignments are renamed.
      const oldStations = [...new Set(olds)];
      const donorMap = await classifyDonorProfiles(oldStations);
      // ngoId|oldStation -> newStation, for the work_as_sessions rewrite.
      const renameByKey = new Map(okRows.map(r => [`${r.ngo_id}|${r.old_station}`, r.new_station]));
      // Which NGOs have a rename row for a given old station code.
      const ngosByOld = new Map();
      for (const r of okRows) {
        if (!ngosByOld.has(r.old_station)) ngosByOld.set(r.old_station, new Set());
        ngosByOld.get(r.old_station).add(String(r.ngo_id));
      }

      // (a) Station registry
      const regIds = await sql(
        `UPDATE fro_station_assignments x
            SET station = t.new_station
           FROM ${unnestUpd}
          WHERE x.ngo_id::text = t.ngo_id AND x.station = t.old_station
          RETURNING x.id`, upd);
      // (b) Donor assignments (also drives the FRO queue)
      const assignIds = await sql(
        `UPDATE fro_assignments x
            SET station = t.new_station
           FROM ${unnestUpd}
          WHERE x.ngo_id::text = t.ngo_id AND x.station = t.old_station
          RETURNING x.id`, upd);
      // (c) Transfer history — both columns, independently scoped
      const tFrom = await sql(
        `UPDATE fro_transfers x
            SET station = t.new_station
           FROM ${unnestUpd}
          WHERE x.ngo_id::text = t.ngo_id AND x.station = t.old_station
          RETURNING x.id`, upd);
      const tTo = await sql(
        `UPDATE fro_transfers x
            SET target_station = t.new_station
           FROM ${unnestUpd}
          WHERE x.ngo_id::text = t.ngo_id AND x.target_station = t.old_station
          RETURNING x.id`, upd);
      const transferIds = new Set([...tFrom.map(x => x.id), ...tTo.map(x => x.id)]);
      // (d) Work queue — station + the cycle_key station segment
      //     (cycle_key format: `${ngo|all}:${station|all}:${tab}:${month}`)
       const queueIds = await sql(
         `UPDATE work_queue x
             SET station = t.new_station,
                 cycle_key = replace(x.cycle_key, ':' || t.old_station || ':', ':' || t.new_station || ':')
            FROM ${unnestUpd}
          WHERE x.ngo_id::text = t.ngo_id AND x.station = t.old_station
          RETURNING x.id`, upd);
      // (e) Active work-as (acting FRO) sessions — rewrite the jsonb pairs
      const allSessions = await sql(`SELECT id, stations FROM work_as_sessions WHERE stations != '[]'::jsonb`);
      let sessionsUpdated = 0;
      for (const s of allSessions) {
        let changed = false;
        const pairs = (Array.isArray(s.stations) ? s.stations : []).map(p => {
          const key = `${String(p?.ngo_id ?? '')}|${String(p?.station ?? '').trim()}`;
          const target = renameByKey.get(key);
          if (target && target !== p.station) { changed = true; return { ...p, station: target }; }
          return p;
        });
        if (!changed) continue;
        await sql(`UPDATE work_as_sessions SET stations = $1::jsonb WHERE id = $2`, [JSON.stringify(pairs), s.id]);
        sessionsUpdated++;
      }
      // (f) Donor profiles — only where the NGO attribution is unambiguous
      const skippedDonors = [];
      for (const [station, donors] of donorMap) {
        for (const d of donors) {
          const batchNgos = ngosByOld.get(station) || new Set();
          if (d.ngos && d.ngos.length === 1 && batchNgos.has(d.ngos[0])) continue; // claimed by its NGO's row
          let reason;
          if (!d.ngos || d.ngos.length === 0) reason = 'no NGO assignment';
          else if (d.ngos.length > 1) reason = 'assignments under multiple NGOs';
          else reason = 'no rename row for its NGO';
          skippedDonors.push({ donor_id: d.id, name: d.name, station, reason });
        }
      }
      const donorUpdates = [];
      for (const r of okRows) {
        const donors = donorMap.get(r.old_station) || [];
        const mine = donors
          .filter(d => d.ngos && d.ngos.length === 1 && d.ngos[0] === String(r.ngo_id))
          .map(d => d.id);
        if (mine.length === 0) { donorUpdates.push({ ...r, updated_donors: 0 }); continue; }
        const updated = await sql(
          `UPDATE donor_profiles SET station = $1 WHERE id = ANY($2::int[]) RETURNING id`,
          [r.new_station, mine]
        );
        donorUpdates.push({ ...r, updated_donors: updated.length });
      }
      // (g) Audit log — one row per applied rename
      for (const r of okRows) {
        const donors = donorMap.get(r.old_station) || [];
        const ambiguousForRow = donors.filter(
          d => d.ngos && d.ngos.length > 1 && d.ngos.includes(String(r.ngo_id))
        ).length;
        const du = donorUpdates.find(u => u.ngo_id === r.ngo_id && u.old_station === r.old_station);
        const counts = {
          fro_station_assignments: regIds.length,
          fro_assignments: assignIds.length,
          fro_transfers: transferIds.size,
          work_queue: queueIds.length,
          work_as_sessions: sessionsUpdated,
          donor_profiles: du ? du.updated_donors : 0,
        };
        await sql(
          `INSERT INTO station_rename_log (ngo_id, ngo_name, old_station, new_station, counts, skipped_donors, performed_by, batch_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [r.ngo_id, r.ngo_name, r.old_station, r.new_station, JSON.stringify(counts), ambiguousForRow, performedBy, batchId]
        );
      }
      // NOTE: regIds/assignIds/queueIds lengths above are batch totals; the
      // audit rows repeat them per-row on purpose — each log entry records
      // the full batch impact for its (ngo, old -> new) mapping.

      // (h) Post-verify: scoped old codes must be gone from every table.
      //     Any leftover throws, which rolls the whole transaction back.
      const checkPairs = [ngoIds, olds];
      const unnestChk = 'unnest($1::text[], $2::text[]) AS t(ngo_id, station)';
      const checks = [
        ['fro_station_assignments', `SELECT COUNT(*)::int AS cnt FROM fro_station_assignments x JOIN ${unnestChk} ON x.ngo_id::text = t.ngo_id AND x.station = t.station`],
        ['fro_assignments', `SELECT COUNT(*)::int AS cnt FROM fro_assignments x JOIN ${unnestChk} ON x.ngo_id::text = t.ngo_id AND x.station = t.station`],
        ['fro_transfers.station', `SELECT COUNT(*)::int AS cnt FROM fro_transfers x JOIN ${unnestChk} ON x.ngo_id::text = t.ngo_id AND x.station = t.station`],
        ['fro_transfers.target_station', `SELECT COUNT(*)::int AS cnt FROM fro_transfers x JOIN ${unnestChk} ON x.ngo_id::text = t.ngo_id AND x.target_station = t.station`],
        ['work_queue', `SELECT COUNT(*)::int AS cnt FROM work_queue x JOIN ${unnestChk} ON x.ngo_id::text = t.ngo_id AND x.station = t.station`],
      ];
      for (const [label, query] of checks) {
        const [{ cnt }] = await sql(query, checkPairs);
        if (cnt > 0) throw new Error(`Post-verify failed: ${cnt} row(s) still carry an old code in ${label} — rolling back`);
      }
      // donor_profiles leftovers must be exactly the intentionally skipped ones
      const [{ cnt: profileLeft }] = await sql(
        `SELECT COUNT(*)::int AS cnt FROM donor_profiles WHERE station = ANY($1::text[])`, [oldStations]
      );
      if (profileLeft !== skippedDonors.length) {
        throw new Error(`Post-verify failed: ${profileLeft} donor profile(s) still carry an old code, expected ${skippedDonors.length} — rolling back`);
      }
      // Informational: rows with a NULL ngo_id keep old codes (pre-existing
      // orphans / all-station queue cycles); the queue rebuilds these itself.
      const [unscoped] = await sql(
        `SELECT
           (SELECT COUNT(*)::int FROM fro_assignments WHERE ngo_id IS NULL AND station = ANY($1::text[])) AS assignments,
           (SELECT COUNT(*)::int FROM fro_transfers WHERE ngo_id IS NULL AND (station = ANY($1::text[]) OR target_station = ANY($1::text[]))) AS transfers,
           (SELECT COUNT(*)::int FROM work_queue WHERE ngo_id IS NULL AND station = ANY($1::text[])) AS queue`,
        [oldStations]
      );

      return {
        applied: okRows.length,
        batch_id: batchId,
        rows: donorUpdates,
        totals: {
          fro_station_assignments: regIds.length,
          fro_assignments: assignIds.length,
          fro_transfers: transferIds.size,
          work_queue: queueIds.length,
          work_as_sessions: sessionsUpdated,
        },
        skipped_donors: skippedDonors,
        post_verify: { old_codes_remaining: 0, unscoped_old_rows: unscoped },
      };
    });

    // A rename rewrites station codes in every table the roll-ups read, so the
    // station list, the disposition stats and the TL dashboard are all stale.
    // This is the highest-stakes invalidation in the file — a cached copy here
    // would show donors under a station name that no longer exists.
    bustStationCache();

    return res.json(summary);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Rename history for the bulk-rename revert UI: the last 20 applied batches,
// grouped by batch_id (rows logged before batch_id existed fall back to
// single-entry groups). Scoped to the caller's NGO access.
export const getStationRenameLog = async (req, res) => {
  try {
    await ensureStationRenameLogTable();

    const isSuperAdmin = req.user?.role === 'super_admin';
    let scopeSql = '';
    let params = [];
    if (!isSuperAdmin) {
      const allowed = (await getUserNgoIds(req.user)).map(String);
      if (allowed.length === 0) return res.json([]);
      scopeSql = 'WHERE ngo_id::text = ANY($1::text[])';
      params = [allowed];
    }

    const batches = await sql(
      `SELECT COALESCE(batch_id::text, 'legacy-' || id::text) AS batch_id,
              max(performed_at) AS performed_at,
              max(performed_by) AS performed_by,
              json_agg(json_build_object('ngo_name', ngo_name, 'old_station', old_station, 'new_station', new_station) ORDER BY id) AS entries,
              sum((counts->>'fro_assignments')::int)::int AS donor_assignments,
              sum(skipped_donors)::int AS skipped_donors
         FROM station_rename_log
         ${scopeSql}
        GROUP BY 1
        ORDER BY max(performed_at) DESC
        LIMIT 20`,
      params
    );
    return res.json(batches);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
