import { useState, useEffect, useRef } from 'react'
import { Routes, Route, NavLink, useLocation, useNavigate, Navigate } from 'react-router-dom'
import { useUcs } from '../../store'
import { Grid, Cal, Plus, FileTxt, Bell, Users, Plane, Brief, Star, Eye, Settings as SettingsIcon } from './icons'
import { themes, applyTheme } from './theme'
import SettingsDrawer from '../../components/SettingsDrawer'
import { fetchDeadlineNotifs } from './store'
import Overview from './components/Overview'
import EventDashboard from './pages/EventDashboard'
import CreateEvent from './pages/CreateEvent'
import MonthlyPlanner from './pages/MonthlyPlanner'
import ActivityPlanner from './pages/ActivityPlanner'
import ReelsChecklist from './components/ReelsChecklist'
import AssetRegister from './pages/AssetRegister'
import MaterialRegister from './pages/MaterialRegister'
import BeneficiaryDistribution from './pages/BeneficiaryDistribution'
import VolunteerManagement from './pages/VolunteerManagement'

import AttendanceManagement from './pages/AttendanceManagement'
import EventReports from './pages/EventReports'
import ApprovalWorkflow from './pages/ApprovalWorkflow'
import NotificationsPage from './pages/Notifications'
import EventsPage from './pages/EventsPage'
import MyEvents from './pages/MyEvents'
import NGOs from './pages/NGOs'
import Sectors from './pages/Sectors'
import Activities from './pages/Activities'
import ActivityDetail from './pages/ActivityDetail'
import EventDetail from './pages/EventDetail'
import MediaManagement from './pages/MediaManagement'
import TechnicalTickets from '../../components/TechnicalTickets'
import AllTicketsDashboard from './pages/AllTicketsDashboard'
import NoticePopup from '../../components/NoticePopup'
import ChatWorkspace from '../../components/chat/ChatWorkspace'
import ChatNavBadge from '../../components/chat/ChatNavBadge'
import { ChatIcon } from '../../components/chat/chatIcons'

const NAV = [
  { id:'dashboard',      path:'/event-head/dashboard',        label:'Dashboard',             icon:Grid, section:'Overview' },
  { id:'events',         path:'/event-head/events',           label:'Events',                icon:Cal, section:'Programs' },
  { id:'monthly-planner',path:'/event-head/monthly-planner',  label:'Calendar',              icon:Cal, section:'Programs' },
  /* Second entry for the same page under its real name. It gets its own alias
     route (`/event-head/planner`) so that only one of the two links is ever
     highlighted as active — sharing one path would light up both at once. */
  { id:'planner',         path:'/event-head/planner',           label:'Monthly Planner',       icon:Plane, section:'Programs' },
  { id:'reels-checklist', path:'/event-head/reels-checklist',   label:'Reels Checklist',       icon:Eye, section:'Programs' },
  { id:'ngos',           path:'/event-head/ngos',             label:'NGOs',                  icon:Brief, section:'Programs' },
  { id:'sectors',        path:'/event-head/sectors',          label:'Sectors',               icon:Grid, section:'Programs' },
  { id:'activities',     path:'/event-head/activities',       label:'Activities',            icon:Star, section:'Programs' },
  { id:'create',         path:'/event-head/create',           label:'+ Create Event',        icon:Plus, section:'Programs' },
  { id:'events-list',    path:'/event-head/events-list',      label:'My Events',             icon:Cal, section:'Manage' },
  { id:'media',          path:'/event-head/media-management', label:'Media / Banners',       icon:Eye, section:'Manage' },
  { id:'volunteers',     path:'/event-head/volunteers',       label:'Voluntary',             icon:Users, section:'Manage' },
  { id:'reports',        path:'/event-head/reports',          label:'Event Reports',         icon:FileTxt, section:'Reporting' },
  { id:'approvals',      path:'/event-head/approvals',        label:'Approval Workflow',     icon:SettingsIcon, section:'Reporting' },
  { id:'notifications',  path:'/event-head/notifications',    label:'Notifications',         icon:Bell, section:'Reporting' },
  { id:'my-tickets',     path:'/event-head/my-tickets',       label:'My Tickets',            icon:Bell, section:'Reporting' },
  { id:'all-tickets',    path:'/event-head/all-tickets',      label:'All Tickets',           icon:FileTxt, section:'Reporting' },
  { id:'chat',           path:'/event-head/chat',             label:'Community',             icon:ChatIcon, section:'Community' },
]

const SECTIONS = [
  { id:'Overview', label:'Overview' },
  { id:'Programs', label:'Programs' },
  { id:'Manage', label:'Planning & Manage' },
  { id:'Reporting', label:'Reporting' },
  { id:'Community', label:'Community' },
]

function Sidebar({ open, onClose, collapsed, onToggleCollapse }) {
  const location = useLocation()
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/')
  /* The collapse rail is a Calendar / Monthly Planner feature: the toggle and its
     effect appear only on those two routes, everywhere else keeps the full nav. */
  const isCalendarRoute = location.pathname === '/event-head/monthly-planner'
    || location.pathname.startsWith('/event-head/monthly-planner/')
    || location.pathname === '/event-head/planner'
  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">E</div>
          <div className="sidebar-brand-text"><h1>UFS</h1><span>Event Manager</span></div>
        </div>
        <nav className="sidebar-nav">
          {SECTIONS.map(s => (
            <div key={s.id}>
              <div className="user-menu-label" style={{padding:'16px 12px 4px',fontSize:10,textTransform:'uppercase',letterSpacing:'0.08em',color:'var(--ink-soft)',fontWeight:600}}>{s.label}</div>
              {NAV.filter(n => n.section === s.id).map(n => { const Icon = n.icon
                const active = isActive(n.path)
                return (
                  <NavLink key={n.id} to={n.path} onClick={onClose} title={n.label}
                    className={`snav-item ${active ? 'active' : ''}`}>
                    <span className="ico"><Icon size={18} /></span>
                    <span className="snav-label">{n.label}</span>
                    {n.id === 'chat' && <ChatNavBadge quiet />}
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>
        {isCalendarRoute && (
          <button type="button" className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
            {!collapsed && <span style={{ fontSize: 10.5, fontWeight: 600 }}>Collapse</span>}
          </button>
        )}
      </aside>
    </>
  )
}

export default function EventHeadPanel() {
  const { user, logout } = useUcs()
  const location = useLocation()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  /* Collapse rail (Calendar / Monthly Planner only) — persisted so the choice
     survives a reload. The class is applied only while a calendar route is in
     view; on every other page the sidebar renders at full width. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('eh_sidebar_collapsed') === '1')
  const toggleSidebarCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem('eh_sidebar_collapsed', next ? '1' : '0') } catch { /* storage unavailable */ }
      return next
    })
  }
  const isCalendarRoute = location.pathname === '/event-head/monthly-planner'
    || location.pathname.startsWith('/event-head/monthly-planner/')
    || location.pathname === '/event-head/planner'
  const [showMenu, setShowMenu] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [themeName, setThemeName] = useState(() => localStorage.getItem('eh_theme') || 'sky')
  const [deadlines, setDeadlines] = useState([])
  const [bellOpen, setBellOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const firstLoad = useRef(true)
  const menuRef = useRef(null)
  const bellRef = useRef(null)
  let _initSeenNotifs = []; try { _initSeenNotifs = JSON.parse(localStorage.getItem('eh_seen_notifs') || '[]'); } catch { /* corrupted */ }
  const seenNotifIds = useRef(new Set(_initSeenNotifs))

  /* Show a short in-app banner once each time the panel first opens (not
   * repeatedly) only if there are due deadlines. Desktop popups are removed. */
  const showDeadlineToast = (all) => {
    if (!all || all.length === 0) return
    setToast(all.slice(0, 3))
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 10000)
  }

  /* Small 2-tone "ding" for new & urgent (due today) deadline notifications. */
  const playUrgentBeep = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      const play = (freq, delay, dur) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0, ctx.currentTime + delay)
        gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur)
        osc.connect(gain).connect(ctx.destination)
        osc.start(ctx.currentTime + delay)
        osc.stop(ctx.currentTime + delay + dur + 0.05)
      }
      play(880, 0, 0.2)
      play(1175, 0.16, 0.28)
      setTimeout(() => ctx.close(), 1200)
    } catch { /* audio unavailable */ }
  }

  /* Dynamic event-head deadline notifications — computed from event data,
   * refreshed live. No intrusive desktop OS popups; a short in-app toast shows
   * once per open when there are due deadlines, and new urgent deadlines ring. */
  const loadDeadlines = () => {
    fetchDeadlineNotifs(5)
      .then(all => {
        setDeadlines(all);
        if (firstLoad.current) {
          firstLoad.current = false;
          showDeadlineToast(all);
        }
        all.forEach(n => {
          if (!seenNotifIds.current.has(n.key)) {
            seenNotifIds.current.add(n.key);
            localStorage.setItem('eh_seen_notifs', JSON.stringify([...seenNotifIds.current]));
            if (n.urgent) playUrgentBeep();
          }
        });
      })
      .catch((err) => { console.error('Deadline notifications error:', err.message || err); });
  };

  useEffect(() => {
    loadDeadlines();
    const timer = setInterval(loadDeadlines, 60 * 1000);
    const onFocus = () => loadDeadlines();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); if (toastTimer.current) clearTimeout(toastTimer.current) };
  }, [])

  useEffect(() => {
    if (themes[themeName]) {
      applyTheme(themes[themeName], '.panel-event-head')
      const t = themes[themeName]
      const el = document.querySelector('.panel-event-head') || document.documentElement
      el.style.setProperty('--bg', t.sand); el.style.setProperty('--card-bg', t.paper); el.style.setProperty('--sage-light', t['sage-soft'])
    }
    localStorage.setItem('eh_theme', themeName)
  }, [themeName])

  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false)
      if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false)
    }
    if (showMenu || bellOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu, bellOpen])

  const meta = [...NAV].reverse().find(n => location.pathname === n.path || location.pathname.startsWith(n.path + '/'))
  const userName = user?.name || 'Event Manager'
  const initials = userName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
  const urgentCount = deadlines.filter(d => d.urgent).length

  return (
    <div className={`app${sidebarCollapsed && isCalendarRoute ? ' sidebar-collapsed' : ''}`}>
      <NoticePopup />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebarCollapse} />
      <div className="main">
        <header className="topbar">
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="Toggle sidebar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
            <div>
              <div className="eyebrow">{meta?.section || 'Dashboard'}</div>
              <h2>{meta?.label || 'Event Manager'}</h2>
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div className="eh-search" style={{ margin:0, maxWidth:280 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input placeholder="Search events, NGOs, sectors…" style={{ background:'var(--eh-tint-1)', border:'none' }} />
            </div>
            <button className="eh-btn eh-btn-primary" style={{ marginRight:2 }} onClick={() => navigate('/event-head/create')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span className="eh-btn-label">Create Event</span>
            </button>
            <div className="topbar-user" ref={bellRef} style={{ position: 'relative' }} onClick={() => setBellOpen(!bellOpen)}>
              <button className="eh-btn" aria-label="Deadline notifications" style={{ padding: '8px', position: 'relative' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                {deadlines.length > 0 && (
                  <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 999, background: urgentCount > 0 ? 'var(--eh-danger, #dc2626)' : 'var(--eh-primary, #3b82f6)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{deadlines.length}</span>
                )}
              </button>
              {bellOpen && (
                <div className="user-menu" style={{ right: 0, left: 'auto', width: 320, maxHeight: 420, overflowY: 'auto' }}>
                  <div className="user-menu-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>Upcoming Event Notifications</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{deadlines.length} upcoming event{deadlines.length === 1 ? '' : 's'} · live</div>
                  </div>
                  <div className="user-menu-divider" />
                  {deadlines.length === 0 && (
                    <div className="user-menu-item" style={{ cursor: 'default', fontSize: 12, color: 'var(--ink-soft)' }}>No upcoming events in the next 5 days.</div>
                  )}
                  {deadlines.map(d => (
                    <div key={d.key} className="user-menu-item" style={{ cursor: 'pointer', alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}
                      onClick={() => { setBellOpen(false); navigate('/event-head/events/' + d.eventId) }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{d.title}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: d.urgent ? 'var(--eh-danger, #dc2626)' : 'var(--eh-primary, #3b82f6)', color: '#fff', whiteSpace: 'nowrap' }}>{d.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{d.body} · {d.date}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="topbar-user" ref={menuRef} onClick={() => setShowMenu(!showMenu)}>
            <div className="avatar">{initials}</div>
            {showMenu && (
              <div className="user-menu">
                <div className="user-menu-item" style={{flexDirection:'column', alignItems:'flex-start', gap:2, cursor:'default'}}>
                  <div style={{fontWeight:600, fontSize:13}}>{userName}</div>
                  <div style={{fontSize:11, color:'var(--ink-soft)'}}>Event Manager</div>
                </div>
                <div className="user-menu-divider" />
                <div className="user-menu-item" onClick={() => { setShowMenu(false); setShowSettings(true); }} style={{cursor:'pointer'}}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  Settings
                </div>
                <div className="user-menu-divider" />
                <button className="user-menu-item" onClick={() => { setShowMenu(false); logout() }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
          </div>
          <SettingsDrawer
            open={showSettings}
            onClose={() => setShowSettings(false)}
            themes={themes}
            themeName={themeName}
            onThemeChange={(key) => setThemeName(key)}
          />
        </header>
        {toast && (
          <div style={{
            margin: '12px 16px 0', padding: '13px 16px', borderRadius: 14,
            background: 'var(--eh-danger-soft)', border: '1px solid var(--eh-danger)',
            color: 'var(--eh-ink)', boxShadow: '0 10px 30px rgba(0,0,0,.12)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--eh-danger)', flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--eh-danger)' }}>{deadlines.some(d => d.urgent) ? 'Event deadlines due today!' : 'Upcoming event deadlines (3 days)'}</span>
              <button className="eh-btn eh-btn-sm" style={{ marginLeft: 'auto' }} onClick={() => navigate('/event-head/notifications')}>View all</button>
              <button className="eh-btn eh-btn-sm" onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {toast.map(d => (
                <div key={d.key} onClick={() => { setToast(null); navigate('/event-head/events/' + d.eventId) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: 'rgba(255,255,255,.65)', cursor: 'pointer' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: d.urgent ? 'var(--eh-danger)' : 'var(--eh-primary)', color: '#fff', whiteSpace: 'nowrap', flexShrink: 0 }}>{d.label}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--eh-ink-soft)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.date}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="content-body">
          <Routes>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<EventDashboard />} />
            <Route path="monthly-planner" element={<MonthlyPlanner />} />
              {/* The "Monthly Planner" nav entry is its own screen: NGO-wise ->
                  month-wise activity planning with AI programme suggestions.
                  It gets its own route so only one of the two nav links is ever
                  highlighted as active, and so the Calendar grid above stays
                  exactly as it is. */}
              <Route path="planner" element={<ActivityPlanner />} />
              <Route path="reels-checklist" element={<ReelsChecklist />} />
            <Route path="create" element={<CreateEvent />} />
            <Route path="ngos" element={<NGOs />} />
            <Route path="sectors" element={<Sectors />} />
            <Route path="activities" element={<Activities />} />
            <Route path="activities/:id" element={<ActivityDetail />} />
            <Route path="assets" element={<AssetRegister />} />
            <Route path="materials" element={<MaterialRegister />} />
            <Route path="distribution" element={<BeneficiaryDistribution />} />
            <Route path="volunteers" element={<VolunteerManagement />} />
            <Route path="attendance" element={<AttendanceManagement />} />
            <Route path="media-management" element={<MediaManagement />} />

            <Route path="events-list" element={<MyEvents />} />
            <Route path="events-today" element={<EventsPage view="today" />} />
            <Route path="events-upcoming" element={<EventsPage view="upcoming" />} />
            <Route path="events-completed" element={<EventsPage view="completed" />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="events/:id" element={<EventDetail />} />
            <Route path="reports" element={<EventReports />} />
            <Route path="approvals" element={<ApprovalWorkflow />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="my-tickets" element={<TechnicalTickets panel="event_head" category="digital_team" department="event_head" canResolve />} />
            <Route path="all-tickets" element={<AllTicketsDashboard />} />
            <Route path="chat" element={<ChatWorkspace />} />
            <Route path="*" element={<Navigate to="dashboard" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
