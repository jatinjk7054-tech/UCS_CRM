import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import interactionPlugin from '@fullcalendar/interaction'
import { PageHeader, SearchInput, Select } from '../components/ui'
import {
  fetchCalendarEvents, fetchWorkspaceNgos, fetchSectors, fetchActivities,
  createEvent, updateEvent, deleteEvent,
  fetchImportantDays, suggestDayPrograms, getFestivalSuggestions,
  mergeProgrammeRows, blankRepeatedDates,
  EVENT_STATUSES, PRIORITIES, CATEGORIES,
} from '../store'
import '../calendar.css'

const pad2 = (n) => String(n).padStart(2, '0')
const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const STATUS_PRIORITY = ['Draft','Submitted','Approved','Rejected','Completed','Closed','Cancelled','Postponed']

const ymdToLabel = (ymd) => {
  if (!ymd) return '—'
  const [y, m, d] = ymd.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const fmtTime = (t) => {
  if (!t) return null
  const hm = String(t).slice(0, 5).split(':')
  let h = Number(hm[0]); const m = Number(hm[1])
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${String(m).padStart(2, '0')} ${ap}`
}

/* ── Important days / festivals / observances (Calendar layer) ───────────────
   Colours + emoji for the `kind` values produced by the backend reference
   calendar. `scope` decides whether the entry shows under the India filter. */
const OBS_META = {
  observance: { label: 'Observance',  color: '#0ea5e9', icon: '🌐' },
  national:   { label: 'National / Civic', color: '#f59e0b', icon: '🏛️' },
  festival:   { label: 'Festival',     color: '#16a34a', icon: '🎉' },
  religious:  { label: 'Religious',    color: '#8b5cf6', icon: '🕉️' },
}
const OBS_SCOPE = { worldwide: { label: 'Worldwide', icon: '🌍' }, india: { label: 'India', icon: '🇮🇳' } }

/* Every important day / festival on a date is shown in its cell — the grid grows
   taller on dense dates (e.g. 14 Nov) instead of hiding anything behind a
   "+N more" chip. Selected AI programmes get their own chip row beneath. */
const obsMeta = (kind) => OBS_META[kind] || OBS_META.observance

/* ── Event category (derived client-side for coloring) ── */
const CATEGORY_META = {
  'international-day': { label: 'International Day', color: '#0ea5e9', icon: '🌐' },
  'national-holiday': { label: 'National / Civic', color: '#f59e0b', icon: '🏛️' },
  'ngo-campaign': { label: 'NGO Campaign', color: '#16a34a', icon: '🤝' },
  'religious-observance': { label: 'Religious', color: '#8b5cf6', icon: '🕉️' },
  'awareness-day': { label: 'Awareness Day', color: '#ec4899', icon: '🔔' },
  'other': { label: 'Other', color: '#64748b', icon: '📌' },
}

const CATEGORY_KEYWORDS = [
  ['international-day', ['international', 'world', 'day of', 'day for', 'universal', "engineer's day", "grandparents' day", 'ozone', 'literacy', 'democracy', 'peace', 'translation', 'languages', 'tourism', 'bamboo', 'heart', 'rabies', 'rivers', 'first aid', 'physical therapy', 'patient safety', 'pharmacists', 'environmental health', 'contraception', 'access to information', 'red panda', 'sign languages', 'chocolate', 'charity', 'pirate']],
  ['national-holiday', ['independence', 'republic', 'national', 'teacher', 'diwas', 'antodaya', 'engineer', 'martyr', 'modi', 'google', 'digvijay']],
  ['ngo-campaign', ['campaign', 'drive', 'ngo', 'awareness drive']],
  ['religious-observance', ['puja', 'chaturdasi', 'janmashtami', 'diwali', 'holi', 'eid', 'navratri', 'vishwakarma', 'anant', 'religious', 'festival']],
  ['awareness-day', ['day', 'awareness', 'welfare']],
]

const deriveCategory = (name = '') => {
  const n = String(name).toLowerCase()
  if (!n) return 'other'
  // Religious keywords take priority over generic "Day" matches
  for (const w of CATEGORY_KEYWORDS[3][1]) if (n.includes(w)) return 'religious-observance'
  for (const w of CATEGORY_KEYWORDS[0][1]) if (n.includes(w)) return 'international-day'
  if (n.includes('campaign') || n.includes('drive')) return 'ngo-campaign'
  for (const w of CATEGORY_KEYWORDS[1][1]) if (n.includes(w)) return 'national-holiday'
  if (n.includes('day') || n.includes('awareness') || n.includes('welfare')) return 'awareness-day'
  return 'other'
}

const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// Strip the " · NGO" suffix the backend appends to titles so we can group by base name.
const baseTitle = (title, ngoName) => {
  const t = String(title || '')
  const n = String(ngoName || '').trim()
  if (n) {
    const re = new RegExp(`\\s*·\\s*${esc(n)}\\s*$`, 'i')
    return t.replace(re, '').trim()
  }
  return t
}
// Short NGO code: prefer the uppercased, whitespace-free code of the name.
const ngoCode = (name) => String(name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5) || 'NGO'
// Build the clickable NGO tag list for a grouped pill: [{ code, id }], deduped.
const groupNgoTags = (members) => {
  const out = []
  const seen = new Set()
  for (const m of members || []) {
    const p = m.extendedProps || {}
    const mid = p.ngoId
    const code = ngoCode(p.ngoName)
    const key = mid || code
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ code, id: mid })
  }
  return out
}

/* Group a list of calendar event objects by day + base title across NGOs. */
const groupCalendarEvents = (list) => {
  const map = new Map()
  for (const ev of list || []) {
    const p = ev.extendedProps || {}
    const date = p.date || (ev.startStr || '').slice(0, 10) || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const bt = baseTitle(ev.title, p.ngoName)
    const key = `${date}||${bt.toLowerCase()}`
    if (!map.has(key)) {
      map.set(key, { date, baseTitle: bt, category: deriveCategory(bt), raw: ev, members: [] })
    }
    map.get(key).members.push(ev)
  }
  return [...map.values()]
}

const FIELD = { border: '1px solid var(--eh-line)', borderRadius: 10, padding: '8px 10px', width: '100%', fontSize: 13, color: 'var(--eh-ink)', background: '#fff' }
const LABEL = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--eh-ink-soft)', marginBottom: 5 }

function ModalShell({ title, onClose, children, footer }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = '' }
  }, [onClose])
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }} style={{ padding: 20, zIndex: 1200 }}>
      <div className="modal" style={{ maxWidth: 720, width: '100%', borderRadius: 16, background: '#fff', color: 'var(--eh-ink)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(0,0,0,0.24)' }}>
        <div className="modal-head" style={{ padding: '16px 20px', borderBottom: '1px solid var(--eh-line)', background: '#fff', display: 'flex', alignItems: 'center' }}>
          <h3 style={{ flex: 1, fontSize: 16, fontWeight: 700, color: 'var(--eh-ink)' }}>{title}</h3>
          <button onClick={onClose} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', color: 'var(--eh-ink-soft)' }}>✕</button>
        </div>
        {/* minHeight:0 is required, not cosmetic. `.panel-event-head .modal` is
            overflow:hidden, so this div is the only thing that can scroll. A flex
            child defaults to min-height:auto and refuses to shrink below its
            content, which let the body grow past the max-height and get clipped —
            content below the fold was unreachable with no scrollbar. Capping the
            shrink is what makes overflow:auto actually take effect. */}
        <div className="eh-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', WebkitOverflowScrolling: 'touch', padding: '18px 20px', background: '#fff' }}>{children}</div>
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 20px', borderTop: '1px solid var(--eh-line)', background: '#fff' }}>{footer}</div>}
      </div>
    </div>
  )
}

/* ── Event form (create / edit) ──
   `preset` optionally pre-fills a create form from an AI programme suggestion
   (see DayPlanModal). It is merged underneath `initial`, so every existing
   caller — which passes no preset — behaves exactly as before. */
function EventFormModal({ mode, initial, defaultDate, preset, onClose, onSaved }) {
  const navigate = useNavigate()
  const [ngos, setNgos] = useState([])
  const [allSectors, setAllSectors] = useState([])
  const [allActivities, setAllActivities] = useState([])
  const [form, setForm] = useState(() => ({
    ...(preset || {}),
    name: preset?.name || initial?.name || '',
    ngo_id: preset?.ngo_id || initial?.ngo_id || initial?.extendedProps?.ngoId || '',
    sector_id: preset?.sector_id || initial?.sector_id || initial?.extendedProps?.sectorId || '',
    activities: preset?.activities || (initial?.extendedProps?.activities || []).map(a => String(a.id)),
    date: preset?.date || initial?.extendedProps?.date || initial?.startStr?.slice(0, 10) || defaultDate || '',
    start_time: preset?.start_time ?? (initial?.extendedProps?.startTime || (initial?.startStr ? initial.startStr.slice(11, 16) : '')),
    end_time: preset?.end_time ?? (initial?.extendedProps?.endTime || (initial?.endStr ? initial.endStr.slice(11, 16) : '')),
    venue: preset?.venue ?? (initial?.extendedProps?.venue || ''),
    description: preset?.description ?? (initial?.extendedProps?.description || ''),
    status: preset?.status || (initial?.extendedProps?.status) || 'Draft',
    priority: preset?.priority || (initial?.extendedProps?.priority) || 'Medium',
    category: preset?.category || initial?.category || '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      fetchWorkspaceNgos().catch(() => []),
      fetchSectors().catch(() => []),
      fetchActivities().catch(() => []),
    ]).then(([n, s, a]) => {
      setNgos(n || []); setAllSectors(s || []); setAllActivities(a || [])
      // A suggestion names an activity in free text. When that name already
      // exists under the chosen NGO + sector, preselect it so the coordinator
      // does not have to hunt for it. Never invents a new activity here.
      const wanted = String(preset?.activityName || '').trim().toLowerCase()
      if (!wanted) return
      const ngoId = String(preset?.ngo_id || initial?.ngo_id || initial?.extendedProps?.ngoId || '')
      const sectorId = String(preset?.sector_id || initial?.sector_id || initial?.extendedProps?.sectorId || '')
      const hit = (a || []).find(x =>
        String(x.name || '').trim().toLowerCase() === wanted &&
        (!sectorId || String(x.sector_id) === sectorId) &&
        (!ngoId || x.ngo_id == null || String(x.ngo_id) === ngoId))
      if (hit) {
        setForm(p => (p.activities.includes(String(hit.id)) ? p : { ...p, activities: [...p.activities, String(hit.id)] }))
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const ngoId = form.ngo_id ? String(form.ngo_id) : ''
  const sectorId = form.sector_id ? String(form.sector_id) : ''

  const sectorOptions = useMemo(() => {
    const ids = new Set()
    for (const a of allActivities) if (a.ngo_id == null || String(a.ngo_id) === ngoId) ids.add(String(a.sector_id))
    let list = allSectors.filter(s => ids.has(String(s.id)))
    if (!list.some(s => String(s.id) === sectorId) && form.sector_id) {
      const cur = allSectors.find(s => String(s.id) === sectorId); if (cur) list = [cur, ...list]
    }
    return list
  }, [allSectors, allActivities, ngoId, sectorId, form.sector_id])

  const activityOptions = useMemo(() => {
    let list = allActivities.filter(a => String(a.sector_id) === sectorId && (a.ngo_id == null || String(a.ngo_id) === ngoId))
    if (form.activities.length) {
      const extra = allActivities.filter(a => form.activities.includes(String(a.id)) && !list.some(x => String(x.id) === String(a.id)))
      list = [...extra, ...list]
    }
    return list
  }, [allActivities, ngoId, sectorId, form.activities])

  const toggleActivity = (id) => {
    setForm(p => {
      const set = new Set(p.activities)
      if (set.has(String(id))) set.delete(String(id)); else set.add(String(id))
      return { ...p, activities: [...set] }
    })
  }

  const change = (e) => {
    const { name, value } = e.target
    setForm(p => {
      const next = { ...p, [name]: value }
      if (name === 'ngo_id') { next.sector_id = ''; next.activities = [] }
      if (name === 'sector_id') next.activities = []
      return next
    })
  }

  const submit = async () => {
    setSaving(true); setError('')
    if (!form.name) { setError('Event name is required'); setSaving(false); return }
    if (!form.ngo_id) { setError('NGO is required'); setSaving(false); return }
    if (!form.sector_id) { setError('Sector is required'); setSaving(false); return }
    if (!form.activities.length) { setError('Select at least one activity'); setSaving(false); return }
    if (!form.date) { setError('Event date is required'); setSaving(false); return }
    if (form.start_time && form.end_time && form.end_time < form.start_time) { setError('End time must be after start time'); setSaving(false); return }

    const payload = {
      name: form.name,
      ngo_id: form.ngo_id,
      sector_id: Number(form.sector_id),
      activity_ids: form.activities.map(Number),
      date: form.date,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      venue: form.venue || null,
      description: form.description || null,
      status: form.status,
      priority: form.priority,
      category: form.category || null,
    }
    // Preserve extra fields when editing (budget, beneficiaries, etc.)
    if (initial) {
      for (const k of ['budget','expected_beneficiaries','gps_location','district','state','organizer','event_manager','coordinator','csr_partner','donor']) {
        if (initial[k] != null) payload[k] = initial[k]
      }
    }
    try {
      if (mode === 'edit' && initial) {
        await updateEvent(initial.id, payload)
      } else {
        await createEvent(payload)
      }
      onSaved && onSaved()
    } catch (err) { setError(err.message || 'Failed to save event'); console.error(err) }
    finally { setSaving(false) }
  }

  return (
    <ModalShell
      title={mode === 'edit' ? 'Edit Event' : 'Create Event'}
      onClose={onClose}
      footer={<>
        <button className="eh-btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="eh-btn eh-btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : (mode === 'edit' ? 'Save Changes' : 'Create Event')}</button>
      </>}
    >
      {error && <div style={{ marginBottom: 14, padding: '11px 14px', borderRadius: 10, background: 'var(--eh-danger-soft)', color: 'var(--eh-danger)', fontSize: 13, fontWeight: 500 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ gridColumn: '1 / -1' }}><label style={LABEL}>Event Name *</label><input style={FIELD} name="name" value={form.name} onChange={change} placeholder="e.g. Ganpati Celebration" /></div>
        <div><label style={LABEL}>NGO *</label>
          <Select value={form.ngo_id} onChange={(v) => change({ target: { name: 'ngo_id', value: v } })}>
            <option value="">Select NGO</option>
            {ngos.map(n => <option key={n.id} value={n.id}>{n.name || n.code}</option>)}
          </Select>
        </div>
        <div><label style={LABEL}>Sector *</label>
          <Select value={form.sector_id} onChange={(v) => change({ target: { name: 'sector_id', value: v } })} disabled={!ngoId}>
            <option value="">{ngoId ? 'Select sector' : 'Select NGO first'}</option>
            {sectorOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={LABEL}>Activities * (multi-select)</label>
        {!sectorId ? (
          <div style={{ fontSize: 12, color: 'var(--eh-ink-faint)' }}>Select a sector first to load its activities.</div>
        ) : activityOptions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--eh-warn)' }}>No activities under this NGO + sector yet. Add one from the Activities page first.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 8 }}>
            {activityOptions.map(a => {
              const on = form.activities.includes(String(a.id))
              return (
                <label key={a.id} onClick={() => toggleActivity(a.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 10, border: on ? '1px solid var(--eh-primary)' : '1px solid var(--eh-line)', background: on ? 'var(--eh-tint-1)' : '#fff', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={on} readOnly style={{ accentColor: 'var(--eh-primary)' }} />
                  <span>{a.name}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 14 }}>
        <div><label style={LABEL}>Date *</label><input type="date" style={FIELD} name="date" value={form.date} onChange={change} /></div>
        <div><label style={LABEL}>Start Time</label><input type="time" style={FIELD} name="start_time" value={form.start_time} onChange={change} /></div>
        <div><label style={LABEL}>End Time</label><input type="time" style={FIELD} name="end_time" value={form.end_time} onChange={change} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <div><label style={LABEL}>Status</label>
          <Select value={form.status} onChange={(v) => change({ target: { name: 'status', value: v } })}>
            {STATUS_PRIORITY.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
        <div><label style={LABEL}>Priority</label>
          <Select value={form.priority} onChange={(v) => change({ target: { name: 'priority', value: v } })}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </Select>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <label style={LABEL}>Category</label>
        <input
          style={FIELD}
          name="category"
          value={form.category}
          onChange={change}
          placeholder="e.g. Health, Education, Women Empowerment"
          list="eh-event-categories"
        />
        <datalist id="eh-event-categories">
          {CATEGORIES.map(c => <option key={c} value={c} />)}
        </datalist>
      </div>
      <div style={{ marginTop: 14 }}><label style={LABEL}>Location / Venue</label><input style={FIELD} name="venue" value={form.venue} onChange={change} placeholder="Venue / address" /></div>
      <div style={{ marginTop: 14 }}><label style={LABEL}>Description</label><textarea style={{ ...FIELD, minHeight: 72, resize: 'vertical' }} name="description" value={form.description} onChange={change} placeholder="Event description / notes" /></div>
    </ModalShell>
  )
}

/* ── Event detail / quick actions ── */
function EventInfoModal({ event, onClose, onEdit, onDelete }) {
  const navigate = useNavigate()
  const p = event?.extendedProps || {}
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr] = useState('')

  const doDelete = async () => {
    setDeleting(true); setErr('')
    try { await deleteEvent(event.id); onDelete && onDelete() }
    catch (e) { setErr(e.message || 'Failed to delete'); setDeleting(false) }
  }

  if (!event) return null
  const timeRange = `${fmtTime(p.startTime) || '—'}${p.endTime ? ' – ' + fmtTime(p.endTime) : ''}`
  return (
    <ModalShell
      title={event.title || 'Event'}
      onClose={onClose}
      footer={<>
        {err && <span style={{ fontSize: 12, color: 'var(--eh-danger)', marginRight: 'auto' }}>{err}</span>}
        {!confirmDel && <>
          <button className="eh-btn" style={{ color: 'var(--eh-danger)', borderColor: 'var(--eh-danger)' }} onClick={() => setConfirmDel(true)}>Delete</button>
          <button className="eh-btn" onClick={onEdit}>Edit Event</button>
          <button className="eh-btn eh-btn-primary" onClick={() => navigate('/event-head/events/' + event.id)}>View Event</button>
          <button className="eh-btn" onClick={() => navigate('/event-head/media-management?event=' + event.id)}>Manage Media / Banners</button>
        </>}
        {confirmDel && <>
          <span style={{ fontSize: 13, color: 'var(--eh-ink)', marginRight: 'auto' }}>Delete this event permanently?</span>
          <button className="eh-btn" onClick={() => setConfirmDel(false)} disabled={deleting}>Cancel</button>
          <button className="eh-btn eh-btn-primary" style={{ background: 'var(--eh-danger)', borderColor: 'var(--eh-danger)' }} onClick={doDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Confirm Delete'}</button>
        </>}
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {p.ngoName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,var(--eh-primary),var(--eh-secondary))', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{(p.ngoName||'')[0]}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--eh-ink)' }}>{p.ngoName}</div>
              {p.sectorName && <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)' }}>Sector: {p.sectorName}</div>}
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
          <div><div style={{ color: 'var(--eh-ink-faint)', fontSize: 11 }}>Date</div><b>{ymdToLabel(p.date)}</b></div>
          <div><div style={{ color: 'var(--eh-ink-faint)', fontSize: 11 }}>Time</div><b>{timeRange}</b></div>
        </div>
        {p.activities && p.activities.length > 0 && (
          <div>
            <div style={{ color: 'var(--eh-ink-faint)', fontSize: 11, marginBottom: 4 }}>Activities</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {p.activities.map(a => (
                <span key={a.id} style={{ padding: '4px 10px', borderRadius: 14, background: 'var(--eh-tint-1)', color: 'var(--eh-primary)', fontSize: 12, fontWeight: 600 }}>✓ {a.name}</span>
              ))}
            </div>
          </div>
        )}
        {(p.status || p.priority) && (
          <div style={{ display: 'flex', gap: 8 }}>
            {p.status && <span style={{ padding: '4px 10px', borderRadius: 12, background: 'var(--eh-tint-2)', fontSize: 12, fontWeight: 600, color: 'var(--eh-ink)' }}>{p.status}</span>}
            {p.priority && <span style={{ padding: '4px 10px', borderRadius: 12, background: 'var(--eh-tint-2)', fontSize: 12, fontWeight: 600, color: 'var(--eh-ink)' }}>Priority: {p.priority}</span>}
          </div>
        )}
        {p.venue && <div style={{ fontSize: 13 }}><span style={{ color: 'var(--eh-ink-faint)' }}>Location: </span>{p.venue}</div>}
        {p.description && <div style={{ fontSize: 13, lineHeight: 1.55, background: 'var(--eh-tint-1)', padding: '12px 14px', borderRadius: 12 }}>{p.description}</div>}
      </div>
    </ModalShell>
  )
}

/* ── Important day / festival → suggested programmes → create ──────────────
   The date and occasion shown here come from the backend reference calendar and
   are never AI-generated. Gemini is asked only which programmes would suit the
   day, and each idea can be pushed straight into the normal Event Head create
   flow with its date pre-filled. */
function DayPlanModal({ date, observances, scope, context, onClose, onUseSuggestion }) {
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState('')
  const askedRef = useRef(false)

  const run = async () => {
    setLoading(true); setError('')
    try {
      const d = await suggestDayPrograms({ date, scope, observances, ...context })
      setSuggestions(Array.isArray(d?.suggestions) ? d.suggestions : [])
      setMeta(d?.ai || null)
    } catch (err) {
      setError(err.message || 'Could not load suggestions')
      setMeta({ available: false })
    } finally {
      setLoading(false)
    }
  }

  // Ask once as soon as a day with an occasion is opened.
  useEffect(() => {
    if (askedRef.current) return
    askedRef.current = true
    run() // eslint-disable-line react-hooks/exhaustive-deps
  }, [])

  const unavailable = meta && meta.available === false

  return (
    <ModalShell
      title={`${ymdToLabel(date)} — plan a programme`}
      onClose={onClose}
      footer={<>
        <button className="eh-btn" onClick={onClose}>Close</button>
        <button className="eh-btn" onClick={run} disabled={loading}>{loading ? 'Thinking…' : '↻ Regenerate'}</button>
      </>}
    >
      {/* 1. The reliable part: what the calendar says about this day. */}
      <div style={{ fontSize: 12, color: 'var(--eh-ink-faint)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 700, color: 'var(--eh-success)' }}>✓ Verified dates</span>
        <span>· from the reference calendar, not AI</span>
      </div>

      {observances.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {observances.map((o) => {
            const m = obsMeta(o.kind)
            const sc = OBS_SCOPE[o.scope] || OBS_SCOPE.worldwide
            return (
              <div key={o.name} style={{ border: '1px solid var(--eh-line)', borderLeft: `3px solid ${m.color}`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13 }}>{m.icon}</span>
                  <b style={{ fontSize: 13.5, color: 'var(--eh-ink)' }}>{o.name}</b>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999, background: `${m.color}22`, color: m.color }}>{m.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>{sc.icon} {sc.label}</span>
                  {o.precision === 'lunar' && (
                    <span title="Lunar-calendar festival — confirm against the official gazette before finalising" style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--eh-warn-soft, #fef3c7)', color: 'var(--eh-warn, #b45309)', cursor: 'help' }}>lunar — confirm date</span>
                  )}
                </div>
                {o.note && <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)', marginTop: 4, lineHeight: 1.5 }}>{o.note}</div>}
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--eh-ink-soft)', marginBottom: 16, padding: '10px 12px', borderRadius: 10, background: 'var(--eh-tint-1)' }}>
          No registered important day, festival or observance for {ymdToLabel(date)}. Suggestions below are general community-programme ideas.
        </div>
      )}

      {/* 2. The AI part — clearly labelled as ideas only. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingTop: 12, borderTop: '1px solid var(--eh-line)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--eh-ink-soft)' }}>✦ Suggested programmes</span>
        <span style={{ fontSize: 11, color: 'var(--eh-ink-faint)' }}>AI ideas — you pick what to add</span>
        {meta?.model && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--eh-ink-faint)' }}>{meta.model}</span>}
      </div>

      {loading && <div style={{ fontSize: 13, color: 'var(--eh-ink-soft)', padding: '10px 0' }}>Generating programme ideas…</div>}

      {!loading && error && (
        <div style={{ fontSize: 13, color: 'var(--eh-danger)', background: 'var(--eh-danger-soft)', padding: '10px 12px', borderRadius: 10, marginBottom: 12 }}>{error}</div>
      )}

      {!loading && unavailable && !error && (
        <div style={{ fontSize: 13, color: 'var(--eh-ink-soft)', background: 'var(--eh-tint-1)', padding: '12px 14px', borderRadius: 10, marginBottom: 12, lineHeight: 1.55 }}>
          <b style={{ color: 'var(--eh-ink)' }}>AI suggestions are unavailable.</b>
          <div style={{ fontSize: 12, marginTop: 4 }}>{String(meta.reason || 'The Gemini API is not reachable.')}</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>The dates above are unaffected — you can still create an event for this day below.</div>
        </div>
      )}

      {!loading && !suggestions.length && !unavailable && !error && (
        <div style={{ fontSize: 13, color: 'var(--eh-ink-soft)', marginBottom: 12 }}>No suggestions returned for this day.</div>
      )}

      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          {suggestions.map((s, i) => (
            <div key={i} style={{ border: '1px solid var(--eh-line)', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--eh-ink)' }}>{s.title}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                    {s.format && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--eh-tint-1)', color: 'var(--eh-primary)' }}>{s.format}</span>}
                    {s.priority && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>{s.priority}</span>}
                    {s.duration && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>{s.duration}</span>}
                  </div>
                </div>
              </div>
              {s.audience && <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)', marginTop: 7 }}><b>For:</b> {s.audience}</div>}
              {s.activityName && <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)', marginTop: 3 }}><b>Activity:</b> {s.activityName}</div>}
              {s.rationale && <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)', marginTop: 6, lineHeight: 1.55 }}>{s.rationale}</div>}
              {Array.isArray(s.materials) && s.materials.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)', marginTop: 6 }}>
                  <b>Materials:</b> {s.materials.join(', ')}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                <button className="eh-btn eh-btn-sm" onClick={onClose}>Dismiss</button>
                <button className="eh-btn eh-btn-sm eh-btn-primary" onClick={() => onUseSuggestion(s)}>
                  + Add to Calendar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button className="eh-btn" style={{ width: '100%' }} onClick={() => onUseSuggestion(null)}>
        {observances.length ? '+ Create an event for this day' : '+ Create an event'}
      </button>
    </ModalShell>
  )
}

export default function MonthlyPlanner() {
  const [searchParams] = useSearchParams()
  const calRef = useRef(null)
  /* @fullcalendar/react's ref is the React wrapper, not the calendar: gotoDate and
     the rest of CalendarApi live one level down behind getApi(). Calling
     calRef.current.gotoDate() directly is a TypeError, so every jump goes through
     here - and through the optional call, because the ref is still null on the
     first render and null again after unmount. */
  const calendarApi = () => calRef.current?.getApi?.() || null
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadKey, setLoadKey] = useState(0)

  const initialDate = searchParams.get('date') || (searchParams.get('month') ? `${searchParams.get('month')}-01` : undefined)
  const initialDateRef = useRef(initialDate)
  const [range, setRange] = useState(null)
  /* Filters */
  const [search, setSearch] = useState('')
  const [filterNgo, setFilterNgo] = useState('')
  const [filterSector, setFilterSector] = useState('')
  const [filterActivity, setFilterActivity] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterYear, setFilterYear] = useState('')

  const [ngos, setNgos] = useState([])
  const [sectors, setSectors] = useState([])
  const [activities, setActivities] = useState([])

  /* Important days / festivals / observances */
  const [scope, setScope] = useState('all')            // 'all' | 'worldwide' | 'india'
  const [showObs, setShowObs] = useState(true)         // day-cell layer on/off
  const [obs, setObs] = useState({ byDate: {}, list: [], available_years: [], lunar_years: [], reliability: null, source: 'server' })
  const [obsLoading, setObsLoading] = useState(false)
  const [obsError, setObsError] = useState('')
  const [dayPanel, setDayPanel] = useState(null)       // { date }

  /* Selected Monthly Planner AI programmes. These are the SAME rows the
     Monthly Planner reads and ticks via /planner/festival-suggestions — this
     page only subscribes to them, it never keeps a second selection store.
     Scoped to the month in view and the active NGO filter: changing either
     re-reads exactly what the planner stored for that scope, so a month with no
     selections shows none (stale ticks from another month never linger). */
  const [festivalSel, setFestivalSel] = useState([])
  const [festivalSelLoading, setFestivalSelLoading] = useState(false)

  /* Month / year navigation mirror of the FullCalendar view */
  const [cursor, setCursor] = useState(() => {
    const d = initialDateRef.current ? new Date(`${initialDateRef.current}T00:00:00`) : new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const gotoMonth = (y, m) => {
    const safeY = Number(y); const safeM = Number(m)
    if (!Number.isFinite(safeY) || !Number.isFinite(safeM)) return
    calendarApi()?.gotoDate(new Date(safeY, safeM, 1))
  }
  const navMonth = (delta) => {
    const d = new Date(cursor.y, cursor.m + delta, 1)
    gotoMonth(d.getFullYear(), d.getMonth())
  }
  const goToday = () => { const n = new Date(); gotoMonth(n.getFullYear(), n.getMonth()) }

  /* React Router reuses this component when only the query string changes, so the
     date read on first mount goes stale. Without this, "View in Calendar" after
     planning a programme leaves the calendar on the month it was already showing
     and never refetches, so the programme the user just created looks missing.
     Both the view and the fetch are corrected here. */
  useEffect(() => {
    const d = searchParams.get('date') || (searchParams.get('month') ? `${searchParams.get('month')}-01` : '')
    if (!d) return
    const target = new Date(`${d}T00:00:00`)
    if (Number.isNaN(target.getTime())) return
    calendarApi()?.gotoDate(target)
    setCursor({ y: target.getFullYear(), m: target.getMonth() })
    setLoadKey((k) => k + 1)
  }, [searchParams])

  // Year options: whatever the reference calendar covers, widened around the
  // year currently in view so it never drifts out of date.
  const yearOptions = useMemo(() => {
    const set = new Set(obs.available_years || [])
    for (let y = cursor.y - 4; y <= cursor.y + 4; y++) set.add(y)
    return [...set].filter(y => y >= 1990 && y <= 2100).sort((a, b) => a - b)
  }, [obs.available_years, cursor.y])

  /* Modals */
  const [createOpen, setCreateOpen] = useState(false)
  const [createDate, setCreateDate] = useState(null)
  const [selected, setSelected] = useState(null)
  const [editOpen, setEditOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [groupSel, setGroupSel] = useState(null)
  const [preset, setPreset] = useState(null)           // prefill for EventFormModal
  const [calDownloading, setCalDownloading] = useState(false)

  /* Load options (NGO → Sector → Activity cascade) */
  useEffect(() => {
    fetchWorkspaceNgos().catch(() => []).then(n => setNgos(n || []))
  }, [])
  useEffect(() => {
    if (!filterNgo) { setSectors([]); setActivities([]); return }
    fetchSectors({ ngo_id: filterNgo }).catch(() => []).then(s => setSectors(s || []))
    if (!filterSector) setActivities([])
  }, [filterNgo])
  useEffect(() => {
    if (!filterNgo || !filterSector) { setActivities([]); return }
    fetchActivities({ ngo_id: filterNgo, sector_id: filterSector }).catch(() => []).then(a => setActivities(a || []))
  }, [filterNgo, filterSector])

  /* Fetch visible-range events when range/filters change */
  const loadEvents = () => {
    if (!range) return
    setLoading(true)
    fetchCalendarEvents({
      start: range.startStr, end: range.endStr,
      ngoId: filterNgo || undefined, sectorId: filterSector || undefined,
      activityId: filterActivity || undefined, status: filterStatus || undefined,
      year: filterYear || undefined,
    }).then(d => setEvents(Array.isArray(d) ? d : []))
      .catch(err => { console.error('cal fetch', err); setEvents([]) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadEvents() /* eslint-disable-line */ }, [range, filterNgo, filterSector, filterActivity, filterStatus, filterYear, loadKey])

  /* ── Important days / festivals / observances for the visible range ──
     Fetched from GET /api/important-days, which merges the curated reference
     calendar, the fixed international days, operator holidays and Calendarific
     (India festivals + worldwide/UN days) server-side. No AI produces any of
     these dates. */

  const loadObservances = () => {
    if (!range) return
    setObsLoading(true); setObsError('')
    fetchImportantDays({
      year: cursor.y,
      month: cursor.m + 1,
      start: range.startStr,
      end: range.endStr,
      scope,
    })
      .then(d => {
        setObs({
          byDate: d?.by_date || {},
          list: Array.isArray(d?.observances) ? d.observances : [],
          available_years: Array.isArray(d?.available_years) ? d.available_years : [],
          lunar_years: Array.isArray(d?.lunar_years) ? d.lunar_years : [],
          reliability: d?.reliability || null,
          source: d?.source || 'server',
        })
        // A failed /api/important-days call returns ok:false with a bundled
        // fallback list, so the grid stays populated AND the error is shown.
        setObsError(d?.ok === false ? (d.error || 'Could not load the Important Days calendar') : '')
      })
      .catch(err => {
        console.error('observances fetch', err)
        setObsError(err.message || 'Could not load the observance calendar')
        setObs({ byDate: {}, list: [], available_years: [], lunar_years: [], reliability: null, source: 'server' })
      })
      .finally(() => setObsLoading(false))
  }
  useEffect(() => { loadObservances() /* eslint-disable-line */ }, [range, scope])

  /* Selected festival programmes for the visible month. Abort-guarded so a fast
     month/NGO hop cannot let an older response overwrite a newer view. */
  useEffect(() => {
    let live = true
    setFestivalSelLoading(true)
    getFestivalSuggestions({ month: cursor.m + 1, year: cursor.y, ngo_id: filterNgo || undefined })
      .then((l) => { if (live) setFestivalSel(Array.isArray(l) ? l : []) })
      .catch(() => { if (live) setFestivalSel([]) })
      .finally(() => { if (live) setFestivalSelLoading(false) })
    return () => { live = false }
  }, [cursor.y, cursor.m, filterNgo])

  // Observances falling inside the month currently in view (for the side list).
  const monthObservances = useMemo(() => {
    const y = cursor.y; const m0 = cursor.m
    return obs.list.filter(o => {
      const d = o.date.split('-')
      return Number(d[0]) === y && Number(d[1]) - 1 === m0
    })
  }, [obs.list, cursor.y, cursor.m])

  const obsFor = (ymdStr) => (showObs && obs.byDate[ymdStr]) || []

  /* ── Day plan (observance → AI suggestions → create) ── */
  const openDayPlan = async (ymdStr) => {
    const day = String(ymdStr || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
    setDayPanel({ date: day, loading: true })
    // Ground the model in the org's own vocabulary. Failures just yield fewer
    // context hints — never block the panel.
    const [allSectorsList, allActivitiesList] = await Promise.all([
      filterNgo ? Promise.resolve([]) : fetchSectors().catch(() => []),
      filterNgo ? fetchActivities({ ngo_id: filterNgo }).catch(() => []) : Promise.resolve([]),
    ])
    const sectorNames = (filterNgo ? sectors : allSectorsList).map(s => s?.name).filter(Boolean)
    const activityNames = (filterNgo ? activities : allActivitiesList).map(a => a?.name).filter(Boolean)
    setDayPanel({
      date: day,
      loading: false,
      context: {
        ngoName: ngos.find(n => String(n.id) === String(filterNgo))?.name || null,
        sectorName: sectors.find(s => String(s.id) === String(filterSector))?.name || null,
        sectors: sectorNames.slice(0, 15),
        activities: activityNames.slice(0, 30),
        existingTitles: events
          .map(e => baseTitle(e.title, e.extendedProps?.ngoName))
          .filter(Boolean)
          .slice(0, 40),
      },
    })
  }

  // Push a suggestion (or a bare "create on this day") into the normal
  // Event Head create flow, with the verified date already filled in.
  const useSuggestion = (day, suggestion) => {
    const ngoId = filterNgo || ''
    const sectorId = filterSector || ''
    const obsOnDay = Array.isArray(day?.observances) ? day.observances : []
    setDayPanel(null)
    setPreset({
      name: suggestion?.title || (obsOnDay[0]?.name ? `${obsOnDay[0].name} — Programme` : ''),
      ngo_id: ngoId,
      sector_id: sectorId,
      activities: [],
      date: day.date,
      start_time: '', end_time: '',
      status: 'Draft',
      priority: suggestion?.priority || 'Medium',
      category: suggestion?.format || '',
      description: suggestion
        ? [
            `Planned for ${ymdToLabel(day.date)}.`,
            obsOnDay.length ? `Occasion: ${obsOnDay.map(o => o.name).join(', ')}.` : '',
            suggestion.audience ? `Target group: ${suggestion.audience}.` : '',
            suggestion.duration ? `Duration: ${suggestion.duration}.` : '',
            suggestion.rationale || '',
            Array.isArray(suggestion.materials) && suggestion.materials.length ? `Materials: ${suggestion.materials.join(', ')}.` : '',
          ].filter(Boolean).join('\n')
        : obsOnDay.length ? `Planned for ${obsOnDay.map(o => o.name).join(', ')}.` : '',
      activityName: suggestion?.activityName || '',
    })
    setCreateDate(day.date)
    setCreateOpen(true)
  }

  /* ── Auto-jump the calendar to a month that actually has events ── */
  const didJumpRef = useRef(false)
  useEffect(() => {
    if (didJumpRef.current) return
    didJumpRef.current = true
    if (!calendarApi() || initialDate) return
    const yNow = new Date().getFullYear()
    fetchCalendarEvents({
      start: `${yNow - 1}-01-01`, end: `${yNow + 1}-01-01`,
      ngoId: filterNgo || undefined,
    })
      .then(d => {
        const list = Array.isArray(d) ? d : []
        // Current visible month (from range) already has events → nothing to do.
        if (range && events.length && events.filter(e => {
          const day = (e.extendedProps?.date || '').slice(0, 10)
          return day >= String(range.start).slice(0, 10) && day < String(range.end).slice(0, 10)
        }).length > 0) return
        const dated = list.filter(e => (e.extendedProps?.date || '').slice(0, 10) >= new Date().toISOString().slice(0, 10))
          .sort((a, b) => String(a.extendedProps?.date || '').localeCompare(String(b.extendedProps?.date || '')))
        const target = dated[0] || list[0]
        calendarApi()?.gotoDate(String(target.extendedProps?.date || target.startStr || '').slice(0, 10))
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const clearFilters = () => { setSearch(''); setFilterNgo(''); setFilterSector(''); setFilterActivity(''); setFilterStatus(''); setFilterYear('') }
  const hasFilters = search || filterNgo || filterSector || filterActivity || filterStatus || filterYear

  const changeNgo = (v) => { setFilterNgo(v); setFilterSector(''); setFilterActivity('') }
  const changeSector = (v) => { setFilterSector(v); setFilterActivity('') }

  /* Clicking an NGO tag on a calendar pill filters the calendar to that NGO;
     clicking an observance chip opens that day's programme planner. */
  const handleCalendarClick = (e) => {
    const chip = e.target.closest('.eh-obs-chip')
    if (chip) {
      e.stopPropagation()
      const date = chip.getAttribute('data-obs-date')
      if (date) { openDayPlan(date); return }
    }
    const t = e.target.closest('.eh-tag')
    if (!t) return
    const id = t.getAttribute('data-ngo-id')
    if (!id) return
    changeNgo(filterNgo === id ? '' : id)
  }

  /* Keep the month/year navigator in sync with whatever FullCalendar shows. */
  const handleDatesSet = (info) => {
    setRange(info)
    if (info?.view?.currentStart) {
      const d = new Date(info.view.currentStart)
      // In timeGridWeek the week can start in the previous month — follow the
      // range's midpoint month instead of the grid's first cell.
      const mid = new Date((new Date(info.start).getTime() + new Date(info.end).getTime()) / 2)
      const use = Number.isNaN(mid.getTime()) ? d : mid
      setCursor(prev => (prev.y === use.getFullYear() && prev.m === use.getMonth() ? prev : { y: use.getFullYear(), m: use.getMonth() }))
    }
  }

  const refresh = () => setLoadKey(k => k + 1)
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 2600) }

  const scopePlain = { all: 'Worldwide + India', worldwide: 'Worldwide only', india: 'India only' }[scope]

  /* ── Calendar download (full selected month) ──
     Every date of the month appears, in order. Rows are date → festival → the
     AI programmes selected for that festival in the Monthly Planner (read fresh
     from the SAME stored set, so the file and the planner ticks can never
     disagree). A festival with no selected programme still lists itself once;
     a date with neither festival nor programme still appears. */
  const buildCalendarRows = async () => {
    const y = cursor.y
    const m = cursor.m
    const monthDates = new Set()
    const days = []
    const total = new Date(y, m + 1, 0).getDate()
    for (let i = 1; i <= total; i++) {
      const date = `${y}-${pad2(m + 1)}-${pad2(i)}`
      monthDates.add(date)
      days.push({ date, day: new Date(y, m, i).toLocaleDateString('en-US', { weekday: 'long' }) })
    }

    const obsByDate = new Map()
    for (const o of monthObservances) {
      const d = String(o.date || '').slice(0, 10)
      if (!monthDates.has(d)) continue
      if (!obsByDate.has(d)) obsByDate.set(d, [])
      obsByDate.get(d).push(o)
    }

    const sel = await getFestivalSuggestions({ month: m + 1, year: y, ngo_id: filterNgo || undefined, selected_only: true }).catch(() => [])
    const progsByDate = new Map()
    for (const s of Array.isArray(sel) ? sel : []) {
      const d = String(s.observance_date || '').slice(0, 10)
      if (!monthDates.has(d)) continue
      if (!progsByDate.has(d)) progsByDate.set(d, [])
      progsByDate.get(d).push(s)
    }

    const ngoNameOf = new Map(ngos.map((n) => [String(n.id), String(n.code || '').trim() || String(n.name || '').trim() || 'NGO']))
    const rows = []
    for (const { date, day } of days) {
      const obsOn = obsByDate.get(date) || []
      const progs = progsByDate.get(date) || []
      if (!obsOn.length && !progs.length) {
        rows.push({ date, day, festival: '—', ngo: '—', beneficiary: '—', location: '—', activity: '—', programme: '—' })
        continue
      }
      for (const o of obsOn) {
        const p = progs.filter((s) => String(s.festival || '').trim().toLowerCase() === String(o.name || '').trim().toLowerCase())
        if (!p.length) {
          rows.push({ date, day, festival: o.name, ngo: '—', beneficiary: '—', location: '—', activity: '—', programme: '—' })
        } else {
          for (const s of p) {
            rows.push({ date, day, festival: o.name, ngo: ngoNameOf.get(String(s.ngo_id)) || '—', beneficiary: s.beneficiary || '—', location: s.location || '—', activity: s.activity_name || '—', programme: s.title || '—' })
          }
        }
      }
      /* A selected programme whose stored festival string does not exactly match
         the observable name still gets its own row, festival label intact. */
      const matched = new Set(obsOn.map((o) => String(o.name || '').trim().toLowerCase()))
      for (const s of progs) {
        if (matched.has(String(s.festival || '').trim().toLowerCase())) continue
        rows.push({ date, day, festival: s.festival || '—', ngo: ngoNameOf.get(String(s.ngo_id)) || '—', beneficiary: s.beneficiary || '—', location: s.location || '—', activity: s.activity_name || '—', programme: s.title || '—' })
      }
    }
    /* Rule 8: final dedupe before the PDF is built. Unique key date + festival +
       NGO + beneficiary — multiple selected programmes for the same festival
       collapse into ONE row with the programme (and activity) titles
       comma-joined instead of one duplicate date/festival row per programme.
       Different festivals sharing a date stay separate. blankRepeatedDates then
       shows each date once: the date/day cells fill only on the first row of
       that date, so 2026-12-05 never repeats across its festival rows. */
    return {
      rows: blankRepeatedDates(mergeProgrammeRows(rows, ['date', 'festival', 'ngo', 'beneficiary', 'location']), 'date', 'day'),
      total,
    }
  }

  /* Proper styled PDF: A4 landscape, title/meta band, banded bordered table with
     wrapped text, repeated header row on each page, and a build stamp. */
  const downloadCalendar = async () => {
    if (calDownloading) return
    setCalDownloading(true)
    try {
      const { rows, total } = await buildCalendarRows()
      const { default: jsPDF } = await import('jspdf')
      const y = cursor.y
      const m = cursor.m
      const ngoSel = filterNgo ? ngos.find((n) => String(n.id) === String(filterNgo)) : null
      const pdfCode = String(ngoSel?.code || ngoSel?.name || 'all-ngos').replace(/[^A-Za-z0-9_-]/g, '')

      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      const PAD = 16
      const PAGE_H = 210
      const headers = ['Date', 'Day', 'Festival / Important Day', 'NGO', 'Beneficiary', 'Activity', 'Selected AI Programme', 'Location']
      const widths = [28, 22, 58, 22, 28, 32, 54, 24]
      const tableW = widths.reduce((a, b) => a + b, 0)
      const colX = []
      let acc = PAD
      for (const w of widths) { colX.push(acc); acc += w }

      let ypos = PAD
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(20, 24, 40)
      doc.text(`Monthly Calendar — ${ngoSel?.code || ngoSel?.name || 'All NGOs'} · ${MONTHS[m]} ${y}`, PAD, ypos)
      ypos += 6
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 104, 124)
      doc.text(`${scopePlain} · every date in the month (${total}) · selected AI programmes from the Monthly Planner`, PAD, ypos)
      ypos += 4

      const drawHeader = () => {
        doc.setFillColor(232, 236, 246)
        doc.rect(PAD, ypos, tableW, 8, 'F')
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(20, 24, 40)
        headers.forEach((h, i) => doc.text(h, colX[i] + 2, ypos + 5.5))
        doc.setDrawColor(213, 217, 228); doc.setLineWidth(0.2)
        doc.rect(PAD, ypos, tableW, 8)
        ypos += 8
      }
      drawHeader()

      const lineH = 3.6
      let rowCount = 0
      for (const r of rows) {
        const cells = [r.date, r.day, r.festival, r.ngo, r.beneficiary, r.activity, r.programme, r.location]
        const wrapped = cells.map((c, i) => doc.splitTextToSize(String(c || ''), widths[i] - 4))
        const rowH = Math.max(5.4, Math.max(...wrapped.map((w) => w.length)) * lineH + 2.2)
        if (ypos + rowH > PAGE_H - 12) {
          doc.addPage(); ypos = PAD; drawHeader()
        }
        if (rowCount % 2 === 0) { doc.setFillColor(247, 249, 252); doc.rect(PAD, ypos, tableW, rowH, 'F') }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(55, 60, 78)
        wrapped.forEach((lines, i) => {
          let yy = ypos + 4.4
          for (const ln of lines) { doc.text(ln, colX[i] + 2, yy); yy += lineH }
        })
        doc.setDrawColor(213, 217, 228); doc.setLineWidth(0.1); doc.rect(PAD, ypos, tableW, rowH)
        ypos += rowH
        rowCount++
      }

      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 134, 152)
      doc.text(`Generated ${new Date().toLocaleString('en-IN')} · festival dates come from the reference calendar (never AI) · programmes are the AI suggestions selected in the Monthly Planner.`, PAD, PAGE_H - 8)
      doc.save(`calendar-${pdfCode}-${MONTHS[m]}-${y}.pdf`)
    } catch (e) {
      console.error('downloadCalendar error:', e)
      showToast('Could not build the calendar PDF.')
    } finally {
      setCalDownloading(false)
    }
  }

  /* Filters applied post-fetch (search + delegated UI) */
  const filteredEvents = useMemo(() => {
    if (!search) return events
    const q = search.toLowerCase()
    return events.filter(ev => {
      const p = ev.extendedProps || {}
      const hay = [ev.title, p.ngoName, p.sectorName, p.status, p.priority, (p.activities || []).map(a => a.name).join(' '), p.venue]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [events, search])

  /* Group same-titled events across NGOs into one pill per day */
  const groupedEvents = useMemo(() => {
    return groupCalendarEvents(filteredEvents).map((g) => {
      const p = g.raw.extendedProps || {}
      const day = String(p.date || g.date || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
      const stRaw = String(p.startTime || '').slice(0, 5)
      const etRaw = String(p.endTime || '').slice(0, 5)
      const hasTime = Boolean(stRaw || etRaw)
      const cat = CATEGORY_META[g.category] || CATEGORY_META.other
      const obj = {
        id: g.raw.id,
        title: g.baseTitle,
        allDay: !hasTime,
        editable: g.members.length === 1,
        extendedProps: {
          ...p,
          category: g.category,
          categoryColor: cat.color,
          categoryIcon: cat.icon,
          ngos: groupNgoTags(g.members),
          members: g.members,
        },
      }
      if (hasTime) {
        const st = stRaw || '00:00'
        obj.start = `${day}T${st}`
        if (etRaw && etRaw > st) obj.end = `${day}T${etRaw}`
      } else {
        obj.start = day
      }
      return obj
    }).filter(Boolean)
  }, [filteredEvents])

  /* Selected Monthly Planner AI programmes, rendered as read-only calendar
     chips. `start` is the suggestion's observance_date, so a programme can
     never drift onto another date: the chips are non-editable (no drag/drop)
     and their date is never rewritten. Each chip shows the programme plus its
     NGO · beneficiary tag; the festival it belongs to rides on the tooltip so
     the box never loses the pairing shown in the planner grid. */
  const ngoShortLabel = useMemo(() => {
    const m = new Map(ngos.map((n) => [String(n.id), String(n.code || '').trim() || String(n.name || '').trim() || 'NGO']))
    return (id) => m.get(String(id)) || 'NGO'
  }, [ngos])

  const festivalProgEvents = useMemo(() => {
    return festivalSel
      .filter((s) => Boolean(s?.is_selected) && /^\d{4}-\d{2}-\d{2}$/.test(String(s.observance_date || '')))
      .map((s) => ({
        id: `fps-${s.id}`,
        title: s.title || 'Programme',
        start: String(s.observance_date),
        allDay: true,
        editable: false,
        classNames: ['eh-fprog'],
        extendedProps: {
          fp: true,
          suggestionId: s.id,
          festival: s.festival || '',
          beneficiary: s.beneficiary || '',
          activity: s.activity_name || '',
          sector: s.sector_name || '',
          ngoId: s.ngo_id ?? null,
          ngoLabel: ngoShortLabel(s.ngo_id),
        },
      }))
  }, [festivalSel, ngoShortLabel])

  const applyFilterToCal = () => {} // eslint-disable-line

  const handleEventClick = (info) => {
    /* AI programme chips are read-only: they only report what the Monthly
       Planner stored. Clicking one must not open the event editor or move it. */
    if (info.event.extendedProps?.fp) return
    const members = info.event.extendedProps?.members
    if (Array.isArray(members) && members.length > 1) {
      setGroupSel({ title: baseTitle(info.event.title, info.event.extendedProps?.ngoName), date: (info.event.extendedProps?.date || info.event.startStr || '').slice(0, 10), members })
      return
    }
    setSelected(info.event)
  }

  const handleEventDrop = async (info) => {
    const ev = info.event
    if (ev.extendedProps?.fp) { info.revert(); return }
    const members = ev.extendedProps?.members
    if (Array.isArray(members) && members.length > 1) {
      info.revert()
      showToast('This is a grouped event across NGOs — open it and edit each NGO separately.')
      return
    }
    const newDate = info.allDay ? toYmd(info.start) : ev.startStr.slice(0, 10)
    const label = ymdToLabel(newDate)
    const ok = window.confirm(`Move this event to ${label}?`)
    if (!ok) { info.revert(); return }
    try {
      const payload = { date: newDate }
      if (!info.allDay && ev.extendedProps) {
        payload.start_time = ev.extendedProps.startTime || null
        payload.end_time = ev.extendedProps.endTime || null
      }
      await updateEvent(ev.id, payload)
      refresh()
      showToast('Event moved successfully.')
    } catch (err) {
      info.revert()
      showToast('Could not move event: ' + (err.message || 'error'))
    }
  }

  const handleEventResize = async (info) => {
    const ev = info.event
    const members = ev.extendedProps?.members
    if (Array.isArray(members) && members.length > 1) {
      info.revert()
      showToast('This is a grouped event across NGOs — open it and edit each NGO separately.')
      return
    }
    const startTime = ev.startStr ? ev.startStr.slice(11, 16) : null
    const endTime = ev.endStr ? ev.endStr.slice(11, 16) : null
    try {
      await updateEvent(ev.id, { start_time: startTime || null, end_time: endTime || null, date: toYmd(ev.start) })
      refresh()
      showToast('Event updated successfully.')
    } catch (err) {
      info.revert()
      showToast('Could not update event: ' + (err.message || 'error'))
    }
  }

  const scopeLabel = { all: '🌍 Worldwide + India', worldwide: '🌍 Worldwide only', india: '🇮🇳 India only' }[scope]

  const ScopeBar = (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="card-pad eh-planner-bar" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={LABEL}>Important Days Calendar</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', background: 'var(--eh-tint-1)', padding: 3, borderRadius: 10 }}>
            {['all', 'worldwide', 'india'].map(s => (
              <button
                key={s}
                onClick={() => setScope(s)}
                style={{
                  border: 'none', cursor: 'pointer', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700,
                  background: scope === s ? 'var(--eh-primary)' : 'transparent',
                  color: scope === s ? '#fff' : 'var(--eh-ink-soft)',
                  boxShadow: scope === s ? '0 1px 3px rgba(0,0,0,.14)' : 'none',
                }}
              >{scopeLabel === null ? s : ({ all: '🌍 Worldwide + India', worldwide: '🌍 Worldwide only', india: '🇮🇳 India only' })[s]}</button>
            ))}
          </div>
        </div>

        <div style={{ width: 150 }}><label style={LABEL}>Month</label>
          <Select value={String(cursor.m)} onChange={(v) => gotoMonth(cursor.y, v)}>
            {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </Select>
        </div>
        <div style={{ width: 105 }}><label style={LABEL}>Year</label>
          <Select value={String(cursor.y)} onChange={(v) => gotoMonth(v, cursor.m)}>
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="eh-btn eh-btn-sm" onClick={() => navMonth(-1)} title="Previous month">‹</button>
          <button className="eh-btn eh-btn-sm" onClick={goToday} title="Jump to today">Today</button>
          <button className="eh-btn eh-btn-sm" onClick={() => navMonth(1)} title="Next month">›</button>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {festivalSelLoading ? (
            <span style={{ fontSize: 11.5, color: 'var(--eh-ink-faint)' }}>Loading programmes…</span>
          ) : festivalSel.some((s) => Boolean(s.is_selected)) ? (
            <span style={{ fontSize: 11.5, color: 'var(--eh-ink-faint)' }}>
              {festivalSel.filter((s) => Boolean(s.is_selected)).length} program{festivalSel.filter((s) => Boolean(s.is_selected)).length === 1 ? '' : 's'} selected in Monthly Planner
            </span>
          ) : null}
          <button className="eh-btn eh-btn-sm eh-btn-primary" onClick={downloadCalendar} disabled={calDownloading} title="Download the complete month as a PDF: every date, its festival / important day, and the AI programmes you selected in the Monthly Planner">
            {calDownloading ? 'Building…' : 'Download Calendar'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--eh-ink)', cursor: 'pointer', margin: 0 }}>
            <input type="checkbox" checked={showObs} onChange={(e) => setShowObs(e.target.checked)} style={{ accentColor: 'var(--eh-primary)' }} />
            Show important days on the grid
          </label>
          <span style={{ fontSize: 11.5, color: 'var(--eh-ink-faint)' }}>
            {obsLoading ? 'Loading…' : `${monthObservances.length} in ${MONTHS[cursor.m]}`}
          </span>
        </div>
      </div>
    </div>
  )

  const FilterBar = (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="card-pad eh-planner-bar" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 200px' }}><label style={LABEL}>Search Events</label><SearchInput value={search} onChange={setSearch} placeholder="Search events, NGO, activity…" /></div>
        <div style={{ width: 170 }}><label style={LABEL}>NGO</label>
          <Select value={filterNgo} onChange={(v) => changeNgo(v)}><option value="">All NGOs</option>{ngos.map(n => <option key={n.id} value={n.id}>{n.name || n.code}</option>)}</Select>
        </div>
        <div style={{ width: 210 }}><label style={LABEL}>Sector</label>
          <Select value={filterSector} onChange={(v) => changeSector(v)} disabled={!filterNgo}><option value="">{filterNgo ? 'All sectors' : 'Select NGO first'}</option>{sectors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </div>
        <div style={{ width: 200 }}><label style={LABEL}>Activity</label>
          <Select value={filterActivity} onChange={setFilterActivity} disabled={!filterNgo || !filterSector}><option value="">{filterSector ? 'All activities' : 'Select sector first'}</option>{activities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        </div>
        <div style={{ width: 150 }}><label style={LABEL}>Status</label>
          <Select value={filterStatus} onChange={setFilterStatus}><option value="">All</option>{STATUS_PRIORITY.map(s => <option key={s} value={s}>{s}</option>)}</Select>
        </div>
        <div style={{ width: 110 }}><label style={LABEL}>Event Year</label>
          <Select value={filterYear} onChange={setFilterYear}><option value="">All</option>{yearOptions.map(y => <option key={y} value={y}>{y}</option>)}</Select>
        </div>
        <div>
          <button className="eh-btn" onClick={clearFilters} disabled={!hasFilters}>Clear</button>
        </div>
      </div>
    </div>
  )

  const today = new Date()
  const currentLabel = range
    ? `${MONTHS[range.start.getMonth()]} ${range.start.getFullYear()}`
    : `${MONTHS[today.getMonth()]} ${today.getFullYear()}`

  /* Compact observance strip inside each day cell.

     Rendered through `dayCellContent`, which is the React-native hook — the
     content is part of React's tree, so it re-renders by itself when the
     observance data arrives or the scope changes.

     The previous implementation used `dayCellDidMount` and built the chips by
     hand with document.createElement. That never produced a single chip:
     FullCalendar 6 does not put a `dateStr` on this hook's argument, so the
     guard `if (!arg.dateStr) return` bailed out on every single cell and the
     "Important Days" listed in the side panel appeared nowhere on the grid.

     The date key therefore comes from `arg.date`, not `arg.dateStr`, and it is
     built from the LOCAL year/month/day parts. toISOString() must not be used
     here: in IST midnight is 18:30 UTC the previous day, which silently moved
     every observance onto the cell above its own.

     It reads the same `obs.byDate` the side panel renders from, so the panel and
     the grid can never disagree. */
  const dayCellContent = (arg) => {
    const key = toYmd(arg.date)
    const chips = showObs ? (obs.byDate[key] || []) : []
    return (
      /* FullCalendar renders dayCellContent *inside* its own
         .fc-daygrid-day-number element, which is a shrink-to-fit flex item.
         Wrapping the number and the strip here is what keeps them stacked with
         the date on top and the chips spanning the full cell width. */
      <div className="eh-obs-cell">
        <span className="eh-obs-num">{arg.date.getDate()}</span>
        {!!chips.length && (
          <div className="eh-obs-strip">
            {chips.map((o) => {
              const m = obsMeta(o.kind)
              const sc = (OBS_SCOPE[o.scope] || OBS_SCOPE.worldwide)
              const tip = o.precision === 'lunar' ? ' (lunar date — confirm against the gazette)' : ''
              return (
                <span
                  key={`${key}|${o.name}`}
                  className="eh-obs-chip"
                  data-obs-date={key}
                  style={{ '--obs-c': m.color }}
                  title={`${sc.icon} ${sc.label} · ${m.label}${tip} — click to plan a programme`}
                >
                  {sc.icon} {o.name}
                </span>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  /* Group the visible month's observances by day for the side list. */
  const monthGroups = useMemo(() => {
    const map = new Map()
    for (const o of monthObservances) {
      if (!map.has(o.date)) map.set(o.date, [])
      map.get(o.date).push(o)
    }
    return [...map.entries()]
  }, [monthObservances])

  /* Programmes already planned for the month in view, grouped by day. Same
     event feed the grid draws from (filteredEvents), so a programme can never
     be listed here without also appearing on the calendar. Read-only: clicking a
     row opens the event, exactly like clicking its pill in the grid. */
  const monthPrograms = useMemo(() => {
    const y = cursor.y; const m0 = cursor.m
    const map = new Map()
    for (const ev of filteredEvents) {
      const p = ev.extendedProps || {}
      const day = String(p.date || ev.date || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const d = day.split('-')
      if (Number(d[0]) !== y || Number(d[1]) - 1 !== m0) continue
      if (!map.has(day)) map.set(day, [])
      map.get(day).push({ ev, p })
    }
    // Soonest first, and stable within a day by time then title.
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filteredEvents, cursor.y, cursor.m])

  const ProgrammesPanel = (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="card-pad">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <b style={{ fontSize: 14, color: 'var(--eh-ink)' }}>Programmes</b>
          <span style={{ fontSize: 11, color: 'var(--eh-ink-faint)' }}>{MONTHS[cursor.m]} {cursor.y}</span>
          <button
            type="button"
            className="eh-btn eh-btn-sm"
            style={{ marginLeft: 'auto' }}
            title={`Create a programme in ${MONTHS[cursor.m]} ${cursor.y}`}
            onClick={() => { setPreset(null); setCreateDate(`${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}-01`); setCreateOpen(true) }}
          >
            + Add
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--eh-ink-faint)', marginBottom: 12 }}>
          {monthPrograms.length
            ? `${monthPrograms.reduce((n, [, items]) => n + items.length, 0)} planned on ${monthPrograms.length} ${monthPrograms.length === 1 ? 'day' : 'days'}`
            : `Nothing planned in ${MONTHS[cursor.m]} yet.`}
        </div>

        {monthPrograms.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--eh-ink-soft)', lineHeight: 1.55 }}>
            No programmes scheduled this month. Click a day on the grid, or use <b>+ Add</b> to create one.
          </div>
        ) : (
          <div className="eh-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 460, overflow: 'auto' }}>
            {monthPrograms.map(([day, items]) => (
              <div key={day}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--eh-ink-soft)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>
                  {ymdToLabel(day)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {items.map(({ ev, p }) => {
                    const m = CATEGORY_META[ev.category] || CATEGORY_META.other
                    const time = String(p.startTime || '').slice(0, 5)
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => { setSelected(ev); setEditOpen(false) }}
                        title={p.description || ev.title}
                        style={{
                          textAlign: 'left', cursor: 'pointer', width: '100%',
                          border: '1px solid var(--eh-line)', borderLeft: `3px solid ${m.color}`,
                          borderRadius: 9, padding: '8px 10px', background: '#fff',
                        }}
                      >
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--eh-ink)', lineHeight: 1.35 }}>{ev.title}</div>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                          {time && <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: `${m.color}22`, color: m.color }}>{time}</span>}
                          <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>{m.icon} {m.label}</span>
                          {p.ngoName && <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>{p.ngoName}</span>}
                          {p.status && <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>{p.status}</span>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  const ImportantDaysPanel = (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="card-pad">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <b style={{ fontSize: 14, color: 'var(--eh-ink)' }}>Important Days</b>
          <span style={{ fontSize: 11, color: 'var(--eh-ink-faint)' }}>{MONTHS[cursor.m]} {cursor.y}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--eh-ink-faint)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontWeight: 700, color: 'var(--eh-success)' }}>✓ Verified dates</span>
          <span>· reference calendar</span>
          {(obs.lunar_years || []).length > 0 && (
            <span title={`Lunar festivals are tabulated for ${obs.lunar_years.join(', ')}`} style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--eh-warn, #b45309)' }}>lunar dates flagged</span>
          )}
        </div>

        {obs.source === 'client-fallback' && (
          <div style={{ fontSize: 11.5, color: 'var(--eh-warn, #b45309)', background: 'var(--eh-warn-soft, #fef3c7)', padding: '8px 10px', borderRadius: 9, marginBottom: 10, lineHeight: 1.5 }}>
            <b>Built-in reference calendar.</b> The calendar service did not respond, so the
            built-in festival dates are shown. Any custom holidays added by an admin are not
            included until the service is reachable.
          </div>
        )}

        {obsError && (
          <div style={{ fontSize: 12, color: 'var(--eh-danger)', background: 'var(--eh-danger-soft)', padding: '9px 11px', borderRadius: 9 }}>{obsError}</div>
        )}
        {!obsError && obsLoading && <div style={{ fontSize: 12.5, color: 'var(--eh-ink-soft)' }}>Loading…</div>}
        {!obsError && !obsLoading && monthGroups.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--eh-ink-soft)', lineHeight: 1.55 }}>
            {scope === 'worldwide'
              ? 'No worldwide observances in this month. Try "Worldwide + India" or another month.'
              : scope === 'india'
                ? 'No Indian observances or festivals in this month.'
                : 'No important days in this month.'}
          </div>
        )}

{/* .eh-scroll keeps the Windows 11 overlay scrollbar permanently visible —
              without it this list reads as content cut off with no way to drag. */}
          <div className="eh-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 460, overflow: 'auto' }}>
            {monthGroups.map(([date, items]) => (
            <div key={date}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--eh-ink-soft)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>
                {ymdToLabel(date)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {items.map((o) => {
                  const m = obsMeta(o.kind)
                  const sc = OBS_SCOPE[o.scope] || OBS_SCOPE.worldwide
                  return (
                    <button
                      key={o.name}
                      onClick={() => openDayPlan(date)}
                      title={o.note || o.name}
                      style={{
                        textAlign: 'left', cursor: 'pointer', width: '100%',
                        border: '1px solid var(--eh-line)', borderLeft: `3px solid ${m.color}`,
                        borderRadius: 9, padding: '8px 10px', background: '#fff',
                      }}
                    >
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--eh-ink)', lineHeight: 1.35 }}>{m.icon} {o.name}</div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: `${m.color}22`, color: m.color }}>{sc.icon} {sc.label}</span>
                        {o.precision === 'lunar' && <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-warn, #b45309)' }}>confirm date</span>}
                        {o.source === 'db' && <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--eh-tint-2)', color: 'var(--eh-ink-soft)' }}>custom</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Calendar"
        subtitle={`Live interactive calendar · ${currentLabel}`}
        actions={<button className="eh-btn eh-btn-primary" onClick={() => { setPreset(null); setCreateDate(null); setCreateOpen(true) }}>+ Create Event</button>}
      />

      {ScopeBar}

      {FilterBar}

      {toast && <div style={{ padding: '11px 16px', borderRadius: 12, background: 'var(--eh-success-soft)', color: 'var(--eh-success)', fontSize: 13, fontWeight: 600 }}>{toast}</div>}

      <div className="card" style={{ marginBottom: 0 }}>
        <div className="card-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--eh-ink-soft)' }}>Event Legend</span>
          {Object.entries(CATEGORY_META).map(([k, m]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--eh-ink)' }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: m.color, display: 'inline-block' }} />
              {m.icon} {m.label}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--eh-ink)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: '#e5e7eb', border: '1px solid #d1d5db', display: 'inline-block' }} />
            NGO tags (click to filter)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--eh-ink)', paddingLeft: 8, marginLeft: 4, borderLeft: '1px solid var(--eh-line)' }}>
            <b style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--eh-ink-soft)' }}>Important Days</b>
            {Object.entries(OBS_META).map(([k, m]) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: `${m.color}33`, border: `1px solid ${m.color}`, display: 'inline-block' }} />
                {m.icon} {m.label}
              </span>
            ))}
          </span>
        </div>
      </div>

      {filterNgo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ color: 'var(--eh-ink-soft)' }}>Showing:</span>
          <span className="eh-tag" data-ngo-id={filterNgo} onClick={() => changeNgo('')} style={{ cursor: 'pointer' }}>
            {ngos.find(n => String(n.id) === String(filterNgo))?.name || 'NGO'} ✕
          </span>
          <span style={{ fontSize: 12, color: 'var(--eh-ink-faint)' }}>(viewing this NGO&apos;s events only — click ✕ or choose &quot;All NGOs&quot; to clear)</span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div className="card" onClick={handleCalendarClick} style={{ marginBottom: 0, flex: '1 1 660px', minWidth: 0 }}>
          <div className="card-pad">
            {loading && <div style={{ fontSize: 12, color: 'var(--eh-ink-faint)', marginBottom: 8 }}>Loading calendar…</div>}
            <FullCalendar
              ref={calRef}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              initialDate={initialDateRef.current}
              headerToolbar={{
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,listMonth',
              }}
              height="auto"
              editable
              selectable
              selectMirror
              nowIndicator
              events={[...groupedEvents, ...festivalProgEvents]}
              dayCellContent={dayCellContent}
              eventClassNames={(arg) => {
                if (arg.event.extendedProps?.fp) return ['eh-fprog']
                const p = arg.event.extendedProps || {}
                return ['ev-status-' + (p.status || ''), 'ev-cat-' + (p.category || 'other')].filter(Boolean)
              }}
              eventContent={(arg) => {
                const p = arg.event.extendedProps || {}
                if (p.fp) {
                  return {
                    html: `<div class="eh-fp-chip" title="${escapeHtml(`${p.festival ? `${p.festival} · ` : ''}${arg.event.title}${p.activity ? ` — ${p.activity}` : ''}`)}">
                      <div class="eh-fp-title">${escapeHtml(arg.event.title)}</div>
                      <span class="eh-fp-tag">${escapeHtml(p.ngoLabel)}${p.beneficiary ? ` · ${escapeHtml(p.beneficiary)}` : ''}</span>
                    </div>`,
                  }
                }
                const cat = CATEGORY_META[p.category] || CATEGORY_META.other
                const ngos = p.ngos || []
                const title = baseTitle(arg.event.title, p.ngoName)
                return {
                  html: `<div class="eh-pill" style="--pile-c:${cat.color}">
                    <div class="eh-pill-row1"><span class="eh-pill-icon">${cat.icon}</span><span class="eh-pill-title">${escapeHtml(title)}${ngos.length > 1 ? ` <b class="eh-pill-count">(${ngos.length} NGOs)</b>` : ''}</span></div>
                    <div class="eh-pill-ngos">${ngos.map(n => `<span class="eh-tag" data-ngo-id="${escapeHtml(n.id || '')}" title="Click to show only ${escapeHtml(n.code)} events" style="cursor:pointer">${escapeHtml(n.code)}</span>`).join('')}</div>
                  </div>`,
                }
              }}
              datesSet={handleDatesSet}
              dateClick={(info) => { setPreset(null); setCreateDate(info.dateStr); setCreateOpen(true) }}
              select={(info) => { setPreset(null); setCreateDate(info.startStr.slice(0, 10)); setCreateOpen(true) }}
              eventClick={handleEventClick}
              eventDrop={handleEventDrop}
              eventResize={handleEventResize}
            />
          </div>
        </div>
        {/* Sidebar column: Programmes first (what we are planning), then Important
            Days (what the calendar says about the month). Both keep their own
            scrollbar, so a long month never pushes the grid off screen. */}
        <div style={{ flex: '0 1 330px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {ProgrammesPanel}
          {ImportantDaysPanel}
        </div>
      </div>

      {dayPanel && !dayPanel.loading && (
        <DayPlanModal
          date={dayPanel.date}
          observances={obs.byDate[dayPanel.date] || []}
          scope={scope}
          context={dayPanel.context || {}}
          onClose={() => setDayPanel(null)}
          onUseSuggestion={(s) => useSuggestion({ date: dayPanel.date, observances: obs.byDate[dayPanel.date] || [] }, s)}
        />
      )}

      {createOpen && (
        <EventFormModal
          mode="create"
          initial={null}
          preset={preset}
          defaultDate={createDate || undefined}
          onClose={() => { setCreateOpen(false); setPreset(null) }}
          onSaved={() => { setCreateOpen(false); setPreset(null); refresh(); showToast('Event created successfully.') }}
        />
      )}
      {selected && !editOpen && (
        <EventInfoModal
          event={selected}
          onClose={() => setSelected(null)}
          onEdit={() => setEditOpen(true)}
          onDelete={() => { setSelected(null); refresh(); showToast('Event deleted.') }}
        />
      )}
      {editOpen && selected && (
        <EventFormModal
          mode="edit"
          initial={selected}
          defaultDate={undefined}
          onClose={() => { setEditOpen(false); setSelected(null) }}
          onSaved={() => { setEditOpen(false); setSelected(null); refresh(); showToast('Event updated successfully.') }}
        />
      )}
      {groupSel && (
        <ModalShell title={groupSel.title || 'Events'} onClose={() => setGroupSel(null)}>
          <div style={{ fontSize: 13, color: 'var(--eh-ink-soft)', marginBottom: 12 }}>
            {groupSel.members.length} events on {ymdToLabel(groupSel.date)} across different NGOs.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groupSel.members.map((ev) => {
              const p = ev.extendedProps || {}
              return (
                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--eh-line)', borderRadius: 12, padding: '10px 12px' }}>
                  <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,var(--eh-primary),var(--eh-secondary))', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{(p.ngoName || '')[0]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--eh-ink)' }}>{p.ngoName || 'NGO'}</div>
                    <div style={{ fontSize: 12, color: 'var(--eh-ink-soft)' }}>{p.status || '—'}{p.sectorName ? ` · ${p.sectorName}` : ''}</div>
                  </div>
                  <button className="eh-btn eh-btn-sm" onClick={() => navigate('/event-head/events/' + ev.id)}>View</button>
                </div>
              )
            })}
          </div>
        </ModalShell>
      )}
    </div>
  )
}
