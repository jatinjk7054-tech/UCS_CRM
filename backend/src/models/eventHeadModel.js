import db, { getTableColumns } from '../config/db.js';
import { istDateString } from '../utils/ist.js';
import { servedFestivalBeneficiary } from '../utils/activityProgramPrompt.js';

// ─── EVENTS ───
export const createEventHeadEvent = async (data) => {
  const { data: result, error } = await db.from('event_head_events').insert([{ ...data, updated_at: new Date() }]).select().single();
  if (error) throw error;
  return result;
};

// Bulk insert from an events sheet import. No ON CONFLICT (events have no
// natural unique key) — the caller dedupes rows before calling.
export const insertEventHeadEventsBulk = async (rows) => {
  if (!rows || !rows.length) return [];
  const withTs = rows.map(r => ({ ...r, updated_at: new Date() }));
  const { data, error } = await db.from('event_head_events').insert(withTs).select('id, ngo_id');
  if (error) throw error;
  return data || [];
};

export const getAllEventHeadEvents = async (filters = {}) => {
  const { ngo_id, sector_id, activity_id, status, month, year } = filters;
  const SUBMITTED_STATUSES = ['Submitted', 'Submitted&', 'Pending Approval', 'Approval Pending'];
  let query = db.from('event_head_events').select('*').order('created_at', { ascending: false });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (sector_id) query = query.eq('sector_id', sector_id);
  if (activity_id) query = query.eq('activity_id', activity_id);
  if (status) {
    if (status === 'Submitted') query = query.in('status', SUBMITTED_STATUSES);
    else query = query.eq('status', status);
  }
  if (month && year) {
    const m = Number(month), y = Number(year);
    if (m >= 1 && m <= 12) {
      query = query.gte('date', `${y}-${String(m).padStart(2, '0')}-01`)
        .lt('date', `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`);
    }
  }
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getEventHeadEventById = async (id) => {
  const { data, error } = await db.from('event_head_events').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
};

export const updateEventHeadEvent = async (id, updates) => {
  const { data, error } = await db.from('event_head_events').update({ ...updates, updated_at: new Date() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const deleteEventHeadEvent = async (id) => {
  const { error } = await db.from('event_head_events').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Event deleted' };
};

export const deleteEventHeadEventsBulk = async (ids) => {
  if (!ids || !ids.length) return 0;
  const { data, error } = await db.from('event_head_events').delete().in('id', ids).select('id');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
};

export const getEventHeadEventsByMonth = async (month, year, ngo_id) => {
  const m = Number(month), y = Number(year);
  let query = db.from('event_head_events').select('*')
    .gte('date', `${y}-${String(m).padStart(2, '0')}-01`)
    .lt('date', `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`)
    .order('date', { ascending: true });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

// ─── MULTI-ACTIVITY (join table) ───

// The event_head_event_activities join table is added by migration 092. Until
// that migration is applied on a given DB, the table does not exist and any
// read/write to it throws 'relation ... does not exist' — killing event create.
// Guard every join-table access behind this cached-existence check so events
// keep working via the legacy single `activity_id` column in the interim.
let joinTableExistsCache = null;
const joinTableExists = async () => {
  if (joinTableExistsCache !== null) return joinTableExistsCache;
  try {
    const cols = await getTableColumns('event_head_event_activities');
    joinTableExistsCache = Array.isArray(cols) && cols.length > 0;
  } catch {
    joinTableExistsCache = false;
  }
  return joinTableExistsCache;
};

export const getEventHeadActivityIds = async (eventId) => {
  if (!(await joinTableExists())) return [];
  const { data, error } = await db.from('event_head_event_activities').select('activity_id').eq('event_id', eventId);
  if (error) throw error;
  return (data || []).map(r => Number(r.activity_id));
};

// Set the full set of activities for an event (replaces existing rows).
export const setEventHeadActivities = async (eventId, activityIds = []) => {
  if (!(await joinTableExists())) return [];
  const ids = [...new Set(activityIds.filter(id => id != null).map(Number))];
  await db.from('event_head_event_activities').delete().eq('event_id', eventId);
  if (ids.length) {
    const rows = ids.map(activity_id => ({ event_id: Number(eventId), activity_id }));
    const { data, error } = await db.from('event_head_event_activities').insert(rows);
    if (error) throw error;
  }
  return ids;
};

// Calendar-range query for FullCalendar. Returns events within [start, end).
export const getEventHeadEventsByRange = async ({ start, end, ngo_id, sector_id, activity_id, status, year } = {}) => {
  let query = db.from('event_head_events').select('*');
  if (activity_id != null) {
    // Filter by an event containing this activity (join table).
    const ids = await getEventIdsForActivity(activity_id);
    if (ids.length) query = query.in('id', ids);
    else return [];
  }
  if (start) query = query.gte('date', String(start).slice(0, 10));
  if (end) query = query.lt('date', String(end).slice(0, 10));
  if (year) {
    const y = Number(year);
    if (Number.isFinite(y)) query = query.gte('date', `${y}-01-01`).lt('date', `${y + 1}-01-01`);
  }
  if (ngo_id != null) query = query.eq('ngo_id', ngo_id);
  if (sector_id != null) query = query.eq('sector_id', sector_id);
  if (status) query = query.eq('status', status);
  query = query.order('date', { ascending: true });
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

// Events ids that reference a given activity (via the join table), falling back
// to the legacy single activity_id column.
const getEventIdsForActivity = async (activityId) => {
  const a = Number(activityId);
  const joinIds = (await joinTableExists())
    ? (await db.from('event_head_event_activities').select('event_id').eq('activity_id', a)).data || []
    : [];
  const joinSet = new Set(joinIds.map(r => Number(r.event_id)));
  const { data: legacy } = await db.from('event_head_events').select('id').eq('activity_id', a);
  const ids = new Set([...joinSet, ...(legacy || []).map(r => Number(r.id))]);
  return [...ids];
};

export const getEventHeadEventsByNgo = async (ngoId) => {
  const { data, error } = await db.from('event_head_events').select('*').eq('ngo_id', ngoId).order('date', { ascending: false });
  if (error) throw error;
  return data;
};

export const getEventHeadEventsByState = async (state) => {
  const { data, error } = await db.from('event_head_events').select('*').ilike('state', state).order('date', { ascending: false });
  if (error) throw error;
  return data;
};

export const getEventHeadDashboard = async () => {
  const { data, error } = await db.from('event_head_events').select('*');
  if (error) throw error;
  const total = data.length;
  const upcoming = data.filter(e => e.status === 'Approved' && new Date(e.date) > new Date()).length;
  const today = data.filter(e => e.date === new Date().toISOString().slice(0, 10)).length;
  const completed = data.filter(e => e.status === 'Completed').length;
  const cancelled = data.filter(e => ['Cancelled', 'Postponed'].includes(e.status)).length;
  const budgetTotal = data.reduce((s, e) => s + (+e.budget || 0), 0);
  const beneficiariesTotal = data.reduce((s, e) => s + (+e.expected_beneficiaries || 0), 0);
  return { total, upcoming, today, completed, cancelled, budget_total: budgetTotal, beneficiaries_total: beneficiariesTotal };
};

const pad2 = (n) => String(n).padStart(2, '0');
const monthBounds = (month, year) => {
  const y = year ? Number(year) : null;
  if (month) {
    const m = Number(month);
    if (!(m >= 1 && m <= 12)) return null;
    const yearForMonth = y || new Date().getFullYear();
    const next = m === 12 ? `${yearForMonth + 1}-01-01` : `${yearForMonth}-${pad2(m + 1)}-01`;
    return { from: `${yearForMonth}-${pad2(m)}-01`, to: next };
  }
  if (y && Number.isFinite(y)) return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
  return null;
};

// Lean projection of events for the dashboard stats calculation.
// Applies the scalar filters (ngo/sector/activity) and the month+year window.
export const getEventHeadDashboardEvents = async (filters = {}) => {
  const { ngo_id, sector_id, activity_id, month, year } = filters;
  let query = db.from('event_head_events')
    .select('id, name, date, start_time, end_time, venue, status, ngo_id, sector_id, activity_id, budget, expected_beneficiaries');
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (sector_id) query = query.eq('sector_id', sector_id);
  if (activity_id) query = query.eq('activity_id', activity_id);
  const bounds = monthBounds(month, year);
  if (bounds) query = query.gte('date', bounds.from).lt('date', bounds.to);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

// ─── ASSETS ───
export const createAsset = async (data) => {
  const { data: result, error } = await db.from('event_head_assets').insert([{ ...data, available_qty: data.quantity, updated_at: new Date() }]).select().single();
  if (error) throw error;
  return result;
};

export const getAllAssets = async () => {
  const { data, error } = await db.from('event_head_assets').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getAssetById = async (id) => {
  const { data, error } = await db.from('event_head_assets').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
};

export const updateAsset = async (id, updates) => {
  const { data, error } = await db.from('event_head_assets').update({ ...updates, updated_at: new Date() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const deleteAsset = async (id) => {
  const { error } = await db.from('event_head_assets').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Asset deleted' };
};

export const issueAsset = async (assetId, qty) => {
  const asset = await getAssetById(assetId);
  const newIssued = (asset.issued_qty || 0) + qty;
  const newAvailable = (asset.available_qty || asset.quantity) - qty;
  return updateAsset(assetId, { issued_qty: newIssued, available_qty: newAvailable });
};

export const returnAsset = async (assetId) => {
  const asset = await getAssetById(assetId);
  return updateAsset(assetId, { issued_qty: 0, available_qty: asset.quantity, damaged_qty: 0 });
};

// ─── MATERIALS ───
export const createMaterial = async (data) => {
  const balance = +data.opening_stock + +data.received - +data.issued;
  const { data: result, error } = await db.from('event_head_materials').insert([{ ...data, balance, updated_at: new Date() }]).select().single();
  if (error) throw error;
  return result;
};

export const getAllMaterials = async () => {
  const { data, error } = await db.from('event_head_materials').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const updateMaterial = async (id, updates) => {
  const balance = +updates.opening_stock + +updates.received - +updates.issued;
  const { data, error } = await db.from('event_head_materials').update({ ...updates, balance, updated_at: new Date() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const deleteMaterial = async (id) => {
  const { error } = await db.from('event_head_materials').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Material deleted' };
};

export const getMaterialStock = async () => {
  const { data, error } = await db.from('event_head_materials').select('name, balance, opening_stock, received, issued').order('balance', { ascending: true });
  if (error) throw error;
  return data;
};

export const adjustMaterialStock = async (id, adjustment) => {
  const mat = await db.from('event_head_materials').select('*').eq('id', id).single().then(r => r.data);
  const newBalance = (mat.balance || 0) + adjustment;
  return updateMaterial(id, { balance: Math.max(0, newBalance) });
};

// ─── DISTRIBUTIONS ───
export const createDistribution = async (eventId, data) => {
  const { data: result, error } = await db.from('event_head_distributions').insert([{ ...data, event_id: eventId }]).select().single();
  if (error) throw error;
  if (data.material_id && data.quantity) {
    const mat = await db.from('event_head_materials').select('*').eq('id', data.material_id).single().then(r => r.data);
    if (mat) await updateMaterial(data.material_id, { issued: (mat.issued || 0) + +data.quantity, opening_stock: mat.opening_stock, received: mat.received });
  }
  return result;
};

export const getDistributionsByEvent = async (eventId) => {
  const { data, error } = await db.from('event_head_distributions').select('*').eq('event_id', eventId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

// ─── VOLUNTEERS ───
export const createVolunteer = async (data) => {
  const { data: result, error } = await db.from('event_head_volunteers').insert([data]).select().single();
  if (error) throw error;
  return result;
};

export const getAllVolunteers = async () => {
  const { data, error } = await db.from('event_head_volunteers').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const updateVolunteer = async (id, updates) => {
  const { data, error } = await db.from('event_head_volunteers').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

// NGO-wise volunteer roster for the Voluntary section. Reads the HR workers
// table (the volunteer team in the database) and joins the NGO name/code.
export const getVolunteerPeople = async () => {
  const [workersRes, ngosRes] = await Promise.all([
    db.from('workers')
      .select('id, name, ngo_id, is_test')
      .eq('employment_status', 'active')
      .eq('is_active', true)
      .order('name'),
    db.from('ngos').select('id, name, code'),
  ]);
  if (workersRes.error) throw workersRes.error;
  if (ngosRes.error) throw ngosRes.error;
  const ngoMap = {};
  for (const n of ngosRes.data || []) {
    ngoMap[String(n.id)] = { name: n.name || n.code || 'NGO ' + n.id, code: n.code };
  }
  return (workersRes.data || [])
    .filter((w) => !w.is_test)
    .map((w) => {
      const n = w.ngo_id != null ? ngoMap[String(w.ngo_id)] : null;
      return {
        id: w.id,
        name: w.name,
        ngo_id: w.ngo_id ?? null,
        ngo_name: n ? n.name : null,
        ngo_code: n ? n.code : null,
      };
    })
    .sort((a, b) => {
      const na = a.ngo_name || 'Other';
      const nb = b.ngo_name || 'Other';
      return na.localeCompare(nb) || (a.name || '').localeCompare(b.name || '');
    });
};

// Today's HR attendance, keyed for the Voluntary section's per-person status.
//
// WHY A SEPARATE READ. The HR attendance endpoints are gated to
// super_admin/admin/hr/accounts, so the `event_head` role cannot read them, and
// the Create New Event form needs today's status to flag absent volunteers.
// getVolunteerPeople() stays attendance-free on purpose: it is shared with the
// volunteer management screen, and attendance has no business in that contract.
//
// WHY ONLY MARKED ROWS COME BACK. `attendance` stores no 'absent' rows — a missing
// punch IS the absence (see hrDailyReportController and the dashboard's Daily
// Check-ins), so the rows returned here are only present/late/half-day/leave.
// Turning that into an "absent" verdict needs the roster, which is why the caller
// joins this against getVolunteerPeople() by worker id and treats a person with
// no row here as absent.
//
// `attendance.date` is a real DATE column already holding an IST calendar day
// (db sessions are pinned to Asia/Kolkata), so it compares to a plain
// 'YYYY-MM-DD' string with no timezone conversion.
export const getVolunteerAttendanceToday = async () => {
  const date = istDateString();
  const { data, error } = await db
    .from('attendance')
    .select('worker_id, status, late_minutes, punch_in_time')
    .eq('date', date);
  if (error) throw error;
  const byWorker = {};
  for (const row of data || []) {
    // One row per worker per date (the writes upsert), but a legacy duplicate
    // must not let a later row blank out the status we report.
    const key = String(row.worker_id);
    if (byWorker[key]) continue;
    byWorker[key] = {
      status: row.status || null,
      late_minutes: Number(row.late_minutes) || 0,
      punch_in_time: row.punch_in_time || null,
    };
  }
  return { date, byWorker };
};

// Workers who are no longer active (absconded, offboarded, resigned, terminated
// or de-activated in the HR panel). Used to drop them from the Voluntary list of
// events they were already assigned to, so HR stays the single source of truth.
//
// Deliberately keyed by BOTH id and name: entries saved by the current picker
// carry the HR worker id, while rows saved before that existed only have a name.
// A name is only treated as inactive when it actually matches one of these rows —
// a name that matches no worker at all (management, or a misspelling) is left
// alone rather than silently deleted.
export const getInactiveVolunteerKeys = async () => {
  const { data, error } = await db
    .from('workers')
    .select('id, name, is_active, employment_status')
    .neq('employment_status', 'active');
  if (error) throw error;
  const ids = new Set();
  const names = new Set();
  const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  for (const w of data || []) {
    if (w.is_test) continue;
    if (w.is_active !== false) continue;
    if (w.id != null) ids.add(String(w.id));
    if (w.name) names.add(key(w.name));
  }
  return { ids, names };
};

// ─── EXPENSES ───
export const createExpense = async (eventId, data) => {
  const { data: result, error } = await db.from('event_head_expenses').insert([{ ...data, event_id: eventId }]).select().single();
  if (error) throw error;
  return result;
};

export const getExpensesByEvent = async (eventId) => {
  const { data, error } = await db.from('event_head_expenses').select('*').eq('event_id', eventId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const deleteExpense = async (eventId, id) => {
  const { error } = await db.from('event_head_expenses').delete().eq('id', id).eq('event_id', eventId);
  if (error) throw error;
  return { message: 'Expense deleted' };
};

// ─── VEHICLES ───
export const createVehicle = async (data) => {
  const { data: result, error } = await db.from('event_head_vehicles').insert([data]).select().single();
  if (error) throw error;
  return result;
};

export const getAllVehicles = async () => {
  const { data, error } = await db.from('event_head_vehicles').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const assignVehicle = async (data) => {
  const { data: result, error } = await db.from('event_head_vehicles').insert([data]).select().single();
  if (error) throw error;
  return result;
};

// ─── MEDIA ───
// The base `event_head_media` table stores id, event_id, name, url, type,
// created_at. The richer metadata columns (title, description, media_type,
// year, size, uploaded_by, updated_at) are additive and managed idempotently
// by `ensureMediaColumns()` so existing rows and deployments keep working.
export const MEDIA_COLUMNS_SQL = [
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS media_type TEXT`,
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS year INT`,
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS size BIGINT`,
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS uploaded_by TEXT`,
  `ALTER TABLE event_head_media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
];

// Idempotent: add metadata columns if the table/columns do not yet exist.
export const ensureMediaColumns = async () => {
  const { rows } = await db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='event_head_media'`
  );
  if (rows.length === 0) return;
  for (const sql of MEDIA_COLUMNS_SQL) {
    try { await db._pool.query(sql); } catch (e) { /* ignore if column missing concurrently */ }
  }
};

export const createMedia = async (eventId, data) => {
  await ensureMediaColumns();
  const { data: result, error } = await db.from('event_head_media').insert([{ ...data, event_id: eventId }]).select().single();
  if (error) throw error;
  return result;
};

export const getMediaByEvent = async (eventId) => {
  const { data, error } = await db.from('event_head_media').select('*').eq('event_id', eventId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getBannerMediaByEvents = async (eventIds) => {
  if (!eventIds || !eventIds.length) return [];
  const { data, error } = await db.from('event_head_media').select('event_id, url, media_type').eq('media_type', 'Banner').in('event_id', eventIds);
  if (error) throw error;
  return data || [];
};

// All media across every event of a single NGO (event → ngo).
export const getMediaByNgo = async (ngoId) => {
  await ensureMediaColumns();
  const { data, error } = await db.from('event_head_media')
    .select('*, event_head_events!inner(id, name, date, ngo_id)')
    .eq('event_head_events.ngo_id', ngoId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getMediaById = async (eventId, id) => {
  const { data, error } = await db.from('event_head_media').select('*').eq('id', id).eq('event_id', eventId).maybeSingle();
  if (error) throw error;
  return data;
};

export const updateMedia = async (eventId, id, updates) => {
  await ensureMediaColumns();
  const { data: result, error } = await db.from('event_head_media')
    .update({ ...updates, updated_at: new Date() })
    .eq('id', id).eq('event_id', eventId).select().single();
  if (error) throw error;
  return result;
};

export const deleteMedia = async (eventId, id) => {
  const { error } = await db.from('event_head_media').delete().eq('id', id).eq('event_id', eventId);
  if (error) throw error;
  return { message: 'Media deleted' };
};

// ─── ATTENDANCE ───
export const createAttendance = async (eventId, data) => {
  const { data: result, error } = await db.from('event_head_attendance').insert([{ ...data, event_id: eventId }]).select().single();
  if (error) throw error;
  return result;
};

export const getAttendanceByEvent = async (eventId) => {
  const { data, error } = await db.from('event_head_attendance').select('*').eq('event_id', eventId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

// ─── CHECKLIST ───
export const getChecklistByEvent = async (eventId) => {
  const { data, error } = await db.from('event_head_checklist').select('*').eq('event_id', eventId).order('id', { ascending: true });
  if (error) throw error;
  return data;
};

export const upsertChecklistItem = async (eventId, item) => {
  if (item.id) {
    const { data, error } = await db.from('event_head_checklist').update({ status: item.status, notes: item.notes }).eq('id', item.id).eq('event_id', eventId).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db.from('event_head_checklist').insert([{ event_id: eventId, label: item.label, status: item.status, notes: item.notes }]).select().single();
  if (error) throw error;
  return data;
};

export const createChecklistItem = async (eventId, item) => {
  const { data, error } = await db.from('event_head_checklist').insert([{ event_id: eventId, label: item.label, status: !!item.status, notes: item.notes || null }]).select().single();
  if (error) throw error;
  return data;
};

// ─── PARTNERS (CSR) ───
export const getAllPartners = async () => {
  const { data, error } = await db.from('event_head_partners').select('*').order('name', { ascending: true });
  if (error) throw error;
  return data;
};

// ─── DONORS ───
export const getAllDonors = async () => {
  const { data, error } = await db.from('event_head_donors').select('*').order('name', { ascending: true });
  if (error) throw error;
  return data;
};

// ─── SECTORS (Dynamic 12-sector reference, seeded via migration) ───
export const getAllEventHeadSectors = async () => {
  const { data, error } = await db.from('event_head_sectors').select('*').order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
};

export const createEventHeadSector = async ({ name, description } = {}) => {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Sector name is required');
  const { data: existing, error: findError } = await db
    .from('event_head_sectors')
    .select('*')
    .ilike('name', cleanName)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return { ...existing, existing: true };
  const { data: maxRow, error: maxError } = await db
    .from('event_head_sectors')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1);
  if (maxError) throw maxError;
  const sort_order = (maxRow && maxRow[0] && maxRow[0].sort_order != null ? Number(maxRow[0].sort_order) : 0) + 1;
  const { data, error } = await db
    .from('event_head_sectors')
    .insert({ name: cleanName, description: description ? String(description).trim() || null : null, is_active: true, sort_order })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getSectorActivityCounts = async (ngoId) => {
  let query = db.from('event_head_activities').select('id, sector_id, ngo_id');
  if (ngoId) query = query.eq('ngo_id', ngoId);
  const { data, error } = await query;
  if (error) throw error;
  const counts = {};
  for (const a of data || []) if (a.sector_id) counts[a.sector_id] = (counts[a.sector_id] || 0) + 1;
  return counts;
};

export const getSectorEventCounts = async (ngoId) => {
  let query = db.from('event_head_events').select('id, sector_id, ngo_id');
  if (ngoId) query = query.eq('ngo_id', ngoId);
  const { data, error } = await query;
  if (error) throw error;
  const counts = {};
  for (const e of data || []) if (e.sector_id) counts[e.sector_id] = (counts[e.sector_id] || 0) + 1;
  return counts;
};

// ─── ACTIVITIES (NGO → Sector → Activity) ───

/* Whether a column on event_head_activities exists yet.

   Migration 168 adds beneficiary_group and 169 adds in_report, but the writes
   below are a plain spread of the request body, so a client that sends either
   field against a database where the migration has not been applied gets a hard
   "column not found" and the whole save fails. Rather than make a feature depend
   on a migration being applied, each column is probed once and the field is
   dropped when it is absent - the activity still saves, and the caller is told
   which field was lost. Cached per column because it cannot change while the
   process runs. */
const columnProbeCache = new Map();
export const activityColumnExists = async (column) => {
  if (!columnProbeCache.has(column)) {
    columnProbeCache.set(column, (async () => {
      try {
        const { error } = await db.from('event_head_activities').select(column).limit(1);
        return !error;
      } catch {
        return false;
      }
    })());
  }
  return columnProbeCache.get(column);
};

/* Exported so the suggestion endpoint can use the same answer when it writes the
   AI prompt's beneficiary line. */
export const activityBeneficiaryColumnExists = () => activityColumnExists('beneficiary_group');

/* Columns a client may set that are not part of the table's original shape, with
   what each one does with an empty value. Anything not listed here is never probed
   and never stripped. */
const OPTIONAL_ACTIVITY_COLUMNS = {
  beneficiary_group: { empty: null },
  in_report: { boolean: true },
};

/* Normalises the optional fields the database can actually store, and removes the
   ones it cannot. Returns which columns were unavailable so a caller that cares -
   the controller, so a tick can report "your selection was not saved" instead of
   appearing to succeed - can say so. */
const prepareActivityRow = async (row) => {
  const unavailable = [];
  for (const [column, rule] of Object.entries(OPTIONAL_ACTIVITY_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    if (!(await activityColumnExists(column))) {
      delete row[column];
      unavailable.push(column);
      continue;
    }
    if (rule.boolean) row[column] = Boolean(row[column]);
    else if (!row[column]) row[column] = rule.empty;
  }
  return unavailable;
};

export const createActivity = async (data) => {
  const row = { ...data };
  await prepareActivityRow(row);
  const { data: result, error } = await db.from('event_head_activities').insert([{ ...row, updated_at: new Date() }]).select().single();
  if (error) throw error;
  return result;
};

// Bulk upsert from a sheet import. Only actually-inserted rows are returned
// (ON CONFLICT ... DO NOTHING skips existing), so callers can report
// inserted vs skipped_existing counts precisely.
export const insertActivitiesBulk = async (rows) => {
  if (!rows || !rows.length) return [];
  const { data, error } = await db.from('event_head_activities')
    .upsert(rows, { onConflict: 'ngo_id,sector_id,name', ignoreDuplicates: true })
    .select('id, ngo_id, sector_id, name');
  if (error) throw error;
  return data || [];
};

// ─── PLANNER SUGGESTIONS (Monthly Planner: AI ideas kept for the report) ───

// Store one generated batch of AI ideas. ignoreDuplicates + the unique key on
// (activity, month, year, batch, title) means re-running the generator cannot
// create duplicates — and critically it cannot reset a user's existing ticks,
// because a conflicting row is skipped rather than updated.
export const savePlannerSuggestions = async ({ ngo_id, activity_id, month, year, batch_no = 1, suggestions = [], created_by = null }) => {
  if (!activity_id || !suggestions.length) return [];
  const rows = suggestions.map((s) => ({
    ngo_id: ngo_id ?? null,
    activity_id,
    month,
    year,
    batch_no,
    title: String(s.title || '').trim(),
    format: s.format || null,
    priority: s.priority || null,
    audience: s.audience || null,
    duration: s.duration || null,
    objective: s.objective || null,
    rationale: s.rationale || null,
    materials: Array.isArray(s.materials) ? s.materials : [],
    created_by,
  })).filter((r) => r.title);

  if (!rows.length) return [];

  const { error } = await db.from('event_head_planner_suggestions')
    .upsert(rows, { onConflict: 'activity_id,month,year,batch_no,title', ignoreDuplicates: true });
  if (error) throw error;

  // Re-read the batch so the caller gets real ids and the user's current ticks.
  return getPlannerSuggestions({ activity_id, month, year, batch_no });
};

export const getPlannerSuggestions = async ({ ngo_id, activity_id, month, year, batch_no, selected_only = false } = {}) => {
  let query = db.from('event_head_planner_suggestions').select('*').order('created_at', { ascending: true });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (activity_id) query = query.eq('activity_id', activity_id);
  if (month) query = query.eq('month', Number(month));
  if (year) query = query.eq('year', Number(year));
  if (batch_no) query = query.eq('batch_no', Number(batch_no));
  if (selected_only) query = query.eq('is_selected', true);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const setPlannerSuggestionSelected = async (id, is_selected, suggested_event_id) => {
  const patch = { is_selected: Boolean(is_selected) };
  // Which programme this idea became. Written together with the tick so the
  // report can print the idea against the exact programme the user chose it for,
  // instead of against every programme that shares the activity.
  if (suggested_event_id != null && suggested_event_id !== '') {
    const evId = Number(suggested_event_id);
    if (Number.isInteger(evId) && evId > 0) patch.suggested_event_id = evId;
  }
  const { data, error } = await db.from('event_head_planner_suggestions')
    .update(patch)
    .eq('id', id).select().single();
  if (error) throw error;
  return data;
};

// ─── FESTIVAL SUGGESTIONS (Monthly Planner: per festival/day AI ideas) ─────
// A lighter, festival-anchored cousin of the activity suggestions above. Rows
// are keyed by (activity_id, month, observance_date, festival, title) so a
// re-run of the generator cannot duplicate ideas — and cannot reset a tick.

/* Whether migration 176's beneficiary_picked column is on the table. A write
   that set an unknown column would fail with "column not found", and a read
   could not tell an auto-filled legacy value from one the user picked — so
   both guard on this: writes omit the flag and reads fall back to comparing
   the value against the NGO's mapped group until the migration is applied.
   Cached per column for the life of the process (same pattern as
   activityColumnExists): apply the migration and restart the server to pick
   it up. */
const festivalColumnProbeCache = new Map();
const festivalColumnExists = (column) => {
  if (!festivalColumnProbeCache.has(column)) {
    festivalColumnProbeCache.set(column, (async () => {
      try {
        const { error } = await db.from('event_head_festival_suggestions').select(column).limit(1);
        return !error;
      } catch {
        return false;
      }
    })());
  }
  return festivalColumnProbeCache.get(column);
};
const festivalBeneficiaryPickedColumnExists = () => festivalColumnExists('beneficiary_picked');

export const saveFestivalSuggestions = async ({
  ngo_id, activity_id, month, year, observance_date, festival, beneficiary = null,
  location = null,
  sector_name = null, activity_name = null, batch_no = 1, suggestions = [], created_by = null,
}) => {
  if (!suggestions.length) return [];
  const pickedColumn = await festivalBeneficiaryPickedColumnExists();
  const rows = suggestions.map((s) => ({
    ngo_id: ngo_id ?? null,
    activity_id: Number.isInteger(activity_id) && activity_id > 0 ? activity_id : null,
    month: Number(month),
    year: Number(year),
    observance_date,
    festival: String(festival || '').trim(),
    beneficiary: beneficiary || null,
    ...(pickedColumn ? { beneficiary_picked: Boolean(beneficiary) } : {}),
    location: location || null,
    sector_name: sector_name || null,
    activity_name: activity_name || null,
    batch_no,
    title: String(s.title || '').trim(),
    format: s.format || null,
    priority: s.priority || null,
    audience: s.audience || null,
    duration: s.duration || null,
    objective: s.objective || null,
    rationale: s.rationale || null,
    materials: Array.isArray(s.materials) ? s.materials : [],
    created_by,
  })).filter((r) => r.title && r.observance_date && r.festival);

  if (!rows.length) return [];

  const { error } = await db.from('event_head_festival_suggestions')
    .upsert(rows, { onConflict: 'activity_id,month,observance_date,festival,title', ignoreDuplicates: true });
  if (error) throw error;

  /* The upsert never rewrites a title that already exists, so a re-run under a
     NEW beneficiary from the row's dropdown would leave the earlier rows
     showing the old category in the grid and the export. Align every stored
     row of this festival (this NGO, month, date) with the category the
     generation was actually aimed at. Only titles can differ between runs —
     never the beneficiary of a live suggestion set. */
  if (ngo_id !== undefined && ngo_id !== null && ngo_id !== '') {
    await setFestivalSuggestionsBeneficiary({ ngo_id, month, observance_date, festival, beneficiary });
    // The same re-align for the block's location: it is optional, so only
    // ever written when the generation actually carried one — a bare run must
    // not wipe a place the user had already chosen.
    if (location) {
      await setFestivalSuggestionsLocation({ ngo_id, month, observance_date, festival, location });
    }
  }

  // Re-read the batch so the caller gets real ids and the user's current ticks.
  return getFestivalSuggestions({ month, year, ngo_id, activity_id, date: observance_date, festival, batch_no });
};

/* Writes the Beneficiary dropdown's chosen category onto every stored
   suggestion of one festival (NGO + month + date + festival). Called by the
   generator after a run, and by the planner when the user changes the dropdown
   without regenerating — the grid, the post-reload fallback and the Excel/PDF
   export must all show the category that was actually picked. The write also
   records that the value WAS picked (beneficiary_picked, migration 176);
   clearing the dropdown stores null and drops the flag, so the reads know
   nothing was chosen. */
export const setFestivalSuggestionsBeneficiary = async ({
  ngo_id, month, observance_date, festival, beneficiary = null,
}) => {
  if (ngo_id === undefined || ngo_id === null || ngo_id === '') return 0;
  const pickedColumn = await festivalBeneficiaryPickedColumnExists();
  const patch = { beneficiary: beneficiary || null };
  if (pickedColumn) patch.beneficiary_picked = Boolean(beneficiary);
  const { data, error } = await db.from('event_head_festival_suggestions')
    .update(patch)
    .eq('month', Number(month))
    .eq('observance_date', observance_date)
    .eq('festival', String(festival || '').trim())
    .eq('ngo_id', ngo_id)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
};

/* Writes the Location dropdown's chosen spot onto every stored suggestion of
   one festival (NGO + month + date + festival), exactly like the Beneficiary
   writer above — the grid, the post-reload fallback and the Excel/PDF export
   must all show the place that was actually picked, even when the user never
   regenerates. The value is free text (a known location from the client's
   per-NGO list, or anything typed under "Other…"); clearing the dropdown
   stores null. Until migration 177 is applied the column does not exist, so
   the write degrades to a no-op like the other post-176/177 probes and the
   field is simply not persisted (apply the migration and restart the server). */
export const setFestivalSuggestionsLocation = async ({
  ngo_id, month, observance_date, festival, location = null,
}) => {
  if (ngo_id === undefined || ngo_id === null || ngo_id === '') return 0;
  const locationColumn = await festivalColumnExists('location');
  if (!locationColumn) return 0;
  const { data, error } = await db.from('event_head_festival_suggestions')
    .update({ location: location || null })
    .eq('month', Number(month))
    .eq('observance_date', observance_date)
    .eq('festival', String(festival || '').trim())
    .eq('ngo_id', ngo_id)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
};

export const getFestivalSuggestions = async ({
  ngo_id, activity_id, month, year, date, festival, batch_no, selected_only = false,
} = {}) => {
  let query = db.from('event_head_festival_suggestions').select('*').order('observance_date', { ascending: true }).order('created_at', { ascending: true });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (activity_id) query = query.eq('activity_id', Number(activity_id));
  if (month) query = query.eq('month', Number(month));
  if (year) query = query.eq('year', Number(year));
  if (date) query = query.eq('observance_date', date);
  if (festival) query = query.eq('festival', String(festival).trim());
  if (batch_no) query = query.eq('batch_no', Number(batch_no));
  if (selected_only) query = query.eq('is_selected', true);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return rows;

  /* Every consumer — the grid, the Excel/PDF export, the Calendar report and
     the save's own re-read — comes through here, so withholding the
     beneficiary at this one point hides the NGO's old auto-filled default
     from every surface at once. After migration 176 a stored value is served
     only when it was really picked; until then a value equal to the NGO's
     mapped group is treated as auto-filled and withheld. See
     servedFestivalBeneficiary. */
  const pickedColumn = await festivalBeneficiaryPickedColumnExists();
  let codeByNgoId = null;
  if (!pickedColumn) {
    const ids = [...new Set(rows.map((r) => r.ngo_id).filter((v) => v !== null && v !== undefined && v !== ''))];
    if (ids.length) {
      const { data: ngoRows } = await db.from('ngos').select('id, code').in('id', ids);
      codeByNgoId = new Map((ngoRows || []).map((n) => [String(n.id), n.code]));
    }
  }
  return rows.map((r) => ({
    ...r,
    beneficiary: servedFestivalBeneficiary(r, {
      pickedColumn,
      ngoCode: codeByNgoId ? (codeByNgoId.get(String(r.ngo_id)) || '') : '',
    }),
  }));
};

export const setFestivalSuggestionSelected = async (id, is_selected, suggested_event_id) => {
  const patch = { is_selected: Boolean(is_selected) };
  if (suggested_event_id != null && suggested_event_id !== '') {
    const evId = Number(suggested_event_id);
    if (Number.isInteger(evId) && evId > 0) patch.suggested_event_id = evId;
  }
  const { data, error } = await db.from('event_head_festival_suggestions')
    .update(patch)
    .eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const getAllActivities = async ({ ngo_id, sector_id } = {}) => {
  let query = db.from('event_head_activities').select('*').order('created_at', { ascending: false });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (sector_id) query = query.eq('sector_id', sector_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getActivityById = async (id) => {
  const { data, error } = await db.from('event_head_activities').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
};

export const updateActivity = async (id, updates) => {
  const row = { ...updates };
  await prepareActivityRow(row);
  const { data, error } = await db.from('event_head_activities').update({ ...row, updated_at: new Date() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

/* How many events reference this activity, so the UI can say what a delete
   takes with it. Counts the join table (migration 092) and the legacy
   `activity_id` column, because an event created before the join table exists
   only has the column. */
export const countActivityEvents = async (id) => {
  const n = Number(id);
  const ids = await getEventIdsForActivity(n);
  return ids.length;
};

/* Events that would keep working but lose this activity's name: linked through
   the legacy `activity_id` column, which the join table does not own. Their
   column is cleared rather than left dangling, because a row pointing at a
   deleted activity renders as a nameless programme in the calendar.
   Run only after the join rows are gone, so nothing is still linked through
   both and silently dropped from the calendar. */
const unlinkLegacyEvents = async (id) => {
  const { error } = await db
    .from('event_head_events')
    .update({ activity_id: null })
    .eq('activity_id', Number(id));
  if (error) throw error;
};

/* Deletes the activity and everything keyed to it. Programmes are deliberately
   kept: the calendar must not lose a scheduled event because the activity it
   was named after is gone, so the links are cleared instead. Each step checks
   its error and stops on failure — a half-finished delete that left the activity
   in place with its suggestions removed would quietly lose the user's work. */
export const deleteActivity = async (id) => {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Activity not found');
  // Suggestions first: they are keyed by activity_id and would otherwise be
  // orphaned rows that nothing can ever resolve a name for.
  const sug = await db.from('event_head_planner_suggestions').delete().eq('activity_id', n);
  if (sug.error) throw sug.error;
  if (await joinTableExists()) {
    const join = await db.from('event_head_event_activities').delete().eq('activity_id', n);
    if (join.error) throw join.error;
  }
  await unlinkLegacyEvents(n);
  const { data, error } = await db.from('event_head_activities').delete().eq('id', n).select('id');
  if (error) throw error;
  if (!Array.isArray(data) || !data.length) throw new Error('Activity not found');
  return { message: 'Activity deleted' };
};

export const getActivityEventCounts = async () => {
  const { data, error } = await db.from('event_head_events').select('id, activity_id');
  if (error) throw error;
  const counts = {};
  for (const e of data || []) if (e.activity_id) counts[e.activity_id] = (counts[e.activity_id] || 0) + 1;
  return counts;
};

// ─── NGO CONTEXT (read-only, Event Head workspace) ───
const EVENT_HEAD_NGO_CODES = ['bsct', 'mann', 'aflf'];

export const getAllEventHeadNgos = async () => {
  const { data, error } = await db.from('ngos').select('id, name, code').order('name', { ascending: true });
  if (error) throw error;
  return (data || []).sort((a, b) => {
    const ia = EVENT_HEAD_NGO_CODES.indexOf(String(a.code || a.name || '').toLowerCase());
    const ib = EVENT_HEAD_NGO_CODES.indexOf(String(b.code || b.name || '').toLowerCase());
    return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib) || String(a.name || a.code).localeCompare(String(b.name || b.code));
  });
};

export const getEventHeadNgoById = async (ngoId) => {
  if (!ngoId) return null;
  const { data, error } = await db.from('ngos').select('id, name, code').eq('id', ngoId).maybeSingle();
  if (error) return null;
  return data;
};
