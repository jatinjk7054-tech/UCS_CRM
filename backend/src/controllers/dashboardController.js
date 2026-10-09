import { getAllNgos } from '../models/ngoModel.js';
import { getAllUsers, getUsersCountByRole } from '../models/userModel.js';
import { getAllHRs } from '../models/hrModel.js';
import { getAllWorkers, getWorkerById } from '../models/workerModel.js';
import { getDashboardStats } from '../models/froAssignmentModel.js';
import { getTotalCollectedByWorker, getWorkerCollectionReceipts } from '../models/froDonorLogModel.js';
import db from '../config/db.js';
import { FRO_IDLE_LIVE_COLS } from '../utils/froIdleCols.js';
import { dayTotalsForWorkers } from '../services/froTimeSessions.js';
import { istDateStr, effectiveIdleSeconds, idleFreezeCutoffMs } from '../utils/froIdle.js';
import { isCovered } from '../utils/workAs.js';
import { getActiveCoversForTargets } from '../models/workAsSessionModel.js';

function calcDateRange(period) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);

  let from, prevFrom, prevTo;
  const dur = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : period === '1y' ? 365 : null;

  if (dur) {
    const s = new Date(now); s.setDate(s.getDate() - dur + 1);
    from = s.toISOString().slice(0, 10);
    const ps = new Date(s); ps.setDate(ps.getDate() - dur);
    prevFrom = ps.toISOString().slice(0, 10);
    const pe = new Date(s); pe.setDate(pe.getDate() - 1);
    prevTo = pe.toISOString().slice(0, 10);
  } else {
    from = '1970-01-01';
    prevFrom = '1970-01-01';
    prevTo = '1970-01-01';
  }
  return { from, to: end, prevFrom, prevTo, dur, isAll: !dur };
}

function calcChange(curr, prev) {
  if (!prev || prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100 * 10) / 10;
}

export const getSuperAdminDashboard = async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const range = calcDateRange(period);

    const ngos = await getAllNgos();
    const [users, hrs, workers] = await Promise.all([
      getAllUsers({}),
      getAllHRs({}),
      getAllWorkers(),
    ]);

    /* ── Period-filtered stats ── */
    const userCreated = users.filter(u => u.created_at?.slice(0, 10) >= range.from);
    const workerCreated = workers.filter(w => w.created_at?.slice(0, 10) >= range.from);
    const activeUsers = userCreated.filter(u => u.is_active).length;

    /* ── Previous period stats for change % ── */
    const prevUserCreated = users.filter(u => {
      const d = u.created_at?.slice(0, 10);
      return d >= range.prevFrom && d <= range.prevTo;
    }).length;
    const prevWorkerCreated = workers.filter(w => {
      const d = w.created_at?.slice(0, 10);
      return d >= range.prevFrom && d <= range.prevTo;
    }).length;

    const stats = {
      totalNgos: ngos.length,
      totalUsers: userCreated.length,
      activeUsers,
      totalWorkers: workerCreated.length,
      activeWorkers: workerCreated.filter(w => w.is_active).length,
      totalHr: hrs.length,
      totalRecruiters: userCreated.filter(u => u.role === 'recruiter').length,
      workersJoinedThisMonth: period === 'all'
        ? 0
        : (() => {
            const ms = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
            return workers.filter(w => w.created_at >= ms).length;
          })(),
    };

    /* ── KPI changes ── */
    const kpiChanges = {
      totalNgos: 0,
      totalUsers: calcChange(userCreated.length, prevUserCreated),
      activeUsers: 0,
      totalWorkers: calcChange(workerCreated.length, prevWorkerCreated),
      totalHr: 0,
      totalRecruiters: 0,
    };

    /* ── NGO counts ── */
    const ngoUserCounts = await Promise.all(
      ngos.map(async (ngo) => ({
        id: ngo.id, name: ngo.name, code: ngo.code,
        users: (await getAllUsers({ ngo_id: ngo.id })).filter(
          u => u.created_at?.slice(0, 10) >= range.from
        ).length,
        workers: workers.filter(w => w.ngo_id === ngo.id && w.created_at?.slice(0, 10) >= range.from).length,
      }))
    );

    /* ── Role distribution ── */
    const roleDistribution = {};
    userCreated.forEach(u => {
      roleDistribution[u.role] = (roleDistribution[u.role] || 0) + 1;
    });
    /* all-time role distribution (ignores period filter) */
    const allTimeRoleDistribution = {};
    users.forEach(u => {
      allTimeRoleDistribution[u.role] = (allTimeRoleDistribution[u.role] || 0) + 1;
    });

    /* ── Department worker counts ── */
    const deptWorkers = {};
    workerCreated.forEach(w => {
      if (w.department) deptWorkers[w.department] = (deptWorkers[w.department] || 0) + 1;
    });

    /* ── Gender counts ── */
    const genderCounts = { Male: 0, Female: 0, Other: 0 };
    workerCreated.forEach(w => {
      if (w.gender && genderCounts[w.gender] !== undefined) genderCounts[w.gender]++;
    });

    /* ── Parallel independent queries ── */
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayDate = `${istNow.getUTCFullYear()}-${String(istNow.getUTCMonth() + 1).padStart(2, '0')}-${String(istNow.getUTCDate()).padStart(2, '0')}`;
    const today = new Date().toISOString().slice(0, 10);

    const [
      { data: attendance },
      { data: todayRows },
      { data: prevAtt },
      { count: pendingLeaves },
      { data: monthData },
      { data: salaries },
      { data: recentNotices },
      { data: upcomingEvents },
      { data: leadLogs },
    ] = await Promise.all([
      db
        .from('attendance')
        .select('status, date, worker_id, punch_in_time')
        .gte('date', range.from)
        .lte('date', range.to),
      db
        .from('attendance')
        .select('status, worker_id, punch_in_time')
        .eq('date', todayDate),
      db
        .from('attendance')
        .select('status')
        .gte('date', range.prevFrom)
        .lte('date', range.prevTo),
      db
        .from('leaves')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending'),
      db
        .from('attendance')
        .select('date, status')
        .gte('date', range.from)
        .lte('date', range.to),
      db
        .from('salary_history')
        .select('worker_id, salary')
        .is('to_month', null),
      db
        .from('notices')
        .select('id, title, content, created_at, created_by_name, target_role')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(5),
      db
        .from('events')
        .select('id, title, description, event_date, event_time, location')
        .gte('event_date', today)
        .eq('is_active', true)
        .order('event_date', { ascending: true })
        .limit(5),
      db
        .from('fro_donor_logs')
        .select('accounts_status, amount_collected, verified_at')
        .eq('disposition_detail', 'lead_done'),
    ]);

    const attendanceStatus = { present: 0, late: 0, absent: 0, leave: 0 };
    const uniquePills = { present: new Set(), late: new Set(), absent: new Set(), leave: new Set() };
    const workerDept = {};
    workerCreated.forEach(w => { workerDept[w.id] = w.department; });

    const deptPivot = {};
    const workerMap = {};
    workers.forEach(w => { workerMap[w.id] = { name: w.name, department: w.department }; });

    const attendanceDetails = { present: [], late: [], absent: [] };
    const detailAdded = { present: new Set(), late: new Set(), absent: new Set() };

    const allMarkedInPeriod = new Set();
    (attendance || []).forEach(a => {
      allMarkedInPeriod.add(a.worker_id);
      if (attendanceStatus[a.status] !== undefined) {
        attendanceStatus[a.status]++;
        uniquePills[a.status].add(a.worker_id);
      }
      const dept = workerDept[a.worker_id];
      if (dept) {
        if (!deptPivot[dept]) deptPivot[dept] = { department: dept, present: 0, late: 0, absent: 0 };
        if (deptPivot[dept][a.status] !== undefined) deptPivot[dept][a.status]++;
      }
      if (attendanceDetails[a.status] && !detailAdded[a.status].has(a.worker_id)) {
        detailAdded[a.status].add(a.worker_id);
        const w = workerMap[a.worker_id];
        const time = a.punch_in_time
          ? (() => {
              const ms = new Date(a.punch_in_time).getTime() + 5.5 * 60 * 60 * 1000;
              const d = new Date(ms);
              return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
            })()
          : '';
        attendanceDetails[a.status].push({
          name: w?.name || 'Unknown',
          dept: w?.department || '',
          time,
        });
      }
    });

    // Active workers with no attendance record in the period → mark as absent
    workerCreated.filter(w => w.is_active !== false).forEach(w => {
      if (!allMarkedInPeriod.has(w.id) && !detailAdded.absent.has(w.id)) {
        uniquePills.absent.add(w.id);
        detailAdded.absent.add(w.id);
        attendanceDetails.absent.push({
          name: w.name || 'Unknown',
          dept: w.department || '',
          time: '',
        });
      }
    });

    const attendanceWorkerCounts = {
      present: uniquePills.present.size,
      late: uniquePills.late.size,
      absent: uniquePills.absent.size,
      leave: uniquePills.leave.size,
    };
    const deptAttendance = Object.values(deptPivot);

    const totalAtt = Object.values(attendanceWorkerCounts).reduce((s, v) => s + v, 0);
    const attendancePercent = totalAtt > 0
      ? Math.round((attendanceStatus.present / totalAtt) * 1000) / 10
      : 0;

    /* ── Today attendance (for Daily Check-ins pills) ── */
    const todayUnique = { present: new Set(), late: new Set(), absent: new Set(), leave: new Set() };
    const todayAdded = { present: new Set(), late: new Set(), absent: new Set() };
    const todayAttendanceDetails = { present: [], late: [], absent: [] };

    const todayMarked = new Set();
    (todayRows || []).forEach(a => {
      todayMarked.add(a.worker_id);
      if (todayUnique[a.status] !== undefined) todayUnique[a.status].add(a.worker_id);
      if (todayAttendanceDetails[a.status] && !todayAdded[a.status].has(a.worker_id)) {
        todayAdded[a.status].add(a.worker_id);
        const w = workerMap[a.worker_id];
        const time = a.punch_in_time
          ? (() => {
              const ms = new Date(a.punch_in_time).getTime() + istOffset;
              const d = new Date(ms);
              return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
            })()
          : '';
        todayAttendanceDetails[a.status].push({
          name: w?.name || 'Unknown',
          dept: w?.department || '',
          time,
        });
      }
    });

    // Active workers with no attendance record today → mark as absent
    const activeWorkers = workers.filter(w => w.is_active !== false);
    activeWorkers.forEach(w => {
      if (!todayMarked.has(w.id)) {
        todayUnique.absent.add(w.id);
        if (!todayAdded.absent.has(w.id)) {
          todayAdded.absent.add(w.id);
          todayAttendanceDetails.absent.push({
            name: w.name || 'Unknown',
            dept: w.department || '',
            time: '',
          });
        }
      }
    });

    const todayAttendance = {
      present: todayUnique.present.size,
      late: todayUnique.late.size,
      absent: todayUnique.absent.size,
      leave: todayUnique.leave.size,
    };

    /* ── Previous period attendance for comparison ── */
    const prevAttCount = (prevAtt || []).length;
    const prevPresent = (prevAtt || []).filter(a => a.status === 'present').length;
    const prevAttPercent = prevAttCount > 0 ? Math.round((prevPresent / prevAttCount) * 1000) / 10 : 0;
    kpiChanges.attendancePercent = calcChange(attendancePercent, prevAttPercent);

    /* ── Pending leaves ── */

    /* ── Monthly trend (based on period range) ── */
    const dateMap = {};
    const startDate = new Date(range.from);
    const endDate = new Date(range.to);
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      dateMap[ds] = { date: ds, present: 0, late: 0, absent: 0 };
    }
    (monthData || []).forEach(a => {
      if (dateMap[a.date] && dateMap[a.date][a.status] !== undefined) {
        dateMap[a.date][a.status]++;
      }
    });
    const monthlyAttendance = Object.values(dateMap);

    /* ── Salary payable (always all-time) ── */
    const salarySet = new Set();
    let totalSalaryPayable = 0;
    (salaries || []).forEach(s => {
      if (!salarySet.has(s.worker_id)) {
        salarySet.add(s.worker_id);
        totalSalaryPayable += parseFloat(s.salary || 0);
      }
    });

    /* ── Recent notices ── */

    /* ── Upcoming events ── */

    /* ── Accounts Summary (lead verification) ── */
    const accountsSummary = { pending: 0, pendingAmount: 0, verified: 0, verifiedAmount: 0, rejected: 0, rejectedAmount: 0, verifiedToday: 0, verifiedTodayAmount: 0 };
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const log of leadLogs || []) {
      const amt = parseFloat(log.amount_collected || 0);
      if (log.accounts_status === 'pending') { accountsSummary.pending++; accountsSummary.pendingAmount += amt; }
      else if (log.accounts_status === 'verified') {
        accountsSummary.verified++; accountsSummary.verifiedAmount += amt;
        if (log.verified_at && log.verified_at.slice(0, 10) === todayStr) {
          accountsSummary.verifiedToday++; accountsSummary.verifiedTodayAmount += amt;
        }
      }
      else if (log.accounts_status === 'rejected') { accountsSummary.rejected++; accountsSummary.rejectedAmount += amt; }
    }

    /* ── Recruiter Summary ── */
    let recruiterSummary = { totalLeads: 0, newToday: 0, conversionRate: 0 };
    try {
      const { data: allLeads } = await db
        .from('leads')
        .select('id, status, created_at');
      const totalLeads = allLeads?.length || 0;
      const newToday = (allLeads || []).filter(l => l.created_at?.slice(0, 10) === todayStr).length;
      const byStatus = {};
      for (const l of allLeads || []) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      const selected = byStatus['selected'] || 0;
      const rejected = byStatus['rejected'] || 0;
      const conversionRate = (selected + rejected) > 0 ? Math.round((selected / (selected + rejected)) * 1000) / 10 : 0;
      recruiterSummary = { totalLeads, newToday, conversionRate };
    } catch (_) { /* table may not exist */ }

    /* ── Monthly Revenue Trend (last 12 months, verified amounts) ── */
    let monthlyRevenue = [];
    try {
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
      twelveMonthsAgo.setDate(1);
      const fromDate = twelveMonthsAgo.toISOString().slice(0, 10);
      const { data: revenueLogs } = await db
        .from('fro_donor_logs')
        .select('amount_collected, verified_at')
        .eq('accounts_status', 'verified')
        .gte('verified_at', fromDate);
      const monthMap = {};
      for (let i = 0; i < 12; i++) {
        const d = new Date(twelveMonthsAgo);
        d.setMonth(d.getMonth() + i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthMap[key] = { month: key, amount: 0, count: 0 };
      }
      for (const log of revenueLogs || []) {
        const key = log.verified_at?.slice(0, 7);
        if (monthMap[key]) {
          monthMap[key].amount += parseFloat(log.amount_collected || 0);
          monthMap[key].count++;
        }
      }
      monthlyRevenue = Object.values(monthMap);
    } catch (_) { monthlyRevenue = []; }

    /* ── Top FROs by total collection (all-time) ── */
    let topFros = [];
    try {
      const allWorkersForFro = await getAllWorkers();
      const froWorkersOnly = allWorkersForFro.filter(w =>
        (w.department || '').toLowerCase().trim() === 'fro'
      );
      const froNames = froWorkersOnly.filter(w => w.name).map(w => ({ id: w.id, name: w.name.trim() }));
      const froTotals = {};
      // One shared loader instead of a per-FRO `ilike` over the whole receipts
      // table. It attributed by name only, so a receipt stamped with a CRM agent
      // label ("Agent 13") or a printed-name variant was credited to nobody, and
      // ilike treated `_`/`%` in a name as wildcards. All-time window: this tile
      // is explicitly all-time, unlike the per-month card.
      for (const w of froNames) {
        const receipts = await getWorkerCollectionReceipts(w.id, '1970-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z');
        const total = receipts.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
        if (total > 0) froTotals[w.id] = total;
      }
      topFros = froWorkersOnly
        .map(w => ({ id: w.id, name: w.name, totalCollection: froTotals[w.id] || 0 }))
        .filter(f => f.totalCollection > 0)
        .sort((a, b) => b.totalCollection - a.totalCollection)
        .slice(0, 5);
    } catch (_) { topFros = []; }

    /* ── Top Recruiters by lead count (all-time) ── */
    let topRecruiters = [];
    try {
      const { data: recruiterUsers } = await db
        .from('users')
        .select('id, name, login_id')
        .eq('role', 'recruiter');
      const { data: allLeadsForRecruiters } = await db
        .from('leads')
        .select('recruiter_id, created_by');
      const recruiterLeadCounts = {};
      for (const ld of allLeadsForRecruiters || []) {
        const rid = ld.recruiter_id || ld.created_by;
        if (rid) recruiterLeadCounts[rid] = (recruiterLeadCounts[rid] || 0) + 1;
      }
      topRecruiters = (recruiterUsers || [])
        .map(u => ({
          id: u.id,
          name: u.name,
          loginId: u.login_id,
          leadCount: recruiterLeadCounts[u.id] || 0,
        }))
        .filter(r => r.leadCount > 0)
        .sort((a, b) => b.leadCount - a.leadCount)
        .slice(0, 5);
    } catch (_) { topRecruiters = []; }

    /* ── Recent Activity Log (union from multiple tables) ── */
    let recentActivities = [];
    try {
      const [verifiedLeads, newLeads, newWorkers, recentNotifications] = await Promise.all([
        db
          .from('fro_donor_logs')
          .select('id, amount_collected, verified_at, accounts_status, fro_worker_id')
          .not('accounts_status', 'eq', 'pending')
          .order('verified_at', { ascending: false })
          .limit(5),
        db
          .from('leads')
          .select('id, name, status, created_at')
          .order('created_at', { ascending: false })
          .limit(5),
        db
          .from('workers')
          .select('id, name, created_at')
          .order('created_at', { ascending: false })
          .limit(5),
        db
          .from('notification_log')
          .select('id, message, sent_at, type')
          .order('sent_at', { ascending: false })
          .limit(5),
      ]);

      const activities = [];
      for (const l of verifiedLeads?.data || []) {
        activities.push({
          type: l.accounts_status === 'verified' ? 'verified' : 'rejected',
          message: `${l.accounts_status === 'verified' ? '✓' : '✗'} Lead ${l.accounts_status}`,
          detail: `₹${parseFloat(l.amount_collected || 0).toLocaleString('en-IN')}`,
          time: l.verified_at,
        });
      }
      for (const l of newLeads?.data || []) {
        activities.push({
          type: 'lead_created',
          message: `New lead: ${l.name || 'Unknown'}`,
          detail: `Status: ${l.status}`,
          time: l.created_at,
        });
      }
      for (const w of newWorkers?.data || []) {
        activities.push({
          type: 'worker_joined',
          message: `Worker joined: ${w.name || 'Unknown'}`,
          detail: 'New registration',
          time: w.created_at,
        });
      }
      for (const n of recentNotifications?.data || []) {
        activities.push({
          type: 'notification',
          message: n.message || 'Notification sent',
          detail: n.type || '',
          time: n.sent_at,
        });
      }
      activities.sort((a, b) => {
        const ta = a.time ? new Date(a.time).getTime() : 0;
        const tb = b.time ? new Date(b.time).getTime() : 0;
        return tb - ta;
      });
      recentActivities = activities.slice(0, 10);
    } catch (_) { recentActivities = []; }

    return res.json({
      ngos: {
        total: stats.totalNgos || 0,
        change: (kpiChanges.totalNgos) || 0,
        per_ngo: ngoUserCounts,
      },
      users: {
        total: stats.totalUsers || 0,
        active: stats.activeUsers || 0,
        change_total: kpiChanges.totalUsers || 0,
        change_active: kpiChanges.activeUsers || 0,
        role_distribution: roleDistribution,
        all_time_role_distribution: allTimeRoleDistribution,
      },
      workers: {
        total: stats.totalWorkers || 0,
        active: stats.activeWorkers || 0,
        joined_this_month: stats.workersJoinedThisMonth || 0,
        change: kpiChanges.totalWorkers || 0,
        by_department: deptWorkers,
        by_gender: genderCounts,
        by_department_attendance: deptAttendance,
      },
      hr: {
        total: stats.totalHr || 0,
        change: kpiChanges.totalHr || 0,
      },
      recruiters: {
        total: stats.totalRecruiters || 0,
        change: kpiChanges.totalRecruiters || 0,
      },
      attendance: {
        percent: attendancePercent,
        percent_change: kpiChanges.attendancePercent || 0,
        by_status: attendanceStatus,
        by_worker: attendanceWorkerCounts,
        today: todayAttendance,
        by_department: deptAttendance,
        monthly_trend: monthlyAttendance,
        details: attendanceDetails,
        today_details: todayAttendanceDetails,
      },
      pending_leaves: pendingLeaves || 0,
      salary_payable: totalSalaryPayable,
      accounts: {
        pending: { count: accountsSummary.pending ?? 0, amount: accountsSummary.pendingAmount ?? 0 },
        verified: { count: accountsSummary.verified ?? 0, amount: accountsSummary.verifiedAmount ?? 0 },
        rejected: { count: accountsSummary.rejected ?? 0, amount: accountsSummary.rejectedAmount ?? 0 },
        verified_today: { count: accountsSummary.verifiedToday ?? 0, amount: accountsSummary.verifiedTodayAmount ?? 0 },
      },
      recruiting: {
        total_leads: recruiterSummary.totalLeads ?? 0,
        new_today: recruiterSummary.newToday ?? 0,
        conversion_rate: recruiterSummary.conversionRate ?? 0,
      },
      monthly_revenue: monthlyRevenue,
      top_fros: topFros,
      top_recruiters: topRecruiters,
      recent_notices: recentNotices || [],
      upcoming_events: upcomingEvents || [],
      recent_activities: recentActivities,
      froAssignments: [],
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroLiveStatus = async (req, res) => {
  try {
    const allWorkers = await getAllWorkers();
    const froWorkers = allWorkers.filter(w => (w.department || '').toLowerCase().trim() === 'fro');

    const todayStr = new Date().toISOString().slice(0, 10);

    const { data: todayAttendance } = await db
      .from('attendance')
      .select('worker_id, status')
      .eq('date', todayStr)
      .in('worker_id', froWorkers.map(w => w.id));

    const punchedIn = new Set();
    (todayAttendance || []).forEach(a => {
      if (a.status === 'present' || a.status === 'late') punchedIn.add(a.worker_id);
    });

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayStart = new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 0, 0, 0, 0));
    const todayEnd = new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 23, 59, 59, 999));

    const froWorkerIds = froWorkers.map(w => w.id);

    const [allAssignments, allTodayLogs] = await Promise.all([
      db
        .from('fro_assignments')
        .select('fro_worker_id, status')
        .in('fro_worker_id', froWorkerIds),
      db
        .from('fro_donor_logs')
        .select('amount_collected, action, disposition_detail, accounts_status, created_at, verified_at, fro_worker_id')
        .in('fro_worker_id', froWorkerIds)
        .or(
          `and(action.eq.donation,created_at.gte.${todayStart.toISOString()},created_at.lte.${todayEnd.toISOString()}),` +
          `and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified,verified_at.gte.${todayStart.toISOString()},verified_at.lte.${todayEnd.toISOString()}),` +
          `and(disposition_detail.eq.done,action.eq.disposition,created_at.gte.${todayStart.toISOString()},created_at.lte.${todayEnd.toISOString()})`
        ),
    ]);

    const keyMap = {
      pending: 'pending', contacted: 'contacted', follow_up: 'follow_up',
      busy: 'not_reachable', ringing: 'not_reachable', call_waiting: 'not_reachable',
      unreachable: 'not_reachable', switched_off: 'not_reachable', out_of_coverage: 'not_reachable',
      wrong_number: 'not_reachable', invalid_number: 'not_reachable', rejected: 'not_reachable',
      temporary_network_issue: 'not_reachable', voicemail: 'not_reachable',
      not_interested: 'not_interested', not_interested_now: 'not_interested',
      dnd: 'not_interested', wrong_person: 'not_interested', call_disconnected: 'contacted',
      donation_collected: 'donation_collected', lead_done: 'donation_collected', done: 'donation_collected',
      scheduled: 'follow_up', visit_donate: 'contacted', will_donate_online: 'contacted',
      promise_to_pay: 'contacted', payment_pending: 'contacted', already_donated: 'contacted',
      email_sent: 'contacted', whatsapp_sent: 'contacted', csr_inquiry: 'contacted',
      wants_80g_details: 'contacted', wants_trust_documents: 'contacted',
      language_barrier: 'contacted', transferred_senior: 'contacted',
      query_complaint: 'contacted', receipt_request: 'contacted',
    };

    const perWorkerStats = {};
    for (const wid of froWorkerIds) {
      perWorkerStats[wid] = { total: 0, pending: 0, contacted: 0, not_reachable: 0, donation_collected: 0, not_interested: 0, follow_up: 0 };
    }
    for (const a of allAssignments?.data || []) {
      const s = perWorkerStats[a.fro_worker_id];
      if (!s) continue;
      s.total++;
      const key = keyMap[a.status];
      if (key && s[key] !== undefined) s[key]++;
    }

    const perWorkerToday = {};
    for (const wid of froWorkerIds) perWorkerToday[wid] = 0;
    for (const d of allTodayLogs?.data || []) {
      const wid = d.fro_worker_id;
      if (!wid || !(wid in perWorkerToday)) continue;
      perWorkerToday[wid] += parseFloat(d.amount_collected || 0);
    }

    const result = froWorkers.map((w) => {
      const stats = perWorkerStats[w.id];
      const dataUsed = (stats.contacted || 0) + (stats.donation_collected || 0);
      const dataUnused = (stats.total || 0) - dataUsed;

      return {
        id: w.id,
        name: w.name,
        login_id: w.login_id,
        is_active: w.is_active !== false,
        is_punched_in: punchedIn.has(w.id),
        total_data: stats.total || 0,
        data_used: dataUsed,
        data_unused: dataUnused,
        today_collection: perWorkerToday[w.id],
      };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getHrDashboard = async (req, res) => {
  try {
    const workers = await getAllWorkers();
    const users = await getAllUsers({});

    const totalWorkers = workers.length;
    const recruiters = users.filter((u) => u.role === 'recruiter').length;
    const totalNgos = (await getAllNgos()).length;

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const newThisMonth = workers.filter((w) => w.created_at >= monthStart).length;

    const { data: leaves } = await db
      .from('leaves')
      .select('status')
      .eq('status', 'pending');
    const pendingLeaves = leaves?.length || 0;

    const { data: attendance } = await db
      .from('attendance')
      .select('status')
      .gte('date', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));
    const statusCounts = { present: 0, late: 0, absent: 0, leave: 0 };
    (attendance || []).forEach((a) => {
      if (statusCounts[a.status] !== undefined) statusCounts[a.status]++;
    });

    const deptWorkers = {};
    workers.forEach((w) => {
      if (w.department) deptWorkers[w.department] = (deptWorkers[w.department] || 0) + 1;
    });

    const genderCounts = { Male: 0, Female: 0, Other: 0 };
    workers.forEach((w) => {
      if (w.gender && genderCounts[w.gender] !== undefined) genderCounts[w.gender]++;
    });

    return res.json({
      stats: { totalWorkers, recruiters, pendingLeaves, newThisMonth, totalNgos, totalUsers: users.length },
      attendanceStatus: statusCounts,
      deptWorkers,
      genderCounts,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAdminDashboard = async (req, res) => {
  try {
    const ngoId = req.user.ngo_id;
    const workers = ngoId ? await getAllWorkers(ngoId) : await getAllWorkers();
    const users = ngoId ? await getAllUsers({ ngo_id: ngoId }) : await getAllUsers({});

    const userCounts = {};
    users.forEach((u) => { userCounts[u.role] = (userCounts[u.role] || 0) + 1; });

    const { data: attendance } = await db
      .from('attendance')
      .select('status, workers!inner(ngo_id)')
      .gte('date', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));

    const statusCounts = { present: 0, late: 0, absent: 0, leave: 0 };
    const workerIds = new Set(workers.map((w) => w.id));
    (attendance || []).forEach((a) => {
      if (workerIds.has(a.worker_id) && statusCounts[a.status] !== undefined) statusCounts[a.status]++;
    });

    const deptWorkers = {};
    workers.forEach((w) => {
      if (w.department) deptWorkers[w.department] = (deptWorkers[w.department] || 0) + 1;
    });

    return res.json({
      stats: { totalWorkers: workers.length, ...userCounts },
      attendanceStatus: statusCounts,
      deptWorkers,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAccountsDashboard = async (req, res) => {
  try {
    const ngoId = req.user.ngo_id;
    const workers = ngoId ? await getAllWorkers(ngoId) : await getAllWorkers();

    const { data: attendance } = await db
      .from('attendance')
      .select('worker_id, status, date, late_minutes')
      .gte('date', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10));

    const workerIds = new Set(workers.map((w) => w.id));
    const monthAttendance = (attendance || []).filter((a) => workerIds.has(a.worker_id));

    const deptWorkers = {};
    workers.forEach((w) => {
      if (w.department) deptWorkers[w.department] = (deptWorkers[w.department] || 0) + 1;
    });

    return res.json({
      stats: { totalWorkers: workers.length },
      deptWorkers,
      attendanceCount: monthAttendance.length,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getRecruiterDashboard = async (req, res) => {
  try {
    const workers = await getAllWorkers();
    const totalWorkers = workers.length;
    return res.json({ stats: { totalWorkers } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getLeadsDashboard = async (req, res) => {
  try {
    // TODO: Implement actual leads dashboard query
    return res.json({ stats: { totalLeads: 0, callsToday: 0 } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTelecallerDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';

    const { count: assignedLeads } = await db
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .or(`recruiter_id.eq.${userId},created_by.eq.${userId}`);

    const { count: callsToday } = await db
      .from('call_logs')
      .select('*', { count: 'exact', head: true })
      .eq('telecaller_id', userId)
      .gte('call_time', today);

    const { count: callsThisMonth } = await db
      .from('call_logs')
      .select('*', { count: 'exact', head: true })
      .eq('telecaller_id', userId)
      .gte('call_time', monthStart);

    const { data: followUps } = await db
      .from('call_logs')
      .select('id')
      .eq('telecaller_id', userId)
      .lte('follow_up_date', today)
      .not('follow_up_date', 'is', null);

    const followUpsDue = followUps ? new Set(followUps.map(f => f.id)).size : 0;

    return res.json({
      stats: {
        assignedLeads: assignedLeads || 0,
        callsToday: callsToday || 0,
        callsThisMonth: callsThisMonth || 0,
        followUpsDue,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTeamLeadDashboard = async (req, res) => {
  try {
    return res.json({ stats: { teamSize: 0, pendingTasks: 0 } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFroWorkerDashboard = async (req, res) => {
  try {
    const { workerId } = req.params;
    const userNgoIds = req.user.ngo_id ? [req.user.ngo_id] : [];
    if (userNgoIds.length > 0) {
      const worker = await getWorkerById(workerId);
      if (worker && worker.ngo_id && !userNgoIds.some(id => String(id) === String(worker.ngo_id))) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const [stats] = await Promise.all([
      getDashboardStats(workerId),
    ]);

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayStart = new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 0, 0, 0, 0));
    const todayEnd = new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate(), 23, 59, 59, 999));

    const [totalDonations, dailyDonations] = await Promise.all([
      getTotalCollectedByWorker(workerId, '1970-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z'),
      getTotalCollectedByWorker(workerId, todayStart.toISOString(), todayEnd.toISOString()),
    ]);

    const { data: leadDoneData } = await db
      .from('fro_donor_logs')
      .select('donor_id, created_at, fro_worker_id')
      .eq('fro_worker_id', workerId)
      .eq('action', 'disposition')
      .eq('disposition_detail', 'lead_done')
      .eq('accounts_status', 'verified');

    const earliestLead = {};
    for (const log of leadDoneData || []) {
      if (!earliestLead[log.donor_id] || log.created_at < earliestLead[log.donor_id]) {
        earliestLead[log.donor_id] = log.created_at;
      }
    }
    const newDonorsToday = Object.values(earliestLead).filter(
      d => d >= todayStart.toISOString() && d <= todayEnd.toISOString()
    ).length;

    const dataUsed = (stats.contacted || 0) + (stats.donation_collected || 0) + (stats.follow_up || 0);
    const dataUnused = (stats.total || 0) - dataUsed;

    return res.json({
      total_donations: totalDonations,
      daily_donations: dailyDonations,
      new_donors_today: newDonorsToday,
      assigned_data: stats.total || 0,
      data_used: dataUsed,
      data_unused: dataUnused,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/* ════════════════════════════════════════════════════════════════
   SUPER ADMIN — RISK & ALERTS
   ════════════════════════════════════════════════════════════════ */

export const getSuperAdminAlerts = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);

    const twoDaysAgo = new Date(now); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fourteenDaysAgo = new Date(now); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const threeDaysAgo = new Date(now); threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const twentyFourHoursAgo = new Date(now); twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    const sevenDaysAgoForWeek = new Date(now); sevenDaysAgoForWeek.setDate(sevenDaysAgoForWeek.getDate() - 7);

    const alerts = [];

    // ── 1. Zero-Collection FROs (active today, called but collected nothing) ──
    try {
      const { data: froStatus } = await db
        .from('fro_live_status')
        .select('worker_id, today_calls, today_collection')
        .eq('is_active', true);

      const zeroFroIds = (froStatus || [])
        .filter(f => (f.today_calls || 0) > 0 && Number(f.today_collection || 0) === 0)
        .map(f => f.worker_id);

      if (zeroFroIds.length > 0) {
        const { data: froWorkers } = await db
          .from('workers')
          .select('id, name, login_id')
          .in('id', zeroFroIds);

        alerts.push({
          id: 'zero-collection-fros',
          severity: 'critical',
          category: 'fro',
          title: `${zeroFroIds.length} FRO(s) with zero collection today`,
          description: `These FROs made calls today but collected nothing despite being active.`,
          count: zeroFroIds.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Management',
          details: (froWorkers || []).map(w => ({ name: w.name, value: `Login: ${w.login_id}`, id: w.id })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 2. High Rejection Ratio (>10% rejected leads per FRO) ──
    try {
      const { data: recentLogs } = await db
        .from('fro_donor_logs')
        .select('fro_worker_id, disposition_detail, accounts_status, rejection_reason')
        .gte('created_at', sevenDaysAgo.toISOString())
        .limit(50000);

      const froStats = {};
      for (const log of recentLogs || []) {
        const wid = log.fro_worker_id;
        if (!wid) continue;
        if (!froStats[wid]) froStats[wid] = { total: 0, rejected: 0 };
        froStats[wid].total++;
        if (log.accounts_status === 'rejected' || log.disposition_detail === 'rejected') {
          froStats[wid].rejected++;
        }
      }

      const highRejectFros = Object.entries(froStats)
        .filter(([_, s]) => s.total >= 3 && (s.rejected / s.total) > 0.10)
        .map(([wid, s]) => ({ wid, ...s, pct: Math.round((s.rejected / s.total) * 100) }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 10);

      if (highRejectFros.length > 0) {
        const { data: workers } = await db
          .from('workers')
          .select('id, name, login_id')
          .in('id', highRejectFros.map(f => f.wid));

        const workerMap = {};
        for (const w of workers || []) workerMap[w.id] = w;

        alerts.push({
          id: 'high-rejection-ratio',
          severity: 'critical',
          category: 'fro',
          title: `${highRejectFros.length} FRO(s) with high rejection rate (>10%)`,
          description: `FROs with above-threshold rejection rates in the last 7 days.`,
          count: highRejectFros.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Performance',
          details: highRejectFros.map(f => ({
            name: workerMap[f.wid]?.name || 'Unknown',
            value: `${f.rejected}/${f.total} rejected (${f.pct}%)`,
            id: f.wid,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 3. Revenue Drop (>20% week-over-week decline) ──
    try {
      const { data: thisWeek } = await db
        .from('fro_donor_logs')
        .select('amount_collected')
        .eq('accounts_status', 'verified')
        .gte('verified_at', sevenDaysAgo.toISOString());

      const { data: lastWeek } = await db
        .from('fro_donor_logs')
        .select('amount_collected')
        .eq('accounts_status', 'verified')
        .gte('verified_at', fourteenDaysAgo.toISOString())
        .lt('verified_at', sevenDaysAgo.toISOString());

      const thisWeekTotal = (thisWeek || []).reduce((s, l) => s + Number(l.amount_collected || 0), 0);
      const lastWeekTotal = (lastWeek || []).reduce((s, l) => s + Number(l.amount_collected || 0), 0);

      if (lastWeekTotal > 0) {
        const dropPct = Math.round(((lastWeekTotal - thisWeekTotal) / lastWeekTotal) * 100);
        if (dropPct >= 20) {
          alerts.push({
            id: 'revenue-drop',
            severity: 'critical',
            category: 'account',
            title: `Revenue dropped ${dropPct}% week-over-week`,
            description: `This week: ₹${thisWeekTotal.toLocaleString('en-IN')} vs last week: ₹${lastWeekTotal.toLocaleString('en-IN')}`,
            count: dropPct,
            actionPanel: 'accounts',
            actionLabel: 'View Revenue Overview',
            details: [
              { name: 'This Week', value: `₹${thisWeekTotal.toLocaleString('en-IN')}` },
              { name: 'Last Week', value: `₹${lastWeekTotal.toLocaleString('en-IN')}` },
              { name: 'Drop', value: `${dropPct}%` },
            ],
            createdAt: now.toISOString(),
          });
        }
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 4. Unverified Receipts >48h ──
    try {
      const { data: stalePending, count } = await db
        .from('fro_donor_logs')
        .select('id, donor_id, amount_collected, created_at, fro_worker_id', { count: 'exact' })
        .eq('disposition_detail', 'lead_done')
        .eq('accounts_status', 'pending')
        .lt('created_at', twoDaysAgo.toISOString());

      if ((count || 0) > 0) {
        const froIds = [...new Set((stalePending || []).map(l => l.fro_worker_id).filter(Boolean))];
        const { data: froNames } = await db.from('workers').select('id, name').in('id', froIds);
        const nameMap = {};
        for (const w of froNames || []) nameMap[w.id] = w.name;

        alerts.push({
          id: 'stale-pending-verification',
          severity: 'warning',
          category: 'account',
          title: `${count} donation receipt(s) pending verification >48h`,
          description: `These donations have been waiting for accounts verification for over 2 days.`,
          count,
          actionPanel: 'accounts',
          actionLabel: 'View Pending Verifications',
          details: (stalePending || []).slice(0, 10).map(l => ({
            name: `₹${Number(l.amount_collected || 0).toLocaleString('en-IN')}`,
            value: `FRO: ${nameMap[l.fro_worker_id] || 'N/A'} · ${new Date(l.created_at).toLocaleDateString('en-IN')}`,
            id: l.id,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 5. Unresolved Suspense Entries >7d ──
    try {
      const { count } = await db
        .from('bank_audit_entries')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'unverified')
        .lt('created_at', sevenDaysAgo.toISOString());

      if ((count || 0) > 0) {
        alerts.push({
          id: 'stale-suspense',
          severity: 'warning',
          category: 'account',
          title: `${count} suspense bank entries unresolved for 7+ days`,
          description: `Bank audit entries that haven't been verified or matched for over a week.`,
          count,
          actionPanel: 'accounts',
          actionLabel: 'View Bank Audit',
          details: [],
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 6. Missed Schedules (2+ per FRO this week) ──
    try {
      const { data: missedAlerts } = await db
        .from('alerts')
        .select('fro_name, fro_worker_id, donor_name')
        .eq('type', 'missed_schedule')
        .eq('acknowledged', false)
        .gte('created_at', sevenDaysAgoForWeek.toISOString());

      const missedByFro = {};
      for (const a of missedAlerts || []) {
        const key = a.fro_worker_id || a.fro_name || 'unknown';
        if (!missedByFro[key]) missedByFro[key] = { name: a.fro_name || 'Unknown', count: 0, donors: [] };
        missedByFro[key].count++;
        if (a.donor_name) missedByFro[key].donors.push(a.donor_name);
      }

      const seriousMissers = Object.values(missedByFro).filter(f => f.count >= 2);

      if (seriousMissers.length > 0) {
        alerts.push({
          id: 'missed-schedules',
          severity: 'warning',
          category: 'fro',
          title: `${seriousMissers.length} FRO(s) with multiple missed schedules`,
          description: `FROs who missed 2+ scheduled calls this week without follow-up.`,
          count: seriousMissers.reduce((s, f) => s + f.count, 0),
          actionPanel: 'fro',
          actionLabel: 'View Missed Schedules',
          details: seriousMissers.slice(0, 6).map(f => ({
            name: f.name,
            value: `${f.count} missed schedule(s)`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 7. Unresolved Data Requests >24h ──
    try {
      const { data: staleRequests, count } = await db
        .from('fro_data_requests')
        .select('id, fro_worker_id, message, created_at', { count: 'exact' })
        .eq('status', 'pending')
        .lt('created_at', twentyFourHoursAgo.toISOString());

      if ((count || 0) > 0) {
        const workerIds = [...new Set((staleRequests || []).map(r => r.fro_worker_id).filter(Boolean))];
        const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
        const wMap = {};
        for (const w of workers || []) wMap[w.id] = w.name;

        alerts.push({
          id: 'stale-data-requests',
          severity: 'warning',
          category: 'fro',
          title: `${count} FRO data request(s) unresolved >24h`,
          description: `FRO workers waiting for data/admin response for over a day.`,
          count,
          actionPanel: 'fro',
          actionLabel: 'View Data Requests',
          details: (staleRequests || []).slice(0, 6).map(r => ({
            name: wMap[r.fro_worker_id] || 'Unknown',
            value: r.message?.slice(0, 60) || 'No message',
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 8. Missing PAN for Large Donations (>₹10,000) ──
    try {
      const { count } = await db
        .from('fro_donor_logs')
        .select('id', { count: 'exact', head: true })
        .eq('accounts_status', 'verified')
        .gt('amount_collected', 10000)
        .or('pan_number.is.null,pan_number.eq.')
        .gte('created_at', sevenDaysAgo.toISOString());

      if ((count || 0) > 0) {
        alerts.push({
          id: 'missing-pan-large-donations',
          severity: 'warning',
          category: 'compliance',
          title: `${count} verified donation(s) >₹10K missing PAN`,
          description: `Donations above ₹10,000 require PAN for tax compliance. These are missing it.`,
          count,
          actionPanel: 'accounts',
          actionLabel: 'View Accounts',
          details: [],
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 9. Stale Leads (>7 days, status 'new', no contact) ──
    try {
      const { count } = await db
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'new')
        .lt('created_at', sevenDaysAgo.toISOString());

      if ((count || 0) > 0) {
        alerts.push({
          id: 'stale-leads',
          severity: 'info',
          category: 'lead',
          title: `${count} lead(s) unattended for 7+ days`,
          description: `Leads with status "new" that haven't been contacted in over a week.`,
          count,
          actionPanel: 'recruiter',
          actionLabel: 'View Leads Pipeline',
          details: [],
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 10. Pending Leaves >3 days ──
    try {
      const { count } = await db
        .from('leaves')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .lt('created_at', threeDaysAgo.toISOString());

      if ((count || 0) > 0) {
        alerts.push({
          id: 'stale-pending-leaves',
          severity: 'info',
          category: 'hr',
          title: `${count} leave request(s) pending for 3+ days`,
          description: `Leave requests awaiting approval for over 3 working days.`,
          count,
          actionPanel: 'hr',
          actionLabel: 'View Leave Requests',
          details: [],
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 11. FRO Idle >30 min (HIGH) ──
    // The disposition timer lapsed and they haven't pressed Resume. idle_since
    // is the authoritative marker; today_idle_seconds is the day's running
    // total, so the alert can quote both "how long right now" and "how much of
    // the day" at once.
    try {
      const thirtyMinAgo = new Date(now); thirtyMinAgo.setMinutes(thirtyMinAgo.getMinutes() - 30);
      const { data: idleRows } = await db
        .from('fro_live_status')
        .select('worker_id, idle_since, today_idle_seconds, status')
        .eq('is_active', true)
        .eq('is_paused', false)
        .not('idle_since', 'is', null)
        .lt('idle_since', thirtyMinAgo.toISOString());

      // A row left holding idle_since overnight is stale, not a live problem, and
      // a meeting/pause means an admin is holding the FRO rather than the FRO
      // stalling — neither belongs in this alert.
      const todayIst = istDateStr(now);
      // A COVERED FRO is not stalling either. Their row is the one the covering
      // agent's heartbeats land on, so a lapsed deadline on it describes the
      // agent's timer, not the FRO's — alerting on it pages somebody about a
      // telecaller who is demonstrably being worked for.
      let coveredNow = new Set();
      try {
        const { data: covers } = await getActiveCoversForTargets((idleRows || []).map(r => r.worker_id));
        coveredNow = new Set(covers || []);
      } catch (e) {
        console.error('Idle alert cover lookup failed:', e.message);
      }
      const idleFros = (idleRows || []).filter(f =>
        f.status !== 'meeting' && istDateStr(new Date(f.idle_since)) === todayIst
      ).filter(f => !coveredNow.has(String(f.worker_id)));

      if ((idleFros || []).length > 0) {
        const wIds = idleFros.map(f => f.worker_id);
        const { data: iw } = await db.from('workers').select('id, name').in('id', wIds);
        const iwMap = {};
        for (const w of iw || []) iwMap[w.id] = w.name;

        const sinceLabel = (v) => {
          const mins = Math.floor((now.getTime() - new Date(v).getTime()) / 60000);
          return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        };
        const totalLabel = (secs) => {
          const mins = Math.floor((Number(secs || 0)) / 60);
          return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        };

        alerts.push({
          id: 'fro-long-idle',
          severity: 'critical',
          category: 'fro',
          title: `${idleFros.length} FRO(s) idle for 30+ minutes`,
          description: `Active FRO workers whose 4-minute disposition timer ran out and who have not resumed.`,
          count: idleFros.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Live Status',
          details: idleFros.slice(0, 8).map(f => ({
            name: iwMap[f.worker_id] || 'Unknown',
            value: `Idle for ${sinceLabel(f.idle_since)} · Idle today: ${totalLabel(f.today_idle_seconds)}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 12. FRO Ghost Login — punched in but zero calls all day (HIGH) ──
    try {
      const { data: ghostFros } = await db
        .from('fro_live_status')
        .select('worker_id, today_calls, today_talk_seconds, status, updated_at')
        .eq('is_active', true);

      const ghosts = (ghostFros || []).filter(f =>
        (f.today_calls || 0) === 0 &&
        (f.today_talk_seconds || 0) === 0 &&
        (f.status === 'online')
      );

      if (ghosts.length > 0) {
        const gIds = ghosts.map(f => f.worker_id);
        const { data: gw } = await db.from('workers').select('id, name').in('id', gIds);
        const gwMap = {};
        for (const w of gw || []) gwMap[w.id] = w.name;

        alerts.push({
          id: 'fro-ghost-login',
          severity: 'critical',
          category: 'fro',
          title: `${ghosts.length} FRO(s) logged in with zero activity today`,
          description: `Active FRO workers showing online status but have made no calls or talks today.`,
          count: ghosts.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Live Status',
          details: ghosts.slice(0, 8).map(f => ({
            name: gwMap[f.worker_id] || 'Unknown',
            value: `Status: ${f.status} · Last update: ${new Date(f.updated_at).toLocaleTimeString('en-IN')}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 13. Duplicate UPI Transaction IDs (HIGH) ──
    try {
      const { data: upiLogs } = await db
        .from('fro_donor_logs')
        .select('id, upi_transaction_id, amount_collected, donor_id, fro_worker_id, created_at')
        .not('upi_transaction_id', 'is', null)
        .neq('upi_transaction_id', '')
        .gte('created_at', sevenDaysAgo.toISOString());

      const upiMap = {};
      for (const log of upiLogs || []) {
        const txnId = (log.upi_transaction_id || '').trim().toUpperCase();
        if (!txnId) continue;
        if (!upiMap[txnId]) upiMap[txnId] = [];
        upiMap[txnId].push(log);
      }

      const dupes = Object.entries(upiMap).filter(([_, logs]) => logs.length > 1);

      if (dupes.length > 0) {
        const allWorkerIds = [...new Set(dupes.flatMap(([_, logs]) => logs.map(l => l.fro_worker_id)).filter(Boolean))];
        const { data: dw } = allWorkerIds.length > 0
          ? await db.from('workers').select('id, name').in('id', allWorkerIds)
          : { data: [] };
        const dwMap = {};
        for (const w of dw || []) dwMap[w.id] = w.name;

        alerts.push({
          id: 'duplicate-upi',
          severity: 'critical',
          category: 'compliance',
          title: `${dupes.length} duplicate UPI transaction ID(s) detected`,
          description: `Same UPI transaction ID used in multiple donation logs — possible duplicate or fraudulent entries.`,
          count: dupes.length,
          actionPanel: 'accounts',
          actionLabel: 'View Accounts',
          details: dupes.slice(0, 6).map(([txnId, logs]) => ({
            name: `UPI: ${txnId}`,
            value: `${logs.length} entries · ₹${logs.reduce((s, l) => s + Number(l.amount_collected || 0), 0).toLocaleString('en-IN')} total`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 14. Consecutive Absences (3+ days) (HIGH) ──
    try {
      const sevenDaysAgoDate = new Date(now); sevenDaysAgoDate.setDate(sevenDaysAgoDate.getDate() - 7);
      const { data: recentAbsences } = await db
        .from('attendance')
        .select('worker_id, date')
        .eq('status', 'absent')
        .gte('date', sevenDaysAgoDate.toISOString().slice(0, 10))
        .order('date', { ascending: true });

      const absByWorker = {};
      for (const rec of recentAbsences || []) {
        if (!absByWorker[rec.worker_id]) absByWorker[rec.worker_id] = [];
        absByWorker[rec.worker_id].push(rec.date);
      }

      const chronicAbsents = [];
      for (const [wid, dates] of Object.entries(absByWorker)) {
        const sorted = [...new Set(dates)].sort();
        let maxStreak = 1, streak = 1;
        for (let i = 1; i < sorted.length; i++) {
          const prev = new Date(sorted[i - 1]);
          const curr = new Date(sorted[i]);
          const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);
          if (diffDays <= 1.5) { streak++; maxStreak = Math.max(maxStreak, streak); }
          else { streak = 1; }
        }
        if (maxStreak >= 3) chronicAbsents.push({ wid, days: maxStreak });
      }

      if (chronicAbsents.length > 0) {
        const cIds = chronicAbsents.map(c => c.wid);
        const { data: cw } = await db.from('workers').select('id, name').in('id', cIds);
        const cwMap = {};
        for (const w of cw || []) cwMap[w.id] = w.name;

        alerts.push({
          id: 'consecutive-absences',
          severity: 'critical',
          category: 'hr',
          title: `${chronicAbsents.length} worker(s) with 3+ consecutive absent days`,
          description: `Workers with extended consecutive absences in the last 7 days — possible abandonment or attendance fraud.`,
          count: chronicAbsents.length,
          actionPanel: 'hr',
          actionLabel: 'View HR',
          details: chronicAbsents.slice(0, 6).map(c => ({
            name: cwMap[c.wid] || 'Unknown',
            value: `${c.days} consecutive day(s) absent`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 15. FRO High Idle Time (>50% of work hours) (HIGH) ──
    try {
      const workHoursSeconds = 8 * 3600;
      // The panel only commits elapsed idle when a period closes, so the raw
      // counter reads 0 mid-period and an FRO idle for hours would never trip
      // this alert. effectiveIdleSeconds() adds the still-running period, which
      // is derived from the deadline — no heartbeat required.
        const { data: idleFros } = await db
          .from('fro_live_status')
          .select(FRO_IDLE_LIVE_COLS)
          .eq('is_active', true);

        // A covered-away FRO's idle is frozen, here as everywhere else.
        //
        // This is the alert that pages somebody about an FRO being idle for more
        // than half their working day, and a covered-away FRO is the single most
        // likely person to trip it: their row goes quiet the moment somebody else
        // takes their stations, the deadline lapses against nobody, and the
        // still-open period keeps being added on read. Without the freeze the
        // alert escalates about someone who is legitimately being covered, and
        // the only way to silence it is to make them look busy.
        let coversByTarget = new Map();
        try {
          coversByTarget = await getActiveCoversForTargets((idleFros || []).map(f => f.worker_id));
        } catch (e) {
          // work_as_sessions unavailable — fall back to the unfrozen figure.
        }
        const nowMs = Date.now();
        const idleByWorker = {};
        const frozenFor = {};
        for (const f of idleFros || []) {
          const frozenAt = isCovered(coversByTarget, f.worker_id) ? idleFreezeCutoffMs(f) : NaN;
          frozenFor[String(f.worker_id)] = frozenAt;
          idleByWorker[f.worker_id] = effectiveIdleSeconds(f, null, nowMs, frozenAt);
        }
        try {
          const ledger = await dayTotalsForWorkers((idleFros || []).map(f => f.worker_id), {
            nowMs,
            nowFor: (id) => frozenFor[id],
          });
          for (const f of idleFros || []) {
            const t = ledger.get(String(f.worker_id));
            if (t) idleByWorker[f.worker_id] = t.idle_seconds;
          }
        } catch (e) {
          console.error('High idle alert ledger read failed:', e.message);
        }

      const highIdle = (idleFros || []).filter(f =>
        idleByWorker[f.worker_id] > workHoursSeconds * 0.5 &&
        (f.today_calls || 0) > 0
      );

      if (highIdle.length > 0) {
        const iIds = highIdle.map(f => f.worker_id);
        const { data: iw } = await db.from('workers').select('id, name').in('id', iIds);
        const iwMap = {};
        for (const w of iw || []) iwMap[w.id] = w.name;

        // The threshold is workHoursSeconds * 0.5, NOT a flat 4h. The title used
        // to hardcode ">4h today", which only coincided with the real number at
        // the default 8h day and misreported it for any other configured day.
        const thresholdHours = (workHoursSeconds * 0.5) / 3600;
        const thresholdLabel = `${Number.isInteger(thresholdHours) ? thresholdHours : thresholdHours.toFixed(1)}h`;

        alerts.push({
          id: 'fro-high-idle',
          severity: 'warning',
          category: 'fro',
          title: `${highIdle.length} FRO(s) with excessive idle time (>${thresholdLabel} today)`,
          description: `FROs spending over 50% of working hours (${thresholdLabel}) idle despite being active — possible productivity issue.`,
          count: highIdle.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Performance',
          details: highIdle.slice(0, 6).map(f => ({
            name: iwMap[f.worker_id] || 'Unknown',
            value: `Idle: ${Math.round(idleByWorker[f.worker_id] / 60)}min · Calls: ${f.today_calls || 0}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 16. NGOs with Zero Active FROs (HIGH) ──
    try {
      const { data: ngoList } = await db.from('ngos').select('id, name');
      const { data: activeFroByNgo } = await db
        .from('workers')
        .select('id, ngo_id')
        .eq('department', 'fro')
        .eq('is_active', true);

      const frosByNgo = {};
      for (const w of activeFroByNgo || []) {
        const ngo = w.ngo_id;
        if (ngo) frosByNgo[ngo] = (frosByNgo[ngo] || 0) + 1;
      }

      const ngosWithNoFro = (ngoList || []).filter(n => !frosByNgo[n.id] || frosByNgo[n.id] === 0);

      if (ngosWithNoFro.length > 0) {
        alerts.push({
          id: 'ngo-zero-fros',
          severity: 'warning',
          category: 'ngo',
          title: `${ngosWithNoFro.length} NGO(s) with zero active FROs`,
          description: `NGOs with no active FRO workers assigned — operational coverage gap.`,
          count: ngosWithNoFro.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Management',
          details: ngosWithNoFro.slice(0, 6).map(n => ({
            name: n.name,
            value: 'No active FRO workers',
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 17. Workers Missing ALL KYC Documents (HIGH) ──
    try {
      const { data: kycWorkers, count: kycCount } = await db
        .from('workers')
        .select('id, name, login_id', { count: 'exact' })
        .eq('is_active', true)
        .or('aadhar_number.is.null,aadhar_number.eq.')
        .or('pan_number.is.null,pan_number.eq.')
        .or('account_number.is.null,account_number.eq.');

      if ((kycCount || 0) > 0) {
        alerts.push({
          id: 'missing-kyc',
          severity: 'warning',
          category: 'compliance',
          title: `${kycCount} active worker(s) missing KYC documents`,
          description: `Active workers with missing Aadhar, PAN, or bank account details — compliance and payroll risk.`,
          count: kycCount,
          actionPanel: 'hr',
          actionLabel: 'View Workers',
          details: (kycWorkers || []).slice(0, 6).map(w => ({
            name: w.name,
            value: `Login: ${w.login_id}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 18. Large Unmatched Bank Entries (>₹50K) (HIGH) ──
    try {
      const { data: largeUnmatched, count: largeCount } = await db
        .from('bank_audit_entries')
        .select('id, amount, payment_id, transaction_date, remarks', { count: 'exact' })
        .eq('status', 'unverified')
        .gt('amount', 50000);

      if ((largeCount || 0) > 0) {
        alerts.push({
          id: 'large-unmatched-bank',
          severity: 'critical',
          category: 'account',
          title: `${largeCount} large bank entry(ies) >₹50K unmatched`,
          description: `Significant bank entries pending verification — high-value unaccounted transactions.`,
          count: largeCount,
          actionPanel: 'accounts',
          actionLabel: 'View Bank Audit',
          details: (largeUnmatched || []).slice(0, 6).map(e => ({
            name: `₹${Number(e.amount).toLocaleString('en-IN')}`,
            value: `Ref: ${e.payment_id || 'N/A'} · ${e.transaction_date || 'No date'}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 19. Stale FRO Transfers Not Returned (HIGH) ──
    try {
      const { data: staleTransfers, count: transferCount } = await db
        .from('fro_transfers')
        .select('id, source_fro_worker_id, target_fro_worker_id, donor_count, auto_return_at, created_at', { count: 'exact' })
        .eq('returned', false)
        .not('auto_return_at', 'is', null)
        .lt('auto_return_at', now.toISOString());

      if ((transferCount || 0) > 0) {
        const allFroIds = [...new Set([
          ...(staleTransfers || []).map(t => t.source_fro_worker_id).filter(Boolean),
          ...(staleTransfers || []).map(t => t.target_fro_worker_id).filter(Boolean),
        ])];
        const { data: tw } = allFroIds.length > 0
          ? await db.from('workers').select('id, name').in('id', allFroIds)
          : { data: [] };
        const twMap = {};
        for (const w of tw || []) twMap[w.id] = w.name;

        alerts.push({
          id: 'stale-transfers',
          severity: 'warning',
          category: 'fro',
          title: `${transferCount} FRO transfer(s) past auto-return date`,
          description: `Temporary donor transfers that were not returned by their scheduled return time.`,
          count: transferCount,
          actionPanel: 'fro',
          actionLabel: 'View FRO Management',
          details: (staleTransfers || []).slice(0, 6).map(t => ({
            name: `${twMap[t.source_fro_worker_id] || '?'} → ${twMap[t.target_fro_worker_id] || '?'}`,
            value: `${t.donor_count || 0} donors · Due: ${new Date(t.auto_return_at).toLocaleDateString('en-IN')}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 20. Chronic Lateness (3+ late days/month) (MEDIUM) ──
    try {
      const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const { data: lateRecords } = await db
        .from('attendance')
        .select('worker_id')
        .eq('status', 'late')
        .gte('date', monthStart.toISOString().slice(0, 10));

      const lateCountByWorker = {};
      for (const rec of lateRecords || []) {
        const wid = rec.worker_id;
        if (!wid) continue;
        lateCountByWorker[wid] = (lateCountByWorker[wid] || 0) + 1;
      }

      const chronicLate = Object.entries(lateCountByWorker)
        .filter(([_, count]) => count >= 3)
        .map(([wid, count]) => ({ wid, count }));

      if (chronicLate.length > 0) {
        const clIds = chronicLate.map(c => c.wid);
        const { data: clw } = await db.from('workers').select('id, name').in('id', clIds);
        const clwMap = {};
        for (const w of clw || []) clwMap[w.id] = w.name;

        alerts.push({
          id: 'chronic-lateness',
          severity: 'warning',
          category: 'hr',
          title: `${chronicLate.length} worker(s) late 3+ times this month`,
          description: `Workers with chronic lateness pattern — potential attendance discipline issue.`,
          count: chronicLate.length,
          actionPanel: 'hr',
          actionLabel: 'View Attendance',
          details: chronicLate.slice(0, 6).map(c => ({
            name: clwMap[c.wid] || 'Unknown',
            value: `${c.count} time(s) late this month`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 21. Workers with Multiple Active Loans (MEDIUM) ──
    try {
      // "Active" has to mean live *and* inside its own term. Filtering on status
      // alone counted loans whose start_month/end_month had already passed —
      // including loans retired as 'overdue' by a settlement run — so the alert
      // fired on workers who were in fact carrying nothing. Mirrors the
      // getActiveLoansByWorker period filter.
      const loanNow = new Date();
      const loanMonthStart = `${loanNow.getFullYear()}-${String(loanNow.getMonth() + 1).padStart(2, '0')}-01`;
      const loanMonthEnd = `${loanNow.getFullYear()}-${String(loanNow.getMonth() + 1).padStart(2, '0')}-31`;
      const { data: activeLoans } = await db
        .from('worker_loans')
        .select('worker_id, id, total_amount, remaining_amount')
        .in('status', ['approved', 'active'])
        .gt('remaining_amount', 0)
        .lte('start_month', loanMonthEnd)
        .or(`end_month.is.null,end_month.gte.${loanMonthStart}`);

      const loansByWorker = {};
      for (const loan of activeLoans || []) {
        if (!loansByWorker[loan.worker_id]) loansByWorker[loan.worker_id] = [];
        loansByWorker[loan.worker_id].push(loan);
      }

      const multiLoanWorkers = Object.entries(loansByWorker)
        .filter(([_, loans]) => loans.length >= 2);

      if (multiLoanWorkers.length > 0) {
        const mlIds = multiLoanWorkers.map(([wid]) => wid);
        const { data: mlw } = await db.from('workers').select('id, name').in('id', mlIds);
        const mlwMap = {};
        for (const w of mlw || []) mlwMap[w.id] = w.name;

        alerts.push({
          id: 'multiple-active-loans',
          severity: 'warning',
          category: 'hr',
          title: `${multiLoanWorkers.length} worker(s) with 2+ active loans`,
          description: `Workers carrying multiple concurrent loans — financial over-exposure risk.`,
          count: multiLoanWorkers.length,
          actionPanel: 'hr',
          actionLabel: 'View Loans',
          details: multiLoanWorkers.slice(0, 6).map(([wid, loans]) => ({
            name: mlwMap[wid] || 'Unknown',
            value: `${loans.length} loans · ₹${loans.reduce((s, l) => s + Number(l.remaining_amount || 0), 0).toLocaleString('en-IN')} outstanding`,
          })),
          createdAt: now.toISOString(),
        });
      }
      } catch (e) { console.error('Alert error:', e.message); }

    // ── 22. FRO Targets Not Set for Current Month (MEDIUM) ──
    try {
      const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      const { data: fros } = await db
        .from('workers')
        .select('id, name')
        .eq('department', 'fro')
        .eq('is_active', true);

      const { data: targetSet } = await db
        .from('fro_monthly_targets')
        .select('fro_worker_id')
        .eq('month', currentMonth);

      const targetWorkerIds = new Set((targetSet || []).map(t => t.fro_worker_id));
      const noTargetFros = (fros || []).filter(f => !targetWorkerIds.has(f.id));

      if (noTargetFros.length > 0) {
        alerts.push({
          id: 'fro-no-target',
          severity: 'info',
          category: 'fro',
          title: `${noTargetFros.length} FRO(s) without monthly target`,
          description: `Active FRO workers without a collection target set for the current month.`,
          count: noTargetFros.length,
          actionPanel: 'fro',
          actionLabel: 'View FRO Targets',
          details: noTargetFros.slice(0, 6).map(f => ({
            name: f.name,
            value: 'No target set',
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 23. Assets Assigned to Inactive Workers (MEDIUM) ──
    try {
      const { data: staleAssets, count: assetCount } = await db
        .from('assets')
        .select('id, name, assigned_to, assigned_to_name, assigned_date', { count: 'exact' })
        .not('assigned_to', 'is', null)
        .eq('status', 'assigned');

      if ((assetCount || 0) > 0) {
        const assignedWorkerIds = [...new Set((staleAssets || []).map(a => a.assigned_to).filter(Boolean))];
        const { data: inactiveWorkers } = assignedWorkerIds.length > 0
          ? await db.from('workers').select('id, name').in('id', assignedWorkerIds).eq('is_active', false)
          : { data: [] };

        const inactiveIds = new Set((inactiveWorkers || []).map(w => w.id));
        const staleAssetList = (staleAssets || []).filter(a => inactiveIds.has(a.assigned_to));

        if (staleAssetList.length > 0) {
          alerts.push({
            id: 'assets-inactive-workers',
            severity: 'info',
            category: 'hr',
            title: `${staleAssetList.length} asset(s) assigned to inactive workers`,
            description: `Physical assets still assigned to workers who are no longer active — asset recovery needed.`,
            count: staleAssetList.length,
            actionPanel: 'hr',
            actionLabel: 'View Assets',
            details: staleAssetList.slice(0, 6).map(a => ({
              name: a.name,
              value: `Assigned to: ${a.assigned_to_name || 'Unknown'} · Since: ${a.assigned_date || 'N/A'}`,
            })),
            createdAt: now.toISOString(),
          });
        }
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── 24. Donor Name Mismatch with Bank Name (MEDIUM) ──
    try {
      const { data: mismatchedDonors, count: mismatchCount } = await db
        .from('donor_profiles')
        .select('id, name, bank_donor_name, mobile_number', { count: 'exact' })
        .not('bank_donor_name', 'is', null)
        .neq('bank_donor_name', '')
        .not('name', 'is', null)
        .neq('name', '');

      const mismatches = (mismatchedDonors || []).filter(d => {
        const a = (d.name || '').trim().toLowerCase();
        const b = (d.bank_donor_name || '').trim().toLowerCase();
        return a !== b && a.length > 2 && b.length > 2;
      });

      if (mismatches.length > 2) {
        alerts.push({
          id: 'donor-name-mismatch',
          severity: 'info',
          category: 'compliance',
          title: `${mismatches.length} donor(s) with name ≠ bank name mismatch`,
          description: `Donor profile names don't match their bank-registered names — possible data entry error or identity issue.`,
          count: mismatches.length,
          actionPanel: 'accounts',
          actionLabel: 'View Donors',
          details: mismatches.slice(0, 6).map(d => ({
            name: d.name,
            value: `Bank shows: ${d.bank_donor_name}`,
          })),
          createdAt: now.toISOString(),
        });
      }
    } catch (e) { console.error('Alert error:', e.message); }

    // ── Sort: critical first, then warning, then info ──
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    const summary = {
      critical: alerts.filter(a => a.severity === 'critical').length,
      warning: alerts.filter(a => a.severity === 'warning').length,
      info: alerts.filter(a => a.severity === 'info').length,
    };

    return res.json({ alerts, summary });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Ticket counts for panel dashboards. Per-role:
//   - Raisers (fro, hr, ngo_admin, recruiter, event_head) look at myRaisedOpen.
//   - Handlers (accounts, digital/developers, super_admin) look at openForAction.
export const getTicketStats = async (req, res) => {
  try {
    const OPEN = ['open', 'in_progress', 'under_review', 'pending'];

    const countRows = async (table, filters) => {
      let q = db.from(table).select('id', { count: 'exact', head: true });
      for (const [col, val] of Object.entries(filters)) {
        if (Array.isArray(val)) q = q.in(col, val);
        else q = q.eq(col, val);
      }
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    };

    const [supportRaisedByMe, devRaisedByMe, supportOpen, devOpen, supportOpenForAccounts] = await Promise.all([
      countRows('support_tickets', { raised_by: req.user.id, status: OPEN }),
      countRows('developer_tickets', { raised_by: req.user.id, status: OPEN }),
      countRows('support_tickets', { status: OPEN }),
      countRows('developer_tickets', { status: OPEN }),
      countRows('support_tickets', { department: 'accounts', status: OPEN }),
    ]);

    let openForAction = 0;
    const role = (req.user.role || '').toLowerCase();
    const department = (req.user.department || '').toLowerCase();
    if (role === 'accounts') {
      openForAction = supportOpenForAccounts;
    } else if (role === 'super_admin' || role === 'admin') {
      openForAction = supportOpen + devOpen;
    } else if (role === 'digital' || department === 'digital' || department === 'developers') {
      openForAction = devOpen;
    }

    return res.json({
      myRaisedOpen: supportRaisedByMe + devRaisedByMe,
      supportRaisedByMe,
      devRaisedByMe,
      supportOpen,
      devOpen,
      openForAction,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
