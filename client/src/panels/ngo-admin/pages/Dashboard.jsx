import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { Download, Trophy, TrendingUp, TriangleAlert, Phone, Target, CircleCheck, Megaphone, Zap, Users, Clock, X, Bell } from 'lucide-react';
import { apiGet, apiPost, apiPut, getFroHourlyPerformance, getFroDailyStats, getStationWiseCollection } from '../api/auth';
import { toast } from '../../../components/Toast';
import { SkeletonDashboard } from '../../../components/Skeleton';
import TeamWiseCollection from '../components/TeamWiseCollection';
import { useMeeting } from '../../../meetingStore';
import { onDbChange } from '../../../lib/socket';
import { formatDuration } from '../../../utils/formatDuration';
import { DISPOSITION_LABELS, DISPOSITION_GROUPS } from '../../../lib/dispositions';

// Station-wise Collection layout: two sibling cards, OLD on the left and NEW on
// the right, in the same two-column grid that holds Hourly Performance and FRO
// Status above.
//
// Each of the three team sections has exactly one station family per card:
//   BSCT  old BOD  / new BFD
//   AFLF  old AOD  / new AFD
//   MANN  old MOD  / new MFD
// The old families are the pre-rename station codes, the new ones the codes the
// bulk station rename produced for the same area. Splitting them across two cards
// lets an admin see, per area, what the old code collected against what the same
// area collects now.
//
// A station lands in a column purely on the prefix before the dash, so 'BOD-3'
// is an old BSCT station and 'BFD-1' is the new BSCT one.
const STATION_PANELS = [
  { key: 'old', title: 'OLD Stations', sub: 'Pre-rename codes', pick: s => s.old },
  { key: 'new', title: 'NEW Stations', sub: 'Current codes', pick: s => s.fresh },
];
const STATION_SECTIONS = [
  { label: 'BSCT', hue: 'blue', old: 'BOD', fresh: 'BFD' },
  { label: 'AFLF', hue: 'purple', old: 'AOD', fresh: 'AFD' },
  { label: 'MANN', hue: 'pink', old: 'MOD', fresh: 'MFD' },
];
const STATION_FAMILY_LIST = STATION_SECTIONS.flatMap(s => [s.old, s.fresh]);
const stationFamilyOf = (code) => {
  const prefix = String(code || '').trim().split('-')[0].toUpperCase();
  return STATION_FAMILY_LIST.includes(prefix) ? prefix : null;
};

// One palette per section, declared once so the section band, the family band
// and the cell accents can never drift out of step with each other.
const STATION_HUES = {
  blue: { head: '#1d4ed8', headBg: '#eff6ff', band: '#dbeafe', cell: '#3b82f6', rule: '#bfdbfe' },
  purple: { head: '#6d28d9', headBg: '#f5f3ff', band: '#ede9fe', cell: '#8b5cf6', rule: '#ddd6fe' },
  pink: { head: '#be185d', headBg: '#fdf2f8', band: '#fce7f3', cell: '#ec4899', rule: '#fbcfe8' },
};

// Compact in-rupee display, matching the Collection card above so the two read
// as the same number rather than looking like different quantities.
const formatRupees = (n) => {
  const v = Math.round(Number(n) || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};

// Stations are listed in code order, not by amount: BOD-1, BOD-2, BOD-3. The
// number after the dash decides, and it is compared numerically so BOD-10
// sorts after BOD-9 instead of before it as a plain string would. Falls back to
// the raw code when there is no number, then to a plain string compare, so
// odd codes like 'BOD-1A' or 'BOD-OLD' still order deterministically rather than
// being dropped.
const stationOrderKey = (station) => {
  const code = String(station ?? '');
  const m = code.match(/^(.*?)-(\d+)(.*)$/);
  if (!m) return [1, code, 0, code];
  return [0, m[1], Number(m[2]), m[3]];
};

const stationOrderCompare = (a, b) => {
  const ka = stationOrderKey(a);
  const kb = stationOrderKey(b);
  return ka[0] - kb[0]
    || ka[1].localeCompare(kb[1])
    || ka[2] - kb[2]
    || ka[3].localeCompare(kb[3])
    || String(a).localeCompare(String(b));
};

// Overdue buckets mirror the backend Telecaller split exactly: FU O/D is the
// follow-up family + promises, CB O/D is callbacks only. Any other past-due
// status counts in neither — so the modal list reconciles 1:1 with the counts.
const OD_FU_KEYS = new Set(['scheduled', 'follow_up', 'office_visit_scheduled', 'program_visit_scheduled', 'promise_to_pay', 'will_donate_online', 'payment_pending', 'promise_pay_wa_email']);
const OD_CB_KEYS = new Set(['callback']);
// Backend excludes these from overdue counting entirely.
const OD_EXCLUDED_KEYS = new Set(['reassigned', 'donation_collected']);
const overdueKindOf = (key) => {
  if (!key || OD_EXCLUDED_KEYS.has(key)) return null;
  if (OD_CB_KEYS.has(key)) return 'callback';
  if (OD_FU_KEYS.has(key)) return 'followup';
  return null;
};
const isPastDueRow = (d) => {
  const nd = d && d.next_follow_up ? String(d.next_follow_up).slice(0, 10) : null;
  if (!nd) return false;
  const t = new Date();
  const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return nd < todayStr;
};

const CONNECTED_STATUS_COLUMNS = [
  { key: 'scheduled', label: 'Follow Up', color: '#16a34a' },
  { key: 'callback', label: 'Callback', color: '#16a34a' },
  { key: 'office_program_visit', label: 'Office / Prog Visit', color: '#16a34a' },
  { key: 'promise_pay_wa_email', label: 'Promise Pay / WA / Email', color: '#16a34a' },
  { key: 'not_interested_np', label: 'Not Inter / Disc / NP', color: '#16a34a' },
  { key: 'dnd', label: 'DND', color: '#16a34a' },
];

// FRO hourly call target default: 200 connected calls per FRO per day over a 12-hr
// (09:00–21:00) working window. The daily figure is editable from the Connected vs
// Target card (stored server-side in settings.connected_call_target) and only
// connected calls count toward it. A 9-hour shift includes a 1-hour break, so
// the effective working time is 8 hours.
const HOURS_IN_WORKDAY = 8;
const DAILY_CONNECTED_TARGET = 200;

const MERGED_STATUS_GROUPS = {
  office_program_visit: ['office_visit_scheduled', 'program_visit_scheduled', 'office_program_visit'],
  promise_pay_wa_email: ['promise_to_pay', 'whatsapp_sent', 'email_sent', 'promise_pay_wa_email'],
  not_interested_np: ['not_interested', 'call_disconnected', 'not_possible', 'not_interested_np'],
  busy_call_waiting: ['busy', 'call_waiting', 'busy_call_waiting'],
  ooc_unreachable_network: ['out_of_coverage', 'unreachable', 'temporary_network_issue', 'ooc_unreachable_network'],
  ringing_voicemail: ['ringing', 'voicemail', 'ringing_voicemail'],
};

const statusMatches = (key, target) =>
  key === target || (MERGED_STATUS_GROUPS[target] || []).includes(key);

const mergedKeyOf = (key) => {
  if (!key) return null;
  if (MERGED_STATUS_GROUPS[key]) return key;
  for (const [group, members] of Object.entries(MERGED_STATUS_GROUPS)) {
    if (members.includes(key)) return group;
  }
  return null;
};

const NOT_CONNECTED_STATUS_COLUMNS = [
  { key: 'switched_off', label: 'Switched Off', color: '#dc2626' },
  { key: 'busy_call_waiting', label: 'Busy / Call Waiting', color: '#dc2626' },
  { key: 'ooc_unreachable_network', label: 'OOC / Unreach / Network', color: '#dc2626' },
  { key: 'ringing_voicemail', label: 'Ringing / Voicemail', color: '#dc2626' },
];

const CONNECTED_IDS = new Set(['contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'callback', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'office_program_visit', 'promise_pay_wa_email', 'not_interested_np', 'office_visit_scheduled', 'program_visit_scheduled', 'not_possible', 'resolved_suspense']);

const NOT_CONNECTED_IDS = new Set(['busy', 'ringing', 'call_waiting', 'unreachable', 'switched_off', 'out_of_coverage', 'wrong_number', 'invalid', 'invalid_number', 'rejected', 'temporary_network_issue', 'voicemail', 'incoming_out', 'busy_call_waiting', 'ooc_unreachable_network', 'ringing_voicemail']);

const PER_PAGE = 50;

const toIstDate = (d = new Date()) =>
  new Date(new Date(d).getTime() + ((5 * 60) + 30) * 60000).toISOString().slice(0, 10);

// An entry in `overrides` is a PENDING confirmation marker, never a source of
// truth. It is written by handleTogglePause only after the pause/resume POST has
// already resolved, and that same call forces the next poll uncached, so the row
// that comes back one poll later is fresh by construction and the server has
// already committed the change. There is therefore no race for the override to
// paper over, and it must never outrank the server.
//
// It used to. A disagreement was read as cache lag, so the local intent was
// re-asserted for the whole 120s window. When an FRO resumed themselves the
// server correctly wrote is_paused=false, the admin's poll correctly received
// it, and this function threw it away and put `true` back — pinning the card on
// "Paused" for up to two minutes while the FRO worked normally. Yielding to the
// server instead means a rejected or lost action self-corrects on the next poll
// rather than lying, and the 120s expiry below is now only a bound on how long a
// marker can survive without the server ever confirming or contradicting it.
const mergePauseState = (payload, overrides) => {
  if (!payload || !Array.isArray(payload.performance) || !overrides.size) return payload;
  for (const row of payload.performance) {
    const key = String(row.fro_id);
    const intent = overrides.get(key);
    if (!intent) continue;
    if (intent.expiresAt <= Date.now()) { overrides.delete(key); continue; }
    if (!!row.is_paused === intent.paused) overrides.delete(key);
  }
  return payload;
};

const PERIOD_LABELS = { today: 'Today', yesterday: 'Yesterday', weekly: 'This Week', monthly: 'This Month', custom: 'Custom Range' };



const NGO_TABS = [
  ['', 'All'],
  ['bsct', 'BSCT'],
  ['aflf', 'AFLF'],
  ['mann', 'MANN'],
];

const NGO_COLORS = { bsct: '#2563eb', mann: '#ec4899', aflf: '#8b5cf6' };
const ngoColorOf = (name) => {
  const hit = NGO_TABS.find(([c]) => c && (name || '').toLowerCase().includes(c));
  return hit ? (NGO_COLORS[hit[0]] || '#6366f1') : '#6366f1';
};
const ngoSortRank = (name) => {
  const hit = NGO_TABS.find(([c]) => c && (name || '').toLowerCase().includes(c));
  return hit ? NGO_TABS.indexOf(hit) : 99;
};

function StationDetailModal({ station, stats, stationInfo, ngoId, onClose }) {
  const [donors, setDonors] = useState([]);
  const [loadingDonors, setLoadingDonors] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  if (!station) return null;
  const total = Object.values(stats || {}).reduce((t, v) => t + v, 0);
  const groupData = DISPOSITION_GROUPS.map(g => ({
    ...g, total: g.statuses.reduce((t, s) => t + (stats?.[s] || 0), 0),
  })).filter(g => g.total > 0);
  const allStatuses = DISPOSITION_GROUPS.flatMap(g =>
    g.statuses.filter(s => (stats?.[s] || 0) > 0).map(s => ({ status: s, count: stats[s], group: g }))
  );

  const donorsRef = useRef(null);
  const fetchDonors = useCallback(async (status) => {
    if (donorsRef.current) donorsRef.current.abort();
    const controller = new AbortController();
    donorsRef.current = controller;
    setLoadingDonors(true);
    setStatusFilter(status || '');
    try {
      // ngo_id is required for a correct count: a station NAME is shared across
      // NGOs (DH-5 is BOD-15/AOD-15/MOD-15), so omitting it unions unrelated
      // stations and the donor total silently disagrees with the station's own
      // figure. `ngoId` is the station's own NGO, resolved by the caller, so it
      // stays scoped even when the admin is viewing the combined "All" tab.
      const params = new URLSearchParams({ station });
      if (ngoId) params.set('ngo_id', ngoId);
      if (status) params.set('status', status);
      const data = await apiGet(`/ngo-admin/donors-by-station?${params}`, { signal: controller.signal, timeout: 30000 });
      if (!controller.signal.aborted) {
        setDonors(data || []);
        setPage(1);
      }
    } catch {
      if (!controller.signal.aborted) setDonors([]);
    } finally {
      if (!controller.signal.aborted) setLoadingDonors(false);
    }
  }, [station]);

  const filtered = useMemo(() => {
    if (!search) return donors;
    const q = search.toLowerCase();
    return donors.filter(d =>
      (d.donor_name && d.donor_name.toLowerCase().includes(q)) ||
      (d.donor_mobile && d.donor_mobile.includes(q)) ||
      (d.donor_city && d.donor_city.toLowerCase().includes(q)) ||
      (d.fro_name && d.fro_name.toLowerCase().includes(q))
    );
  }, [donors, search]);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paginated = useMemo(() => {
    const start = (page - 1) * PER_PAGE;
    return filtered.slice(start, start + PER_PAGE);
  }, [filtered, page]);

  useEffect(() => { setPage(1); }, [search]);

  const handleStatusClick = (status) => {
    if (statusFilter === status) {
      setStatusFilter('');
      setDonors([]);
    } else {
      fetchDonors(status);
    }
  };

  const handleClear = () => {
    setDonors([]);
    setStatusFilter('');
    setSearch('');
    setPage(1);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{station}</h3>
            {stationInfo?.fro_worker_name && (
              <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, background: 'var(--bg)', padding: '2px 10px', borderRadius: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                {stationInfo.fro_worker_name}
              </span>
            )}
            <span style={{ fontSize: 12, background: 'var(--sage)', color: '#fff', padding: '2px 10px', borderRadius: 12, fontWeight: 600 }}>
              {total} donors
            </span>
            {stationInfo?.ngos?.map(n => (
              <span key={n.ngo_id || n.ngo_name} style={{ fontSize: 11, background: '#eef2ff', color: '#6366f1', padding: '2px 8px', borderRadius: 12 }}>
                {n.ngo_name}
              </span>
            ))}
          </div>
          <button className="btn btn-sm btn-outline" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">
          {groupData.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ height: 8, borderRadius: 4, background: '#e5e7eb', display: 'flex', overflow: 'hidden' }}>
                {groupData.map(g => (
                  <div key={g.label} style={{ width: `${(g.total / total) * 100}%`, height: '100%', background: g.color, opacity: 0.6 }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                {groupData.map(g => (
                  <span key={g.label} style={{ fontSize: 11, fontWeight: 600, color: g.color, background: g.bg, padding: '2px 10px', borderRadius: 10 }}>
                    {g.label}: {g.total}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Disposition Breakdown
            {statusFilter && (
              <span style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                — click a status to view donors
              </span>
            )}
          </div>

          {allStatuses.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 16 }}>
              {allStatuses.map(({ status, count, group }) => (
                <button key={status} onClick={() => handleStatusClick(status)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '3px 10px', borderRadius: 20, border: `1px solid ${statusFilter === status ? group.color : 'transparent'}`,
                    background: statusFilter === status ? group.bg : 'var(--bg)',
                    cursor: 'pointer', fontSize: 12, fontWeight: statusFilter === status ? 700 : 500,
                    color: statusFilter === status ? group.color : 'var(--ink-soft)',
                    transition: 'all .15s',
                  }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: group.color, flexShrink: 0 }} />
                  {DISPOSITION_LABELS[status] || status}
                  <span style={{ fontWeight: 700, color: group.color, marginLeft: 2 }}>{count}</span>
                </button>
              ))}
            </div>
          )}

          {!statusFilter && !donors.length && (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
              Click a disposition above to view donor list for that status.
            </div>
          )}

          {(statusFilter || donors.length > 0) && (
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 4 }}>
              <div className="filter-bar" style={{ marginBottom: 12 }}>
                <input placeholder="Search name, phone, city..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 240 }} />
                {statusFilter && (
                  <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: '#f0f2ee', color: 'var(--ink-soft)', fontWeight: 500 }}>
                    {DISPOSITION_LABELS[statusFilter] || statusFilter}
                  </span>
                )}
                <span className="count">{loadingDonors ? 'Loading...' : `${filtered.length} donors`}</span>
                {donors.length > 0 && (
                  <button className="btn btn-sm btn-outline" onClick={handleClear}>Clear</button>
                )}
              </div>

              {loadingDonors ? (
                <div className="loading" style={{ padding: 20 }}>Loading donors...</div>
              ) : paginated.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Phone</th>
                        <th>City</th>
                        <th>FRO</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginated.map(d => (
                        <tr key={d.id}>
                          <td style={{ fontWeight: 500 }}>{d.donor_name || '—'}</td>
                          <td>{d.donor_mobile || '—'}</td>
                          <td>{d.donor_city || '—'}</td>
                          <td style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{d.fro_name || 'Unassigned'}</td>
                          <td><span className="pill" style={{
                            background: (() => { const g = DISPOSITION_GROUPS.find(gr => gr.statuses.includes(d.status)); return g ? g.bg : '#f3f4f6'; })(),
                            color: (() => { const g = DISPOSITION_GROUPS.find(gr => gr.statuses.includes(d.status)); return g ? g.color : '#6b7280'; })(),
                          }}>{DISPOSITION_LABELS[d.status] || d.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
                  No donors match this filter.
                </div>
              )}

              {totalPages > 1 && !loadingDonors && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 0 4px' }}>
                  <button className="btn btn-sm btn-outline" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                    Previous
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                    <button key={p} className={`btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPage(p)} style={{ minWidth: 32 }}>
                      {p}
                    </button>
                  ))}
                  <button className="btn btn-sm btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CollectionDetailModal({ period: defaultPeriod, totalAmount, onClose, status, monthAmount, monthCount, todayAmount, todayCount }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState(defaultPeriod || 'month');

  const isVerification = status === 'verified' || status === 'unverified';
  const label = status === 'verified' ? 'Verified' : status === 'unverified' ? 'Unverified' : 'Collection';

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const url = isVerification
      ? `/ngo-admin/verification?status=${status}&period=${period}`
      : `/ngo-admin/collections/fro-wise?period=${period}`;
    apiGet(url, { signal: controller.signal, timeout: 30000 })
      .then(data => { if (!controller.signal.aborted) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!controller.signal.aborted) setRows([]); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period, status, isVerification]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => (r.fro_name || '').toLowerCase().includes(q));
  }, [rows, search]);

  const isMonth = period === 'month';
  const now = new Date();
  const dateTitle = isMonth
    ? now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    : `Today – ${now.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const title = isVerification ? `${label} Collections — ${dateTitle}` : dateTitle;

  const displayAmount = isVerification
    ? (period === 'month' ? (monthAmount || 0) : (todayAmount || 0))
    : rows.reduce((s, r) => s + (r.collection_amount || 0), 0);
  const totalLeads = rows.reduce((s, r) => s + (r.count || 0), 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 500 }}>
              {rows.length} FRO{rows.length !== 1 ? 's' : ''}
            </span>
            <button className="btn btn-sm btn-outline" onClick={onClose} style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></button>
          </div>
        </div>
        <div className="modal-body" style={{ padding: '14px 18px' }}>
          {loading ? (
            <div className="loading" style={{ padding: 20 }}>Loading...</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
              No {label.toLowerCase()} collection data available.
            </div>
          ) : (
            <>
              {isVerification && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                  <button onClick={() => setPeriod('month')} style={{
                    padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: period === 'month' ? '1.5px solid var(--sage)' : '1px solid var(--line)',
                    background: period === 'month' ? '#f0fdf4' : 'transparent',
                    color: period === 'month' ? 'var(--sage)' : 'var(--ink-soft)',
                  }}>Month</button>
                  <button onClick={() => setPeriod('today')} style={{
                    padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: period === 'today' ? '1.5px solid #f59e0b' : '1px solid var(--line)',
                    background: period === 'today' ? '#fffbeb' : 'transparent',
                    color: period === 'today' ? '#b45309' : 'var(--ink-soft)',
                  }}>Today</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="Search FRO name..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    flex: 1, padding: '7px 10px', border: '1px solid var(--line)',
                    borderRadius: 6, fontSize: 12, fontFamily: 'inherit', outline: 'none',
                    background: 'var(--bg)', color: 'var(--ink)',
                  }}
                />
                {search && (
                  <button onClick={() => setSearch('')} className="btn btn-sm btn-outline">Clear</button>
                )}
              </div>
              {search && (
                <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 8 }}>
                  Showing {filtered.length} of {rows.length} FRO{rows.length !== 1 ? 's' : ''}
                </div>
              )}

              <div style={{ overflowX: 'auto', maxHeight: '50vh', overflowY: 'auto', borderRadius: 6, border: '1px solid var(--line)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--line)' }}>
                        FRO Name
                      </th>
                      <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--line)' }}>
                        {isVerification ? 'Amount (₹)' : 'Collection (₹)'}
                      </th>
                      {isVerification && (
                        <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--line)' }}>
                          Leads
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(r => {
                      const val = isVerification ? r.amount : r.collection_amount;
                      return (
                        <tr key={r.fro_id} style={{ borderBottom: '1px solid var(--line)', transition: 'background .1s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}
                        >
                          <td style={{ padding: '8px 10px', fontWeight: 500 }}>{r.fro_name}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: val > 0 ? 'var(--sage)' : '#9ca3af' }}>
                            ₹{Number(val).toLocaleString('en-IN')}
                            {!isVerification && r.is_achieved && (
                              <span style={{ fontSize: 9, color: '#8b5cf6', fontWeight: 500, marginLeft: 4, verticalAlign: 'middle' }}>(set)</span>
                            )}
                          </td>
                          {isVerification && (
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500, color: 'var(--ink-soft)' }}>
                              {r.count || 0}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={isVerification ? 3 : 2} style={{ padding: 16, textAlign: 'center', color: 'var(--ink-soft)', fontSize: 12 }}>
                          No FROs match your search.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ padding: '10px', fontWeight: 700, borderTop: '2px solid var(--line)', fontSize: 13 }}>Total</td>
                      <td style={{ padding: '10px', textAlign: 'right', fontWeight: 700, borderTop: '2px solid var(--line)', color: 'var(--sage)', fontSize: 13 }}>
                        ₹{displayAmount.toLocaleString('en-IN')}
                      </td>
                      {isVerification && (
                        <td style={{ padding: '10px', textAlign: 'right', fontWeight: 700, borderTop: '2px solid var(--line)', color: 'var(--ink-soft)', fontSize: 13 }}>
                          {totalLeads}
                        </td>
                      )}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const FRO_STATUS_META = {
  on_call: { label: 'Calling', dot: '#16a34a', name: '#15803d' },
  online: { label: 'Online', dot: '#16a34a', name: '#15803d' },
  offline: { label: 'Offline', dot: '#dc2626', name: null },
};

function FroDetailModal({ froId, froName, filterType, rangeFrom, rangeTo, status, onClose }) {
  const [allDonors, setAllDonors] = useState([]);
  const [loadingDonors, setLoadingDonors] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(status || '');
  const [page, setPage] = useState(1);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Overdue views fetch the FRO's FULL assignment list (no date range): the
  // count covers every past-due assignment, including ones with no recent
  // logs — a ranged fetch would silently drop those and disagree with it.
  const isOverdueView = status === 'overdue_callback' || status === 'overdue_followup';
  useEffect(() => {
    if (!froId) return;
    setLoadingDonors(true);
    const params = new URLSearchParams({ fro_worker_id: froId });
    if (!isOverdueView) {
      if (rangeFrom) params.set('from', rangeFrom);
      if (rangeTo) params.set('to', rangeTo);
    }
    apiGet(`/ngo-admin/donors-by-fro?${params}`)
      .then(data => setAllDonors(data || []))
      .catch(() => setAllDonors([]))
      .finally(() => setLoadingDonors(false));
  }, [froId, rangeFrom, rangeTo]);

  const isNonConnected = filterType === 'non_connected';
  const filterColor = isNonConnected ? '#dc2626' : '#16a34a';
  const filterBg = isNonConnected ? '#fef2f2' : '#f0fdf4';
  const filterLabel = status ? (DISPOSITION_LABELS[status] || status) : (isNonConnected ? 'Non-Connected' : 'Connected');

  const hasPeriodData = Boolean(rangeFrom || rangeTo);

  const stack = isNonConnected ? NOT_CONNECTED_STATUS_COLUMNS : CONNECTED_STATUS_COLUMNS;

  const baseList = useMemo(() => {
    const getKey = (d) => hasPeriodData && d.call_status ? d.call_status : d.status;
    const deduped = [];
    const seenDonors = new Set();
    for (const d of allDonors) {
      if (d.donor_id && seenDonors.has(d.donor_id)) continue;
      if (d.donor_id) seenDonors.add(d.donor_id);
      deduped.push(d);
    }
    if (status === 'overdue_callback' || status === 'overdue_followup') {
      const want = status === 'overdue_callback' ? 'callback' : 'followup';
      return deduped.filter(d => overdueKindOf(getKey(d)) === want && isPastDueRow(d));
    }
    if (status) return deduped.filter(d => statusMatches(getKey(d), status));
    const sideOf = (d) => {
      const k = getKey(d);
      if (NOT_CONNECTED_IDS.has(k)) return 'not_connected';
      if (CONNECTED_IDS.has(k)) return 'connected';
      if (hasPeriodData && d.call_category) return String(d.call_category).toLowerCase();
      return null;
    };
    if (isNonConnected) return deduped.filter(d => sideOf(d) === 'not_connected');
    return deduped.filter(d => sideOf(d) === 'connected');
  }, [allDonors, isNonConnected, hasPeriodData, status]);

  const total = baseList.length;

  const stackCounts = useMemo(() => {
    const counts = {};
    let others = 0;
    for (const d of baseList) {
      const key = hasPeriodData && d.call_status ? d.call_status : d.status;
      const mk = mergedKeyOf(key);
      if (mk && stack.some(c => c.key === mk)) counts[mk] = (counts[mk] || 0) + 1;
      else others++;
    }
    const chips = stack.map(c => ({ ...c, count: counts[c.key] || 0 })).filter(c => c.count > 0);
    if (others > 0) chips.push({ key: 'others', label: 'Others', color: '#5B6B4E', count: others });
    return chips;
  }, [baseList, hasPeriodData, stack]);

  const donorsRef = useRef(null);
  const fetchDonors = useCallback(async (status) => {
    if (donorsRef.current) donorsRef.current.abort();
    const controller = new AbortController();
    donorsRef.current = controller;
    setStatusFilter(status || '');
    setPage(1);
    try {
      const params = new URLSearchParams({ fro_worker_id: froId });
      const overdueChip = status && status.startsWith('overdue_');
      if (!overdueChip) {
        if (rangeFrom) params.set('from', rangeFrom);
        if (rangeTo) params.set('to', rangeTo);
      }
      // Overdue pseudo-statuses filter client-side (past-due dates), so the
      // server must return the full list unfiltered.
      if (status && !overdueChip) params.set('status', status);
      const data = await apiGet(`/ngo-admin/donors-by-fro?${params}`, { signal: controller.signal, timeout: 30000 });
      if (!controller.signal.aborted) setAllDonors(data || []);
    } catch {
      if (!controller.signal.aborted) setAllDonors([]);
    }
  }, [froId, rangeFrom, rangeTo]);

  const filtered = useMemo(() => {
    let list = baseList;
    if (statusFilter) {
      list = list.filter(d => {
        const key = hasPeriodData && d.call_status ? d.call_status : d.status;
        if (statusFilter === 'overdue_callback' || statusFilter === 'overdue_followup') {
          const want = statusFilter === 'overdue_callback' ? 'callback' : 'followup';
          return overdueKindOf(key) === want && isPastDueRow(d);
        }
        if (statusFilter === 'others') {
          const mk = mergedKeyOf(key);
          return !mk || !stack.some(c => c.key === mk);
        }
        return statusMatches(key, statusFilter);
      });
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(d =>
        (d.donor_name && d.donor_name.toLowerCase().includes(q)) ||
        (d.donor_mobile && d.donor_mobile.includes(q)) ||
        (d.station && d.station.toLowerCase().includes(q))
      );
    }
    return list;
  }, [baseList, statusFilter, search, stack]);

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paginated = useMemo(() => {
    const start = (page - 1) * PER_PAGE;
    return filtered.slice(start, start + PER_PAGE);
  }, [filtered, page]);

  useEffect(() => { setPage(1); }, [search, statusFilter]);

  const handleStatusClick = (status) => {
    setStatusFilter(prev => prev === status ? '' : status);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{froName}</h3>
            <span style={{ fontSize: 12, fontWeight: 600, color: filterColor, background: filterBg, padding: '2px 10px', borderRadius: 12 }}>
              {total} {filterLabel}
            </span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>of {allDonors.length} total</span>
          </div>
          <button className="btn btn-sm btn-outline" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>
          {loadingDonors ? (
            <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>Loading donors...</div>
          ) : total === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>No {filterLabel.toLowerCase()} donors found</div>
          ) : (
            <>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Disposition Breakdown
                <span style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                  — click a status to view donors
                </span>
              </div>

              {stackCounts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 16 }}>
                  {stackCounts.map(({ key, label, color, count }) => (
                    <button key={key} onClick={() => handleStatusClick(key)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '3px 10px', borderRadius: 20, border: `1px solid ${statusFilter === key ? color : 'transparent'}`,
                        background: statusFilter === key ? `${color}1a` : 'var(--bg)',
                        cursor: 'pointer', fontSize: 12, fontWeight: statusFilter === key ? 700 : 500,
                        color: statusFilter === key ? color : 'var(--ink-soft)',
                        transition: 'all .15s',
                      }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      {label}
                      <span style={{ fontWeight: 700, color, marginLeft: 2 }}>{count}</span>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 4 }}>
                <div className="filter-bar" style={{ marginBottom: 12 }}>
                  <input placeholder="Search name, phone, station..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 240 }} />
                  {statusFilter && (
                    <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: '#f0f2ee', color: 'var(--ink-soft)', fontWeight: 500 }}>
                      {DISPOSITION_LABELS[statusFilter] || statusFilter}
                    </span>
                  )}
                  <span className="count">{loadingDonors ? 'Loading...' : `${filtered.length} donors`}</span>
                  {statusFilter && (
                    <button className="btn btn-sm btn-outline" onClick={() => { setStatusFilter(''); setSearch(''); setPage(1); }}>Clear</button>
                  )}
                </div>

                {paginated.length > 0 ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Name</th>
                          <th>Phone</th>
                          <th>Station</th>
                          <th>Status</th>
                          {statusFilter === 'others' && <th>Remark</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {paginated.map((d, i) => {
                          const displayStatus = hasPeriodData && d.call_status ? d.call_status : d.status;
                          const mk = mergedKeyOf(displayStatus);
                          const col = mk ? [...CONNECTED_STATUS_COLUMNS, ...NOT_CONNECTED_STATUS_COLUMNS].find(c => c.key === mk) : null;
                          const pillColor = col ? col.color : '#6b7280';
                          return (
                            <tr key={d.id || d.donor_id}>
                              <td style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{(page - 1) * PER_PAGE + i + 1}</td>
                              <td style={{ fontWeight: 500 }}>
                                {d.donor_name || '—'}
                                {d.owner_name && froName && String(d.owner_name).trim().toLowerCase() !== String(froName).trim().toLowerCase() && (
                                  <span title={`Assignment owned by ${d.owner_name} — worked via Work-As`} style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 700, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>via {d.owner_name}</span>
                                )}
                              </td>
                              <td>{d.donor_mobile || '—'}</td>
                              <td style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{d.station || '—'}</td>
                              <td><span className="pill" style={{
                                background: `${pillColor}1a`,
                                color: pillColor,
                              }}>{DISPOSITION_LABELS[mk || displayStatus] || displayStatus}</span></td>
                              {statusFilter === 'others' && (
                                <td style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{d.call_remark || d.notes || '—'}</td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--ink-soft)' }}>
                    No donors match this filter.
                  </div>
                )}

                {totalPages > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 0 4px' }}>
                    <button className="btn btn-sm btn-outline" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                      Previous
                    </button>
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                      const p = totalPages <= 5 ? i + 1 : Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
                      return (
                        <button key={p} className={`btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPage(p)} style={{ minWidth: 32 }}>
                          {p}
                        </button>
                      );
                    })}
                    <button className="btn btn-sm btn-outline" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                      Next
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [stationStats, setStationStats] = useState(null);
  const [stationsData, setStationsData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedStation, setSelectedStation] = useState(null);
  const [selectedPeriod, setSelectedPeriod] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedNgoId, setSelectedNgoId] = useState('all');
  const [ngoTab, setNgoTab] = useState('');
  const [dashPeriod, setDashPeriod] = useState('today');
  const [customFrom, setCustomFrom] = useState(() => toIstDate());
  const [customTo, setCustomTo] = useState(() => toIstDate());
  const [selectedFroId, setSelectedFroId] = useState('');
  const [accessibleNgos, setAccessibleNgos] = useState([]);
  // High / Low Performance read the org-wide leaderboard directly rather than the
  // Telecaller board's rows: these panels rank every FRO across all accessible
  // NGOs and gate on punch-in, which the NGO-filtered board does not do.
  const [weakPerformers, setWeakPerformers] = useState([]);
  const [weakLoading, setWeakLoading] = useState(false);
  const [highPerfSearch, setHighPerfSearch] = useState('');
  const [lowPerfSearch, setLowPerfSearch] = useState('');
  // Which half of the below-target roster Low Performance shows. Defaults to
  // 'present' so the panel answers "who came in and underperformed", which is the
  // question the panel exists for; the Absent tab is one click away for the other
  // half, and the footer always reports both counts so neither is hidden.
  const [lowPerfAttendance, setLowPerfAttendance] = useState('present');
  const [froSearch, setFroSearch] = useState('');
  const [perfStatusFilter, setPerfStatusFilter] = useState('all');
  const [perfSort, setPerfSort] = useState({ key: null, dir: 1 });
  const [selectedFro, setSelectedFro] = useState(null);
  const [hourlyExportFrom, setHourlyExportFrom] = useState(() => toIstDate());
  const [hourlyExportTo, setHourlyExportTo] = useState(() => toIstDate());
  const [froHourlyData, setFroHourlyData] = useState([]);
  const [hourlyList, setHourlyList] = useState([]);
  const [hourlyFroRows, setHourlyFroRows] = useState([]);
  const [hourlyLoading, setHourlyLoading] = useState(false);
  const [presentSearch, setPresentSearch] = useState('');
  const [hourlyFroSearch, setHourlyFroSearch] = useState('');
  const [connTarget, setConnTarget] = useState(DAILY_CONNECTED_TARGET);
  const [connTargetOpen, setConnTargetOpen] = useState(false);
  const [connTargetDraft, setConnTargetDraft] = useState('');
  const [connTargetBusy, setConnTargetBusy] = useState(false);
  const [connTargetMsg, setConnTargetMsg] = useState('');
  const [dailyStats, setDailyStats] = useState([]);

  // Station-wise Collection. The month picker is deliberately independent of the
  // header dashPeriod: this panel is a monthly revenue breakdown, so a "Today" or
  // "Last 7 days" header filter would silently narrow it to a partial month and
  // make the station ranking contradict the Collection card above.
  const [stationCollection, setStationCollection] = useState(null);
  const [stationMonth, setStationMonth] = useState(() => {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}`;
  });
  const [stationLoading, setStationLoading] = useState(false);

  // Global date range (derived from the header filter) used by the table & exports
  const activeRange = useMemo(() => {
    const now = new Date();
    if (dashPeriod === 'today') return { from: toIstDate(), to: toIstDate() };
    if (dashPeriod === 'yesterday') { const d = toIstDate(new Date(Date.now() - 86400000)); return { from: d, to: d }; }
    if (dashPeriod === 'weekly') {
      const s = new Date(now); s.setDate(now.getDate() - now.getDay());
      return { from: toIstDate(s), to: toIstDate(now) };
    }
    if (dashPeriod === 'monthly') {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toIstDate(s), to: toIstDate(now) };
    }
    return { from: customFrom, to: customTo };
  }, [dashPeriod, customFrom, customTo]);

  // Hourly performance/alerts date follows the top global filter: for a single-day
  // range use that day, otherwise show the last day of the range.
  const hourlyDate = useMemo(() => {
    const { from, to } = activeRange;
    if (from && from === to) return from;
    return to || toIstDate();
  }, [activeRange]);

  // Auto-update hourly export date range from the global header filter
  useEffect(() => {
    if (activeRange.from) setHourlyExportFrom(activeRange.from);
    if (activeRange.to) setHourlyExportTo(activeRange.to);
  }, [activeRange]);

  // Fetch FRO-level hourly performance when date range or NGO changes
  useEffect(() => {
    let cancelled = false;
    getFroHourlyPerformance({ from: hourlyExportFrom, to: hourlyExportTo, ...(selectedNgoId !== 'all' ? { ngo_id: selectedNgoId } : {}) })
      .then(data => { if (!cancelled) setFroHourlyData(data || []); })
      .catch(() => { if (!cancelled) setFroHourlyData([]); });
    return () => { cancelled = true; };
  }, [hourlyExportFrom, hourlyExportTo, selectedNgoId]);

  // Fetch aggregate hourly stats for the selected date
  useEffect(() => {
    let cancelled = false;
    setHourlyLoading(true);
    getFroHourlyPerformance({ from: hourlyDate, to: hourlyDate, ...(selectedNgoId !== 'all' ? { ngo_id: selectedNgoId } : {}) })
      .then(data => {
        if (!cancelled) {
          setHourlyFroRows(data || []);
          const hourSlots = Array.from({ length: 12 }, (_, i) => 
            `${String(9+i).padStart(2, '0')}:00-${String(10+i).padStart(2, '0')}:00`
          );
          const aggregated = {};
          for (const h of hourSlots) {
            aggregated[h] = { hour: h, calls: 0, connected: 0, non_connected: 0, interested: 0, donations: 0, amount: 0, connected_statuses: {}, non_connected_statuses: {} };
          }
          for (const row of data || []) {
            if (aggregated[row.hour]) {
              const a = aggregated[row.hour];
              a.calls += (row.calls || 0);
              a.connected += (row.connected || 0);
              a.non_connected += (row.non_connected || 0);
              a.interested += (row.interested || 0);
              a.donations += (row.donations || 0);
              a.amount += (row.amount || 0);
              for (const [k, v] of Object.entries(row.connected_statuses || {})) a.connected_statuses[k] = (a.connected_statuses[k] || 0) + v;
              for (const [k, v] of Object.entries(row.non_connected_statuses || {})) a.non_connected_statuses[k] = (a.non_connected_statuses[k] || 0) + v;
            }
          }
          setHourlyList(Object.values(aggregated));
        }
      })
      .catch(() => { if (!cancelled) { setHourlyList([]); setHourlyFroRows([]); } })
      .finally(() => { if (!cancelled) setHourlyLoading(false); });
    return () => { cancelled = true; };
  }, [hourlyDate, selectedNgoId]);

  // Saved per-day activity for the selected date (calls + rank).
  useEffect(() => {
    let cancelled = false;
    getFroDailyStats({ date: hourlyDate, ...(selectedNgoId !== 'all' ? { ngo_id: selectedNgoId } : {}) })
      .then(data => { if (!cancelled) setDailyStats(data || []); })
      .catch(() => { if (!cancelled) setDailyStats([]); });
    return () => { cancelled = true; };
  }, [hourlyDate, selectedNgoId]);

  // Station-wise Collection: refetched on month or NGO change only. There is no
  // client-side filtering, so these are the only two inputs that trigger a fetch.
  useEffect(() => {
    let cancelled = false;
    setStationLoading(true);
    getStationWiseCollection({ month: stationMonth, ...(selectedNgoId !== 'all' ? { ngo_id: selectedNgoId } : {}) })
      .then(data => { if (!cancelled) setStationCollection(data); })
      .catch(() => { if (!cancelled) setStationCollection(null); })
      .finally(() => { if (!cancelled) setStationLoading(false); });
    return () => { cancelled = true; };
  }, [stationMonth, selectedNgoId]);

  // Bucket the month's stations by family, each ranked highest-collecting first.
  // Every family gets an entry, even one with nothing this month, so its column
  // still renders with its heading instead of vanishing from the layout.
  const stationsByFamily = useMemo(() => {
    const map = new Map(STATION_FAMILY_LIST.map(f => [f, []]));
    for (const r of (stationCollection?.stations || [])) {
      const f = r.family || stationFamilyOf(r.station);
      if (map.has(f)) map.get(f).push(r);
    }
    for (const list of map.values()) {
      // Station-code order, so a family reads BOD-1, BOD-2, BOD-3. Amount is no
      // longer the sort key: ranking by collection made the row positions shift
      // between sections, which cannot be reconciled into a per-row total.
      list.sort((a, b) => stationOrderCompare(a.station, b.station));
    }
    return map;
  }, [stationCollection]);

  // Editable "connected calls per day" target — loaded once from server settings
  // (shared by the whole team), falls back to the built-in default (200).
  useEffect(() => {
    let cancelled = false;
    apiGet('/settings')
      .then(s => { if (!cancelled && s && s.connected_call_target) setConnTarget(Number(s.connected_call_target) || DAILY_CONNECTED_TARGET); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const saveConnTarget = () => {
    const n = Math.round(Number(connTargetDraft));
    if (!Number.isFinite(n) || n <= 0 || n > 10000) {
      setConnTargetMsg('Enter a number between 1 and 10000.');
      return;
    }
    setConnTargetBusy(true);
    setConnTargetMsg('');
    apiPut('/settings', { connected_call_target: String(n) })
      .then(() => { setConnTarget(n); setConnTargetOpen(false); setConnTargetMsg(''); })
      .catch((e) => { setConnTargetMsg(e.message || 'Could not save target.'); })
      .finally(() => setConnTargetBusy(false));
  };

  // Derived: day totals + per-FRO productivity alerts for the selected hourly date
  const hourlyTotals = useMemo(() => {
    const t = { calls: 0, connected: 0, nonConnected: 0, interested: 0, donations: 0, amount: 0 };
    for (const h of hourlyList) {
      t.calls += h.calls || 0;
      t.connected += h.connected || 0;
      t.nonConnected += h.non_connected || 0;
      t.interested += h.interested || 0;
      t.donations += h.donations || 0;
      t.amount += h.amount || 0;
    }
    return t;
  }, [hourlyList]);

  const todayStr = new Date().toISOString().slice(0,10);
  const monthStart = new Date().toISOString().slice(0,7) + '-01';
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0,10);

  useEffect(() => {
    let cancelled = false;
    apiGet('/ngo-admin/ngos').then(data => { if (!cancelled) setAccessibleNgos(data); }).catch((err) => { console.error('API error:', err.message); });
    return () => { cancelled = true };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWeakLoading(true);
    const ngoParam = selectedNgoId !== 'all' ? `&ngo_id=${selectedNgoId}` : '';
    apiGet(`/ngo-admin/fro-performance?from=${activeRange.from}&to=${activeRange.to}${ngoParam}`)
      .then(data => { if (!cancelled) setWeakPerformers(data); })
      // Logged, not swallowed: a silent empty array renders as "nobody hit target"
      // on both panels, which reads as a real result rather than a failed load.
      .catch((e) => { console.error('fro-performance load failed:', e?.message || e); if (!cancelled) setWeakPerformers([]); })
      .finally(() => { if (!cancelled) setWeakLoading(false); });
    return () => { cancelled = true };
  }, [selectedNgoId, activeRange]);

  // FROs hidden from every reporting surface on this page.
  //
  // Two long-tenured FROs carrying real collections (Priyank Shah ₹1.2L, Anjana
  // Vyas ₹41K) but no monthly target, so every target-derived column on them read
  // ₹0 / blank. Telecaller Performance has always excluded them; this set now
  // applies to the High / Low panels too, so a FRO cannot be invisible in one
  // board and conspicuous in the next. High Performance is unaffected on its own
  // (it requires monthly_target > 0, which neither has); Low Performance is the
  // one that needed the explicit filter.
  //
  // The underlying rows are untouched in the database — this is a display
  // exclusion only, so clear the ids here once their targets are set and they
  // come back.
  const HIDDEN_FRO_IDS = useMemo(() => new Set([
    '0b6af56d-512c-4ffc-a671-a27ad7c7bfe0', // Priyank Shah
    '766fc6ea-9102-45d9-9475-812287d1bbd7', // Anjana Vyas
  ]), []);

  // High performers: at or above 100% of the period target, and only those who
  // actually punched in, best score first.
  const topPerformers = useMemo(() => weakPerformers.filter(p => !HIDDEN_FRO_IDS.has(p.fro_id) && p.monthly_target > 0 && p.punched_in === true && p.performance_pct >= 100).sort((a, b) => b.performance_pct - a.performance_pct), [weakPerformers, HIDDEN_FRO_IDS]);
  // Low performers: every FRO on the roster below 100% of the period target,
  // minus the display-excluded ids above. Present rows still sort ahead of absent
  // ones so the FROs who came in and underperformed are not buried under everyone
  // who never arrived.
  const lowAll = useMemo(() => weakPerformers
    .filter(p => !HIDDEN_FRO_IDS.has(p.fro_id) && p.performance_pct < 100)
    .sort((a, b) => (Number(b.punched_in) - Number(a.punched_in)) || (a.performance_pct - b.performance_pct)), [weakPerformers, HIDDEN_FRO_IDS]);
  // Absent FROs at or above target land in neither panel, so they are surfaced
  // in the footer to keep the two halves of the roster accounted for.
  const lowAboveTargetAbsent = useMemo(() => weakPerformers.filter(p => p.punched_in !== true && p.performance_pct >= 100).length, [weakPerformers]);

  // NGO filter pills from the admin's accessible NGOs
  const ngoFilterPills = useMemo(() => (accessibleNgos || []).filter(n => n && n.id).map(n => ({
    id: n.id,
    name: n.name || '',
    label: NGO_TABS.find(([c]) => c && (n.name || '').toLowerCase().includes(c))?.[1] || (n.name || 'NGO'),
    color: ngoColorOf(n.name),
  })), [accessibleNgos]);

  const [tlData, setTlData] = useState(null);
  const [tlRefreshNonce, setTlRefreshNonce] = useState(0);
  const tlRequestVersionRef = useRef(0);
  const tlForceFreshRef = useRef(false);
  const pauseOverridesRef = useRef(new Map());

  // Global meeting mode (from meetingStore): freezes live counts + suppresses
  // zero-call alerts while a company-wide meeting is active.
  const meeting = useMeeting();
  const meetingActive = !!meeting;

  // Full roster (search-independent) — every FRO competes, online or not, so the
  // numbering matches the FRO My Leads strip. High Performance stays punch-in
  // gated; Low Performance lists the whole below-target set.
  const topPresent = topPerformers;

  // Independent per-panel search (High / Low). Low Performance additionally
  // applies the Present / Absent tab; the two compose (search inside the tab).
  const highRows = useMemo(
    () => topPresent.filter(p => (p.fro_name || '').toLowerCase().includes(highPerfSearch.trim().toLowerCase())),
    [topPresent, highPerfSearch]
  );
  const lowRows = useMemo(
    () => lowAll.filter(p =>
      (lowPerfAttendance !== 'absent' ? p.punched_in === true : p.punched_in !== true)
      && (p.fro_name || '').toLowerCase().includes(lowPerfSearch.trim().toLowerCase())
    ),
    [lowAll, lowPerfSearch, lowPerfAttendance]
  );
  // Split of the below-target roster, so the footer can report both halves no
  // matter which tab is active.
  const lowAttendanceCounts = useMemo(() => ({
    present: lowAll.filter(p => p.punched_in === true).length,
    absent: lowAll.filter(p => p.punched_in !== true).length,
  }), [lowAll]);

  // FRO × hour groups for the hourly performance table — active
  // (online/on-call) FROs only, sorted low-performer-first; future hours are
  // excluded from totals today.
  // FROs who were ABSENT on the selected date (no attendance punch-in) are excluded.
  const hourlyGroups = useMemo(() => {
    const nowHourIST = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
    const dayIST = toIstDate();
    const isToday = hourlyDate === dayIST;
    const elapsedIdx = isToday ? Math.min(11, Math.max(-1, nowHourIST - 9)) : 12;
    const presentIds = (dailyStats && dailyStats.length > 0)
      ? new Set(dailyStats.filter(s => s.punched_in === true).map(s => String(s.fro_id)))
      : null;
    const hourIdxOf = (r) => {
      const m = /^(\d{2}):/.exec(r.hour || '');
      return m ? parseInt(m[1], 10) - 9 : -1;
    };
    const isFuture = (r) => isToday && elapsedIdx >= 0 && hourIdxOf(r) > elapsedIdx;

    const map = {};
    for (const r of hourlyFroRows) {
      const id = r.fro_worker_id ?? r.fro_name ?? 'Unknown';
      if (!map[id]) map[id] = { id, name: r.fro_name || 'Unknown', rows: [], connected: 0, nonConnected: 0, cells: 0, connPct: null };
      map[id].rows.push(r);
    }
    const groups = Object.values(map).map(g => {
      g.rows.sort((a, b) => (a.hour || '').localeCompare(b.hour || ''));
      g.connected = 0; g.nonConnected = 0; g.cells = 0;
      for (const r of g.rows) {
        if (isFuture(r)) continue;
        g.connected += r.connected || 0;
        g.nonConnected += r.non_connected || 0;
        g.cells++;
      }
      g.connPct = g.connected + g.nonConnected > 0 ? Math.round((g.connected / (g.connected + g.nonConnected)) * 100) : null;
      return g;
    }).filter(g => !presentIds || presentIds.has(String(g.id)));
    groups.sort((a, b) => (a.connected - b.connected) || a.name.localeCompare(b.name));
    return groups;
  }, [hourlyFroRows, tlData, hourlyDate, dailyStats]);

  const hourlyTotalsCalc = useMemo(() => {
    const totalConn = hourlyGroups.reduce((s, g) => s + g.connected, 0);
    const totalNon = hourlyGroups.reduce((s, g) => s + g.nonConnected, 0);
    return {
      totalConn,
      totalNon,
      overallConnPct: totalConn + totalNon > 0 ? Math.round((totalConn / (totalConn + totalNon)) * 100) : 0,
    };
  }, [hourlyGroups]);

  // Telecaller performance rows (search-filtered) + tab totals for the redesign.
  // The COLLECTION figures arrive on each row from /ngo-admin/tl-dashboard. An
  // earlier version joined /ngo-admin/fro-performance onto these rows by fro_id in
  // the browser; that rendered the whole block as ₹0 whenever that second request
  // failed, so the backend now sends the same leaderboard figures on the row.
  //
  // Shares HIDDEN_FRO_IDS with the High / Low panels, so a FRO is either shown
  // across the whole page or excluded from all of it.
  const perfRows = useMemo(() => (tlData?.performance || []).filter(p =>
    !HIDDEN_FRO_IDS.has(p.fro_id)
    && (!froSearch || (p.fro_name || '').toLowerCase().includes(froSearch.toLowerCase()))
  ), [tlData, froSearch, HIDDEN_FRO_IDS]);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let useFresh = tlForceFreshRef.current;
    const requestVersion = ++tlRequestVersionRef.current;
    const controller = new AbortController();
    const buildParams = (fresh) => {
      const params = [];
      if (selectedNgoId !== 'all') params.push(`ngo_id=${selectedNgoId}`);
      let from, to;
      if (dashPeriod === 'today') { from = toIstDate(); to = from; }
      else if (dashPeriod === 'yesterday') { from = toIstDate(new Date(Date.now() - 86400000)); to = from; }
      else if (dashPeriod === 'weekly') {
        const now = new Date();
        const start = new Date(now); start.setDate(now.getDate() - now.getDay());
        from = toIstDate(start); to = toIstDate(now);
      } else if (dashPeriod === 'monthly') {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        from = toIstDate(start); to = toIstDate(now);
      } else {
        from = customFrom; to = customTo;
      }
      if (from) params.push(`from=${from}`);
      if (to) params.push(`to=${to}`);
      if (selectedFroId) params.push(`fro_id=${selectedFroId}`);
      if (fresh) params.push('fresh=1');
      return params.length ? `?${params.join('&')}` : '';
    };
    const fetchTl = () => {
      if (inFlight) return;
      inFlight = true;
      const fresh = useFresh;
      useFresh = false;
      apiGet(`/ngo-admin/tl-dashboard${buildParams(fresh)}`, { signal: controller.signal })
        .then(d => {
          if (cancelled || requestVersion !== tlRequestVersionRef.current) return;
          setTlData(mergePauseState(d, pauseOverridesRef.current));
        })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    tlForceFreshRef.current = false;
    fetchTl();
    const interval = setInterval(fetchTl, 10000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [selectedNgoId, dashPeriod, customFrom, customTo, selectedFroId, tlRefreshNonce]);

  // fro_live_status is already in REALTIME_TABLES, so every write to it already
  // broadcasts a global db:change carrying worker_id/is_paused/paused_by (see
  // config/db.js). The FRO's own resume is just such a write, so the event that
  // proves the card stale was already on the wire and this panel simply was not
  // listening — that is the whole reason the card sat on "Paused" for up to two
  // minutes. No new event or room is needed; this only reads what already ships.
  //
  // The guard is load-bearing, not an optimisation: heartbeats rewrite this row
  // continuously, so refetching on every event would hammer the dashboard. Only
  // an actual pause-state disagreement triggers a fetch, and the debounce
  // coalesces a burst into one uncached refetch. A GET never writes the row, so
  // this cannot feed itself.
  const tlDataRef = useRef(tlData);
  useEffect(() => { tlDataRef.current = tlData; }, [tlData]);
  useEffect(() => {
    let alive = true;
    let timer = null;
    const refetchUncached = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!alive) return;
        tlRequestVersionRef.current += 1;
        tlForceFreshRef.current = true;
        setTlRefreshNonce(v => v + 1);
      }, 300);
    };
    const onPauseRowChanged = (next) => {
      if (!alive || !next || next.is_paused == null) return;
      const row = (tlDataRef.current?.performance || []).find(p => String(p.fro_id) === String(next.worker_id));
      if (!row) return;
      if (!!row.is_paused === !!next.is_paused && (row.paused_by || null) === (next.paused_by || null)) return;
      // The server has spoken, so any pending marker for this FRO is void.
      pauseOverridesRef.current.delete(String(next.worker_id));
      refetchUncached();
    };
    const off = onDbChange({
      table: 'fro_live_status',
      event: '*',
      onInsert: onPauseRowChanged,
      onUpdate: onPauseRowChanged,
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (typeof off === 'function') off();
    };
  }, []);

  // Per-FRO pause/resume from the Dashboard FRO Status panel (same endpoints
  // as the FRO Status page — NGO-scoped server-side).
  const [pausingFroId, setPausingFroId] = useState(null);
  // Shared 30s ticker so paused durations ("Paused 12m") tick live.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const handleTogglePause = useCallback(async (p) => {
    const id = p.fro_id;
    if (!id || pausingFroId) return;
    const pausing = !p.is_paused;
    if (pausing && !window.confirm(`Pause ${p.fro_name || 'this FRO'}? Their talk and idle timers stop until you resume them. Worked hours keep counting.`)) return;
    setPausingFroId(id);
    try {
      await apiPost(`/ngo-admin/fro/${id}/${pausing ? 'pause' : 'resume'}`, {});
      const stamp = new Date().toISOString();
      pauseOverridesRef.current.set(String(id), {
        paused: pausing,
        pausedBy: pausing ? 'Admin' : null,
        pausedAt: stamp,
        expiresAt: Date.now() + 120000,
      });
      tlRequestVersionRef.current += 1;
      tlForceFreshRef.current = true;
      setTlRefreshNonce(value => value + 1);
      setTlData(prev => prev && Array.isArray(prev.performance)
        ? { ...prev, performance: prev.performance.map(p => String(p.fro_id) === String(id)
          ? { ...p, is_paused: pausing, paused_by: pausing ? (p.paused_by || 'Admin') : null, paused_at: pausing ? (p.paused_at || stamp) : null }
          : p) }
        : prev);
      toast(pausing ? `${p.fro_name} paused` : `${p.fro_name} resumed`, 'success');
    } catch (e) {
      toast(e.message || `Could not ${pausing ? 'pause' : 'resume'} this FRO`, 'error');
    } finally {
      setPausingFroId(null);
    }
  }, [pausingFroId]);

  const fetchDashboard = useCallback((opts = {}) => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (selectedNgoId !== 'all') params.set('ngo_id', selectedNgoId);
    if (activeRange.from) params.set('from', activeRange.from);
    if (activeRange.to) params.set('to', activeRange.to);
    if (opts.fresh) params.set('fresh', '1');
    const ngoParam = params.toString() ? `?${params.toString()}` : '';
    const reqOpts = { signal: controller.signal, timeout: 180000 };
    apiGet(`/ngo-admin/dashboard${ngoParam}`, reqOpts)
      .then(d => { if (!controller.signal.aborted) setData(d); })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message || 'Failed to load dashboard data');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    apiGet(`/ngo-admin/dashboard/station-stats${ngoParam}`, reqOpts)
      .then(s => { if (!controller.signal.aborted) setStationStats(s); })
      .catch(() => {});
    apiGet('/ngo-admin/stations', reqOpts)
      .then(st => { if (!controller.signal.aborted) setStationsData(Array.isArray(st) ? st : []); })
      .catch(() => {});
    return controller;
  }, [selectedNgoId, activeRange]);

  useEffect(() => {
    const controller = fetchDashboard();
    return () => controller.abort();
  }, [fetchDashboard]);

  const handleNgoFilter = (ngoId) => {
    if (ngoId === selectedNgoId) return;
    const ngo = (accessibleNgos || []).find(n => n.id === ngoId);
    setNgoTab(NGO_TABS.find(([c]) => c && (ngo?.name || '').toLowerCase().includes(c))?.[0] || '');
    setData(null);
    setStationStats(null);
    setStationsData([]);
    setSelectedNgoId(ngoId);
  };

  if (loading && !data) return <SkeletonDashboard />;
  if (error && !data) {
    return (
      <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p style={{ marginBottom: 6, fontWeight: 600, color: 'var(--ink)' }}>Could not load dashboard data</p>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 16 }}>{error || 'The server took too long to respond. Please try again.'}</p>
        <button className="btn btn-primary" onClick={() => fetchDashboard({ fresh: true })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Retry
        </button>
      </div>
    );
  }
  if (!data) return <SkeletonDashboard />;

  const stations = stationStats?.stations || {};
  const summary = stationStats?.summary || {};
  const stationNames = Object.keys(stations).sort((a, b) => {
    const idxA = a.lastIndexOf('-'), idxB = b.lastIndexOf('-');
    const numA = idxA > 0 ? parseInt(a.slice(idxA + 1)) || 0 : 0;
    const numB = idxB > 0 ? parseInt(b.slice(idxB + 1)) || 0 : 0;
    const preA = idxA > 0 ? a.slice(0, idxA) : a;
    const preB = idxB > 0 ? b.slice(0, idxB) : b;
    if (preA !== preB) return preA.localeCompare(preB);
    return numA - numB;
  });

  const getCell = (station, status) => stations[station]?.[status] || 0;
  const getStationTotal = (station) => Object.values(stations[station] || {}).reduce((t, v) => t + v, 0);

  const stationInfoMap = {};
  for (const st of stationsData) {
    stationInfoMap[st.station] = st;
  }

  const s = data.summary || {};
  const d = s.donors || {};
  const c = s.collection || {};
  const cm = c.month || {};
  const ct = c.today || {};
  const w = data.workers || {};
  const f = w.fro || {};
  const att = w.attendance || {};
  const a = data.assignments || {};

  const total_donors = Number(d.total) || 0;
  const assigned_donors = Number(d.assigned) || 0;
  const month_collection = Number(cm.total) || 0;
  const today_collection = Number(ct.total) || 0;
  const daily_target = Number(c.daily_target) || 0;
  const monthly_target = Number(c.monthly_target) || (daily_target > 0 ? daily_target * 26 : 0);
  const verified_month_amount = Number(cm.verified?.amount) || 0;
  const verified_month_count = Number(cm.verified?.count) || 0;
  const unverified_month_amount = Number(cm.unverified?.amount) || 0;
  const unverified_month_count = Number(cm.unverified?.count) || 0;
  const verified_today_amount = Number(ct.verified?.amount) || 0;
  const verified_today_count = Number(ct.verified?.count) || 0;
  const unverified_today_amount = Number(ct.unverified?.amount) || 0;
  const unverified_today_count = Number(ct.unverified?.count) || 0;
  const total_workers = Number(f.active) || 0;
  const workers_present = Number(att.present) || 0;
  const workers_late = Number(att.late) || 0;
  const workers_absent = Number(att.absent) || 0;
  const attendance_pct = Number(att.pct) || 0;
  const data_used = Number(a.data_connected) || 0;
  const data_unused = Number(a.data_unconnected) || 0;
  // For "Today" the stations card reads the live tl-data (refreshes every 10s);
  // for any other date it reads the (date-aware) dashboard summary instead so the
  // card follows the selected period.
  const isTodayRange = !!(activeRange.to && activeRange.from === activeRange.to && activeRange.to === toIstDate());
  const stations_per_ngo = isTodayRange
    ? (tlData?.stations_per_ngo || data.stations_per_ngo || {})
    : (data.stations_per_ngo || tlData?.stations_per_ngo || {});
  const stations_summary = isTodayRange
    ? (tlData?.stations_summary || data.stations_summary || { total: 0, active: 0 })
    : (data.stations_summary || tlData?.stations_summary || { total: 0, active: 0 });
  const unassigned = Math.max(0, total_donors - assigned_donors);
  const assignPct = Number(d.assigned_pct) || 0;
  const direct_donation_month = Math.max(0, month_collection - verified_month_amount - unverified_month_amount);
  const direct_donation_today = Math.max(0, today_collection - verified_today_amount - unverified_today_amount);

  const pieData = DISPOSITION_GROUPS.map(g => ({
    name: g.label,
    value: g.statuses.reduce((t, s) => t + (summary[s] || 0), 0),
    color: g.color,
  })).filter(d => d.value > 0);

  const handleTelecallerExport = async () => {
    if (!tlData?.performance) return;
    const XLSX = await import('xlsx-js-style');
    const wb = XLSX.utils.book_new();
    const enc = XLSX.utils.encode_cell;
    const styleCell = (ws, r, c, s) => { const ref = ws[enc({ r, c })]; if (ref) ref.s = s; };
    const spanRef = (ws) => {
      const cur = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: cur.e });
    };

    const periodLabel = PERIOD_LABELS[dashPeriod] || 'Range';
    // Same HIDDEN_FRO_IDS filter as the board, so the XLSX matches what is
    // on screen. Filtering only the table would have exported two FROs the admin
    // cannot see in the report they are looking at.
    const filteredPerformance = tlData.performance.filter(p =>
      !HIDDEN_FRO_IDS.has(p.fro_id)
      && (!froSearch || p.fro_name?.toLowerCase().includes(froSearch.toLowerCase()))
    );

    const HDR = {
      fgColor: { rgb: '5B6B4E' }, pattern: 'solid',
      font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };
    const TITLE = {
      fgColor: { rgb: '5B6B4E' }, pattern: 'solid',
      font: { name: 'Calibri', sz: 14, bold: true, color: { rgb: 'FFFFFF' } },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
    const SUB = {
      fgColor: { rgb: 'E8EDE1' }, pattern: 'solid',
      font: { name: 'Calibri', sz: 10, bold: true },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
    const AMT = { numFmt: '"₹"#,##0' };
    const FONT = { name: 'Calibri', sz: 10 };

    const calc = (p) => {
      const calls = p.calls_range || 0;
      const connected = p.connected_range || 0;
      const interested = p.interested_range || 0;
      const received = p.receivedAmount_range || 0;
      return {
        calls, connected,
        nonConnected: p.non_connected_range ?? Math.max(0, calls - connected),
        interested, received,
        donors: p.receivedDonors || 0,
        statuses: p.connectedStatuses_range || {},
      };
    };
    const calcRows1 = filteredPerformance.map(p => ({ p, c: calc(p) }));
    const sum1 = (k) => calcRows1.reduce((a, { c }) => a + c[k], 0);
    const tcalls = sum1('calls'), tconn = sum1('connected'), tnc = sum1('nonConnected');
    const tint = sum1('interested'), tdon = sum1('donors'), tamt = sum1('received');

    // ── Sheet 1: Telecaller Performance ─────────────────────────────
    // Mirrors the on-screen table: FU + C/B under Follow-up, VISIT + P under
    // Field, plus Overdue (calls / follow-ups) and Logout columns.
    const EXPORT_STATUS_ORDER = ['scheduled', 'callback', 'office_program_visit', 'promise_pay_wa_email', 'not_interested_np', 'dnd'];
    const EXPORT_STATUS_LABELS = { scheduled: 'Follow Up (FU)', callback: 'Callback (C/B)', office_program_visit: 'Visit', promise_pay_wa_email: 'P', not_interested_np: 'NI', dnd: 'DND' };
    const headers1 = [
      'Telecaller', 'Login ID', 'Period', 'Total Calls', 'Connected', 'Leads Done',
      ...EXPORT_STATUS_ORDER.map(k => EXPORT_STATUS_LABELS[k]),
      'Non-Connected', 'Interested', 'Amount (₹)', 'CO/D', 'FUP O/D', 'Logout', 'Idle', 'Live Status'
    ];
    const aoa1 = calcRows1.map(({ p, c }) => [
      p.fro_name, p.fro_login_id || '', periodLabel,
      c.calls, c.connected,
      c.statuses.lead_done || 0,
      ...EXPORT_STATUS_ORDER.map(k => c.statuses[k] || 0),
      c.nonConnected, c.interested, c.received, p.overdue_calls || 0, p.overdue_followups || 0,
      p.logout_today || 0,
      // Today's idle (committed + any period still running), in the same
      // "59m" / "1h 5m" form the panel and the FRO strip show.
      formatDuration(p.today_idle_seconds),
      p.status || 'offline'
    ]);
    const t1 = calcRows1.reduce((a, { p, c }) => ({
      calls: a.calls + c.calls, connected: a.connected + c.connected, nonConnected: a.nonConnected + c.nonConnected,
      interested: a.interested + c.interested, donors: a.donors + (p.receivedDonors || 0), amount: a.amount + c.received,
      odc: a.odc + (p.overdue_calls || 0), odf: a.odf + (p.overdue_followups || 0),
      logoutsToday: a.logoutsToday + (p.logout_today || 0),
      idleSec: a.idleSec + (p.today_idle_seconds || 0),
      leadsDone: a.leadsDone + (c.statuses.lead_done || 0),
      statuses: EXPORT_STATUS_ORDER.map((k, i) => a.statuses[i] + (c.statuses[k] || 0)),
    }), { calls: 0, connected: 0, nonConnected: 0, interested: 0, donors: 0, amount: 0, odc: 0, odf: 0, logoutsToday: 0, idleSec: 0, leadsDone: 0, statuses: EXPORT_STATUS_ORDER.map(() => 0) });
    aoa1.push(['TOTAL', '', '', t1.calls, t1.connected, t1.leadsDone, ...t1.statuses, t1.nonConnected, t1.interested, t1.amount, t1.odc, t1.odf, t1.logoutsToday, formatDuration(t1.idleSec), '']);

    const ws1 = XLSX.utils.aoa_to_sheet([]);
    ws1[enc({ r: 0, c: 0 })] = { t: 's', v: `Telecaller Performance — ${periodLabel}` };
    ws1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 19 } }];
    ws1['!rows'] = [{ hpt: 30 }, { hpt: 28 }];
    XLSX.utils.sheet_add_aoa(ws1, [headers1], { origin: 'A2' });
    XLSX.utils.sheet_add_aoa(ws1, aoa1, { origin: 'A3' });
    spanRef(ws1);
    ws1['!cols'] = [
      // 6 fixed + 6 statuses + 8 tail = 20, matching headers1 (0..19).
      { wch: 25 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 },
      ...EXPORT_STATUS_ORDER.map(() => ({ wch: 16 })),
      { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
    ];
    styleCell(ws1, 0, 0, TITLE);
    for (let c = 0; c <= 19; c++) styleCell(ws1, 1, c, HDR);
    const numCols1 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    for (let r = 2; r < 2 + aoa1.length; r++) {
      for (let c = 0; c <= 19; c++) {
        const s = { font: FONT, alignment: { vertical: 'center', horizontal: numCols1.includes(c) ? 'center' : 'left' } };
        if (c === 15) s.numFmt = AMT.numFmt;
        styleCell(ws1, r, c, s);
      }
    }
    for (let c = 0; c <= 19; c++) styleCell(ws1, 1 + aoa1.length, c, { ...SUB, numFmt: c === 15 ? AMT.numFmt : undefined });
    ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws1['!autofilter'] = { ref: `A2:T${1 + aoa1.length}` };
    XLSX.utils.book_append_sheet(wb, ws1, 'Telecaller Performance');

    // ── Sheet 2: Hourly Performance (subtotals per telecaller) ──────
    let hourlyDataToUse = froHourlyData;
    if (!hourlyDataToUse || hourlyDataToUse.length === 0) {
      try {
        hourlyDataToUse = await getFroHourlyPerformance({ from: hourlyExportFrom, to: hourlyExportTo, ...(selectedNgoId !== 'all' ? { ngo_id: selectedNgoId } : {}) }) || [];
      } catch (e) {
        hourlyDataToUse = [];
      }
    }
    const headers2 = ['Telecaller', 'Login ID', 'Hour Slot', 'Calls', 'Connected', 'Interested', 'Donations', 'Amount (₹)'];
    const ws2 = XLSX.utils.aoa_to_sheet([]);
    ws2[enc({ r: 0, c: 0 })] = { t: 's', v: `Hourly Collection Performance — ${hourlyExportFrom} to ${hourlyExportTo}` };
    ws2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
    ws2['!rows'] = [{ hpt: 30 }, { hpt: 26 }];
    XLSX.utils.sheet_add_aoa(ws2, [headers2], { origin: 'A2' });

    const aoa2 = [];
    const subRows2 = [];
    let grandRow2 = -1;
    if (hourlyDataToUse && hourlyDataToUse.length) {
      const groups = {};
      hourlyDataToUse.forEach(h => { const k = h.fro_name || 'Unknown'; (groups[k] = groups[k] || []).push(h); });
      Object.keys(groups).forEach(name => {
        groups[name].forEach(h => aoa2.push([h.fro_name || name, h.fro_login_id || '', h.hour, h.calls || 0, h.connected || 0, h.interested || 0, h.donations || 0, h.amount || 0]));
        const st = groups[name].reduce((a, h) => ({
          calls: a.calls + (h.calls || 0), connected: a.connected + (h.connected || 0), interested: a.interested + (h.interested || 0),
          donations: a.donations + (h.donations || 0), amount: a.amount + (h.amount || 0)
        }), { calls: 0, connected: 0, interested: 0, donations: 0, amount: 0 });
        aoa2.push([`${name} — Subtotal`, '', '', st.calls, st.connected, st.interested, st.donations, st.amount]);
        subRows2.push(1 + aoa2.length);
      });
      const gt = hourlyDataToUse.reduce((a, h) => ({
        calls: a.calls + (h.calls || 0), connected: a.connected + (h.connected || 0), interested: a.interested + (h.interested || 0),
        donations: a.donations + (h.donations || 0), amount: a.amount + (h.amount || 0)
      }), { calls: 0, connected: 0, interested: 0, donations: 0, amount: 0 });
      aoa2.push(['GRAND TOTAL', '', '', gt.calls, gt.connected, gt.interested, gt.donations, gt.amount]);
      grandRow2 = 1 + aoa2.length;
    } else {
      aoa2.push(['No hourly data for selected range', '', '', '', '', '', '', '']);
    }
    XLSX.utils.sheet_add_aoa(ws2, aoa2, { origin: 'A3' });
    spanRef(ws2);
    ws2['!cols'] = [
      { wch: 25 }, { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }
    ];
    styleCell(ws2, 0, 0, TITLE);
    for (let c = 0; c <= 7; c++) styleCell(ws2, 1, c, HDR);
    const numCols2 = [3, 4, 5, 6, 7];
    for (let r = 2; r < 2 + aoa2.length; r++) {
      for (let c = 0; c <= 7; c++) {
        const s = { font: FONT, alignment: { vertical: 'center', horizontal: numCols2.includes(c) ? 'center' : 'left' } };
        if (c === 7) s.numFmt = AMT.numFmt;
        styleCell(ws2, r, c, s);
      }
    }
    subRows2.forEach(r => { for (let c = 0; c <= 7; c++) styleCell(ws2, r, c, { ...SUB, numFmt: c === 7 ? AMT.numFmt : undefined }); });
    if (grandRow2 > 0) for (let c = 0; c <= 7; c++) styleCell(ws2, grandRow2, c, { ...SUB, numFmt: c === 7 ? AMT.numFmt : undefined });
    ws2['!freeze'] = { xSplit: 0, ySplit: 1 };
    if (aoa2.length > 1) ws2['!autofilter'] = { ref: `A2:H${1 + aoa2.length}` };
    XLSX.utils.book_append_sheet(wb, ws2, 'Hourly Performance');

    // ── Sheet 3: Computations ───────────────────────────────────────
    const ws3 = XLSX.utils.aoa_to_sheet([]);
    ws3[enc({ r: 0, c: 0 })] = { t: 's', v: `Computations — ${periodLabel}` };
    ws3['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
    ws3['!rows'] = [{ hpt: 30 }];
    let r3 = 1;
    const appendR = (row) => { XLSX.utils.sheet_add_aoa(ws3, [row], { origin: 'A' + (r3 + 1) }); r3++; };

    const secRows = [];
    const hdrRows = [];
    const totRows = [];
    const amtCells = [];

    appendR(['Key Metrics']);
    secRows.push(r3 - 1);
    [
      ['Total Telecallers', calcRows1.length],
      ['Total Calls', tcalls],
      ['Total Connected', tconn],
      ['Connection Rate', tcalls ? `${((tconn / tcalls) * 100).toFixed(1)}%` : '—'],
      ['Non-Connected', tnc],
      ['Interested', tint],
      ['Received Donors', tdon],
      ['Received Amount (₹)', tamt],
      ['Conversion Rate', tcalls ? `${((tdon / tcalls) * 100).toFixed(1)}%` : '—'],
      ['Avg Ticket Size (₹)', tdon ? Math.round(tamt / tdon) : 0],
    ].forEach(([lbl, val]) => { appendR([lbl, val]); if (lbl.includes('₹')) amtCells.push([r3 - 1, 1]); });

    appendR(['']);
    const hourTotals = {};
    if (hourlyDataToUse && hourlyDataToUse.length) {
      hourlyDataToUse.forEach(h => {
        const k = h.hour || 'Unknown';
        hourTotals[k] = hourTotals[k] || { calls: 0, connected: 0, interested: 0, donations: 0, amount: 0 };
        hourTotals[k].calls += h.calls || 0; hourTotals[k].connected += h.connected || 0;
        hourTotals[k].interested += h.interested || 0; hourTotals[k].donations += h.donations || 0;
        hourTotals[k].amount += h.amount || 0;
      });
      appendR(['Hourly Totals']);
      secRows.push(r3 - 1);
      appendR(['Hour Slot', 'Calls', 'Connected', 'Interested', 'Donations', 'Amount (₹)']);
      hdrRows.push(r3 - 1);
      Object.keys(hourTotals).sort().forEach(k => {
        const t = hourTotals[k];
        appendR([k, t.calls, t.connected, t.interested, t.donations, t.amount]);
        amtCells.push([r3 - 1, 5]);
      });
      const ht = Object.values(hourTotals).reduce((a, t) => ({
        calls: a.calls + t.calls, connected: a.connected + t.connected, interested: a.interested + t.interested,
        donations: a.donations + t.donations, amount: a.amount + t.amount
      }), { calls: 0, connected: 0, interested: 0, donations: 0, amount: 0 });
      appendR(['TOTAL', ht.calls, ht.connected, ht.interested, ht.donations, ht.amount]);
      totRows.push(r3 - 1);
      amtCells.push([r3 - 1, 5]);
      appendR(['']);
    }

    appendR(['Per-Telecaller Share']);
    secRows.push(r3 - 1);
    appendR(['Telecaller', 'Calls', 'Connected', 'Interest (I/C) %', 'Amount (₹)', 'Share %']);
    hdrRows.push(r3 - 1);
    calcRows1.forEach(({ p, c }) => {
      appendR([p.fro_name, c.calls, c.connected, c.connected ? `${((c.interested / c.connected) * 100).toFixed(1)}%` : '—', c.received, tamt ? `${((c.received / tamt) * 100).toFixed(1)}%` : '—']);
      amtCells.push([r3 - 1, 4]);
    });
    appendR(['TOTAL', tcalls, tconn, tconn ? `${((tint / tconn) * 100).toFixed(1)}%` : '—', tamt, '100%']);
    totRows.push(r3 - 1);
    amtCells.push([r3 - 1, 4]);
    appendR(['']);

    const shareCols = calcRows1.map(({ p }) => p.fro_name);
    const statusKeys = [...new Set(calcRows1.flatMap(({ c }) => Object.keys(c.statuses)))];
    appendR(['Connected-Status Matrix']);
    secRows.push(r3 - 1);
    appendR(['Connected Disposition', ...shareCols, 'TOTAL']);
    hdrRows.push(r3 - 1);
    statusKeys.forEach(k => {
      const vals = calcRows1.map(({ c }) => c.statuses[k] || 0);
      appendR([DISPOSITION_LABELS[k] || k, ...vals, vals.reduce((a, b) => a + b, 0)]);
    });
    const colTotals = shareCols.length ? calcRows1.map(({ c }, i) => statusKeys.reduce((a, k) => a + (c.statuses[k] || 0), 0)) : [];
    appendR(['TOTAL', ...colTotals, colTotals.reduce((a, b) => a + b, 0)]);
    totRows.push(r3 - 1);

    spanRef(ws3);
    ws3['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
    styleCell(ws3, 0, 0, TITLE);
    secRows.forEach(r => {
      styleCell(ws3, r, 0, { font: { name: 'Calibri', sz: 11, bold: true } });
    });
    hdrRows.forEach(r => {
      for (let c = 0; c <= 5; c++) styleCell(ws3, r, c, { ...HDR, fgColor: { rgb: 'D9DFCE' }, font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '3F4A38' } } });
    });
    totRows.forEach(r => {
      for (let c = 0; c <= 5; c++) styleCell(ws3, r, c, SUB);
    });
    for (let r = 0; r < r3; r++) {
      amtCells.forEach(([ar, ac]) => { if (ar === r) styleCell(ws3, ar, ac, { font: FONT, alignment: { horizontal: 'center' }, numFmt: AMT.numFmt }); });
    }
    XLSX.utils.book_append_sheet(wb, ws3, 'Computations');

    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `telecaller-performance-${dateStr}.xlsx`);
  };

  return (
    <div>
      <div className="filter-bar">
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, background: '#eef1f6', borderRadius: 12 }}>
          {[['today', 'Today'], ['yesterday', 'Yesterday'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['custom', 'Custom']].map(([val, label]) => (
            <button key={val} onClick={() => setDashPeriod(val)} style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 15px', borderRadius: 9, border: 'none', cursor: 'pointer', background: dashPeriod === val ? '#111827' : 'transparent', color: dashPeriod === val ? '#fff' : '#475569', transition: 'background .12s, color .12s' }}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, background: '#eef1f6', borderRadius: 12 }}>
          <button onClick={() => handleNgoFilter('all')} style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 15px', borderRadius: 9, border: 'none', cursor: 'pointer', background: selectedNgoId === 'all' ? '#111827' : 'transparent', color: selectedNgoId === 'all' ? '#fff' : '#475569', transition: 'background .12s, color .12s' }}>All NGOs</button>
          {ngoFilterPills.map(n => (
            <button key={n.id} onClick={() => handleNgoFilter(n.id)} title={n.name} style={{ fontSize: 12.5, fontWeight: 700, padding: '7px 15px', borderRadius: 9, border: 'none', cursor: 'pointer', background: selectedNgoId === n.id ? n.color : 'transparent', color: selectedNgoId === n.id ? '#fff' : '#475569', transition: 'background .12s, color .12s' }}>{n.label}</button>
          ))}
        </div>
        {dashPeriod === 'custom' && (
          <>
            <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} style={{ padding: '8px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', background: '#fff' }} />
            <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>to</span>
            <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} style={{ padding: '8px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', background: '#fff' }} />
          </>
        )}
        <select value={selectedFroId} onChange={(e) => setSelectedFroId(e.target.value)} style={{ padding: '8px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
          <option value="">All Telecallers</option>
          {(tlData?.performance || []).filter(p => !HIDDEN_FRO_IDS.has(p.fro_id)).map(p => (
            <option key={p.fro_id} value={p.fro_id}>{p.fro_name}</option>
          ))}
        </select>
        <button
          onClick={() => fetchDashboard({ fresh: true })}
          disabled={loading}
          className="btn btn-primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}
          title="Reload dashboard with fresh data"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'weak-spin' : ''}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Top Summary Cards.
          Two columns: the two money/verification cards stack on the left, and the
          team race fills the right column across both rows. The race reads the
          same `activeRange` the whole dashboard obeys, so the card sitting next to
          the Collection total cannot quote a different set of receipts.
          Layout lives in CSS (.dash-summary-grid) rather than inline styles so the
          narrow-viewport collapse is overridable - inline grid-template-columns
          would win over a media query. */}
      <div className="dash-summary-grid">
        <div className="dash-summary-col">
          <div className="card" style={{ marginBottom: 0, padding: '16px 18px', cursor: 'pointer' }} onClick={() => setSelectedPeriod('today')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 2 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 700, letterSpacing: .5, textTransform: 'uppercase', flex: 1 }}>Collection</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>₹{Number(tlData?.kpis?.received_amount ?? today_collection).toLocaleString('en-IN')}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 10 }}>
              {Number(tlData?.kpis?.received_amount ?? today_collection) === 0 ? 'No collections yet' : `(As per global filter — e.g. ${PERIOD_LABELS[dashPeriod]})`}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {(tlData?.collections_per_ngo?.length > 0 ? tlData.collections_per_ngo : (accessibleNgos || []).filter(n => NGO_TABS.some(([c]) => (n.name || '').toLowerCase().includes(c))).map(n => ({ ngo_id: n.id, ngo_name: n.name, amount: 0 })))
                .slice(0, 9)
                .sort((a, b) => ngoSortRank(a.ngo_name) - ngoSortRank(b.ngo_name))
                .slice(0, 3)
                .map(n => {
                  const color = ngoColorOf(n.ngo_name);
                  return (
                    <div key={n.ngo_id ?? n.ngo_name} style={{ padding: '10px 8px 11px', borderRadius: 10, border: '1px solid var(--line)', background: `${color}0d`, textAlign: 'center' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: .5, color, textTransform: 'uppercase' }}>{n.ngo_name}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginTop: 2 }}>₹{Number(n.amount || 0).toLocaleString('en-IN')}</div>
                    </div>
                  );
                })}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 0, padding: '16px 18px', cursor: 'pointer', border: '1px solid #16a34a33' }} onClick={() => setSelectedStatus('verified')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Verified</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: '#16a34a' }}>₹{Number(tlData?.kpis?.received_amount ?? verified_month_amount).toLocaleString('en-IN')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-soft)' }}>
              <span>{tlData?.kpis?.donations ?? verified_month_count} verified donations</span>
              <span>{PERIOD_LABELS[dashPeriod]}</span>
            </div>
            <div style={{ fontSize: 10, color: '#16a34a', marginTop: 4 }}>Verified by Accounts panel</div>
          </div>
        </div>

        <TeamWiseCollection
          from={activeRange.from}
          to={activeRange.to}
          ngoId={selectedNgoId}
          froId={selectedFroId}
          periodLabel={PERIOD_LABELS[dashPeriod]}
        />
      </div>

      {/* Meeting in-progress banner: live counters are frozen */}
      {meetingActive && (
        <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 8, background: '#f5f3ff', border: '1px solid #ddd6fe', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Megaphone size={20} color="#7c3aed" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#6d28d9' }}>
            Meeting in progress{meeting && meeting.title !== 'Meeting' ? ` — ${meeting.title}` : ''}
            {meeting && meeting.teams && meeting.teams.length > 0 ? ` (Teams: ${meeting.teams.join(' · ')})` : ' (All teams)'}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#7c3aed', background: '#ede9fe', padding: '2px 10px', borderRadius: 999 }}>
            Started by {meeting?.started_by_name || 'Admin'}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#6d28d9' }}>
            Live counters (calls, breaks) are paused.
          </span>
        </div>
      )}

      {/* REQUIREMENT 1: Daily Collection Target + Monthly Collection Target (Directly Below) */}
      {daily_target > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: '14px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span style={{ fontSize: 13, color: 'var(--ink-soft)', fontWeight: 600, flex: 1 }}>Daily Collection Target
              <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 400, marginLeft: 6 }}>Set by Super Admin</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Target: <strong style={{ color: 'var(--ink)' }}>₹{daily_target.toLocaleString('en-IN')}</strong></span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Collected: <strong style={{ color: '#16a34a' }}>₹{today_collection.toLocaleString('en-IN')}</strong></span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Remaining: <strong style={{ color: today_collection >= daily_target ? '#16a34a' : '#ef4444' }}>₹{Math.max(0, daily_target - today_collection).toLocaleString('en-IN')}</strong></span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: '#fef2f2', overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(100, (today_collection / daily_target) * 100)}%`,
              height: '100%',
              borderRadius: 4,
              background: today_collection >= daily_target ? '#16a34a' : today_collection >= daily_target * 0.5 ? '#f59e0b' : '#ef4444',
              transition: 'width .5s ease',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>
            <span>{Math.round((today_collection / daily_target) * 100)}% achieved</span>
            <span>{today_collection >= daily_target ? 'Daily target completed!' : `${Math.round(((daily_target - today_collection) / daily_target) * 100)}% remaining`}</span>
          </div>
        </div>
      )}

      {monthly_target > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: '14px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
            <span style={{ fontSize: 13, color: 'var(--ink-soft)', fontWeight: 600, flex: 1 }}>Monthly Collection Target
              <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 400, marginLeft: 6 }}>Current Month</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Target: <strong style={{ color: 'var(--ink)' }}>₹{monthly_target.toLocaleString('en-IN')}</strong></span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Collected: <strong style={{ color: '#16a34a' }}>₹{month_collection.toLocaleString('en-IN')}</strong></span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Remaining: <strong style={{ color: month_collection >= monthly_target ? '#16a34a' : '#ef4444' }}>₹{Math.max(0, monthly_target - month_collection).toLocaleString('en-IN')}</strong></span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: '#fef2f2', overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(100, (month_collection / monthly_target) * 100)}%`,
              height: '100%',
              borderRadius: 4,
              background: month_collection >= monthly_target ? '#16a34a' : month_collection >= monthly_target * 0.5 ? '#f59e0b' : '#ef4444',
              transition: 'width .5s ease',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>
            <span>{Math.round((month_collection / monthly_target) * 100)}% achieved</span>
            <span>{month_collection >= monthly_target ? 'Monthly target completed!' : `${Math.round(((monthly_target - month_collection) / monthly_target) * 100)}% remaining`}</span>
          </div>
        </div>
      )}

      {/* REQUIREMENT 3: Workforce / Attendance (Left) & Stations (Right) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginBottom: 16 }}>
        {/* Left: Workforce & Attendance */}
        <div className="card" style={{ marginBottom: 0, padding: '16px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Workforce & Attendance</span>
              <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-soft)', background: 'var(--bg)', padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{PERIOD_LABELS[dashPeriod] || 'Today'} · {activeRange.to}</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>{total_workers}</span>
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ width: 64, height: 64, flexShrink: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={[
                      { name: 'Present', value: Math.max(0, workers_present), color: '#22c55e' },
                      { name: 'Late', value: Math.max(0, workers_late), color: '#f59e0b' },
                      { name: 'Absent', value: Math.max(0, workers_absent), color: '#ef4444' },
                    ].filter(d => d.value > 0)} cx="50%" cy="50%" innerRadius={20} outerRadius={30} dataKey="value" startAngle={90} endAngle={-270}>
                      <Cell fill="#22c55e" />
                      <Cell fill="#f59e0b" />
                      <Cell fill="#ef4444" />
                      <Cell fill="#d1d5db" />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: '#22c55e', fontWeight: 600 }}>Present</span>
                  <span style={{ fontWeight: 600 }}>{workers_present}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: '#f59e0b', fontWeight: 500 }}>Late</span>
                  <span style={{ fontWeight: 500, color: '#f59e0b' }}>{workers_late}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: '#ef4444', fontWeight: 500 }}>Absent</span>
                  <span style={{ fontWeight: 500, color: '#ef4444' }}>{workers_absent}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 2 }}>{attendance_pct}% attendance</div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, background: '#f0fdf4', borderRadius: 6, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#22c55e' }}>{workers_present}</div>
                <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>Present</div>
              </div>
              <div style={{ flex: 1, background: '#fffbeb', borderRadius: 6, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>{workers_late}</div>
                <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>Late</div>
              </div>
              <div style={{ flex: 1, background: '#fef2f2', borderRadius: 6, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444' }}>{workers_absent}</div>
                <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>Absent</div>
              </div>
            </div>
            {total_workers > 0 && (
              <div style={{ height: 4, borderRadius: 2, background: '#e5e7eb', marginTop: 8, overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: `${(workers_present / total_workers) * 100}%`, height: '100%', background: '#22c55e' }} />
                <div style={{ width: `${(workers_late / total_workers) * 100}%`, height: '100%', background: '#f59e0b' }} />
              </div>
            )}
          </div>
        </div>

        {/* Right: Stations — Total & Currently Active */}
        <div className="card" style={{ marginBottom: 0, padding: '16px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Stations</span>
              <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--ink-soft)', background: 'var(--bg)', padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{PERIOD_LABELS[dashPeriod] || 'Today'} · {activeRange.to}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10, textAlign: 'center' }}>
              <div style={{ background: 'var(--bg)', borderRadius: 6, padding: '8px 6px' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{stations_summary.total}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-soft)' }}>Total Stations</div>
              </div>
              <div style={{ background: '#f0fdf4', borderRadius: 6, padding: '8px 6px' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#16a34a' }}>{stations_summary.active}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-soft)' }}>Active Now</div>
              </div>
            </div>
          </div>
          {Object.keys(stations_per_ngo).length > 0 && (
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6, textTransform: 'uppercase' }}>Stations per NGO — Active / Total</div>
              {Object.entries(stations_per_ngo).map(([name, v]) => {
                const total = typeof v === 'number' ? v : (Number(v?.total) || 0);
                const active = v && typeof v === 'object' ? (Number(v.active) || 0) : 0;
                const pct = total > 0 ? Math.min(100, (active / total) * 100) : 0;
                return (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, minWidth: 50, color: 'var(--ink)' }}>{name}</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: '#16a34a', transition: 'width .3s ease' }} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, minWidth: 40, textAlign: 'right', color: 'var(--ink)' }}>{active}/{total}</span>
                  </div>
                );
              })}
              <div style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 6 }}>Active = station's FRO is online right now</div>
            </div>
          )}
        </div>
      </div>

      {/* Section 6: Telecaller Performance. Moved above High / Low Performance so
          the full roster and every target read before the two gated subsets of it. */}
      {(() => {
        if (!tlData) {
          return (
            <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #eef2f6', boxShadow: '0 2px 8px rgba(15,23,42,.04)', marginBottom: 16, padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span className="weak-spin" style={{ width: 16, height: 16, border: '2px solid #dbeafe', borderTopColor: '#2F80D9', borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />
              <div>
                <h3 style={{ fontSize: 20, fontWeight: 700, color: '#17233C', margin: 0 }}>Telecaller Performance</h3>
                <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>Loading live performance data…</div>
              </div>
            </div>
          );
        }
        // Idle is its own bucket, not a flavour of offline. An FRO sitting on a
        // lapsed disposition timer is still present and still in the field — the
        // backend sends status: 'idle' for exactly that case (idle_since set, not
        // paused, not in a meeting). statusOf used to funnel anything that was not
        // online/meeting into 'offline', so those FROs were counted as Offline and
        // left out of "All" entirely, which is how an idle FRO became invisible.
        const statusBuckets = { online: ['online', 'on_call'], meeting: ['meeting'], idle: ['idle'], offline: ['offline'] };
        const statusOf = (p) => statusBuckets.online.includes(p.status) ? 'online'
          : statusBuckets.meeting.includes(p.status) ? 'meeting'
            : statusBuckets.idle.includes(p.status) ? 'idle'
              : 'offline';
        const bucketRows = {
          online: perfRows.filter(p => statusOf(p) === 'online'),
          meeting: perfRows.filter(p => statusOf(p) === 'meeting'),
          idle: perfRows.filter(p => statusOf(p) === 'idle'),
          offline: perfRows.filter(p => statusOf(p) === 'offline'),
        };
        const viewRows = perfStatusFilter === 'all'
          ? perfRows.filter(p => statusOf(p) !== 'offline')
          : bucketRows[perfStatusFilter] || [];
        const bucketCounts = {
          all: perfRows.filter(p => statusOf(p) !== 'offline').length,
          online: bucketRows.online.length,
          idle: bucketRows.idle.length,
          meeting: bucketRows.meeting.length,
          offline: bucketRows.offline.length,
        };
        const ncOf = (p) => p.non_connected_range ?? Math.max(0, (p.calls_range || 0) - (p.connected_range || 0));
        const statusesOf = (p) => p.connectedStatuses_range || {};
        const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;

        const METRIC_DEFS = {
          // ── Collection ──
          // These five come off each tl-dashboard row, which computes them from
          // the same leaderboard the High/Low Performance panels read, so the
          // board and those cards cannot disagree for a given FRO. A new hire's
          // monthly target is derived from their salary for their first three
          // months (target_source: 'auto') and is never stored in
          // fro_monthly_targets, which is why the board asks the backend for
          // these rather than deriving them again here.
          // Collected and Today are rupee figures, so they are not `narrow` and
          // always render (a zero target still reads as ₹0, not blank).
          monthly: { key: 'monthly', param: 'MONTHLY', full: 'Monthly Target', val: (p) => p.monthly_target || 0, display: fmt },
          collected: { key: 'collected', param: 'COLLECTED', full: 'Collected', val: (p) => p.collected_amount || 0, display: fmt, pill: true, color: '#166534', bg: '#f0fdf4' },
          remaining: { key: 'remaining', param: 'REMAINING', full: 'Remaining Target', val: (p) => p.remaining_target || 0, display: fmt, pill: true, color: '#b45309', bg: '#FFF8E7' },
          ptgt: { key: 'ptgt', param: 'P TGT', full: 'Period Target', val: (p) => p.period_target || 0, display: fmt },
          today: { key: 'today', param: 'TODAY', full: 'Collected Today', val: (p) => p.period_today || 0, display: fmt, pill: true, color: '#166534', bg: '#f0fdf4' },

          // Today's idle (committed + any period still running). The
          // disposition timer is the only thing that produces it, so this is
          // the headline number for "is this FRO actually working".
          //
          // Rendered with the same formatDuration() the FRO strip uses. It used
          // to be a bare hours decimal, so 59 idle minutes displayed as "0.99"
          // here and "59m" on the FRO's own strip — the same number read as two
          // different figures on two screens.
          // val stays NUMERIC: the column sort compares it with </>, so a
          // formatted string here would sort alphabetically ("10m" < "59m").
          // display renders the cell, and metricCell already prefers it.
          // While a FRO is being covered by an agent, the figure here is the AGENT's idle —
// the person actually at the keyboard — because that is what their own panel
// shows. The cell stays a bare duration so it reads as a number in the column and
// not as an aside; who it belongs to is one hover away.
idle: {
    key: 'idle', param: 'IDLE', full: 'Idle',
    val: (p) => p.today_idle_seconds || 0,
    display: (v) => formatDuration(v),
    title: (p) => (p?.idle_attributed_to
      ? `Idle today of ${p.idle_attributed_to}, who is covering this FRO right now`
      : 'Idle today'),
    pill: true, color: '#b91c1c', bg: '#fef2f2', narrow: true,
  },
          nc: { key: 'nc', param: 'NC', full: 'Non-Connected Calls', val: (p) => ncOf(p), pill: true, color: '#dc2626', bg: '#fef2f2', filterType: 'non_connected' },
          conn: { key: 'conn', param: 'CONN', full: 'Connected Calls', val: (p) => p.connected_range || 0, pill: true, color: '#16a34a', bg: '#f0fdf4', narrow: true, filterType: 'connected' },
          ld: { key: 'ld', param: 'LD', full: 'Leads Done', val: (p) => statusesOf(p).lead_done || 0, pill: true, color: '#b45309', bg: '#fff8e7', filterType: 'connected', status: 'lead_done' },
          fu: { key: 'fu', param: 'FU', full: 'Follow-Up', val: (p) => statusesOf(p).scheduled || 0, pill: true, color: '#15803d', bg: '#ecfdf5', narrow: true, filterType: 'connected', status: 'scheduled' },
          odf: { key: 'odf', param: 'O/D', full: 'Follow-Up Overdue', val: (p) => p.overdue_followups || 0, pill: true, color: '#b45309', bg: '#fff8e7', narrow: true, filterType: 'connected', status: 'overdue_followup' },
          cb: { key: 'cb', param: 'CB', full: 'Callback', val: (p) => statusesOf(p).callback || 0, pill: false, narrow: true, filterType: 'connected', status: 'callback' },
          odc: { key: 'odc', param: 'O/D', full: 'Callback Overdue', val: (p) => p.overdue_calls || 0, pill: true, color: '#dc2626', bg: '#fef2f2', narrow: true, filterType: 'connected', status: 'overdue_callback' },
          off: { key: 'off', param: 'VISIT', full: 'Office / Program Visit', val: (p) => statusesOf(p).office_program_visit || 0, pill: false, narrow: true, filterType: 'connected', status: 'office_program_visit' },
          ppay: { key: 'ppay', param: 'P', full: 'Promise To Pay / WhatsApp / Email', val: (p) => statusesOf(p).promise_pay_wa_email || 0, pill: false, narrow: true, filterType: 'connected', status: 'promise_pay_wa_email' },
          ni: { key: 'ni', param: 'NI', full: 'Not Interested / Disconnect / No Pickup', val: (p) => statusesOf(p).not_interested_np || 0, pill: false, narrow: true, filterType: 'connected', status: 'not_interested_np' },
          dnd: { key: 'dnd', param: 'DND', full: 'Do Not Disturb', val: (p) => statusesOf(p).dnd || 0, pill: false, narrow: true, filterType: 'connected', status: 'dnd' },
          lt: { key: 'lt', param: 'LOGOUT', full: 'Logouts Today', val: (p) => p.logout_today || 0, pill: true, color: '#7c3aed', bg: '#f5f3ff', narrow: true },
        };

        // Column order is declared HERE and nowhere else. METRICS is derived from
        // it, so the group header spans and the sub-header cells can no longer
        // drift out of step with the body — the old hardcoded METRICS.slice(n, m)
        // indices had to be recounted by hand every time a group changed, and a
        // miscount silently shifted a header onto the wrong column.
        const GROUPS = [
          { label: 'COLLECTION', color: '#0f766e', bg: '#F0FDFA', keys: ['monthly', 'collected', 'remaining', 'ptgt', 'today'] },
          { label: 'IDLE', color: '#475569', bg: '#F1F5F9', keys: ['idle'] },
          { label: 'CALL ACTIVITY', color: '#be123c', bg: '#FFF1F3', keys: ['nc', 'conn', 'ld'] },
          { label: 'FOLLOW-UP', color: '#1d4ed8', bg: '#EFF6FF', keys: ['fu', 'odf'] },
          { label: 'CALLBACKS', color: '#dc2626', bg: '#FEF2F2', keys: ['cb', 'odc'] },
          { label: 'FIELD', color: '#0e7490', bg: '#ECFEFF', keys: ['off', 'ppay'] },
          { label: 'OTHER', color: '#047857', bg: '#ECFDF5', keys: ['ni', 'dnd'] },
          { label: 'LOGOUT', color: '#6d28d9', bg: '#F4EEFF', keys: ['lt'] },
        ];
        const METRICS = GROUPS.flatMap(g => g.keys.map(k => METRIC_DEFS[k]));

        const COLUMNS = [
          { key: 'name', label: 'FRO Name', val: (p) => (p.fro_name || '').toLowerCase() },
          ...METRICS.map(m => ({ key: m.key, label: m.full, val: m.val })),
        ];
        const ranked = (p) => perfRows.indexOf(p);
        const sortedRows = [...viewRows].sort((a, b) => {
          if (!perfSort.key) return 0;
          const col = COLUMNS.find(c => c.key === perfSort.key);
          if (!col) return 0;
          const va = col.val(a); const vb = col.val(b);
          if (va < vb) return -1 * perfSort.dir;
          if (va > vb) return 1 * perfSort.dir;
          return ranked(a) - ranked(b);
        });
        const setSort = (key) => setPerfSort(s => s.key === key ? { key, dir: -s.dir } : { key, dir: 1 });
        const sortIcon = (key) => (
          <span style={{ color: perfSort.key === key ? '#2F80D9' : '#cbd5e1', fontSize: '0.5625rem' }}>
            {perfSort.key === key ? (perfSort.dir === 1 ? '▲' : '▼') : '↕'}
          </span>
        );

        const subHeader = (m) => (
          <th key={m.key} title={m.full} onClick={() => setSort(m.key)}
            style={{ background: '#fff', padding: m.narrow ? '6px 0' : '6px 2px', textAlign: 'center', cursor: 'pointer', fontSize: '0.5625rem', textTransform: 'uppercase', letterSpacing: .3, color: 'var(--ink-soft)', fontWeight: 700, borderBottom: '1px solid #eef2f6', borderLeft: '1px solid #eef2f6', whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>{m.param}{sortIcon(m.key)}</span>
          </th>
        );
        const stickyTh = (children, left) => (
          <th rowSpan={2} onClick={() => setSort('name')} title="FRO Name — click to sort"
            style={{ position: 'sticky', left, zIndex: 4, background: '#fff', padding: '8px 6px', fontSize: '0.5625rem', textTransform: 'uppercase', letterSpacing: .3, color: '#17233C', fontWeight: 700, borderBottom: '1px solid #eef2f6', borderRight: '1px solid #eef2f6', cursor: 'pointer', maxWidth: 190 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>{children}{sortIcon('name')}</span>
          </th>
        );
        const groupTh = (label, color, bg, span) => (
          <th colSpan={span} style={{ background: bg, color, padding: '6px 4px', fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700, textAlign: 'center', borderBottom: '1px solid #eef2f6', borderLeft: '1px solid #eef2f6', whiteSpace: 'nowrap' }}>{label}</th>
        );

        const metricCell = (p, m) => {
          const v = m.val(p);
          // Clicking still requires a real value — a zero has no donors to list.
          const click = m.filterType ? (e) => { e.stopPropagation(); if (v > 0) setSelectedFro({ froId: p.fro_id, froName: p.fro_name, filterType: m.filterType, status: m.status }); } : null;
          // Every value renders in the same style, zero and ₹0 included. These
          // used to drop to a washed-out grey with no weight whenever the value was
          // 0, and a pill column lost its colour entirely — so a ₹0 read as "no
          // data" rather than "collected nothing", which is a different thing on a
          // performance board. A zero is a real result and is shown like one.
          if (m.pill) {
            return (
              <td key={m.key} style={{ padding: m.narrow ? '5px 0' : '5px 1px', textAlign: 'center', borderLeft: '1px solid #f1f5f9' }}>
                <span
                  onClick={click}
                  title={m.title ? m.title(p) : (click ? `Click to view ${m.full.toLowerCase()}` : undefined)}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: m.narrow ? 18 : 22, padding: m.narrow ? '1px 3px' : '1px 4px', borderRadius: 5, background: m.bg, color: m.color, fontSize: '0.656rem', fontWeight: 700, cursor: click ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
                  {m.display ? m.display(v, p) : v}
                </span>
              </td>
            );
          }
          return (
            <td key={m.key} style={{ padding: m.narrow ? '5px 0' : '5px 1px', textAlign: 'center', borderLeft: '1px solid #f1f5f9' }}>
              <span onClick={click} style={{ fontSize: '0.656rem', fontWeight: 600, color: '#334155', cursor: click ? 'pointer' : 'default' }}>{m.display ? m.display(v, p) : v}</span>
            </td>
          );
        };

        const statusFilters = [
          { key: 'all', label: 'All', color: '#334155' },
          { key: 'online', label: 'Online', color: '#16a34a' },
          { key: 'idle', label: 'Idle', color: '#2F80D9' },
          { key: 'meeting', label: 'Meeting', color: '#7c3aed' },
          { key: 'offline', label: 'Offline', color: '#94a3b8' },
        ];

        const periodOptions = [
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: 'weekly', label: 'This Week' },
          { value: 'monthly', label: 'This Month' },
          { value: 'custom', label: 'Custom Date' },
        ];

        return (
          <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #eef2f6', boxShadow: '0 2px 8px rgba(15,23,42,.04)', marginBottom: 16 }}>

            {/* Header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #eef2f6', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h3 style={{ fontSize: 24, fontWeight: 700, color: '#17233C', margin: 0 }}>Telecaller Performance</h3>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#2F80D9', background: '#eff6ff', border: '1px solid #dbeafe', padding: '2px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>{viewRows.length} FROs</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 400, color: '#64748B', marginTop: 4 }}>Live performance overview of all telecallers</div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Search FRO name..."
                  value={froSearch}
                  onChange={e => setFroSearch(e.target.value)}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, fontFamily: 'inherit', outline: 'none', width: 180, background: '#f7fafc', color: '#17233C' }}
                />
                <select
                  value={dashPeriod}
                  onChange={e => setDashPeriod(e.target.value)}
                  title="Date filter"
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', outline: 'none', background: '#f7fafc', color: '#17233C', cursor: 'pointer' }}
                >
                  {periodOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button
                  onClick={handleTelecallerExport}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', border: 'none', background: '#2F80D9', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  title="Export Telecaller Performance report (XLSX)"
                >
                  <Download width="14" height="14" />
                  Export Full Report (XLSX)
                </button>
              </div>
            </div>

            {/* Status filter pills */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '18px 24px 0' }}>
              {statusFilters.map(f => {
                const active = perfStatusFilter === f.key;
                return (
                  <button
                    key={f.key}
                    onClick={() => setPerfStatusFilter(f.key)}
                    title={`Show ${f.label} FROs`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 999,
                      border: `1.5px solid ${active ? f.color : '#e2e8f0'}`,
                      background: active ? `${f.color}14` : '#fff',
                      color: active ? f.color : '#64748B',
                      fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                      transition: 'all .18s ease', whiteSpace: 'nowrap',
                    }}
                  >
                    {f.key !== 'all' && (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, display: 'inline-block', flexShrink: 0 }} />
                    )}
                    <span>{f.label}</span>
                    <span style={{
                      minWidth: 18, height: 18, padding: '0 6px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                      background: active ? f.color : '#eef1f6', color: active ? '#fff' : '#64748B',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'all .18s ease',
                    }}>{bucketCounts[f.key]}</span>
                  </button>
                );
              })}
            </div>

            {/* Performance table */}
            <div className="perf-scroll" style={{ margin: '16px 12px 0', overflow: 'auto', maxHeight: 620, borderRadius: 12, border: '1px solid #eef2f6' }}>
              {/* width:max-content so every column is exactly as wide as its own
                  widest cell instead of the table stretching to the panel and
                  handing the slack to the columns. minWidth stays as the
                  small-screen floor that forces a horizontal scroll rather than
                  squashing the columns into each other. */}
              {sortedRows.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>No FROs match your search.</div>
              ) : (
                <table className="perf-table" style={{ borderCollapse: 'collapse', minWidth: 1620, width: 'max-content' }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 3, background: '#fff' }}>
                    <tr>
                      {stickyTh('FRO Name', 0)}
                      {GROUPS.map(g => groupTh(g.label, g.color, g.bg, g.keys.length))}
                    </tr>
                    <tr>
                      {/* One sub-header per metric, in GROUPS order, so this
                          cannot fall out of step with the group spans above or
                          the body cells below. */}
                      {GROUPS.flatMap(g => g.keys.map(k => subHeader(METRIC_DEFS[k])))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((p) => {
                      const live = p.status === 'online' || p.status === 'on_call';
                      const met = p.status === 'meeting';
                      // Idle means the disposition timer ran out and nobody has
                      // resumed — surface it on the name cell, not just the
                      // number, so a glance down the row catches it.
                      const idl = p.status === 'idle';
                      const highlighted = live || met || idl;
                      return (
                        <tr key={p.fro_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td className="pf-stick" style={{ position: 'sticky', left: 0, zIndex: 1, background: '#fff', padding: '7px 6px', whiteSpace: 'nowrap', borderRight: '1px solid #f1f5f9', maxWidth: 190 }}>
                            {/* maxWidth matches the header cell's cap (190 minus this
                                cell's 6px padding each side) so the column is decided
                                by its content and both cells agree on where to stop. */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', maxWidth: 178, overflow: 'hidden' }}>
                              {live && (
                                <span className="pf-live-dot" title="Online · on calls/system" style={{ width: 9, height: 9, borderRadius: '50%', background: '#16a34a', display: 'inline-block', flexShrink: 0 }} />
                              )}
                              {met && (
                                <span title="In meeting · counters paused" style={{ width: 9, height: 9, borderRadius: '50%', background: '#7c3aed', display: 'inline-block', flexShrink: 0, boxShadow: '0 0 0 3px rgba(124,58,237,.18)' }} />
                              )}
                              {idl && (
                                <span title="Idle — disposition timer ran out, awaiting disposition" style={{ width: 9, height: 9, borderRadius: '50%', background: '#dc2626', display: 'inline-block', flexShrink: 0, boxShadow: '0 0 0 3px rgba(220,38,38,.18)' }} />
                              )}
                              <span style={{ fontWeight: highlighted ? 700 : 600, color: idl ? '#b91c1c' : live ? '#15803d' : (met ? '#6d28d9' : '#17233C'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.fro_name}</span>
                              {idl && (
                                <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 }}>Idle</span>
                              )}
                              {(p.today_idle_seconds || 0) > 3600 && (
                                <button
                                  title={`Idle for ${formatDuration(p.today_idle_seconds)} — click to warn this telecaller`}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      const r = await apiPost('/ngo-admin/notify-fro', { workerId: p.fro_id, message: 'Your idle time is increasing. Kindly get back to work.' });
                                      toast(r?.message || `Warning sent to ${p.fro_name}`, 'success');
                                    } catch (err) {
                                      toast(err.message || 'Could not send warning', 'error');
                                    }
                                  }}
                                  style={{ background: '#dc2626', border: '1px solid #b91c1c', cursor: 'pointer', padding: '1px 6px', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 999, fontSize: 9, fontWeight: 700, flexShrink: 0 }}
                                >
                                  <Bell size={9} fill="currentColor" /> Warn
                                </button>
                              )}
                              {met && (
                                // Icon only. The word "Meeting" cost more width
                                // than the state was worth on a board this dense —
                                // the purple dot beside it already says meeting at
                                // a glance, and the tooltip names it.
                                <span title="In meeting · counters paused" style={{ width: 18, height: 16, padding: '0 4px', borderRadius: 999, background: '#f5f3ff', color: '#7c3aed', border: '1px solid #ddd6fe', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Megaphone size={10} /></span>
                              )}
                              {p.work_as_operator_name && (
                                <span title={`${p.work_as_operator_name} work as ${p.fro_name}`} style={{ fontSize: 9, fontWeight: 700, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', padding: '1px 7px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap', flexShrink: 0 }}><Zap size={9} /> {p.work_as_operator_name}</span>
                              )}
                            </div>
                          </td>
                          {METRICS.map(mx => metricCell(p, mx))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <style>{`
              @keyframes pfPulseGreen {
                0% { box-shadow: 0 0 0 0 rgba(22,163,74,.45); }
                70% { box-shadow: 0 0 0 7px rgba(22,163,74,0); }
                100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); }
              }
              .perf-scroll { scrollbar-width: none; -ms-overflow-style: none; }
              .perf-scroll::-webkit-scrollbar { width: 0; height: 0; }
              .perf-scroll::-webkit-scrollbar:horizontal { display: none; }
              .perf-scroll::-webkit-scrollbar:vertical { display: none; }
              .perf-table tbody tr:hover td { background: #f8fafc; }
              .perf-table tbody tr:hover td.pf-stick { background: #f8fafc; }
            `}</style>
          </div>
        );
      })()}

      {/* Target-paced High / Low performance panels */}
      <div className="performance-sections">
        {/* ── High Performance ── */}
        <div className="performance-card">
          <div className="performance-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              <span style={{ width: 44, height: 44, borderRadius: '50%', background: '#dcfce7', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Trophy size={20} /></span>
              <div style={{ minWidth: 0 }}>
                <h3 className="performance-title" style={{ color: '#14532D' }}>High Performance</h3>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              {weakLoading
                ? <span style={{ whiteSpace: 'nowrap', fontSize: 10, color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="3" strokeLinecap="round" className="weak-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" className="weak-spin-arc"/></svg> Loading…</span>
                : <span style={{ whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: '#64748b' }}>Daily target pace</span>}
              <input
                type="text"
                placeholder="Search FRO name..."
                value={highPerfSearch}
                onChange={e => setHighPerfSearch(e.target.value)}
                style={{ width: 190, height: 34, border: '1px solid #dbe5f1', borderRadius: 8, background: '#ffffff', padding: '0 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none', color: '#17233C', boxSizing: 'border-box' }}
              />
            </div>
          </div>

          <div className="performance-table-wrapper" style={{ flex: 1 }}>
            {weakLoading ? (
              <div style={{ minHeight: 320, padding: '4px 16px' }}>
                {[0,1,2,3,4,5].map(i => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 0', borderBottom: i < 5 ? '1px solid #f1f5f9' : 'none' }}>
                    <div style={{ width: 24, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ flex: 1, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 80, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 80, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 70, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 55, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 90, height: 18, background: '#eef2f6', borderRadius: 999 }} />
                  </div>
                ))}
              </div>
            ) : highRows.length === 0 ? (
              <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ width: 28, height: 28, margin: '0 auto 10px', borderRadius: '50%', background: '#fffbeb', color: '#d97706', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trophy size={16} /></div>
                  <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
                    {topPresent.length === 0 ? 'No FROs are currently above the daily target.' : 'No FROs match your search.'}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ minHeight: 320, maxHeight: 420, overflowY: 'auto' }}>
                <table className="performance-table">
                  <colgroup>
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '21%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '16%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {['#'].concat(['FRO','Period','Collected','Monthly Tgt','Period Tgt','Worked','Perf']).map((h, ci) => (
                        <th key={ci} style={{ padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#52698a', background: '#f8fafc', position: 'sticky', top: 0, zIndex: 5, textAlign: ci === 0 ? 'center' : ci === 1 ? 'left' : ci === 6 ? 'center' : ci === 7 ? 'center' : 'right', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {highRows.map((p, i) => (
                      <tr key={p.fro_id} className="performance-row" style={{ minHeight: 42, borderBottom: '1px solid #edf1f5' }}>
                        <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, borderRadius: 999, background: '#16a34a', color: '#ffffff', fontSize: 10, fontWeight: 700 }}>{p.rank ?? (i + 1)}</span>
                        </td>
                        <td style={{ padding: '7px 8px', fontWeight: 600, color: '#17233C', fontSize: 11, overflowWrap: 'anywhere', lineHeight: 1.25 }}>{p.fro_name}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>₹{Number(p.period_collection ?? p.today_collection ?? 0).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>₹{Math.round(p.collection_amount || 0).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>₹{Math.round(p.monthly_target || 0).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>₹{Math.round(p.period_target ?? p.average_collection ?? 0).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 600, color: '#17233C', fontSize: 11 }}>{p.worked_days}/{p.working_days}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                          <div style={{ fontWeight: 700, color: '#16a34a', fontSize: 11, marginBottom: 4 }}>{Number(p.performance_pct || 0).toFixed(1)}%</div>
                          <div style={{ width: '100%', height: 5, background: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(Number(p.performance_pct || 0), 100)}%`, height: '100%', borderRadius: 'inherit', background: '#16a34a' }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid #bbf7d0', borderRadius: 10, background: '#f0fdf4' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a', display: 'flex', alignItems: 'center', gap: 6 }}><TrendingUp size={14} /> Total High Performers: {topPresent.length} FROs</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 1.4 }}>These FROs have achieved at least 100% of their daily collection target.</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#14532D', whiteSpace: 'nowrap' }}>Keep it up!</span>
            </div>
          </div>
        </div>

        {/* ── Low Performance ── */}
        <div className="performance-card">
          <div className="performance-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              <span style={{ width: 44, height: 44, borderRadius: '50%', background: '#FFF1F2', color: '#EF4444', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><TriangleAlert size={20} /></span>
              <div style={{ minWidth: 0 }}>
                <h3 className="performance-title" style={{ color: '#991B1B' }}>Low Performance</h3>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <input
                type="text"
                placeholder="Search FRO name..."
                value={lowPerfSearch}
                onChange={e => setLowPerfSearch(e.target.value)}
                style={{ width: 190, height: 34, border: '1px solid #dbe5f1', borderRadius: 8, background: '#ffffff', padding: '0 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none', color: '#17233C', boxSizing: 'border-box' }}
              />
              {/* Present / Absent. Defaults to Present: the panel's question is who
                  came in and underperformed, and mixing in everyone who never
                  arrived pushed the relevant rows down the list. Each tab carries
                  its own count so a non-zero other half is never mistaken for an
                  empty panel. */}
              <div role="tablist" aria-label="Filter Low Performance by attendance" style={{ display: 'inline-flex', border: '1px solid #dbe5f1', borderRadius: 8, overflow: 'hidden', height: 34 }}>
                {[
                  { key: 'present', label: 'Present', count: lowAttendanceCounts.present, color: '#16a34a', bg: '#f0fdf4' },
                  { key: 'absent', label: 'Absent', count: lowAttendanceCounts.absent, color: '#b45309', bg: '#fff8e7' },
                ].map(t => {
                  const active = lowPerfAttendance === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setLowPerfAttendance(t.key)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, height: '100%', padding: '0 10px',
                        border: 'none', borderLeft: t.key === 'absent' ? '1px solid #dbe5f1' : 'none',
                        background: active ? t.bg : '#ffffff', color: active ? t.color : '#64748b',
                        fontSize: 11.5, fontWeight: active ? 700 : 600, fontFamily: 'inherit', cursor: 'pointer',
                      }}
                    >
                      {t.label}
                      <span style={{
                        fontSize: 10, fontWeight: 700, minWidth: 16, padding: '1px 4px', borderRadius: 999,
                        background: active ? t.color : '#f1f5f9', color: active ? '#ffffff' : '#64748b',
                        fontVariantNumeric: 'tabular-nums',
                      }}>{t.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="performance-table-wrapper" style={{ flex: 1 }}>
            {weakLoading ? (
              <div style={{ minHeight: 320, padding: '4px 16px' }}>
                {[0,1,2,3,4,5].map(i => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 0', borderBottom: i < 5 ? '1px solid #f1f5f9' : 'none' }}>
                    <div style={{ width: 24, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ flex: 1, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 80, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 80, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 70, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 55, height: 10, background: '#eef2f6', borderRadius: 5 }} />
                    <div style={{ width: 90, height: 18, background: '#eef2f6', borderRadius: 999 }} />
                  </div>
                ))}
              </div>
            ) : lowRows.length === 0 ? (
              <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ width: 28, height: 28, margin: '0 auto 10px', borderRadius: '50%', background: '#f0fdf4', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Target size={16} /></div>
                  <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
                    {lowPerfSearch.trim()
                      ? 'No FROs match your search.'
                      : lowPerfAttendance === 'absent'
                        ? 'No absent FROs are below target.'
                        : lowAttendanceCounts.absent > 0
                          ? 'No present FROs are below target. Everyone here is on the Absent tab.'
                          : 'All FROs have reached the daily target.'}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ minHeight: 320, maxHeight: 420, overflowY: 'auto' }}>
                <table className="performance-table">
                  <colgroup>
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '21%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '16%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {['#'].concat(['FRO','Period','Collected','Monthly Tgt','Period Tgt','Worked','Perf']).map((h, ci) => (
                        <th key={ci} style={{ padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#52698a', background: '#f8fafc', position: 'sticky', top: 0, zIndex: 5, textAlign: ci === 0 ? 'center' : ci === 1 ? 'left' : ci === 6 ? 'center' : ci === 7 ? 'center' : 'right', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lowRows.map((p) => {
                      const noTarget = !(Number(p.monthly_target) > 0);
                      const absent = p.punched_in !== true;
                      return (
                      <tr key={p.fro_id} className="performance-row" style={{ minHeight: 42, borderBottom: '1px solid #edf1f5' }}>
                        <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                          {p.rank != null
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, borderRadius: 999, background: '#EF4444', color: '#ffffff', fontSize: 10, fontWeight: 700 }}>{p.rank}</span>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, borderRadius: 999, background: '#e5e7eb', color: '#64748b', fontSize: 11, fontWeight: 700 }} title="Not ranked — no monthly target set">—</span>}
                        </td>
                        <td style={{ padding: '7px 8px', fontWeight: 600, color: '#17233C', fontSize: 11, overflowWrap: 'anywhere', lineHeight: 1.25 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span>{p.fro_name}</span>
                            {absent && (
                              <span title="Not marked present for this period" style={{ fontSize: 9, fontWeight: 700, letterSpacing: .3, textTransform: 'uppercase', color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '1px 6px', borderRadius: 999 }}>Absent</span>
                            )}
                            {noTarget && (
                              <span title="No monthly target set for this month" style={{ fontSize: 9, fontWeight: 700, letterSpacing: .3, textTransform: 'uppercase', color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0', padding: '1px 6px', borderRadius: 999 }}>No target</span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>₹{Number(p.period_collection ?? p.today_collection ?? 0).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>₹{Math.round(p.collection_amount || 0).toLocaleString('en-IN')}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>{noTarget ? <span style={{ color: '#94a3b8' }}>—</span> : `₹${Math.round(p.monthly_target || 0).toLocaleString('en-IN')}`}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>{noTarget ? <span style={{ color: '#94a3b8' }}>—</span> : `₹${Math.round(p.period_target ?? p.average_collection ?? 0).toLocaleString('en-IN')}`}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 600, color: '#17233C', fontSize: 11 }}>{p.worked_days}/{p.working_days}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                          {noTarget ? (
                            <div style={{ fontWeight: 600, color: '#64748b', fontSize: 10.5 }} title="Performance is measured against the monthly target; none is set for this month.">No target set</div>
                          ) : (
                            <>
                              <div style={{ fontWeight: 700, color: '#EF4444', fontSize: 11, marginBottom: 4 }}>{Number(p.performance_pct || 0).toFixed(1)}%</div>
                              <div style={{ width: '100%', height: 5, background: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(Number(p.performance_pct || 0), 100)}%`, height: '100%', borderRadius: 'inherit', background: '#EF4444' }} />
                              </div>
                            </>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid #fecdd3', borderRadius: 10, background: '#fff5f5' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#EF4444', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Users size={14} /> Total Low Performers: {lowAll.length} FROs
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 1.4 }}>
                  These FROs are below 100% of their daily collection target — {lowAttendanceCounts.present} present, {lowAttendanceCounts.absent} absent.
                </div>
                {lowAboveTargetAbsent > 0 && (
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, lineHeight: 1.4 }}>
                    {lowAboveTargetAbsent} absent FRO{lowAboveTargetAbsent === 1 ? '' : 's'} at or above target — above 100%, so not listed here.
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#991B1B', whiteSpace: 'nowrap' }}>Let's support them!</span>
            </div>
          </div>
        </div>
      </div>

      {/* REQUIREMENT 5: Hourly Call Performance — summary chips + disposition breakdown + productivity alerts */}
      {(() => {
        const dayIST = toIstDate();
        const isToday = hourlyDate === dayIST;
        const nowHourIST = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
        // how many working hours are in the past/bucketable from 09:00 IST
        const elapsedIdx = isToday ? Math.min(11, Math.max(-1, nowHourIST - 9)) : 12;

        const froGroups = hourlyGroups;
        const elapsedHrs = isToday ? Math.max(0, elapsedIdx + 1) : HOURS_IN_WORKDAY;
        const targetPace = Math.round((connTarget * elapsedHrs) / HOURS_IN_WORKDAY);
        const froPerf = (g) => (targetPace > 0 ? Math.round((g.connected / targetPace) * 1000) / 10 : null);
        const q = hourlyFroSearch.trim().toLowerCase();
        const lowGroups = (q ? froGroups.filter(g => (g.name || '').toLowerCase().includes(q)) : froGroups)
          .filter(g => (froPerf(g) ?? 0) < 100)
          .sort((a, b) => (froPerf(a) - froPerf(b)) || a.name.localeCompare(b.name));
        const froRow = (g) => {
          const perf = froPerf(g);
          const left = Math.max(0, connTarget - g.connected);
          return (
            <tr key={g.id} className="performance-row" style={{ borderBottom: '1px solid #edf1f5' }}>
              <td style={{ padding: '7px 8px', fontWeight: 600, color: '#17233C', fontSize: 11, overflowWrap: 'anywhere', lineHeight: 1.25 }}>{g.name}</td>
              <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 800, color: '#16a34a', fontSize: 11, whiteSpace: 'nowrap' }}>{g.connected}</td>
              <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, color: '#64748B', fontSize: 11, whiteSpace: 'nowrap' }}>{targetPace}</td>
              <td style={{ padding: '7px 8px', textAlign: 'right', fontWeight: 600, color: left > 0 ? '#2F80D9' : '#16a34a', fontSize: 11, whiteSpace: 'nowrap' }}>{left > 0 ? left : '✓'}</td>
              <td style={{ padding: '7px 4px', textAlign: 'center' }}>
                <div style={{ fontWeight: 700, color: perf == null ? '#64748b' : '#ef4444', fontSize: 11, marginBottom: 3 }}>{perf == null ? '—' : perf + '%'}</div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: 56, height: 5, background: '#e5e7eb', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ width: `${perf == null ? 0 : Math.min(perf, 100)}%`, height: '100%', borderRadius: 'inherit', background: '#ef4444' }} />
                  </div>
                </div>
              </td>
            </tr>
          );
        };

        return (
          <>
            {/* FRO Hourly Performance + Productivity Alerts — side by side */}
            <div className="performance-sections">
              <div className="performance-card" style={{ height: 460 }}>
              <div className="performance-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                  <span style={{ width: 44, height: 44, borderRadius: '50%', background: '#E0F2FE', color: '#0284c7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Phone size={20} /></span>
                  <h3 className="performance-title" style={{ color: '#17233C', whiteSpace: 'nowrap' }}>Hourly Performance</h3>
                  <input
                    type="text"
                    placeholder="Search FRO name..."
                    value={hourlyFroSearch}
                    onChange={e => setHourlyFroSearch(e.target.value)}
                    style={{ flex: 1, minWidth: 180, maxWidth: 300, height: 34, border: '1px solid #dbe5f1', borderRadius: 8, background: '#ffffff', padding: '0 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none', color: '#17233C', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ position: 'relative' }}>
                  <button onClick={() => { setConnTargetDraft(String(connTarget)); setConnTargetMsg(''); setConnTargetOpen(o => !o); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#17233C', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <Target size={12} /> Target: {connTarget}
                  </button>
                  {connTargetOpen && (
                    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 240, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.18)', padding: 14, zIndex: 30 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#17233C', marginBottom: 2 }}>Connected calls / day target</div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 8 }}>Only connected calls count toward this target. All FRO pace % recalculates on save.</div>
                      <input type="number" min="1" value={connTargetDraft} onChange={e => setConnTargetDraft(e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, border: '1px solid #dbe5f1', fontSize: 13, fontFamily: 'inherit', outline: 'none', color: '#17233C' }}
                      />
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 5 }}>Hourly pace: {Math.round((Number(connTargetDraft) || 0) / HOURS_IN_WORKDAY)}/hr over {HOURS_IN_WORKDAY} working hours</div>
                      {connTargetMsg && <div style={{ fontSize: 10, color: '#dc2626', marginTop: 6 }}>{connTargetMsg}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={saveConnTarget} disabled={connTargetBusy}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: connTargetBusy ? 'default' : 'pointer' }}>
                          {connTargetBusy ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setConnTargetOpen(false)}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#64748B', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="performance-table-wrapper" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                {hourlyLoading ? (
                  <div style={{ minHeight: 200, padding: '4px 16px' }}>
                      {[0,1,2,3,4,5].map(i => (
                        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '5px 0', borderBottom: i < 5 ? '1px solid #f1f5f9' : 'none' }}>
                          <div style={{ width: 14, height: 6, background: '#eef2f6', borderRadius: 4 }} />
                          <div style={{ flex: 1, height: 6, background: '#eef2f6', borderRadius: 4 }} />
                          <div style={{ width: 36, height: 6, background: '#eef2f6', borderRadius: 4 }} />
                          <div style={{ width: 36, height: 6, background: '#eef2f6', borderRadius: 4 }} />
                          <div style={{ width: 30, height: 6, background: '#eef2f6', borderRadius: 4 }} />
                          <div style={{ width: 44, height: 11, background: '#eef2f6', borderRadius: 999 }} />
                        </div>
                      ))}
                    </div>
                ) : hourlyTotals.calls === 0 && elapsedIdx < 0 ? (
                  <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ width: 28, height: 28, margin: '0 auto 10px', borderRadius: '50%', background: '#f1f5f9', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Clock size={16} /></div>
                      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>Working window hasn't started yet — alerts begin from 09:00 IST</div>
                    </div>
                  </div>
                ) : hourlyTotals.calls === 0 ? (
                  <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ textAlign: 'center', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>No calls recorded on this date</div>
                  </div>
                ) : lowGroups.length === 0 ? (
                  <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ width: 28, height: 28, margin: '0 auto 10px', borderRadius: '50%', background: '#f0fdf4', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700 }}><CircleCheck size={16} /></div>
                      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>All FROs are at or above the target pace.</div>
                    </div>
                  </div>
                ) : (
                  <div className="performance-table-scroll">
                    <table className="performance-table">
                      <colgroup>
                        <col style={{ width: '30%' }} />
                        <col style={{ width: '13%' }} />
                        <col style={{ width: '13%' }} />
                        <col style={{ width: '13%' }} />
                        <col style={{ width: '31%' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          {['FRO','Conn','Tgt Pace','Tgt Left','Perf'].map((h, ci) => (
                            <th key={ci} style={{ padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#52698a', background: '#f8fafc', position: 'sticky', top: 0, zIndex: 5, textAlign: ci === 0 ? 'left' : ci === 4 ? 'center' : 'right', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {lowGroups.map(froRow)}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* FRO Status — present FROs with Pause/Resume */}
            <div className="productivity-alerts" style={{ width: '100%', minWidth: 0, height: 460, background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Header */}
              <div style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: '#17233C', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#16a34a', display: 'inline-flex', flexShrink: 0 }} />
                  FRO Status
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#2F80D9', background: '#eff6ff', border: '1px solid #dbeafe', padding: '2px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                    {(tlData?.performance || []).filter(p => ['online', 'on_call', 'meeting'].includes(p.status)).length} present
                  </span>
                </h3>
                <input
                  type="text"
                  placeholder="Search FRO name..."
                  value={presentSearch}
                  onChange={e => setPresentSearch(e.target.value)}
                  style={{ width: 220, height: 34, border: '1px solid #dbe5f1', borderRadius: 8, background: '#ffffff', padding: '0 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none', color: '#17233C', boxSizing: 'border-box' }}
                />
              </div>

              {/* Body: loading / empty states / present-FRO list with Pause-Resume */}
              {(() => {
                const pillOf = (p) => {
                  if (p.is_paused) return { label: 'Paused', color: '#6D28D9', bg: '#F5F3FF' };
                  if (p.status === 'on_call') return { label: 'On Call', color: '#15803d', bg: '#ecfdf5' };
                  if (p.status === 'meeting') return { label: 'Meeting', color: '#7c3aed', bg: '#f5f3ff' };
                  return { label: 'Online', color: '#16a34a', bg: '#f0fdf4' };
                };
                // Live paused-minutes counter: how long this FRO has been paused.
                const pausedMins = (p) => {
                  if (!p.is_paused || !p.paused_at) return null;
                  const m = Math.floor((nowTs - new Date(p.paused_at).getTime()) / 60000);
                  return m < 0 ? null : m;
                };
                const dotOf = (p) => p.is_paused ? '#6D28D9' : p.status === 'meeting' ? '#7c3aed' : '#16a34a';
                if (!tlData) {
                  return (
                    <div style={{ padding: '8px 24px 20px' }} aria-label="Loading FRO status">
                      {[0, 1, 2, 3, 4].map(i => (
                        <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: i < 4 ? '1px solid #f1f5f9' : 'none', alignItems: 'center' }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#eef2f6' }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ height: 13, width: '45%', background: '#eef2f6', borderRadius: 6, marginBottom: 6 }} />
                            <div style={{ height: 11, width: '70%', background: '#eef2f6', borderRadius: 6 }} />
                          </div>
                          <div style={{ width: 64, height: 28, background: '#eef2f6', borderRadius: 8 }} />
                        </div>
                      ))}
                    </div>
                  );
                }
                if (meetingActive) {
                  return (
                    <div style={{ padding: '28px 24px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Megaphone size={34} color="#7c3aed" /></div>
                      <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, color: '#7c3aed' }}>Counts paused — meeting in progress</div>
                      <div style={{ marginTop: 4, fontSize: 12, color: '#64748B' }}>FRO Status resumes automatically when an admin ends the meeting.</div>
                    </div>
                  );
                }
                const q = presentSearch.toLowerCase().trim();
                const present = (tlData.performance || [])
                  .filter(p => ['online', 'on_call', 'meeting'].includes(p.status) && (!q || (p.fro_name || '').toLowerCase().includes(q)))
                  .sort((a, b) => ((a.fro_name || '').localeCompare(b.fro_name || '')));
                if (present.length === 0) {
                  return (
                    <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                      <div style={{ width: 28, height: 28, margin: '0 auto 10px', borderRadius: '50%', background: '#f1f5f9', color: '#64748B', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Clock size={16} /></div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#17233C' }}>{q ? 'No FROs match your search.' : 'No FROs present right now.'}</div>
                      {!q && <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>Present FROs will appear here with pause controls.</div>}
                    </div>
                  );
                }
                return (
                  <div className="productivity-table-wrap" style={{ width: '100%', minWidth: 0, flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}>
                    {present.map(p => {
                      const pill = pillOf(p);
                      const busy = pausingFroId === p.fro_id;
                      return (
                        <div key={p.fro_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid #f1f5f9' }}>
                          <span style={{ width: 9, height: 9, borderRadius: '50%', background: dotOf(p), display: 'inline-block', flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <span title={p.fro_name} style={{ fontWeight: 700, color: '#17233C', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.fro_name}</span>
                              <span title={p.is_paused && p.paused_by ? `Paused by ${p.paused_by}` : pill.label} style={{ fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: pill.bg, color: pill.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{pill.label}</span>
                            </div>
                            <div style={{ fontSize: 11, color: '#64748B', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.is_paused && <>Paused {pausedMins(p) == null ? '' : `${pausedMins(p)}m `}· by {p.paused_by || 'Admin'}</>}
                              {p.work_as_operator_name ? ` · ⚡ ${p.work_as_operator_name}` : ''}
                            </div>
                          </div>
                          <button
                            onClick={() => handleTogglePause(p)}
                            disabled={pausingFroId === p.fro_id}
                            title={p.is_paused ? `Resume ${p.fro_name}` : `Pause ${p.fro_name}`}
                            style={{ height: 30, padding: '0 10px', borderRadius: 8, fontSize: 11, fontWeight: 700, fontFamily: 'inherit', cursor: pausingFroId === p.fro_id ? 'default' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0, ...(p.is_paused ? { border: '1px solid #DCE7F5', background: '#fff', color: '#17233C' } : { border: '1px solid #FDE68A', background: '#FFFBEB', color: '#92400E' }) }}
                          >
                            {pausingFroId === p.fro_id ? '…' : p.is_paused ? '▶ Resume' : '⏸ Pause'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <style>{`
                .productivity-alerts thead th { position: sticky; top: 0; z-index: 5; }
                .productivity-table-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
                .productivity-table-wrap::-webkit-scrollbar-thumb { background: #d3dae4; border-radius: 999px; }
                .productivity-table-wrap::-webkit-scrollbar-track { background: transparent; }
                .productivity-alerts tbody tr:hover { background: #f8fbff; }
                @keyframes countPop { 0% { transform: scale(.55); opacity: .3; } 60% { transform: scale(1.12); } 100% { transform: scale(1); opacity: 1; } }
              `}</style>
              </div>
            </div>

            {/* Station-wise Collection - monthly actual receipts ranked by station.
                Amounts come from receipts.amount (money received), not from an FRO's
                logged amount_collected, so this card agrees with the Collection card
                above it instead of contradicting it. Full width: it holds three
                team sections side by side, so it needs the whole page. */}
            <div className="station-collection-wrap" style={{ width: '100%', minWidth: 0, marginBottom: 16 }}>
              <div style={{ padding: '0 4px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: '#17233C', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#2F80D9', display: 'inline-flex', flexShrink: 0 }} />
                  Station-wise Collection
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#2F80D9', background: '#eff6ff', border: '1px solid #dbeafe', padding: '2px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>
                    {formatRupees(stationCollection?.total || 0)}
                  </span>
                </h3>
                <input
                  type="month"
                  aria-label="Station-wise Collection month"
                  value={stationMonth}
                  onChange={e => e.target.value && setStationMonth(e.target.value)}
                  style={{ height: 34, border: '1px solid #dbe5f1', borderRadius: 8, background: '#ffffff', padding: '0 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none', color: '#17233C' }}
                />
              </div>

              {(() => {
                if (stationLoading && !stationCollection) {
                  return (
                    <div className="performance-sections" style={{ marginBottom: 0 }} aria-label="Loading station collection">
                      {STATION_PANELS.map(panel => (
                        <div key={panel.key} className="performance-card" style={{ height: 460 }}>
                          <div className="performance-header">
                            <div style={{ height: 14, width: 120, background: '#eef2f6', borderRadius: 6 }} />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', padding: '0 8px 16px' }}>
                            {STATION_SECTIONS.map(section => (
                              <div key={section.label} style={{ minWidth: 0, padding: '0 8px', borderLeft: '1px solid #f1f5f9' }}>
                                <div style={{ height: 12, width: '60%', background: '#eef2f6', borderRadius: 6, marginBottom: 12 }} />
                                {[0, 1, 2, 3].map(i => (
                                  <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
                                    <div style={{ width: 56, height: 12, background: '#eef2f6', borderRadius: 6 }} />
                                    <div style={{ flex: 1 }} />
                                    <div style={{ width: 60, height: 12, background: '#eef2f6', borderRadius: 6 }} />
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                }
                if (!stationCollection) {
                  return (
                    <div className="performance-card" style={{ height: 460, justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#17233C' }}>Could not load station collection.</div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>Change the month or try again.</div>
                    </div>
                  );
                }
                // A month with no receipts at all gets the empty state rather than
                // a grid of empty columns. Verified against production: 2026-07 and
                // 2026-06 both have a zero total and land here.
                if ((stationCollection.total || 0) <= 0) {
                  return (
                    <div className="performance-card" style={{ height: 460, justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: '0 24px' }}>
                      <div style={{ width: 28, height: 28, margin: '0 auto 10px', borderRadius: '50%', background: '#f1f5f9', color: '#64748B', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Clock size={16} /></div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#17233C' }}>No station collected in this month.</div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>Pick a different month above.</div>
                    </div>
                  );
                }
                const other = stationCollection.other || { amount: 0, count: 0 };
                const unattributed = stationCollection.unattributed || { amount: 0, count: 0 };
                // Header band heights are fixed so the three sticky rows can be
                // pinned at exact offsets and never overlap each other.
                const thBase = { fontSize: 11, fontWeight: 700, color: '#64748B', background: '#ffffff', boxSizing: 'border-box' };
                return (
                  <>
                    {/* OLD on the left, NEW on the right, as two sibling cards in
                        the same two-column grid that holds Hourly Performance and
                        FRO Status above. Each card carries the three team sections,
                        and each section shows one station family: the pre-rename
                        code on the OLD card, the current code for the same area on
                        the NEW one. */}
                    <div className="performance-sections" style={{ marginBottom: 0 }}>
                      {STATION_PANELS.map(panel => {
                        // Rows are keyed on the station NUMBER, not on list
                        // position. BOD-1, AOD-1 and MOD-1 share row 1; BOD-10,
                        // AOD-10 and MOD-10 share row 10. Zipping by position
                        // instead would put BOD-10 on row 3 beside AOD-3, whenever
                        // a family is missing a station in the middle.
                        //
                        // A number is the union of the numbers present in any of
                        // the three sections, so a row exists if any one section
                        // has it. The sections that do not have it render blank,
                        // and those blanks contribute nothing to the row total.
                        const byNumber = STATION_SECTIONS.map(s => {
                          const list = stationsByFamily.get(panel.pick(s)) || [];
                          const map = new Map();
                          const unnumbered = [];
                          for (const r of list) {
                            const parsed = stationOrderKey(r.station);
                            // stationOrderKey returns [kind, prefix, num, tail];
                            // kind 0 means a real number was found.
                            if (parsed[0] === 0) map.set(parsed[2], r);
                            else unnumbered.push(r);
                          }
                          return { map, unnumbered };
                        });
                        const numbers = [...new Set(byNumber.flatMap(ix => [...ix.map.keys()]))].sort((a, b) => a - b);
                        // Codes with no number ('BOD-OLD', 'M-2') cannot join a
                        // numbered row, so they are listed after them rather than
                        // being dropped or shoved onto row 1.
                        const stray = [];
                        byNumber.forEach((ix, si) => ix.unnumbered.forEach(r => stray.push({ si, r })));
                        stray.sort((a, b) => stationOrderCompare(a.r.station, b.r.station));
                        const rows = [
                          ...numbers.map(n => ({ key: `n${n}`, label: String(n), cells: byNumber.map(ix => ix.map.get(n) || null) })),
                          ...stray.map((s, i) => ({ key: `s${i}`, label: '', cells: byNumber.map((_, si) => (si === s.si ? s.r : null)) })),
                        ];
                        const depth = rows.length;
                        const rowTotal = (i) => rows[i].cells.reduce((sum, c) => sum + (Number(c?.amount) || 0), 0);
                        // Sum of the row totals, so the grand total is the same
                        // arithmetic as the column beneath it and cannot disagree.
                        const panelTotal = rows.reduce((acc, _, i) => acc + rowTotal(i), 0);
                        return (
                        <div key={panel.key} className="performance-card station-card station-card-old" style={{ height: 460 }}>
                          <div className="performance-header">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                              <span className={`station-card-icon station-card-icon-${panel.key}`}><Users size={18} /></span>
                              <div style={{ minWidth: 0 }}>
                                <h3 className="performance-title" style={{ color: '#17233C' }}>{panel.title}</h3>
                                <div style={{ fontSize: 11, color: '#64748B', lineHeight: 1.3 }}>{panel.sub}</div>
                              </div>
                            </div>
                            <span className="station-card-total" style={{ color: panel.key === 'old' ? '#475569' : '#1d4ed8', background: panel.key === 'old' ? '#f1f5f9' : '#eff6ff', borderColor: panel.key === 'old' ? '#e2e8f0' : '#dbeafe' }} title={`Total collected by ${panel.key === 'old' ? 'pre-rename' : 'current'} station codes this month`}>
                              {formatRupees(panelTotal)}
                            </span>
                          </div>

                          <div className="productivity-table-wrap station-scroll" style={{ width: '100%', minWidth: 0, flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}>
                            {/* Three coloured sections plus a neutral Total column on
                                the right, which is the only column whose figure is not
                                tied to one station family. It carries the panel
                                grand total, matching the badge in the card header. */}
                            <div className="station-sections" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(88px, 0.62fr)' }}>
                              {STATION_SECTIONS.map((section, si) => {
                                const hue = STATION_HUES[section.hue];
                                const family = panel.pick(section);
                                const list = stationsByFamily.get(family) || [];
                                const sum = list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                                // No background here on purpose: the section tint comes
                                // from CSS, so recolouring a section is a one-rule
                                // change. An inline background would win over it.
                                const familyCell = { fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', height: 28, padding: '0 10px', textAlign: 'left', color: hue.head, borderBottom: '1px solid #e2e8f0' };
                                return (
                                  <div key={section.label} className="station-section" style={{ minWidth: 0, borderLeft: si > 0 ? '1px solid #e2e8f0' : 'none' }}>
                                    <table className="station-collection-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                                      {/* Explicit column widths, identical for all
                                          three sections. Without them the two
                                          columns are resolved from content, so a
                                          section whose rows happen to be blank (a
                                          missing station number) came out narrower
                                          than its neighbours and the four columns
                                          stopped lining up. Fixed here so an empty
                                          cell paints an empty bordered box instead
                                          of collapsing the column. */}
                                      <colgroup>
                                        <col style={{ width: '46%' }} />
                                        <col style={{ width: '54%' }} />
                                      </colgroup>
                                      <thead>
                                        <tr>
                                          <th colSpan={2} style={{ ...thBase, height: 34, padding: '0 12px', textAlign: 'left', letterSpacing: '0.1em', fontWeight: 800, fontSize: 12, color: '#ffffff', background: hue.head, borderBottom: '1px solid #e2e8f0' }}>
                                            {section.label}
                                          </th>
                                        </tr>
                                        <tr>
                                          <th colSpan={2} className="station-family-a" style={{ ...familyCell }}>{family}</th>
                                        </tr>
                                        <tr>
                                          <th style={{ ...thBase, height: 26, padding: '0 10px', textAlign: 'left' }}>Station</th>
                                          <th className="station-rule-right" style={{ ...thBase, height: 26, padding: '0 10px', textAlign: 'right' }} title={`Total collected by ${family} this month`}>{formatRupees(sum)}</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {depth === 0 && (
                                          <tr>
                                            <td colSpan={2} style={{ padding: '14px 10px', fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>No {family} collection this month</td>
                                          </tr>
                                        )}
                                        {/* One row per station NUMBER across all three
                                            sections. A section that has no station for
                                            that number renders a blank cell, so a gap
                                            in one column never shifts the others. */}
                                        {rows.map(row => {
                                          const r = row.cells[si];
                                          // A visible rule on every cell, blank or
                                          // not, so a station number missing from
                                          // this section still reads as a real slot
                                          // in the grid instead of a gap.
                                          const cell = { height: 42, boxSizing: 'border-box', padding: '8px 10px', fontSize: 12, whiteSpace: 'nowrap' };
                                          return (
                                            <tr key={`${family}-${row.key}`} className="station-row">
                                              <td title={r?.station} style={{ ...cell, fontWeight: 700, color: r ? '#17233C' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r?.station || ''}</td>
                                              <td className="station-rule-right" style={{ ...cell, textAlign: 'right', fontWeight: 700, color: r ? hue.head : '#cbd5e1' }}>{r ? formatRupees(r.amount) : ''}</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })}

                              {/* Total column. A per-row addition, not a list of
                                  subtotals: row 1 is BOD-1 + AOD-1 + MOD-1, row 2 is
                                  BOD-2 + AOD-2 + MOD-2, and so on.

                                  Correct only because rows are keyed on the station
                                  NUMBER, not on list position. If BOD-10 and AOD-10
                                  exist but MOD-10 does not, row 10 shows those two
                                  and a blank cell for MOD, and the row total adds
                                  just the two that exist.

                                  Neutral grey rather than a fourth section colour, so
                                  it reads as the sum of the three beside it. */}
                              <div className="station-section station-section-total" style={{ minWidth: 0, borderLeft: '1px solid #e2e8f0' }}>
                                <table className="station-collection-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                                  <thead>
                                    <tr>
                                      <th style={{ ...thBase, height: 34, padding: '0 10px', textAlign: 'left', letterSpacing: '0.1em', fontWeight: 800, fontSize: 12, color: '#ffffff', background: '#334155', borderBottom: '1px solid #e2e8f0' }}>
                                        Total
                                      </th>
                                    </tr>
                                    <tr>
                                      <th className="station-family-a" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', height: 28, padding: '0 10px', textAlign: 'left', color: '#334155', borderBottom: '1px solid #e2e8f0' }}>
                                        All
                                      </th>
                                    </tr>
                                    <tr>
                                      <th style={{ ...thBase, height: 26, padding: '0 10px', textAlign: 'right' }} title="Sum of the three sections on this row">Row Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {depth === 0 && (
                                      <tr>
                                        <td style={{ padding: '14px 10px', fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>Nothing to add</td>
                                      </tr>
                                    )}
                                    {rows.map((row, i) => {
                                      const t = rowTotal(i);
                                      // A row where every section is blank adds to
                                      // nothing, so it stays blank rather than
                                      // showing a misleading ₹0. A partial row still
                                      // shows its total, and the tooltip spells out
                                      // which stations went into it.
                                      const present = row.cells.filter(Boolean);
                                      return (
                                        <tr key={`total-${row.key}`} className="station-row">
                                          <td style={{ height: 42, boxSizing: 'border-box', padding: '8px 10px', fontSize: 12, textAlign: 'right', fontWeight: 800, color: present.length ? '#0f172a' : '#cbd5e1', whiteSpace: 'nowrap' }} title={present.length ? present.map(r => r.station).join(' + ') : 'No stations on this row'}>
                                            {present.length ? formatRupees(t) : ''}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                  <tfoot>
                                    <tr>
                                      <td style={{ padding: '10px', fontSize: 13, fontWeight: 800, textAlign: 'right', color: '#0f172a', background: '#f1f5f9', borderTop: '2px solid #cbd5e1', whiteSpace: 'nowrap' }} title={`Total collected by ${panel.key === 'old' ? 'pre-rename' : 'current'} station codes this month`}>
                                        {formatRupees(panelTotal)}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            </div>
                          </div>
                        </div>
                        );
                      })}
                    </div>

                    {/* Money that is not attributable to a family column. Kept below
                        the three sections and inside the same total, so the card
                        still reconciles with the Collection card above. */}
                    {(other.count > 0 || unattributed.count > 0) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '10px 16px', background: '#fffbeb', borderTop: '1px solid #fde68a' }}>
                        {other.count > 0 && (
                          <div title={`Receipts tied to a pre-rename or unrecognised station code (${other.count} receipts). Counted in the total, because the money is attributed - just to an older station name.`}>
                            <span style={{ fontSize: 11, color: '#92400E' }}>Other / Legacy Code </span>
                            <span style={{ fontSize: 12, fontWeight: 800, color: '#92400E' }}>{formatRupees(other.amount)}</span>
                            <span style={{ fontSize: 10, color: '#b45309' }}> ({other.count} receipts)</span>
                          </div>
                        )}
                        {unattributed.count > 0 && (
                          <div title={`Receipts whose assignment carries no station (${unattributed.count} receipts). Counted in the total so this card agrees with the Collection card above.`}>
                            <span style={{ fontSize: 11, color: '#92400E' }}>Unattributed / No Station </span>
                            <span style={{ fontSize: 12, fontWeight: 800, color: '#92400E' }}>{formatRupees(unattributed.amount)}</span>
                            <span style={{ fontSize: 10, color: '#b45309' }}> ({unattributed.count} receipts)</span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Scoped to this card rather than relying on .productivity-alerts,
                  whose sticky rule lives in a <style> tag inside the FRO Status
                  card. Independent, so moving either card cannot break the other. */}
              <style>{`
                /* Three stacked header bands per section. borderCollapse is
                   'separate' because Chromium does not apply position:sticky to
                   a th inside a collapsed-border table, which is what made the
                   labels scroll away underneath the rows. Offsets must match the
                   fixed band heights set inline (34 / 28 / 26). */
                .station-collection-table thead tr:nth-child(1) th { position: sticky; top: 0; z-index: 4; }
                .station-collection-table thead tr:nth-child(2) th { position: sticky; top: 34px; z-index: 4; }
                .station-collection-table thead tr:nth-child(3) th { position: sticky; top: 62px; z-index: 4; border-bottom: 1px solid #cbd5e1; }

                /* Visible row and column lines. Every cell carries a rule —
                   including a cell with no station on it — so a gap reads as an
                   empty slot in the grid rather than the column collapsing.
                   Drawn from --sec-rule, so each section's lines carry its own
                   tint and the three still line up with the Total column. */
                .station-collection-table tbody td { border-bottom: 1px solid var(--sec-rule, #e2e8f0); }
                .station-collection-table tbody tr:last-child td { border-bottom: 1px solid #94a3b8; }
                .station-collection-table .station-rule-right { border-left: 1px solid var(--sec-rule, #e2e8f0); }

                /* Section tinting. The hue rides on a custom property so one rule
                   paints a section, so recolouring BSCT/AFLF/MANN is a single
                   edit per section rather than a per-cell one. */
                .station-section { --sec: #dbeafe; --sec-rule: #bfdbfe; }
                .station-section:nth-child(2) { --sec: #ede9fe; --sec-rule: #ddd6fe; }
                .station-section:nth-child(3) { --sec: #fce7f3; --sec-rule: #fbcfe8; }
                .station-section .station-family-a { background: var(--sec); }
                .station-section tbody tr:nth-child(odd) td { background: #fcfdff; }
                .station-section tbody tr:hover td { background: var(--sec); }

                /* Card header furniture, matching the icon-and-total treatment on
                   Hourly Performance. The OLD card is greyed to read as the
                   reference side of the comparison; the section hues inside it
                   stay identical, so BSCT still matches BSCT across the two. */
                .station-card-icon {
                  width: 36px; height: 36px; border-radius: 50%;
                  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
                }
                .station-card-icon-old { background: #f1f5f9; color: #475569; }
                .station-card-icon-new { background: #dbeafe; color: #1d4ed8; }
                .station-card-total {
                  font-size: 13px; font-weight: 800; padding: 4px 12px;
                  border-radius: 999px; border: 1px solid; white-space: nowrap;
                }
                .station-card-old { background: #fafbfc; }

                /* The Total column must not pick up a section tint from the
                   nth-child rules above, so it opts out explicitly. It is a
                   summary of the other three, not a fourth area. */
                .station-section-total { --sec: #f1f5f9; --sec-rule: #e2e8f0; }

                /* Vertical scrollbar hidden on request. The element keeps
                   overflow-y: auto, so the list still scrolls by wheel, trackpad
                   and keyboard, and the sticky headers still work. Only the bar
                   itself is invisible. */
                .station-scroll { scrollbar-width: none; -ms-overflow-style: none; }
                .station-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
              `}</style>
            </div>
          </>
        );
      })()}

      <style>{`@keyframes weakSpin { to { transform: rotate(360deg); } } .weak-spin { animation: weakSpin .6s linear infinite; transform-origin: center; }`}</style>


      {/* Call Connectivity Widget removed */}

      {selectedStation && (
        <StationDetailModal
          station={selectedStation}
          stats={stations[selectedStation]}
          stationInfo={stationInfoMap[selectedStation]}
          ngoId={(() => {
            // Which NGO this cell belongs to. The station grid is keyed by NAME,
            // so the same name can appear under several NGO tabs; prefer the tab
            // in view and fall back to the station's own first NGO. Without this
            // the donor popup would union every NGO sharing the name.
            const rowNgos = (stationInfoMap[selectedStation]?.ngos || []).filter(n => n && n.ngo_id);
            if (rowNgos.length === 0) return '';
            const preferred = selectedNgoId && selectedNgoId !== 'all' ? String(selectedNgoId) : null;
            const hit = preferred ? rowNgos.find(n => String(n.ngo_id) === preferred) : null;
            return (hit || rowNgos[0]).ngo_id;
          })()}
          onClose={() => setSelectedStation(null)}
        />
      )}
      {selectedPeriod && (
        <CollectionDetailModal
          period={selectedPeriod}
          totalAmount={selectedPeriod === 'month' ? month_collection : today_collection}
          onClose={() => setSelectedPeriod(null)}
        />
      )}

      {selectedStatus && (
        <CollectionDetailModal
          status={selectedStatus}
          monthAmount={selectedStatus === 'verified' ? verified_month_amount : unverified_month_amount}
          monthCount={selectedStatus === 'verified' ? verified_month_count : unverified_month_count}
          todayAmount={selectedStatus === 'verified' ? verified_today_amount : unverified_today_amount}
          todayCount={selectedStatus === 'verified' ? verified_today_count : unverified_today_count}
          onClose={() => setSelectedStatus(null)}
        />
      )}

      {selectedFro && (
        <FroDetailModal
          froId={selectedFro.froId}
          froName={selectedFro.froName}
          filterType={selectedFro.filterType}
          status={selectedFro.status}
          rangeFrom={activeRange.from}
          rangeTo={activeRange.to}
          onClose={() => setSelectedFro(null)}
        />
      )}
    </div>
  );
}
