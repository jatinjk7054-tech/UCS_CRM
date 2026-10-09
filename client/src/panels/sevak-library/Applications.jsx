import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, Download, ChevronLeft, ChevronRight, ArrowUpDown, Inbox, FileText, Loader2,
  SlidersHorizontal, RefreshCw, Copy, Check, MoreVertical, Eye, Pencil, ShieldCheck,
  BadgeCheck, Mail, Ban, Trash2, Tag, ChevronDown, Clock, Users, IndianRupee,
  Bell, AlertTriangle, CircleCheck
} from 'lucide-react'
import {
  STATUS_ORDER, statusLabel, PLAN_COLORS, isRenewalDue, daysUntil,
  daysRemainingForRow, membershipState, toLocalIso
} from './meta.js'
import {
  exportApplicationsCsv, getPhotoUrls, sendPaymentReminder, verifyApplication,
  approveApplication, rejectApplication, removeApplication, resendMembershipEmail,
  renewApplication
} from './api.js'
import { pdfMemberDoc } from './MembershipFormDoc.jsx'
import { formatINR, formatDate, formatTime, computeEndDate, renewalPreview } from './formUtils.js'
import { useToast } from './toast.jsx'
import StatCard from './StatCard.jsx'

const PAGE_SIZES = [10, 25, 50, 100]

const MEMBERSHIP_FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'expiring', label: 'Expiring soon' },
  { key: 'expired', label: 'Expired' }
]

const emptyDraft = () => ({
  statuses: [], plans: [], membership: [], from: '', to: '', expiryFrom: '', expiryTo: ''
})

// Toolbar Time dropdown: filters by application date (created_at).
const TIME_OPTIONS = [
  { key: 'all', label: 'All applications' },
  { key: 'm1', label: 'Last 1 month' },
  { key: 'm3', label: 'Last 3 months' },
  { key: 'm6', label: 'Last 6 months' },
  { key: 'y1', label: 'Last 1 year' }
]

const timeCutoff = (key) => {
  const d = new Date()
  if (key === 'm1') d.setMonth(d.getMonth() - 1)
  else if (key === 'm3') d.setMonth(d.getMonth() - 3)
  else if (key === 'm6') d.setMonth(d.getMonth() - 6)
  else if (key === 'y1') d.setFullYear(d.getFullYear() - 1)
  return toLocalIso(d).slice(0, 10)
}

const keyForFrom = (val) => {
  if (!val) return 'all'
  for (const k of ['m1', 'm3', 'm6', 'y1']) if (val === timeCutoff(k)) return k
  return 'custom'
}

export default function Applications({
  rows, loading = false, onOpen, initialFilters = {}, onRefresh, refreshing = false, refresh
}) {
  const toast = useToast()
  const [q, setQ] = useState(initialFilters.q || '')
  const [statuses, setStatuses] = useState(
    initialFilters.status && initialFilters.status !== 'ALL' ? [initialFilters.status] : []
  )
  const [plans, setPlans] = useState(
    initialFilters.plan && initialFilters.plan !== 'ALL' ? [initialFilters.plan] : []
  )
  const [renewal, setRenewal] = useState(!!initialFilters.renewal)
  const [from, setFrom] = useState(initialFilters.from || '')
  const [to, setTo] = useState(initialFilters.to || '')
  const [expiryFrom, setExpiryFrom] = useState(initialFilters.expiryFrom || '')
  const [expiryTo, setExpiryTo] = useState(initialFilters.expiryTo || '')
  const [membership, setMembership] = useState([])
  const [timeKey, setTimeKey] = useState(() => keyForFrom(initialFilters.from || ''))
  const [sortKey, setSortKey] = useState('created_at')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [pdfBusy, setPdfBusy] = useState(false)

  const [selected, setSelected] = useState(() => new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [openSel, setOpenSel] = useState('')
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [popPos, setPopPos] = useState(null)
  const [draft, setDraft] = useState(null)
  const [copiedRef, setCopiedRef] = useState('')
  const [menuFor, setMenuFor] = useState(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const [menuConfirm, setMenuConfirm] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [renewFee, setRenewFee] = useState('')
  const [renewTxn, setRenewTxn] = useState('')
  const [renewFrom, setRenewFrom] = useState('')
  const [approveEmail, setApproveEmail] = useState(true)
  const [actionBusy, setActionBusy] = useState('')
  const [bulkConfirm, setBulkConfirm] = useState(false)

  const filterRef = useRef(null)
  const popRef = useRef(null)
  const menuRef = useRef(null)
  const selRef = useRef(null)
  const alertsRef = useRef(null)
  const checkAllRef = useRef(null)

  const counts = useMemo(() => {
    const c = { ALL: rows.length }
    STATUS_ORDER.forEach((s) => (c[s] = rows.filter((r) => r.status === s).length))
    return c
  }, [rows])

  const planCounts = useMemo(() => {
    const c = { ALL: rows.length }
    rows.forEach((r) => {
      const p = r.membership_type || 'Other'
      c[p] = (c[p] || 0) + 1
    })
    return c
  }, [rows])

  const planList = useMemo(
    () => Object.keys(planCounts).filter((p) => p !== 'ALL'),
    [planCounts]
  )

  // Moved from the removed Dashboard tab: totals + revenue for the CURRENT
  // time filter (from/to, same bounds the table uses). The delta badge compares
  // the period against the immediately preceding equal-length window; for an
  // unbounded period ("All applications") it falls back to this-month context.
  const hero = useMemo(() => {
    const todayIso = toLocalIso(new Date()).slice(0, 10)
    const inRange = (iso10, startIso, endIso) => {
      if (!iso10) return false
      if (startIso && iso10 < startIso) return false
      if (endIso && iso10 > endIso) return false
      return true
    }
    const paidInRange = (startIso, endIso) =>
      rows
        .filter(
          (r) =>
            (r.status === 'VERIFIED' || r.status === 'APPROVED') &&
            inRange((r.created_at || '').slice(0, 10), startIso, endIso)
        )
        .reduce((s, r) => s + (Number(r.membership_fee) || 0) + (Number(r.renewal_fees) || 0), 0)

    const total = rows.filter((r) => inRange((r.created_at || '').slice(0, 10), from, to)).length
    const newTotal = rows.filter((r) => {
      const t = new Date(r.created_at || '').getTime()
      return Number.isFinite(t) && t >= Date.now() - 7 * 86400000
    }).length
    const revenue = paidInRange(from, to)

    // Previous equal-length window for the delta badge — only when the period
    // has a start (pickTime sets from; custom ranges set both ends; '' = all).
    let revDelta = null
    if (from) {
      const startMs = new Date(`${from}T00:00:00`).getTime()
      const endMs = new Date(`${to || todayIso}T00:00:00`).getTime()
      const spanDays = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1)
      const prevEndIso = toLocalIso(new Date(startMs - 86400000)).slice(0, 10)
      const prevStartIso = toLocalIso(new Date(startMs - spanDays * 86400000)).slice(0, 10)
      const prev = paidInRange(prevStartIso, prevEndIso)
      if (prev > 0) revDelta = Math.round(((revenue - prev) / prev) * 100)
    }

    const monthKey = (offset = 0) => {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() + offset)
      return toLocalIso(d).slice(0, 7)
    }
    const thisMonth = paidInRange(monthKey(0), `${monthKey(0)}-31`)
    return { total, newTotal, revenue, revDelta, thisMonth }
  }, [rows, from, to])

  // Bell-icon alerts: renewals due (expiring soon / overdue / expired) + queued work.
  const alertsData = useMemo(() => {
    const due = rows
      .filter((r) => isRenewalDue(r))
      .map((r) => ({ row: r, days: daysUntil(r.end_date) }))
      .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))
    const expired = due.filter((a) => a.days < 0).length
    const soon = due.length - expired
    const pending = rows.filter((r) => r.status === 'SUBMITTED').length
    const awaiting = rows.filter((r) => r.status === 'PAYMENT_SUBMITTED').length
    return { due, expired, soon, pending, awaiting, total: due.length + pending + awaiting }
  }, [rows])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    let list = rows
    if (term) {
      list = list.filter((r) =>
        [r.ref, r.full_name, r.email, r.mobile, r.transaction_id, r.membership_id, r.membership_type]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term))
      )
    }
    if (statuses.length) list = list.filter((r) => statuses.includes(r.status))
    if (plans.length) list = list.filter((r) => plans.includes(r.membership_type || 'Other'))
    if (renewal) list = list.filter((r) => isRenewalDue(r))
    if (membership.length) list = list.filter((r) => membership.includes(membershipState(r)))
    if (from) list = list.filter((r) => (r.created_at || '').slice(0, 10) >= from)
    if (to) list = list.filter((r) => (r.created_at || '').slice(0, 10) <= to)
    if (expiryFrom) list = list.filter((r) => r.end_date && r.end_date >= expiryFrom)
    if (expiryTo) list = list.filter((r) => r.end_date && r.end_date <= expiryTo)

    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (sortKey === 'created_at') return (new Date(a.created_at) - new Date(b.created_at)) * dir
      if (sortKey === 'membership_fee') return ((Number(a.membership_fee) || 0) - (Number(b.membership_fee) || 0)) * dir
      return String(av || '').localeCompare(String(bv || '')) * dir
    })
  }, [rows, q, statuses, plans, renewal, membership, from, to, expiryFrom, expiryTo, sortKey, sortDir])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pages)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const activeFilterCount =
    (statuses.length ? 1 : 0) +
    (plans.length ? 1 : 0) +
    (membership.length ? 1 : 0) +
    (renewal ? 1 : 0) +
    (from || to ? 1 : 0) +
    (expiryFrom || expiryTo ? 1 : 0)
  const hasFilters = activeFilterCount > 0 || !!q.trim()

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected])

  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [pages, page])

  useEffect(() => {
    setPage(1)
  }, [q, statuses, plans, renewal, membership, from, to, expiryFrom, expiryTo, pageSize])

  // Keep bulk selection scoped to the current view — never act on unseen rows.
  useEffect(() => {
    setSelected(new Set())
    setMenuFor(null)
    setMenuConfirm(null)
    setBulkConfirm(false)
  }, [q, statuses, plans, renewal, membership, from, to, expiryFrom, expiryTo, page, pageSize, sortKey, sortDir])

  useEffect(() => {
    const el = checkAllRef.current
    if (!el) return
    const onPage = pageRows.filter((r) => selected.has(r.id)).length
    el.indeterminate = onPage > 0 && onPage < pageRows.length
  }, [selected, pageRows])

  useEffect(() => {
    if (!filtersOpen) return
    const onDown = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [filtersOpen])

  // Close Plan/Time dropdown menus on outside click.
  useEffect(() => {
    if (!openSel) return
    const onDown = (e) => {
      if (selRef.current && !selRef.current.contains(e.target)) setOpenSel('')
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openSel])

  // Close the alerts popover on outside click.
  useEffect(() => {
    if (!alertsOpen) return
    const onDown = (e) => {
      if (alertsRef.current && !alertsRef.current.contains(e.target)) setAlertsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [alertsOpen])

  const positionFilters = () => {
    const btn = filterRef.current?.querySelector('button')
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const pop = popRef.current
    const w = pop ? pop.offsetWidth : Math.min(300, window.innerWidth - 40)
    const h = pop ? pop.offsetHeight : 0
    let left = r.left
    if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12
    if (left < 12) left = 12
    let top = r.bottom + 8
    if (h && top + h > window.innerHeight - 12) {
      const above = r.top - 8 - h
      top = above >= 12 ? above : Math.max(12, window.innerHeight - h - 12)
    }
    setPopPos({ top, left })
  }

  useEffect(() => {
    if (!filtersOpen) return
    positionFilters()
    const onResize = () => positionFilters()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [filtersOpen])

  useEffect(() => {
    if (!menuFor) return
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuFor(null)
        setMenuConfirm(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    const onResize = () => {
      setMenuFor(null)
      setMenuConfirm(null)
    }
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onResize)
    }
  }, [menuFor])

  useEffect(() => {
    if (!filtersOpen && !menuFor && !openSel && !alertsOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setFiltersOpen(false)
        setMenuFor(null)
        setMenuConfirm(null)
        setOpenSel('')
        setAlertsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filtersOpen, menuFor, openSel, alertsOpen])

  const clearFilters = () => {
    setQ('')
    setStatuses([])
    setPlans([])
    setRenewal(false)
    setMembership([])
    setFrom('')
    setTo('')
    setExpiryFrom('')
    setExpiryTo('')
    setTimeKey('all')
  }

  const openFilters = () => {
    setDraft({ statuses, plans, membership, from, to, expiryFrom, expiryTo })
    positionFilters()
    setFiltersOpen(true)
  }

  const applyFilters = () => {
    if (!draft) return
    setStatuses(draft.statuses)
    setPlans(draft.plans)
    setMembership(draft.membership)
    setFrom(draft.from)
    setTo(draft.to)
    setTimeKey(keyForFrom(draft.from))
    setExpiryFrom(draft.expiryFrom)
    setExpiryTo(draft.expiryTo)
    setFiltersOpen(false)
  }

  const pickPlan = (p) => {
    setPlans(p ? [p] : [])
    setOpenSel('')
  }

  const pickTime = (key) => {
    setTimeKey(key)
    setFrom(key === 'all' ? '' : timeCutoff(key))
    setTo('')
    setOpenSel('')
  }

  const timeLabel =
    TIME_OPTIONS.find((t) => t.key === timeKey)?.label || 'Custom dates'
  const planLabel =
    plans.length === 0 ? 'All plans' : plans.length === 1 ? plans[0] : `${plans.length} plans`

  const toggleDraft = (field, value) => {
    setDraft((d) => ({
      ...d,
      [field]: d[field].includes(value) ? d[field].filter((x) => x !== value) : [...d[field], value]
    }))
  }

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const openApp = (row, opts) => {
    setFiltersOpen(false)
    setMenuFor(null)
    setMenuConfirm(null)
    onOpen(row, opts)
  }

  const exportRows = (list, what) => {
    const csv = exportApplicationsCsv(list)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sevak-applications-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast(`Exported ${list.length} ${what} to CSV.`)
  }

  const printPdf = async () => {
    const approved = filtered.filter((r) => r.status === 'APPROVED')
    if (approved.length === 0) return
    setPdfBusy(true)
    try {
      const urls = await Promise.all(
        approved.map((r) => getPhotoUrls(r.id, 'data').then((u) => u || null).catch(() => null))
      )
      await pdfMemberDoc(approved, urls)
      toast(`Downloaded ${approved.length} membership registration PDF(s).`)
    } catch (e) {
      toast(`Could not generate PDF: ${e.message}`, 'error')
    }
    setPdfBusy(false)
  }

  const copyRef = async (ref) => {
    try {
      await navigator.clipboard.writeText(ref)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = ref
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopiedRef(ref)
    toast('Reference copied.')
    setTimeout(() => setCopiedRef((c) => (c === ref ? '' : c)), 1500)
  }

  const closeMenu = () => {
    setMenuFor(null)
    setMenuConfirm(null)
  }

  const menuItemCount = (r) => {
    let n = 3 // view, edit, delete
    if (r.status === 'SUBMITTED') n += 2 // reminder + reject
    if (r.status === 'PAYMENT_SUBMITTED') n += 2 // verify + reject
    if (r.status === 'VERIFIED') n += 2 // approve + reject
    if (r.status === 'APPROVED') n += 1 // resend
    return n
  }

  // The table wrapper scrolls horizontally, so the menu is positioned against
  // the viewport instead of the row (an absolute menu would get clipped).
  const openMenu = (e, r) => {
    const btn = e.currentTarget.getBoundingClientRect()
    const estH = menuItemCount(r) * 34 + 14
    let top = btn.bottom + 6
    if (top + estH > window.innerHeight - 8) top = Math.max(8, btn.top - estH - 6)
    const width = 240
    const left = Math.max(8, Math.min(btn.right - width, window.innerWidth - width - 8))
    setMenuPos({ top, left })
    setMenuConfirm(null)
    setMenuFor(r.id)
  }

  const doReminder = async (r) => {
    setActionBusy('remind')
    try {
      await sendPaymentReminder(r.id)
      toast('Payment reminder email sent.')
      closeMenu()
    } catch (e) {
      toast(e.message, 'error')
    }
    setActionBusy('')
  }

  const doVerify = async (r) => {
    setActionBusy('verify')
    try {
      await verifyApplication(r.id)
      toast('Payment verified.')
      closeMenu()
      if (refresh) refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
    setActionBusy('')
  }

  const doApprove = async (r) => {
    setActionBusy('approve')
    try {
      const data = await approveApplication(r.id)
      toast(data && data.membership_id ? `Membership ${data.membership_id} issued.` : 'Membership issued.')
      closeMenu()
    } catch (e) {
      toast(e.message, 'error')
      setActionBusy('')
      return
    }
    setActionBusy('')
    if (refresh) refresh()
    if (approveEmail) {
      try {
        const res = await resendMembershipEmail(r.id)
        if (res && res.sent) toast('Membership email sent.')
        else toast(`Membership issued, but email not sent: ${(res && res.error) || 'unknown error'}`, 'error')
      } catch (e) {
        toast(`Membership issued, but email failed: ${e.message}`, 'error')
      }
    }
  }

  const doRenew = async (r) => {
    const txn = String(renewTxn || '').trim()
    if (!txn) {
      toast('Enter the transaction / UTR id of the renewal payment.', 'error')
      return
    }
    const feeNum = Number(renewFee)
    if (!Number.isFinite(feeNum) || feeNum < 0) {
      toast('Enter a valid renewal fee.', 'error')
      return
    }
    if (!renewFrom) {
      toast('Pick the renewal start date.', 'error')
      return
    }
    setActionBusy('renew')
    try {
      const data = await renewApplication(r.id, { fee: feeNum, transactionId: txn, startDate: renewFrom })
      toast(data && data.end_date ? `Membership renewed until ${formatDate(data.end_date)}.` : 'Membership renewed.')
      closeMenu()
      if (refresh) refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
    setActionBusy('')
  }

  const doReject = async (r) => {
    if (!rejectReason.trim()) {
      toast('Please enter a reason for rejection.', 'error')
      return
    }
    setActionBusy('reject')
    try {
      await rejectApplication(r.id, rejectReason)
      toast('Application rejected.')
      closeMenu()
      if (refresh) refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
    setActionBusy('')
  }

  const doDelete = async (r) => {
    setActionBusy('delete')
    try {
      await removeApplication(r.id)
      toast('Application deleted.')
      closeMenu()
      if (refresh) refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
    setActionBusy('')
  }

  const doResend = async (r) => {
    setActionBusy('resend')
    try {
      const res = await resendMembershipEmail(r.id)
      if (res && res.sent) toast('Membership email sent.')
      else toast(`Email not sent: ${(res && res.error) || 'unknown error'}`, 'error')
    } catch (e) {
      toast(e.message, 'error')
    }
    setActionBusy('')
  }

  const bulkRemind = async () => {
    const list = selectedRows
    if (!list.length) return
    setActionBusy('bulk-remind')
    const results = await Promise.all(
      list.map((r) => sendPaymentReminder(r.id).then(() => true).catch(() => false))
    )
    const sent = results.filter(Boolean).length
    if (sent === list.length) toast(`Payment reminder sent to ${sent} applicant${sent === 1 ? '' : 's'}.`)
    else toast(`Reminder sent to ${sent} of ${list.length} applicants.`, 'error')
    setActionBusy('')
  }

  const bulkDelete = async () => {
    const list = selectedRows
    if (!list.length) return
    setActionBusy('bulk-delete')
    let ok = 0
    for (const r of list) {
      try {
        await removeApplication(r.id)
        ok++
      } catch {
        // keep going — report partial failures below
      }
    }
    if (ok === list.length) toast(`Deleted ${ok} application${ok === 1 ? '' : 's'}.`)
    else toast(`Deleted ${ok} of ${list.length} applications.`, 'error')
    setActionBusy('')
    setBulkConfirm(false)
    setSelected(new Set())
    if (refresh) refresh()
  }

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const checkAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      const all = pageRows.every((r) => next.has(r.id))
      pageRows.forEach((r) => (all ? next.delete(r.id) : next.add(r.id)))
      return next
    })
  }

  const SortBtn = ({ label, k }) => (
    <button className="sort-btn" onClick={() => toggleSort(k)}>
      {label}
      <ArrowUpDown size={12} className={sortKey === k ? `sort-active ${sortDir}` : ''} />
    </button>
  )

  const renderRowMenu = (r) => {
    const menuStyle = { top: menuPos.top, left: menuPos.left }
    if (menuConfirm && menuConfirm.row.id === r.id) {
      if (menuConfirm.type === 'approve') {
        return (
          <div className="row-menu row-menu-box" style={menuStyle}>
            <strong>Approve Application?</strong>
            <div className="menu-kv"><span>Applicant</span><b>{r.full_name}</b></div>
            <div className="menu-kv"><span>Plan</span><b>{r.membership_type || '—'}</b></div>
            <div className="menu-kv"><span>Fee</span><b>{formatINR(r.membership_fee)}</b></div>
            <label className="menu-check">
              <input
                type="checkbox"
                checked={approveEmail}
                onChange={(e) => setApproveEmail(e.target.checked)}
              />
              Send approval email
            </label>
            <div className="menu-btns">
              <button className="btn-mini" onClick={() => setMenuConfirm(null)} disabled={!!actionBusy}>Cancel</button>
              <button className="btn-mini approve" onClick={() => doApprove(r)} disabled={!!actionBusy}>
                {actionBusy === 'approve' ? <Loader2 size={13} className="spin" /> : <BadgeCheck size={13} />} Approve
              </button>
            </div>
          </div>
        )
      }
      if (menuConfirm.type === 'renew') {
        const p = renewalPreview(r)
        const txnOk = !!String(renewTxn || '').trim()
        const feeNum = Number(renewFee)
        const feeOk = Number.isFinite(feeNum) && feeNum >= 0
        const from = renewFrom || (p ? p.from : '')
        const to = from ? computeEndDate(from, r.membership_type) : ''
        const dateOk = !!from && !!to
        return (
          <div className="row-menu row-menu-box" style={menuStyle}>
            <strong>Renew membership?</strong>
            <div className="menu-kv"><span>Member</span><b>{r.full_name}</b></div>
            <div className="menu-kv"><span>Plan</span><b>{r.membership_type || '—'}</b></div>
            <div className="menu-kv">
              <span>New period</span>
              <b>{dateOk ? `${formatDate(from)} → ${formatDate(to)}` : '—'}</b>
            </div>
            <label className="menu-field">
              Renewal start date *
              <input
                type="date"
                value={renewFrom}
                onChange={(e) => setRenewFrom(e.target.value)}
              />
            </label>
            <label className="menu-field">
              Fee (₹)
              <input
                type="number"
                min="0"
                step="1"
                value={renewFee}
                onChange={(e) => setRenewFee(e.target.value)}
                placeholder="Renewal fee"
              />
            </label>
            <label className="menu-field">
              Transaction / UTR ID *
              <input
                type="text"
                value={renewTxn}
                onChange={(e) => setRenewTxn(e.target.value)}
                placeholder="UTR of the renewal payment"
                maxLength={64}
                required
              />
            </label>
            <p className="menu-hint">
              {p && from === p.from
                ? p.keeps
                  ? 'Remaining days are kept — the plan is added to the current end date.'
                  : 'Membership already expired, so the new period starts from today.'
                : 'The plan duration is added to the chosen start date.'}{' '}
              Records {feeOk ? formatINR(feeNum) : '—'} as renewal fee.
            </p>
            <div className="menu-btns">
              <button className="btn-mini" onClick={() => setMenuConfirm(null)} disabled={!!actionBusy}>Cancel</button>
              <button className="btn-mini approve" onClick={() => doRenew(r)} disabled={!!actionBusy || !txnOk || !feeOk || !dateOk}>
                {actionBusy === 'renew' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Renew
              </button>
            </div>
          </div>
        )
      }
      if (menuConfirm.type === 'reject') {
        return (
          <div className="row-menu row-menu-box" style={menuStyle}>
            <strong>Reject Application?</strong>
            <label className="menu-field">
              Reason
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Enter rejection reason..."
                rows={3}
              />
            </label>
            <div className="menu-btns">
              <button className="btn-mini" onClick={() => setMenuConfirm(null)} disabled={!!actionBusy}>Cancel</button>
              <button className="btn-mini danger" onClick={() => doReject(r)} disabled={!!actionBusy}>
                {actionBusy === 'reject' ? <Loader2 size={13} className="spin" /> : <Ban size={13} />} Reject Application
              </button>
            </div>
          </div>
        )
      }
      return (
        <div className="row-menu row-menu-box" style={menuStyle}>
          <strong>Delete application?</strong>
          <p className="menu-text"><b>{r.full_name}</b><span className="mono">{r.ref}</span></p>
          <p className="menu-hint">This action cannot be undone.</p>
          <div className="menu-btns">
            <button className="btn-mini" onClick={() => setMenuConfirm(null)} disabled={!!actionBusy}>Cancel</button>
            <button className="btn-mini danger" onClick={() => doDelete(r)} disabled={!!actionBusy}>
              {actionBusy === 'delete' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Delete Application
            </button>
          </div>
        </div>
      )
    }

    const items = [
      { key: 'view', label: 'View application', icon: <Eye size={14} />, onClick: () => openApp(r) },
      { key: 'edit', label: 'Edit details', icon: <Pencil size={14} />, onClick: () => openApp(r, { edit: true }) }
    ]
    if (r.status === 'SUBMITTED') {
      items.push({ key: 'remind', label: 'Send payment reminder', icon: <Mail size={14} />, onClick: () => doReminder(r) })
    }
    if (r.status === 'PAYMENT_SUBMITTED') {
      items.push({ key: 'verify', label: 'Verify application', icon: <ShieldCheck size={14} />, onClick: () => doVerify(r) })
    }
    if (r.status === 'VERIFIED') {
      items.push({
        key: 'approve',
        label: 'Approve & send email',
        icon: <BadgeCheck size={14} />,
        onClick: () => { setRejectReason(''); setApproveEmail(true); setMenuConfirm({ type: 'approve', row: r }) }
      })
    }
    if (r.status === 'APPROVED') {
      items.push({ key: 'renew', label: 'Renew membership', icon: <RefreshCw size={14} />, onClick: () => { setRenewFee(r.membership_fee != null ? String(r.membership_fee) : ''); setRenewTxn(''); setRenewFrom((renewalPreview(r) || {}).from || ''); setMenuConfirm({ type: 'renew', row: r }) } })
      items.push({ key: 'resend', label: 'Resend approval email', icon: <Mail size={14} />, onClick: () => doResend(r) })
    }
    if (['SUBMITTED', 'PAYMENT_SUBMITTED', 'VERIFIED'].includes(r.status)) {
      items.push({
        key: 'reject',
        label: 'Reject',
        icon: <Ban size={14} />,
        onClick: () => { setRejectReason(''); setMenuConfirm({ type: 'reject', row: r }) }
      })
    }
    items.push({ key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, onClick: () => setMenuConfirm({ type: 'delete', row: r }) })

    return (
      <div className="row-menu" style={menuStyle}>
        {items.map((it) => (
          <button
            key={it.key}
            className={`row-menu-item ${it.key === 'delete' || it.key === 'reject' ? 'danger' : ''}`}
            disabled={!!actionBusy}
            onClick={it.onClick}
          >
            {it.icon} {it.label}
          </button>
        ))}
      </div>
    )
  }

  const pageNums = (() => {
    const arr = []
    if (pages <= 7) {
      for (let i = 1; i <= pages; i++) arr.push(i)
    } else {
      arr.push(1)
      if (safePage > 3) arr.push('…')
      for (let i = Math.max(2, safePage - 1); i <= Math.min(pages - 1, safePage + 1); i++) arr.push(i)
      if (safePage < pages - 2) arr.push('…')
      arr.push(pages)
    }
    return arr
  })()

  const rangeStart = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const rangeEnd = Math.min(safePage * pageSize, filtered.length)

  return (
    <div className="admin-view">
      <div className="admin-view-head">
        <div>
          <h2 className="view-title-spec">Applications</h2>
          <p className="admin-sub">Manage membership applications and verification</p>
        </div>
        <div className="admin-view-head-btns">
          <div className="alerts-wrap" ref={alertsRef}>
            <button
              type="button"
              className={`bell-btn ${alertsOpen ? 'active' : ''}`}
              onClick={() => setAlertsOpen((o) => !o)}
              title="Alerts"
              aria-label="Alerts"
            >
              <Bell size={16} />
              {alertsData.total > 0 && <span className="bell-badge">{alertsData.total}</span>}
            </button>

            {alertsOpen && (
              <div className="alerts-pop">
                <div className="alerts-head">
                  <strong><Bell size={14} /> Alerts</strong>
                  <small>{alertsData.total} need attention</small>
                </div>

                {alertsData.total === 0 ? (
                  <div className="alerts-empty">
                    <CircleCheck size={18} /> Nothing needs attention.
                  </div>
                ) : (
                  <>
                    {alertsData.due.length > 0 && (
                      <>
                        <div className="alerts-sec">
                          <AlertTriangle size={13} /> Renewals due
                          <em>{alertsData.due.length}</em>
                        </div>
                        {alertsData.due.slice(0, 6).map(({ row, days }) => (
                          <button
                            key={row.id}
                            type="button"
                            className="alert-row"
                            onClick={() => { setAlertsOpen(false); openApp(row) }}
                          >
                            <span className={`alert-dot ${days < 0 ? 'red' : 'amber'}`} />
                            <span className="alert-main">
                              <strong>{row.full_name || '—'}</strong>
                              <small>
                                {row.ref} ·{' '}
                                {days < 0
                                  ? `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
                                  : days === 0
                                    ? 'Expires today'
                                    : `Due in ${days} day${days === 1 ? '' : 's'}`}
                              </small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        ))}
                        {alertsData.due.length > 6 && (
                          <button
                            type="button"
                            className="alerts-all"
                            onClick={() => {
                              setAlertsOpen(false)
                              setStatuses([])
                              setRenewal(true)
                            }}
                          >
                            View all {alertsData.due.length} renewals due <ChevronRight size={13} />
                          </button>
                        )}
                      </>
                    )}

                    {alertsData.pending > 0 && (
                      <button
                        type="button"
                        className="alert-row"
                        onClick={() => {
                          setAlertsOpen(false)
                          setRenewal(false)
                          setStatuses(['SUBMITTED'])
                        }}
                      >
                        <span className="alert-dot amber" />
                        <span className="alert-main">
                          <strong>{alertsData.pending} payment pending</strong>
                          <small>Collect fees before approving members</small>
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    )}

                    {alertsData.awaiting > 0 && (
                      <button
                        type="button"
                        className="alert-row"
                        onClick={() => {
                          setAlertsOpen(false)
                          setRenewal(false)
                          setStatuses(['PAYMENT_SUBMITTED'])
                        }}
                      >
                        <span className="alert-dot blue" />
                        <span className="alert-main">
                          <strong>{alertsData.awaiting} awaiting verification</strong>
                          <small>Verify submitted transactions</small>
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <button
            className="btn-export btn-export-pdf"
            onClick={printPdf}
            disabled={pdfBusy || filtered.filter((r) => r.status === 'APPROVED').length === 0}
          >
            {pdfBusy ? <Loader2 size={15} className="spin" /> : <FileText size={15} />} Print approved PDF
          </button>
          <button className="btn-export" onClick={() => exportRows(filtered, 'applications')} disabled={filtered.length === 0}>
            <Download size={15} /> Export CSV
          </button>
        </div>
      </div>

      {loading ? (
        <div className="app-table-wrap">
          <div className="skeleton-table" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => (
              <div className="skeleton-row" key={i}>
                <span style={{ width: '6%' }} />
                <span style={{ width: '16%' }} />
                <span style={{ width: '20%' }} />
                <span style={{ width: '9%' }} />
                <span style={{ width: '7%' }} />
                <span style={{ width: '14%' }} />
                <span style={{ width: '12%' }} />
                <span style={{ width: '10%' }} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="hero-stats">
            <StatCard
              icon={<Users size={20} />} label="Total applications" value={hero.total}
              color="#0ea5e9" dot
              sub={`${hero.newTotal} new this week`}
            />
            <StatCard
              icon={<IndianRupee size={20} />} label="Revenue collected" value={hero.revenue}
              color="#8b5cf6"
              sub={formatINR(hero.revenue)}
              trend={
                hero.revDelta !== null
                  ? {
                      up: hero.revDelta >= 0,
                      label: `${Math.abs(hero.revDelta)}% vs previous period`,
                      color: hero.revDelta >= 0 ? '#15803d' : '#b91c1c'
                    }
                  : from
                    ? { label: 'No revenue in previous period', color: '#5f6368' }
                    : { label: `${formatINR(hero.thisMonth)} this month`, color: '#5f6368' }
              }
            />
          </div>

          <div className="app-toolbar">
            <div className="search-box">
              <Search size={15} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name, reference, email, mobile number..."
              />
            </div>

            <div className="sel-group" ref={selRef}>
            <div className="sel-wrap">
              <button
                type="button"
                className={`sel-btn ${plans.length ? 'active' : ''}`}
                onClick={() => setOpenSel(openSel === 'plan' ? '' : 'plan')}
              >
                <Tag size={14} /> {planLabel} <ChevronDown size={14} />
              </button>
              {openSel === 'plan' && (
                <div className="sel-pop">
                  <button
                    type="button"
                    className={`sel-item ${plans.length === 0 ? 'active' : ''}`}
                    onClick={() => pickPlan('')}
                  >
                    All plans <span>{planCounts.ALL}</span>
                  </button>
                  {planList.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`sel-item ${plans.length === 1 && plans[0] === p ? 'active' : ''}`}
                      onClick={() => pickPlan(p)}
                    >
                      <i className="sel-dot" style={{ background: PLAN_COLORS[p] || '#9aa0a6' }} />
                      {p} <span>{planCounts[p]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="sel-wrap">
              <button
                type="button"
                className={`sel-btn ${timeKey !== 'all' ? 'active' : ''}`}
                onClick={() => setOpenSel(openSel === 'time' ? '' : 'time')}
              >
                <Clock size={14} /> {timeLabel} <ChevronDown size={14} />
              </button>
              {openSel === 'time' && (
                <div className="sel-pop">
                  {TIME_OPTIONS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className={`sel-item ${timeKey === t.key ? 'active' : ''}`}
                      onClick={() => pickTime(t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            </div>

            <div className="filter-wrap" ref={filterRef}>
              <button
                type="button"
                className={`btn-filter ${activeFilterCount ? 'has-filters' : ''}`}
                onClick={() => (filtersOpen ? setFiltersOpen(false) : openFilters())}
              >
                <SlidersHorizontal size={15} /> Filters
                {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
              </button>

              {filtersOpen && draft && (
                <div
                  className="filter-pop"
                  ref={popRef}
                  style={popPos ? { top: popPos.top, left: popPos.left } : { top: -9999, left: -9999 }}
                >
                  <div className="filter-group">
                    <span className="filter-title">Status</span>
                    {STATUS_ORDER.map((s) => (
                      <label key={s} className="filter-check">
                        <input
                          type="checkbox"
                          checked={draft.statuses.includes(s)}
                          onChange={() => toggleDraft('statuses', s)}
                        />
                        {statusLabel(s)}
                        <em>{counts[s]}</em>
                      </label>
                    ))}
                  </div>

                  <div className="filter-group">
                    <span className="filter-title">Plan</span>
                    {planList.map((p) => (
                      <label key={p} className="filter-check">
                        <input
                          type="checkbox"
                          checked={draft.plans.includes(p)}
                          onChange={() => toggleDraft('plans', p)}
                        />
                        {p}
                        <em>{planCounts[p]}</em>
                      </label>
                    ))}
                  </div>

                  <div className="filter-group">
                    <span className="filter-title">Membership</span>
                    {MEMBERSHIP_FILTERS.map((m) => (
                      <label key={m.key} className="filter-check">
                        <input
                          type="checkbox"
                          checked={draft.membership.includes(m.key)}
                          onChange={() => toggleDraft('membership', m.key)}
                        />
                        {m.label}
                      </label>
                    ))}
                  </div>

                  <div className="filter-group">
                    <span className="filter-title">Application date</span>
                    <div className="date-fields">
                      <input
                        type="date"
                        value={draft.from}
                        onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                        aria-label="Application from date"
                      />
                      <span>→</span>
                      <input
                        type="date"
                        value={draft.to}
                        onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                        aria-label="Application to date"
                      />
                    </div>
                  </div>

                  <div className="filter-group">
                    <span className="filter-title">Expiry date</span>
                    <div className="date-fields">
                      <input
                        type="date"
                        value={draft.expiryFrom}
                        onChange={(e) => setDraft((d) => ({ ...d, expiryFrom: e.target.value }))}
                        aria-label="Expiry from date"
                      />
                      <span>→</span>
                      <input
                        type="date"
                        value={draft.expiryTo}
                        onChange={(e) => setDraft((d) => ({ ...d, expiryTo: e.target.value }))}
                        aria-label="Expiry to date"
                      />
                    </div>
                  </div>

                  <div className="filter-pop-actions">
                    <button className="btn-mini" onClick={() => setDraft(emptyDraft())}>Reset</button>
                    <button className="btn-mini apply" onClick={applyFilters}>Apply Filters</button>
                  </div>
                </div>
              )}
            </div>

            <button type="button" className="btn-filter" onClick={onRefresh} disabled={refreshing || !onRefresh}>
              <RefreshCw size={15} className={refreshing ? 'spin' : ''} /> Refresh
            </button>
          </div>

          {selected.size > 0 && (
            <>
              <div className="bulk-bar">
                <strong>{selected.size} selected</strong>
                <button className="bulk-btn" onClick={bulkRemind} disabled={!!actionBusy}>
                  {actionBusy === 'bulk-remind' ? <Loader2 size={14} className="spin" /> : <Mail size={14} />}
                  Send Payment Reminder
                </button>
                <button className="bulk-btn" onClick={() => exportRows(selectedRows, 'selected applications')}>
                  <Download size={14} /> Export
                </button>
                <button className="bulk-btn danger" onClick={() => setBulkConfirm(true)} disabled={!!actionBusy}>
                  <Trash2 size={14} /> Delete
                </button>
                <button className="bulk-clear" onClick={() => setSelected(new Set())} disabled={!!actionBusy}>
                  Clear
                </button>
              </div>
              {bulkConfirm && (
                <div className="bulk-confirm">
                  <p>
                    Delete <b>{selected.size} application{selected.size === 1 ? '' : 's'}</b>? This removes
                    their uploaded files and cannot be undone.
                  </p>
                  <div className="menu-btns">
                    <button className="btn-mini" onClick={() => setBulkConfirm(false)} disabled={!!actionBusy}>Cancel</button>
                    <button className="btn-mini danger" onClick={bulkDelete} disabled={!!actionBusy}>
                      {actionBusy === 'bulk-delete' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                      Delete {selected.size} application{selected.size === 1 ? '' : 's'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {pageRows.length === 0 ? (
            <div className="app-table-wrap">
              <div className="admin-empty-block app-empty">
                <Inbox size={34} />
                <p className="empty-title">No applications found</p>
                <p className="empty-sub">Try changing your search or filters.</p>
                {hasFilters && (
                  <button className="btn-view" onClick={clearFilters}>Clear Filters</button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="app-table-wrap app-table-desktop">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th className="col-check">
                        <input
                          ref={checkAllRef}
                          type="checkbox"
                          checked={pageRows.length > 0 && pageRows.every((r) => selected.has(r.id))}
                          onChange={checkAll}
                          disabled={pageRows.length === 0}
                          aria-label="Select page"
                        />
                      </th>
                      <th><SortBtn label="Ref" k="ref" /></th>
                      <th><SortBtn label="Applicant" k="full_name" /></th>
                      <th className="col-plan"><SortBtn label="Plan" k="membership_type" /></th>
                      <th className="col-fee"><SortBtn label="Fee" k="membership_fee" /></th>
                      <th>Status</th>
                      <th><SortBtn label="Applied On" k="created_at" /></th>
                      <th><SortBtn label="Days Remaining" k="end_date" /></th>
                      <th className="col-expire">Expire On</th>
                      <th className="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const dri = daysRemainingForRow(r)
                      const expired = r.status === 'APPROVED' && dri && dri.days < 0
                      return (
                        <tr
                          key={r.id}
                          className="app-row"
                          onClick={() => openApp(r)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              openApp(r)
                            }
                          }}
                          tabIndex={0}
                        >
                          <td className="col-check" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected.has(r.id)}
                              onChange={() => toggleSelect(r.id)}
                              aria-label={`Select ${r.full_name || r.ref}`}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="ref-copy mono"
                              title="Copy reference"
                              onClick={(e) => {
                                e.stopPropagation()
                                copyRef(r.ref)
                              }}
                            >
                              {r.ref}
                              {copiedRef === r.ref
                                ? <Check size={12} className="ref-check" />
                                : <Copy size={12} className="ref-icon" />}
                            </button>
                          </td>
                          <td>
                            <div className="cell-name">
                              <span className="cell-avatar">{r.full_name ? r.full_name.charAt(0).toUpperCase() : '?'}</span>
                              <span>
                                <strong>{r.full_name}</strong>
                                <small>{r.email}</small>
                                {r.mobile && <small className="cell-mobile">+91 {r.mobile}</small>}
                              </span>
                            </div>
                          </td>
                          <td className="col-plan">
                            <span
                              className="plan-tag"
                              style={{ '--pc': PLAN_COLORS[r.membership_type] || '#9aa0a6' }}
                            >
                              {r.membership_type || '—'}
                            </span>
                          </td>
                          <td className="col-fee num-td">{formatINR(r.membership_fee)}</td>
                          <td>
                            <span className={`admin-badge ${r.status}`}>{statusLabel(r.status)}</span>
                            {r.membership_id && <div className="mid mono">{r.membership_id}</div>}
                          </td>
                          <td className="date-cell">
                            {formatDate(r.created_at)}
                            <small>{formatTime(r.created_at)}</small>
                          </td>
                          <td>
                            {dri ? (
                              <span className={`days-pill tone-${dri.tone}`}>
                                <i className="days-dot" />{dri.text}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="date-cell col-expire">
                            {r.end_date ? (
                              <>
                                {formatDate(r.end_date)}
                                {expired && <small className="exp-tag">Expired</small>}
                              </>
                            ) : '—'}
                          </td>
                          <td className="actions-cell col-actions" onClick={(e) => e.stopPropagation()}>
                            <button className="btn-view" onClick={() => openApp(r)}>View</button>
                            <div
                              className="menu-wrap"
                              ref={menuFor === r.id ? menuRef : undefined}
                            >
                              <button
                                className={`btn-more ${menuFor === r.id ? 'active' : ''}`}
                                onClick={(e) => {
                                  if (menuFor === r.id) closeMenu()
                                  else openMenu(e, r)
                                }}
                                aria-label="More actions"
                                disabled={!!actionBusy && menuFor !== r.id}
                              >
                                <MoreVertical size={15} />
                              </button>
                              {menuFor === r.id && renderRowMenu(r)}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="app-cards">
                {pageRows.map((r) => {
                  const dri = daysRemainingForRow(r)
                  return (
                    <div
                      key={r.id}
                      className="app-card"
                      onClick={() => openApp(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openApp(r)
                      }}
                      tabIndex={0}
                    >
                      <div className="app-card-head">
                        <span className="cell-avatar">{r.full_name ? r.full_name.charAt(0).toUpperCase() : '?'}</span>
                        <div className="app-card-id">
                          <strong>{r.full_name}</strong>
                          <span className="mono">{r.ref}</span>
                        </div>
                        <span className={`admin-badge ${r.status}`}>{statusLabel(r.status)}</span>
                      </div>
                      <div className="app-card-meta">
                        <span
                          className="plan-tag"
                          style={{ '--pc': PLAN_COLORS[r.membership_type] || '#9aa0a6' }}
                        >
                          {r.membership_type || '—'}
                        </span>
                        <span className="mono">{formatINR(r.membership_fee)}</span>
                      </div>
                      <dl className="app-card-rows">
                        <div>
                          <dt>Applied</dt>
                          <dd>{formatDate(r.created_at)}{formatTime(r.created_at) ? ` · ${formatTime(r.created_at)}` : ''}</dd>
                        </div>
                        <div>
                          <dt>Remaining</dt>
                          <dd>
                            {dri ? (
                              <span className={`days-pill tone-${dri.tone}`}>
                                <i className="days-dot" />{dri.text}
                              </span>
                            ) : '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>Expires</dt>
                          <dd>{r.end_date ? formatDate(r.end_date) : '—'}</dd>
                        </div>
                      </dl>
                      <button
                        className="btn-view app-card-view"
                        onClick={(e) => {
                          e.stopPropagation()
                          openApp(r)
                        }}
                      >
                        View Application
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {filtered.length > 0 && (
            <div className="pagination pagination-split">
              <span className="page-range">
                Showing {rangeStart}–{rangeEnd} of {filtered.length} application{filtered.length === 1 ? '' : 's'}
              </span>
              <div className="page-right">
                <button
                  className="page-btn"
                  disabled={safePage === 1}
                  onClick={() => setPage(safePage - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                {pageNums.map((n, i) =>
                  n === '…' ? (
                    <span key={`gap-${i}`} className="page-ellipsis">…</span>
                  ) : (
                    <button
                      key={n}
                      className={`page-num ${n === safePage ? 'active' : ''}`}
                      onClick={() => setPage(n)}
                    >
                      {n}
                    </button>
                  )
                )}
                <button
                  className="page-btn"
                  disabled={safePage === pages}
                  onClick={() => setPage(safePage + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} />
                </button>
                <select
                  className="page-size"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n} / page</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
