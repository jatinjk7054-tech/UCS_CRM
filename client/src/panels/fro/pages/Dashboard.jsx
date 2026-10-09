import { useState, useEffect } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { getMyDashboard, getMyCollections, requestMoreData, getFollowUps, getLeadStats, getMonthlyDonors, getReactivatedDonors } from '../api/donors'
import { getMyTarget } from '../api/target'
import { SkeletonDashboard } from '../../../components/Skeleton'
import RecentNotices from '../../../components/RecentNotices'
import { cacheGet, cacheSet, cacheAge } from '../../../utils/cache'
import { useCall } from '../CallContext'
import { api, getUser } from '../api/auth'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { formatIstTime } from '../utils/time'
import { istMonthKey, istParts } from '../../../utils/istDate'

const currency = n => n != null ? '₹' + Number(n).toLocaleString('en-IN') : '—'

// '2026-09-01' -> 'Sep 2026'
const monthLabel = (v) => {
  if (!v) return ''
  const [y, m] = String(v).slice(0, 7).split('-')
  if (!y || !m) return String(v)
  const d = new Date(Number(y), Number(m) - 1, 1)
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

const fmtStamp = (v) => {
  if (!v) return '—'
  const iso = String(v)
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso) || /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.\d+)?Z$/.test(iso)
  if (isDateOnly) {
    return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function callFmt(seconds) {
  if (seconds == null) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const Icon = ({ children, color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'var(--ink)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)

const pad2 = n => String(n).padStart(2, '0')

const todayYM = () => istMonthKey()

const monthLabelOf = (ym) => {
  // ym: 'YYYY-MM' → 'August 2026'
  const [y, m] = String(ym || '').split('-').map(Number)
  if (!y || !m) return ''
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' })
}

function IncentiveCalendar({ akiPerDay = [], monthStr, onlyEligible }) {
  const [y, m] = (monthStr || '').split('-').map(Number)
  if (!y || !m) return <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>No month data</div>

  const daysInMonth = new Date(y, m, 0).getDate()
  const firstDay = new Date(y, m - 1, 1).getDay()
  const akiMap = {}
  akiPerDay.forEach(r => { akiMap[r.date] = r })

  const now = new Date()
  const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const weekday = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

  const cells = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${pad2(m)}-${pad2(d)}`
    const rec = akiMap[dateStr]
    const aki = rec ? rec.aki : 0
    cells.push({ d, dateStr, rec, aki, eligible: aki > 0, show: !onlyEligible || aki > 0 })
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginBottom: 6 }}>
        {weekday.map(w => (
          <div key={w} style={{ textAlign: 'center', fontSize: 9, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase' }}>{w}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
        {cells.map((c, i) => {
          if (!c || !c.show) return <div key={i} style={{ height: 58 }} />
          const isToday = c.dateStr === todayStr
          return (
            <div key={i} title={c.rec ? `₹${Number(c.rec.collection || 0).toLocaleString('en-IN')} collected · AKI ₹${c.aki}` : undefined} style={{
              height: 58, borderRadius: 8, border: `1.5px solid ${c.eligible ? '#86efac' : '#e2e8f0'}`,
              background: c.eligible ? 'linear-gradient(135deg, #dcfce7 0%, #f0fdf4 100%)' : '#f8fafc',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
              outline: isToday ? '2px solid var(--sage)' : 'none', outlineOffset: isToday ? 1 : 0,
            }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: c.eligible ? '#166534' : '#94a3b8' }}>{c.d}</span>
              <span style={{ fontSize: 9, fontWeight: 700, color: c.eligible ? '#15803d' : '#64748b' }}>
                {c.rec ? '₹' + Number(c.rec.collection || 0).toLocaleString('en-IN') : ''}
              </span>
              {c.aki > 0 && (
                <span style={{ fontSize: 8, fontWeight: 700, color: '#16a34a', background: '#bbf7d0', padding: '1px 5px', borderRadius: 999, lineHeight: 1.4 }}>
                  AKI ₹{c.aki}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--ink-soft)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: '#dcfce7', border: '1px solid #86efac', display: 'inline-block' }} /> Eligible (AKI earned)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, color: 'var(--ink-soft)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: '#f8fafc', border: '1px solid #e2e8f0', display: 'inline-block' }} /> No AKI
        </span>
      </div>
    </div>
  )
}

const STATUS_COLORS = {
  pending: '#fbbf24', contacted: '#60a5fa', follow_up: '#a78bfa',
  donation_collected: '#34d399', lead_done: '#34d399', done: '#34d399', not_interested: '#f87171',
  not_reachable: '#9ca3af', scheduled: '#a78bfa',
}

// How long a cached dashboard payload counts as fresh enough to skip refetching.
// Short by design: the numbers only move when the FRO themselves act, but a
// save must still show up promptly, so this only covers the bounce between
// Dashboard and My Leads — not a genuine reload.
const DASH_FRESH_MS = 60 * 1000

export default function Dashboard() {
  // Scoped to the signed-in worker, and resolved per render rather than at
  // module load. A shared global key would hand one FRO another's dashboard
  // numbers, and skipping the refetch would keep that wrong page on screen for a
  // full minute — nothing else clears this store, including logout.
  const CACHE_KEY = `fro_dashboard:${getUser()?.id ?? 'anon'}`
  const cached = cacheGet(CACHE_KEY)
  const cachedAge = cacheAge(CACHE_KEY)
  const dashIsFresh = !!cached && (cachedAge ?? Infinity) < DASH_FRESH_MS
  const { todayStats } = useCall()
  const isMobile = useIsMobile()
  const [dashData, setDashData] = useState(cached?.dash || null)
  const [targetData, setTargetData] = useState(cached?.target || null)
  const [loading, setLoading] = useState(!cached)
  const [showRequest, setShowRequest] = useState(false)
  const [reqMsg, setReqMsg] = useState('')
  const [sending, setSending] = useState(false)
  const [reqDone, setReqDone] = useState(false)
  const [followUps, setFollowUps] = useState([])
  const [leadStats, setLeadStats] = useState(null)
  const [monthlyDonors, setMonthlyDonors] = useState([])
  const [showMonthlyModal, setShowMonthlyModal] = useState(false)
  const [assignedView, setAssignedView] = useState('total')
  const [showCollections, setShowCollections] = useState(false)
  const [collectionsData, setCollectionsData] = useState(null)
  const [collectionsLoading, setCollectionsLoading] = useState(false)
  const [selectedCollectionNgo, setSelectedCollectionNgo] = useState('all')
  const [collectionSearch, setCollectionSearch] = useState('')
  const [collectionsByNgo, setCollectionsByNgo] = useState({})
  const [ngoMap, setNgoMap] = useState({})
  const [collectionsMonth, setCollectionsMonth] = useState('current')
  const [collectionsMonthLabel, setCollectionsMonthLabel] = useState('')
  const [reactivatedFilter, setReactivatedFilter] = useState('today')
  const [reactivatedDonors, setReactivatedDonors] = useState([])
  const [reactivatedCount, setReactivatedCount] = useState(0)
  const [reactivatedLoading, setReactivatedLoading] = useState(false)
  const [showReactivatedModal, setShowReactivatedModal] = useState(false)
  const [incentiveOnly, setIncentiveOnly] = useState(false)

  const today = new Date()
  const istToday = istParts(today)
  const day = istToday.day
  const monthStr = istMonthKey(today)
  const isMonthlyPopupSeason = day >= 1 && day <= 3

  useEffect(() => {
    let cancelled = false
    const safeSet = (setter, value) => { if (!cancelled) setter(value) }

    // Render as soon as the core dashboard request returns. Follow-ups,
    // lead stats, and monthly donors enrich the page afterwards instead of
    // keeping the whole screen in a loading state.
    //
    // These two are the expensive pair, so a payload this session already holds
    // is reused instead of re-requested. The backend caches them too, so this
    // mainly removes the round trip — but it also means revisiting the dashboard
    // inside a minute costs nothing at either end.
    if (dashIsFresh) {
      safeSet(setLoading, false)
    } else {
      const dashboardRequest = getMyDashboard()
        .catch((err) => { console.error('API error:', err.message); return null })
      const targetRequest = getMyTarget()
        .catch((err) => { console.error('API error:', err.message); return null })

      dashboardRequest.then(data => {
        safeSet(setDashData, data)
        safeSet(setLoading, false)
      })

      targetRequest.then(data => safeSet(setTargetData, data))

      Promise.all([dashboardRequest, targetRequest]).then(([dash, target]) => {
        if (dash || target) cacheSet(CACHE_KEY, { dash, target }, 5 * 60 * 1000)
      })
    }

    getFollowUps()
      .then(data => safeSet(setFollowUps, data || []))
      .catch((err) => { console.error('API error:', err.message); safeSet(setFollowUps, []) })

    getLeadStats(monthStr)
      .then(data => safeSet(setLeadStats, data))
      .catch((err) => { console.error('API error:', err.message); safeSet(setLeadStats, null) })

    if (isMonthlyPopupSeason) {
      getMonthlyDonors(monthStr)
        .then(data => {
          const donors = data || []
          safeSet(setMonthlyDonors, donors)
          if (!cancelled && donors.length > 0 && localStorage.getItem('monthly_donors_dismissed') !== monthStr) setShowMonthlyModal(true)
        })
        .catch((err) => { console.error('API error:', err.message); safeSet(setMonthlyDonors, []) })
    }

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setReactivatedLoading(true)
    getReactivatedDonors(reactivatedFilter).then(data => {
      setReactivatedDonors(data?.donors || [])
      setReactivatedCount(data?.count || 0)
    }).catch(() => { setReactivatedDonors([]); setReactivatedCount(0) })
      .finally(() => setReactivatedLoading(false))
  }, [reactivatedFilter])

  const handleSendRequest = async () => {
    if (!reqMsg.trim()) return
    setSending(true)
    try {
      await requestMoreData(reqMsg)
      setReqDone(true)
      setReqMsg('')
      setTimeout(() => { setShowRequest(false); setReqDone(false) }, 2000)
    } catch (err) {
      alert(err.message)
    } finally {
      setSending(false)
    }
  }

  const openCollections = async (ngoId, month) => {
    const isToggle = month !== undefined
    const targetMonth = isToggle ? month : collectionsMonth
    if (targetMonth !== collectionsMonth) setCollectionsMonth(targetMonth)
    setShowCollections(true)
    setCollectionsLoading(true)
    if (ngoId !== undefined) setSelectedCollectionNgo(String(ngoId))
    setCollectionsMonthLabel(targetMonth === 'current' ? monthLabelOf(todayYM()) : monthLabelOf(targetMonth))
    try {
      const res = await getMyCollections(ngoId, targetMonth)
      if (res?.month) setCollectionsMonthLabel(monthLabelOf(res.month))
      // Keep the whole response, not just its rows: it carries the server-side
      // total so the modal can show the subtotal of what it rendered.
      setCollectionsData(res)
      let collectionsByNgo = res?.collections || { all: [] }
      let ngoMap = res?.ngoMap || {}
      
      // Handle both API response formats:
      // New format: { all: [...], ngoId1: [...], ngoId2: [...] }
      // Old format: flat array [...]
      if (Array.isArray(collectionsByNgo)) {
        const allCollections = collectionsByNgo
        // Build NGO map from collections if not provided
        if (Object.keys(ngoMap).length === 0) {
          const ngoIds = new Set()
          for (const c of allCollections) {
            if (c.ngo_id) ngoIds.add(c.ngo_id)
          }
          if (ngoIds.size > 0) {
            const { data: ngos } = await api(`/ngo-admin/ngos`)
            const allNgos = ngos || []
            for (const nid of ngoIds) {
              const ngo = allNgos.find(n => n.id === nid)
              if (ngo) ngoMap[nid] = ngo.name
            }
          }
        }
        // Group by NGO
        const byNgo = {}
        for (const c of allCollections) {
          const ngoId = c.ngo_id || null
          if (!byNgo[ngoId]) byNgo[ngoId] = []
          byNgo[ngoId].push(c)
        }
        collectionsByNgo = { all: allCollections, ...byNgo }
      }
      
      setCollectionsByNgo(collectionsByNgo)
      setNgoMap(ngoMap)
      if (!isToggle) setSelectedCollectionNgo('all')
    } catch (err) {
      console.error('Error:', err.message)
      setCollectionsByNgo({ all: [] })
      setNgoMap({})
      // Cleared with the rows: a total left over from the previous month would
      // otherwise be shown next to an empty list.
      setCollectionsData(null)
    } finally {
      setCollectionsLoading(false)
    }
  }

  if (loading) return <SkeletonDashboard />

  const ts = targetData || {}
  let ds = dashData || {}

  // Map new nested structure to old flat field names for backward compat
  if (ds.worker || ds.target?.amount != null || ds.connected || ds.donations || ds.verification || ds.data) {
    const d = ds
    ds = {
      is_active: d.worker?.is_active,
      is_punched_in: d.worker?.is_punched_in,
      target: d.target?.amount,
      collected: d.target?.collected,
      achieved_target: d.target?.achieved,
      monthly_connected: d.connected?.monthly,
      daily_connected: d.connected?.daily,
      daily_donations: d.donations?.daily,
      new_donors_today: d.donations?.new_donors?.today,
      new_donors_monthly: d.donations?.new_donors?.monthly,
      reactivated_today: d.reactivations?.today,
      reactivated_monthly: d.reactivations?.monthly,
      data_used: d.data?.used,
      data_unused: d.data?.unused,
      total_donations: d.donations?.total,
      active_donors: d.donors?.active,
      inactive_donors: d.donors?.inactive,
      verified_month_amount: d.verification?.month?.verified?.amount,
      verified_month_count: d.verification?.month?.verified?.count,
      unverified_month_amount: d.verification?.month?.unverified?.amount,
      unverified_month_count: d.verification?.month?.unverified?.count,
      verified_today_amount: d.verification?.today?.verified?.amount,
      verified_today_count: d.verification?.today?.verified?.count,
      unverified_today_amount: d.verification?.today?.unverified?.amount,
      unverified_today_count: d.verification?.today?.unverified?.count,
      stats: d.stats,
      assignedData: d.assignedData,
    }
  }
  const { stats = {} } = ds
  const target = ts.target || ds.target || 0
  const collected = ts.collected ?? ds.collected ?? 0
  const akiPerDay = ts.incentive?.akiPerDay || []
  const totalAKI = ts.incentive?.totalCollectionAKI != null ? ts.incentive.totalCollectionAKI : akiPerDay.reduce((s, r) => s + (r.aki || 0), 0)
  const achieved_target = ts.achieved_target != null ? ts.achieved_target : (ds.achieved_target != null ? ds.achieved_target : null)
  const displayCollected = collected
  const collectedByNgo = ts.collected_by_ngo || []
  const remaining = Math.max(0, target - displayCollected)
  const progress = target > 0 ? Math.min(100, (displayCollected / target) * 100) : 0

  const pieData = ts.stats
    ? Object.entries(ts.stats).filter(([k]) => k !== 'total').map(([k, v]) => ({
        name: k.replace(/_/g, ' '),
        value: v,
        color: STATUS_COLORS[k] || '#94a3b8',
      }))
    : []

  const barData = target > 0 ? [
    { name: 'Target', amount: target, fill: '#94a3b8' },
    { name: 'Collected', amount: displayCollected, fill: '#34d399' },
    { name: 'Remaining', amount: remaining, fill: '#f87171' },
  ] : []

  const cq = collectionSearch.trim().toLowerCase()
  const visibleCollections = (collectionsByNgo[selectedCollectionNgo] || []).filter(c => !cq ||
    (c.donor_name || '').toLowerCase().includes(cq) ||
    String(c.donor_mobile || '').includes(cq) ||
    String(c.receipt_no || '').includes(cq))

return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 14, marginBottom: 20,
      }}>
        <div className="card" style={{ marginBottom: 0, padding: '16px 18px', border: `1.5px solid ${ds.is_punched_in ? 'var(--sage)' : '#f87171'}`, background: ds.is_punched_in ? 'linear-gradient(135deg, #f0fdf4 0%, #fff 100%)' : 'linear-gradient(135deg, #fef2f2 0%, #fff 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: ds.is_active ? (ds.is_punched_in ? '#16a34a' : '#f87171') : '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{ds.is_punched_in ? 'check_circle' : ds.is_active ? 'schedule' : 'cancel'}</span>
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>Live Status</span>
              <div style={{ display: 'flex', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: ds.is_active ? (ds.is_punched_in ? 'var(--sage)' : '#f87171') : '#94a3b8' }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: ds.is_active ? (ds.is_punched_in ? 'var(--sage)' : '#f87171') : '#e2e8f0', marginRight: 4, verticalAlign: 'middle' }} />
                  {ds.is_active ? (ds.is_punched_in ? 'Punched In' : 'Not Punched') : 'Inactive'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 600 }}>
                  Data: {ds.data_used ?? 0}/{stats.total ?? 0}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--sage)' }}>
                  Today: {currency(ds.daily_donations ?? 0)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px', border: '1.5px solid #8b5cf6', background: 'linear-gradient(135deg, #faf5ff 0%, #fff 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <Icon color="#8b5cf6">
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
            </Icon>
            <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600, flex: 1, textTransform: 'uppercase', letterSpacing: 0.3 }}>
              {/* Same window as the Collected card below, and labelled the same way
                  so the two are visibly a pair. */}
              Target{ts.month ? ` · ${monthLabel(ts.month)}` : ''}
            </span>
            <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>{currency(target)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
            {ts.target_source === 'not_set'
              ? 'Not set by admin'
              : ts.target_source === 'carried_forward' && ts.target_source_month
                // Say where the number came from, otherwise a carried figure looks
                // identical to one someone deliberately set for this month.
                ? `${progress.toFixed(0)}% achieved · carried over from ${monthLabel(ts.target_source_month)}`
                : `${progress.toFixed(0)}% achieved`}
          </div>
        </div>

        <div className="card" onClick={openCollections} style={{ marginBottom: 0, padding: '16px 18px', border: '1.5px solid var(--sage)', background: 'linear-gradient(135deg, #f0fdf4 0%, #fff 100%)', cursor: 'pointer', transition: 'transform .12s, box-shadow .12s' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,.06)' }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <Icon color="var(--sage)">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="17" y2="12"/><path d="M17 6v12"/>
            </Icon>
            <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600, flex: 1, textTransform: 'uppercase', letterSpacing: 0.3 }}>
              {/* The figure is scoped to the current calendar month, but on the
                  1st it resets to near-zero and on the last day it is a whole
                  month's work -- which reads like a bug unless the month is
                  stated. Labelled from the server's own `month` value rather than
                  recomputed here, so the label cannot drift from the window the
                  total was actually summed over. */}
              Collected{ts.month ? ` · ${monthLabel(ts.month)}` : ''}
            </span>
            <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--sage)' }}>{currency(displayCollected)}</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--md-outline-variant)', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ height: '100%', borderRadius: 2, background: 'var(--sage)', width: `${progress}%`, transition: 'width .4s' }} />
          </div>
          {achieved_target != null && (
            <div style={{ fontSize: 10, color: '#8b5cf6', fontWeight: 500 }}>Admin target: ₹{Number(achieved_target).toLocaleString('en-IN')}</div>
          )}
          {collectedByNgo.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {collectedByNgo.map(item => (
                <span key={item.ngo_id} style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: item.ngo_id === 'others' ? '#fef3c7' : '#f0fdf4', color: item.ngo_id === 'others' ? '#92400e' : '#166534', border: `1px solid ${item.ngo_id === 'others' ? '#fde68a' : '#bbf7d0'}` }}>
                  {item.ngo_name}: ₹{Number(item.amount).toLocaleString('en-IN')}
                </span>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--ink-soft)', fontWeight: 600, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            View collections →
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px', border: `1.5px solid ${remaining > 0 ? '#e53e3e' : 'var(--sage)'}`, background: remaining > 0 ? 'linear-gradient(135deg, #fef2f2 0%, #fff 100%)' : 'linear-gradient(135deg, #f0fdf4 0%, #fff 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <Icon color={remaining > 0 ? '#e53e3e' : 'var(--sage)'}>
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </Icon>
            <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600, flex: 1, textTransform: 'uppercase', letterSpacing: 0.3 }}>Remaining</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: remaining > 0 ? '#e53e3e' : 'var(--sage)' }}>{currency(remaining)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
            {remaining > 0 ? `${currency(remaining)} more to hit target` : 'Target achieved!'}
          </div>
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 14, marginBottom: 20,
      }}>
        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="var(--sage)">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Monthly Connected</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--sage)' }}>{ds.monthly_connected ?? stats.contacted ?? 0}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donors connected this month</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#3b82f6">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Daily Connected</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#3b82f6' }}>{ds.daily_connected ?? 0}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donors connected today</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="var(--sage)">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="17" y2="12"/><path d="M17 6v12"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Monthly Donations</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--sage)' }}>{currency(collected)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donations this month</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#3b82f6">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="6" x2="21" y2="6"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Daily Donations</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#3b82f6' }}>{currency(ds.daily_donations ?? 0)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donations today</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#16a34a">
              <polyline points="20 6 9 17 4 12"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Verified</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#16a34a', lineHeight: 1.2 }}>{currency(ds.verified_month_amount ?? 0)}</div>
              <div style={{ fontSize: 10, color: '#16a34a', opacity: 0.7 }}>{ds.verified_month_count ?? 0} leads</div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-soft)' }}>
            <span>Today: {currency(ds.verified_today_amount ?? 0)} ({ds.verified_today_count ?? 0})</span>
            <span>Verified by Accts</span>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#f59e0b">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Unverified</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b', lineHeight: 1.2 }}>{currency(ds.unverified_month_amount ?? 0)}</div>
              <div style={{ fontSize: 10, color: '#f59e0b', opacity: 0.7 }}>{ds.unverified_month_count ?? 0} leads</div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-soft)' }}>
            <span>Today: {currency(ds.unverified_today_amount ?? 0)} ({ds.unverified_today_count ?? 0})</span>
            <span>Pending verification</span>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#16a34a">
              <polyline points="20 6 9 17 4 12"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Data Used</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#16a34a' }}>{ds.data_used ?? (stats.contacted ?? 0) + (stats.donation_collected ?? 0) + (stats.follow_up ?? 0)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donors in connected statuses</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#f87171">
              <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Data Unused</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#f87171' }}>{ds.data_unused ?? (stats.pending ?? 0) + (stats.not_reachable ?? 0) + (stats.not_interested ?? 0)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donors in non-connected statuses</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#8b5cf6">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Active Donors</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#8b5cf6' }}>{ds.active_donors ?? 0}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Donated in last 1 year</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#f97316">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Inactive Donors</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#f97316' }}>{ds.inactive_donors ?? 0}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>No donation in last 1 year</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="var(--sage)">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="17" y2="12"/><path d="M17 6v12"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Total Donations</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--sage)' }}>{currency(ds.total_donations ?? collected)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Lifetime donations collected</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <Icon color="var(--ink)">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1, minWidth: 80 }}>Assigned Data</span>
            <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 6, padding: 2, flexWrap: 'wrap' }}>
              {['total', 'ngo', 'station', 'type'].map(v => (
                <button key={v} onClick={() => setAssignedView(v)}
                  style={{ padding: '3px 6px', borderRadius: 5, border: 'none', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap',
                    background: assignedView === v ? 'var(--sage)' : 'transparent',
                    color: assignedView === v ? '#fff' : 'var(--ink-soft)' }}>
                  {v === 'total' ? 'Total' : v === 'ngo' ? 'By NGO' : v === 'station' ? 'By Station' : 'By Type'}
                </button>
              ))}
            </div>
          </div>
          {assignedView === 'total' && (
            <>
              <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>{stats.total ?? ts.stats?.total ?? 0}</span>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>Total donors assigned</div>
            </>
          )}
          {assignedView === 'ngo' && (
            ds.assignedData?.byNgo?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                {ds.assignedData.byNgo.map(n => (
                  <div key={n.ngo_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '2px 0', minWidth: 0 }}>
                    <span style={{ color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, marginRight: 8 }}>{n.ngo_name}</span>
                    <span style={{ fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>{n.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>No NGO data</div>
            )
          )}
          {assignedView === 'station' && (
            ds.assignedData?.byStation?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                {ds.assignedData.byStation.map(s => (
                  <div key={s.station} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '2px 0', minWidth: 0 }}>
                    <span style={{ color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, marginRight: 8 }}>{s.station}</span>
                    <span style={{ fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>{s.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>No station data</div>
            )
          )}
          {assignedView === 'type' && (
            ds.assignedData?.byType?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                {ds.assignedData.byType.map(t => (
                  <div key={t.type} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '2px 0', minWidth: 0 }}>
                    <span style={{ color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, marginRight: 8 }}>{t.type === 'new_data' ? 'New Data' : t.type === 'old_data' ? 'Old Data' : t.type}</span>
                    <span style={{ fontWeight: 700, color: 'var(--ink)', flexShrink: 0 }}>{t.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>No type data</div>
            )
          )}
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#8b5cf6">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>New Donors Today</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#8b5cf6' }}>{ds.new_donors_today ?? 0}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>First-time donors today</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#8b5cf6">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>New Donors This Month</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#8b5cf6' }}>{ds.new_donors_monthly ?? 0}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>First-time donors this month</div>
        </div>

        <div className="card" style={{ marginBottom: 0, padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Icon color="#f59e0b">
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
            </Icon>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)', fontWeight: 500, flex: 1 }}>Reactivated Donors</span>
            <div style={{ display: 'flex', gap: 4, background: 'var(--bg)', borderRadius: 6, padding: 2 }}>
              <button onClick={() => setReactivatedFilter('today')}
                style={{ padding: '4px 12px', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', transition: 'all .15s',
                  background: reactivatedFilter === 'today' ? 'var(--sage)' : 'transparent',
                  color: reactivatedFilter === 'today' ? '#fff' : 'var(--ink-soft)' }}>
                Today
              </button>
              <button onClick={() => setReactivatedFilter('month')}
                style={{ padding: '4px 12px', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', transition: 'all .15s',
                  background: reactivatedFilter === 'month' ? 'var(--sage)' : 'transparent',
                  color: reactivatedFilter === 'month' ? '#fff' : 'var(--ink-soft)' }}>
                Month
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: '#f59e0b' }}>{reactivatedLoading ? '—' : reactivatedCount}</span>
              <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>donor{reactivatedCount !== 1 ? 's' : ''} reactivated {reactivatedFilter === 'today' ? 'today' : 'this month'}</span>
            </div>
            {reactivatedCount > 0 && (
              <button onClick={() => { setShowReactivatedModal(true); }}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--sage)', color: '#fff', fontSize: 10, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', transition: 'opacity .15s' }}
                onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
                View
              </button>
            )}
          </div>
        </div>
      </div>

      {showReactivatedModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.4)' }}
          onClick={() => setShowReactivatedModal(false)}>
          <div style={{ background: '#fff', borderRadius: 12, width: isMobile ? 'calc(100vw - 32px)' : 440, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,.15)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Reactivated Donors</div>
                <div style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{reactivatedFilter === 'today' ? 'Today' : 'This month'} — {reactivatedCount} donor{reactivatedCount !== 1 ? 's' : ''}</div>
              </div>
              <button onClick={() => setShowReactivatedModal(false)}
                style={{ width: 28, height: 28, border: 'none', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 }}>
                ×
              </button>
            </div>
            <div style={{ overflow: 'auto', padding: 8, flex: 1 }}>
              {reactivatedDonors.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: 'var(--ink-soft)' }}>No reactivated donors</div>
              ) : (
                reactivatedDonors.map(d => (
                  <div key={d.donor_id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 4, borderRadius: 8,
                    background: 'var(--bg)', border: '1px solid var(--line)',
                  }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--sage)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      {d.donor_name?.charAt(0) || '?'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.donor_name}</div>
                      <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{d.donor_mobile || '—'}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--sage)' }}>{currency(d.amount)}</div>
                      <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{fmtStamp(d.date)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="fro-flex-row" style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: isMobile ? 'wrap' : undefined }}>
        <div className="card" style={{ marginBottom: 0, flex: 1, minWidth: isMobile ? '100%' : undefined }}>
          <div className="card-head"><h3>Lead Stats — {monthStr}</h3></div>
          <div className="card-pad">
            {leadStats ? (
              <div style={{ display:'flex', gap:12 }}>
                <div style={{ flex:1, padding:12, borderRadius:8, background:'#eff6ff', border:'1px solid #bfdbfe' }}>
                  <div style={{ fontSize:9, textTransform:'uppercase', fontWeight:600, color:'#3b82f6', marginBottom:2 }}>New Donors</div>
                  <div style={{ fontSize:20, fontWeight:800, color:'#1d4ed8' }}>{leadStats.new_donors}</div>
                  <div style={{ fontSize:10, color:'#3b82f6' }}>₹{Number(leadStats.new_amount).toLocaleString('en-IN')}</div>
                </div>
                <div style={{ flex:1, padding:12, borderRadius:8, background:'#f0fdf4', border:'1px solid #bbf7d0' }}>
                  <div style={{ fontSize:9, textTransform:'uppercase', fontWeight:600, color:'#16a34a', marginBottom:2 }}>Existing Donors</div>
                  <div style={{ fontSize:20, fontWeight:800, color:'#15803d' }}>{leadStats.existing_donors}</div>
                  <div style={{ fontSize:10, color:'#16a34a' }}>₹{Number(leadStats.existing_amount).toLocaleString('en-IN')}</div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign:'center', padding:20, color:'var(--md-outline)', fontSize:11 }}>No lead data for this month.</div>
            )}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0, flex: 1 }}>
          <div className="card-head"><h3>Follow-ups Today</h3></div>
          <div className="card-pad">
            {followUps.length === 0 ? (
              <div style={{ textAlign:'center', padding:20, color:'var(--md-outline)', fontSize:11 }}>No follow-ups scheduled for today.</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {followUps.map(fu => (
                  <div key={fu.id} style={{
                    display:'flex', alignItems:'center', gap:8, padding:'6px 8px', borderRadius:8,
                    background: fu.is_overdue ? '#fef2f2' : '#f0fdf4',
                    border: '1px solid ' + (fu.is_overdue ? '#fecaca' : '#bbf7d0'),
                  }}>
                    <span style={{ fontSize:10, fontWeight:600, color:'var(--ink-soft)', minWidth:50 }}>
                      {formatIstTime(fu.scheduled_at)}
                    </span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:11, fontWeight:600 }}>{fu.donor_name}</div>
                      <div style={{ fontSize:9, color:'var(--md-outline)' }}>{fu.donor_mobile}</div>
                    </div>
                    {fu.ngo_name && <span className="bento-pill bento-pill-gray" style={{fontSize:8}}>{fu.ngo_name}</span>}
                    {fu.is_overdue && <span className="bento-pill" style={{background:'#f87171', color:'#fff', fontSize:8}}>Overdue</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14, flexDirection:'row', alignItems:'center', justifyContent:'space-between', padding:'12px 16px' }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700 }}>Need more donor data?</div>
          <div style={{ fontSize:10, color:'var(--md-outline)', marginTop:2 }}>Request additional assignments or data from the Admin.</div>
        </div>
        <button onClick={() => setShowRequest(true)}
          style={{ padding:'8px 20px', border:'none', borderRadius:8, background:'var(--sage)', color:'#fff', fontSize:11, fontWeight:700, fontFamily:'inherit', cursor:'pointer', display:'flex', alignItems:'center', gap:6, whiteSpace:'nowrap' }}>
          <span className="material-symbols-outlined" style={{ fontSize:16 }}>add_circle</span>
          Request More Data
        </button>
      </div>

      {barData.length > 0 && (
      <div className="fro-flex-row" style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: isMobile ? 'wrap' : undefined }}>
          <div className="card" style={{ marginBottom: 0, flex: isMobile ? 1 : 7, minWidth: isMobile ? '100%' : undefined }}>
            <div className="card-head"><h3>Target vs Collection</h3></div>
            <div className="card-pad" style={{ width:'100%', height:220 }}>
              <ResponsiveContainer>
                <BarChart data={barData} margin={{ top:8, right:8, left:-8, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" tick={{ fontSize:11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize:10 }} axisLine={false} tickLine={false} tickFormatter={v => '₹' + (v / 1000).toFixed(0) + 'k'} />
                  <Tooltip formatter={(v) => [currency(v), 'Amount']} contentStyle={{ fontSize:11, borderRadius:8, border:'1px solid #e2e8f0' }} />
                  <Bar dataKey="amount" radius={[6,6,0,0]} barSize={48}>
                    {barData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 0, flex: 5 }}>
            <div className="card-head"><h3>Donor Status</h3></div>
            <div className="card-pad" style={{ width:'100%', height:220, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {pieData.length > 0 ? (
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={52} outerRadius={78} paddingAngle={3} dataKey="value">
                      {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [v, n]} contentStyle={{ fontSize:11, borderRadius:8, border:'1px solid #e2e8f0' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ fontSize:11, color:'var(--ink-soft)' }}>No status data</div>
              )}
            </div>
            {pieData.length > 0 && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 10px', marginTop:6, justifyContent:'center', paddingBottom: 8 }}>
                {pieData.map(e => (
                  <div key={e.name} style={{ display:'flex', alignItems:'center', gap:4, fontSize:9, color:'var(--ink-soft)' }}>
                    <span style={{ width:8, height:8, borderRadius:2, background:e.color, display:'inline-block' }} />
                    {e.name} ({e.value})
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showCollections && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.4)' }}
          onClick={() => { setShowCollections(false); setCollectionSearch('') }}>
          <div style={{ background: '#fff', borderRadius: 12, width: isMobile ? 'calc(100vw - 32px)' : 520, maxHeight: '75vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,.15)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>My Collections</div>
                <div style={{ fontSize: 10, color: 'var(--ink-soft)' }}>
                  {collectionsLoading ? 'Loading…' : `${(collectionsByNgo[selectedCollectionNgo] || []).length} collections`}
                  {collectionsMonthLabel ? ` · ${collectionsMonthLabel}` : ''}
                  {/* The subtotal of the rows actually shown. Served by the same
                      loader the Collected card totals, so on the current month
                      with no NGO filter this must equal the card; if it ever does
                      not, the number on screen is what was collected. */}
                  {!collectionsLoading && selectedCollectionNgo === 'all' && collectionsMonth === 'current' && collectionsData?.total != null && (
                    <span> · {currency(Number(collectionsData.total))} total</span>
                  )}
                </div>
                <button onClick={() => { setShowCollections(false); setSelectedCollectionNgo('all'); setCollectionSearch('') }}
                  style={{ width: 28, height: 28, border: 'none', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 }}>
                  ×
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {/* Month Toggle */}
                <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 6, padding: 2 }}>
                  {[['current', 'This month'], ['prev', 'Last month']].map(([val, lbl]) => (
                    <button
                      key={val}
                      onClick={() => { if (!collectionsLoading && collectionsMonth !== val) openCollections(undefined, val) }}
                      style={{
                        padding: '4px 10px', borderRadius: 4, border: 'none',
                        fontSize: 10, fontWeight: 600, fontFamily: 'inherit', cursor: collectionsLoading ? 'not-allowed' : 'pointer',
                        background: collectionsMonth === val ? 'var(--sage)' : 'transparent',
                        color: collectionsMonth === val ? '#fff' : 'var(--ink-soft)',
                        opacity: collectionsLoading ? 0.6 : 1,
                      }}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                {/* NGO Tabs */}
                <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', borderRadius: 6, padding: 2 }}>
                  {['all', ...Object.keys(ngoMap)].map(ngoId => (
                    <button
                      key={ngoId}
                      onClick={() => setSelectedCollectionNgo(ngoId)}
                      style={{
                        padding: '4px 10px', borderRadius: 4, border: 'none',
                        fontSize: 10, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                        background: selectedCollectionNgo === ngoId ? 'var(--sage)' : 'transparent',
                        color: selectedCollectionNgo === ngoId ? '#fff' : 'var(--ink-soft)',
                      }}
                    >
                      {ngoId === 'all' ? 'All' : ngoMap[ngoId]}
                      <span style={{ marginLeft: 4, opacity: 0.7 }}>
                        ({collectionsByNgo[ngoId]?.length || 0})
                      </span>
                    </button>
                  ))}
                </div>
                <button onClick={() => { setShowCollections(false); setCollectionSearch('') }} style={{ width: 28, height: 28, border: 'none', borderRadius: 6, background: 'var(--bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 }}>×</button>
              </div>
            </div>
            <div style={{ padding: '8px 18px 0' }}>
              <input
                value={collectionSearch}
                onChange={e => setCollectionSearch(e.target.value)}
                placeholder="Search donor, mobile or receipt #"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--ink)', outline: 'none' }}
              />
            </div>
            <div style={{ overflow: 'auto', padding: 8, flex: 1 }}>
              {collectionsLoading ? (
                <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: 'var(--ink-soft)' }}>Loading collections…</div>
              ) : visibleCollections.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: 'var(--ink-soft)' }}>
                  {collectionSearch.trim() ? 'No matching collections' : `No collections in ${collectionsMonthLabel || 'this month'}`}
                </div>
              ) : (
                visibleCollections.map(c => (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 4, borderRadius: 8,
                    background: 'var(--bg)', border: '1px solid var(--line)',
                  }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: c.is_work_as ? '#f59e0b' : 'var(--sage)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      {c.donor_name?.charAt(0) || '?'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.donor_name}</span>
                        {c.ngo_name && (
                          <span style={{ fontSize: 8, fontWeight: 700, color: '#6d28d9', background: '#ede9fe', border: '1px solid #ddd6fe', padding: '1px 5px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0 }}>{c.ngo_name}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{c.donor_mobile || '—'}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--sage)' }}>{currency(c.amount_collected)}</div>
                      {c.receipt_no && (
                        <div style={{ fontSize: 9, fontWeight: 600, color: '#7c3aed' }}>#{c.receipt_no}</div>
                      )}
                      <div style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{fmtStamp(c.collected_at)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showMonthlyModal && monthlyDonors.length > 0 && (
        <div style={{ position:'fixed', inset:0, zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,.4)' }} onClick={() => { localStorage.setItem('monthly_donors_dismissed', monthStr); setShowMonthlyModal(false); }}>
          <div style={{ background:'#fff', borderRadius:12, width: isMobile ? 'calc(100vw - 32px)' : 480, maxHeight:'70vh', display:'flex', flexDirection:'column', boxShadow:'0 8px 32px rgba(0,0,0,.15)' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div>
                <div style={{ fontSize:14, fontWeight:700 }}>Monthly Recurring Donors</div>
                <div style={{ fontSize:10, color:'var(--ink-soft)' }}>{monthStr} — Donors with 3+ donations history</div>
              </div>
              <button onClick={() => { localStorage.setItem('monthly_donors_dismissed', monthStr); setShowMonthlyModal(false); }}
                style={{ width:28, height:28, border:'none', borderRadius:6, background:'var(--bg)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, lineHeight:1 }}>
                ×
              </button>
            </div>
            <div style={{ overflow:'auto', padding:8, flex:1 }}>
              {monthlyDonors.map(d => (
                <div key={`${d.donor_id}-${d.ngo_id}`} style={{
                  display:'flex', alignItems:'center', gap:10, padding:'8px 12px', marginBottom:4, borderRadius:8,
                  background:'var(--bg)', border:'1px solid var(--line)',
                }}>
                  <div style={{ width:32, height:32, borderRadius:'50%', background:'var(--sage)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, flexShrink:0 }}>
                    {d.donor_name?.charAt(0) || '?'}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:11, fontWeight:600 }}>{d.donor_name}</div>
                    <div style={{ fontSize:9, color:'var(--md-outline)' }}>{d.donor_mobile}{d.donor_city ? ` · ${d.donor_city}` : ''}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:10, fontWeight:600 }}>₹{Number(d.amount).toLocaleString('en-IN')}</div>
                    <div style={{ fontSize:8, color:'var(--md-outline)' }}>{d.donation_count} donations</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showRequest && (
        <div style={{ position:'fixed', inset:0, zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,.4)' }} onClick={() => { if (!sending) { setShowRequest(false); setReqDone(false) } }}>
          <div style={{ background:'#fff', borderRadius:12, width:400, padding:20, boxShadow:'0 8px 32px rgba(0,0,0,.15)' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Request More Data</div>
            <div style={{ fontSize:10, color:'var(--ink-soft)', marginBottom:12 }}>Send a request to the Admin for additional donor assignments or data.</div>
            {reqDone ? (
              <div style={{ textAlign:'center', padding:'16px 0', color:'var(--sage)', fontWeight:600, fontSize:12 }}>
                <span className="material-symbols-outlined" style={{ fontSize:18, verticalAlign:'middle', marginRight:4 }}>check_circle</span>
                Request sent successfully
              </div>
            ) : (
              <>
                <textarea value={reqMsg} onChange={e => setReqMsg(e.target.value)} rows={4}
                  placeholder="Describe what data you need..."
                  style={{ width:'100%', padding:8, border:'1px solid var(--line)', borderRadius:6, fontSize:11, fontFamily:'inherit', resize:'vertical', boxSizing:'border-box' }} />
                <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
                  <button onClick={() => { setShowRequest(false); setReqMsg('') }}
                    style={{ padding:'7px 16px', border:'1px solid var(--line)', borderRadius:6, background:'#fff', fontSize:11, fontWeight:600, fontFamily:'inherit', cursor:'pointer' }}>Cancel</button>
                  <button onClick={handleSendRequest} disabled={sending || !reqMsg.trim()}
                    style={{ padding:'7px 16px', border:'none', borderRadius:6, background:'var(--sage)', color:'#fff', fontSize:11, fontWeight:700, fontFamily:'inherit', cursor:'pointer', opacity: sending || !reqMsg.trim() ? .5 : 1 }}>
                    {sending ? 'Sending...' : 'Send Request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'var(--sage)' }}>stack_star</span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Incentive Eligible?</span>
        </div>
        <button onClick={() => setIncentiveOnly(v => !v)}
          style={{ padding: '6px 14px', borderRadius: 999, border: incentiveOnly ? 'none' : '1px solid var(--line)', background: incentiveOnly ? 'var(--sage)' : 'var(--bg)', color: incentiveOnly ? '#fff' : 'var(--ink-soft)', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: incentiveOnly ? '#fff' : '#cbd5e1' }} />
          Only incentive eligible
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 22, textAlign: 'right' }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-soft)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4 }}>Total Collected</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--ink)' }}>{currency(displayCollected)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-soft)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4 }}>Total AKI</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--sage)' }}>{currency(totalAKI)}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginBottom: 14, alignItems: 'start' }}>
        <RecentNotices limit={5} containerStyle={{ marginTop: 0 }} />
        <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', boxShadow: '0 1px 2px rgba(30,77,59,0.04), 0 6px 18px -10px rgba(30,77,59,0.08)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                background: 'linear-gradient(135deg, #16a34a 0%, #4ade80 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-outlined" style={{ color: '#fff', fontSize: 15 }}>calendar_month</span>
              </span>
              <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: 'var(--ink)' }}>Incentive Calendar</h3>
            </div>
            <span style={{ fontSize: 10, color: 'var(--ink-soft)', fontWeight: 600 }}>{monthStr}</span>
          </div>
          <IncentiveCalendar akiPerDay={akiPerDay} monthStr={monthStr} onlyEligible={incentiveOnly} />
        </div>
      </div>
    </div>
  )
}
