import { useRef, useState } from 'react'

const todayYmd = () => new Date().toISOString().slice(0, 10)

const REELS_VIDEO_TYPES = ['Long Video', 'Short', 'Event', 'Story', 'Awareness']

const REELS_SECTIONS = [
  {
    id: 'quality',
    label: 'Video Quality Check',
    items: [
      'Strong hook in first 5–10 seconds',
      'Story is clear and engaging',
      'Unnecessary footage removed',
      'Audio/voice is clear',
      'Background music is balanced',
      'Subtitles/captions checked',
      'Names, dates & facts are correct',
      'Video quality is HD/1080p or better',
      'Video has been checked on mobile',
      'Ending has a clear Call to Action',
    ],
  },
  {
    id: 'beneficiary',
    label: 'Beneficiary & Content Check',
    items: [
      'Beneficiary consent/permission confirmed where required',
      'Children\u2019s privacy/safety checked',
      'No misleading information',
      'No disrespectful or insensitive footage',
      'NGO\u2019s work and impact are accurately represented',
      'All statistics/data have been verified',
    ],
  },
  {
    id: 'thumbnail',
    label: 'Thumbnail Check',
    items: [
      'High-quality image',
      'Strong emotion/visual',
      'Text is short (2–5 words)',
      'Easy to read on mobile',
      'Thumbnail matches the actual video',
      'No misleading/clickbait image',
    ],
  },
  {
    id: 'seo',
    label: 'YouTube SEO Check',
    items: [
      'Title is attractive and relevant',
      'Main keyword included naturally',
      'Description completed',
      'Important keywords included in description',
      'Relevant hashtags added',
      'Correct category selected',
      'Correct language selected',
      'Playlist added',
      'End screen added',
      'Cards added where useful',
    ],
  },
  {
    id: 'final',
    label: 'Final Publishing Check',
    items: [
      'Video watched completely after final export',
      'Thumbnail checked',
      'Title checked',
      'Description checked',
      'Links/contact information checked',
      'Spelling checked',
      'Copyright/music checked',
      'Visibility setting confirmed',
      'Upload date/time confirmed',
    ],
  },
]

const REELS_INIT_CHECKS = REELS_SECTIONS.reduce((acc, s) => {
  acc[s.id] = s.items.map(() => false)
  return acc
}, {})

const REELS_PUBLISH_RULES = [
  'All mandatory checks are completed',
  'Final video has been approved',
  'Thumbnail + title are approved',
  'No copyright/privacy/content issue is pending',
]

const APPROVER_ROLES = [
  { id: 'editor', label: 'Editor' },
  { id: 'social', label: 'Social Media Executive' },
  { id: 'final', label: 'Final Approver' },
]

const REELS_CSS = `
.reels-wrap { background: #fff; border: 1px solid #E3E6F2; border-radius: 16px; overflow: hidden; }
.reels-head { padding: 15px 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--eh-line, #E3E6F2); background: linear-gradient(180deg, #fbfaff, #fff); }
.reels-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.reels-title { margin: 0; font-size: 16px; font-weight: 800; color: var(--eh-ink, #1f2430); }
.reels-sub { font-size: 11.5px; color: var(--eh-ink-soft, #6f6c86); }
.reels-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
.reels-block { border: 1px solid var(--eh-line, #E3E6F2); border-radius: 12px; overflow: hidden; background: #fff; }
.reels-block-head { display: flex; align-items: center; gap: 10px; padding: 10px 13px; background: var(--eh-tint-1, #f0eefb); }
.reels-block-num { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--eh-primary, #6c5ce7); color: #fff; font-size: 11px; font-weight: 800; flex: none; }
.reels-block-name { font-size: 13.5px; font-weight: 800; color: var(--eh-ink, #1f2430); flex: 1; }
.reels-block-count { font-size: 11px; font-weight: 800; color: var(--eh-ink-soft, #6f6c86); white-space: nowrap; }
.reels-progress { height: 5px; border-radius: 999px; background: var(--eh-surface-2, #eef0f7); overflow: hidden; }
.reels-progress-fill { height: 100%; border-radius: 999px; background: var(--eh-primary, #6c5ce7); transition: width .2s; }
.reels-item { display: flex; align-items: flex-start; gap: 10px; padding: 9px 13px; cursor: pointer; font-size: 13px; line-height: 1.35; color: var(--eh-ink, #1f2430); border-top: 1px solid #F0F0F6; user-select: none; }
.reels-item:first-child { border-top: none; }
.reels-item:hover { background: #faf9ff; }
.reels-item input { position: absolute; opacity: 0; pointer-events: none; }
.reels-item .reels-box { width: 20px; height: 20px; border-radius: 7px; border: 2px solid #cfd2e5; background: #fff; display: inline-flex; align-items: center; justify-content: center; flex: none; margin-top: 0; color: #fff; font-size: 13px; font-weight: 900; line-height: 1; transition: background .15s, border-color .15s, box-shadow .15s; }
.reels-item input:checked + .reels-box { background: var(--eh-success, #16a34a); border-color: var(--eh-success, #16a34a); box-shadow: 0 0 0 3px rgba(22, 163, 74, .15); }
.reels-item.done { background: #f2fdf5; box-shadow: inset 3px 0 0 var(--eh-success, #16a34a); }
.reels-item.done .reels-item-text { color: var(--eh-ink-soft, #6f6c86); }
.reels-item.done .reels-typed-sig { border-color: var(--eh-success, #16a34a); }
.reels-item .reels-field span { text-transform: none; letter-spacing: 0; }
.reels-block-head.done { background: #ecfdf3; }
.reels-block-head.done .reels-block-num { background: var(--eh-success, #16a34a); }
.reels-block-count.ok { color: var(--eh-success, #16a34a); }
.reels-progress-fill.done { background: var(--eh-success, #16a34a); }
.reels-typed-sig { font-family: 'Segoe Script', 'Brush Script MT', cursive; font-size: 20px; line-height: 1.3; color: var(--eh-ink, #1f2430); border-bottom: 2px solid #9ca3af; padding: 0 2px 2px; }
.reels-sig-note { font-size: 11px; color: var(--eh-ink-faint, #a09db4); }
.reels-details { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.reels-field { display: flex; flex-direction: column; gap: 5px; }
.reels-field span { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--eh-ink-soft, #6f6c86); }
.reels-field input { padding: 8px 10px; font-family: inherit; font-size: 13px; color: var(--eh-ink, #1f2430); background: #fff; border: 1px solid var(--eh-line, #d1d5db); border-radius: 9px; outline: none; transition: border-color .15s, box-shadow .15s; }
.reels-field input:focus { border-color: var(--eh-primary, #2036bd); box-shadow: 0 0 0 3px rgba(32, 54, 189, .12); }
.reels-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.reels-pill { padding: 6px 12px; border: 1px solid var(--eh-line, #d1d5db); border-radius: 999px; background: #fff; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--eh-ink, #1f2430); cursor: pointer; transition: all .15s; }
.reels-pill.on { background: var(--eh-primary, #6c5ce7); border-color: var(--eh-primary, #6c5ce7); color: #fff; }
.reels-approvers { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
.reels-approver { border: 1px solid var(--eh-line, #E3E6F2); border-radius: 12px; padding: 12px; background: var(--eh-tint-1, #faf9ff); display: flex; flex-direction: column; gap: 8px; }
.reels-approver h4 { margin: 0; font-size: 12.5px; font-weight: 800; color: var(--eh-ink, #1f2430); }
.reels-approver .reels-field { gap: 4px; }
.reels-sig-pad { display: flex; flex-direction: column; gap: 6px; }
.reels-sig-canvas { width: 100%; height: 110px; background: #fff; border: 1px dashed #c9c4e8; border-radius: 9px; touch-action: none; cursor: crosshair; }
.reels-sig-hint { position: relative; }
.reels-sig-hint span { position: absolute; left: 12px; top: 44px; font-size: 11px; color: #b3aecb; pointer-events: none; }
.reels-sig-actions { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.reels-sig-clear { font: inherit; font-size: 11.5px; font-weight: 700; color: var(--eh-danger, #dc2626); background: transparent; border: 1px solid var(--eh-danger, #dc2626); border-radius: 7px; padding: 3px 9px; cursor: pointer; }
.reels-sig-clear:disabled { opacity: .4; cursor: default; }
.reels-sig-status { font-size: 11px; color: var(--eh-ink-faint, #a09db4); }
.reels-sig-status.ok { color: var(--eh-success, #16a34a); }
.reels-publish { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; border: 1px solid transparent; font-size: 13px; line-height: 1.4; }
.reels-publish.ok { background: #ecfdf3; border-color: #a7e3c1; color: #166534; }
.reels-publish.pending { background: #fff7ed; border-color: #fbd5a7; color: #9a3412; }
.reels-publish strong { display: block; font-size: 13.5px; }
.reels-rules { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; }
.reels-rules li { font-size: 12px; list-style: none; display: inline-flex; align-items: center; gap: 5px; }
`

function ReelsSig({ value, onChange }) {
  const canvasRef = useRef(null)
  const drawing = useRef(false)
  const last = useRef(null)
  const [hasInk, setHasInk] = useState(false)

  const pos = (e) => {
    const c = canvasRef.current
    const r = c.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    }
  }

  const paint = (value) => {
    setHasInk(true)
    onChange(value)
  }
  const clear = () => {
    const c = canvasRef.current
    c.getContext('2d').clearRect(0, 0, c.width, c.height)
    setHasInk(false)
    onChange(null)
  }

  const start = (e) => {
    e.preventDefault()
    const c = canvasRef.current
    drawing.current = true
    if (c.width !== 640 || c.height !== 220) {
      c.width = 640
      c.height = 220
      if (hasInk) {}
    }
    last.current = pos(e)
    try { c.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const move = (e) => {
    if (!drawing.current) return
    const ctx = canvasRef.current.getContext('2d')
    const p = pos(e)
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#1f2937'
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
  }
  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    paint(canvasRef.current.toDataURL('image/png'))
  }

  return (
    <div className="reels-sig-pad">
      <div className="reels-sig-canvas" style={{ position: 'relative', padding: 0 }}>
        <canvas
          ref={canvasRef}
          width={640}
          height={220}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
          style={{ width: '100%', height: '110px', background: 'transparent', display: 'block' }}
          aria-label="Signature drawing pad"
        />
        {!hasInk && <span className="reels-sig-hint"><span>Sign here</span></span>}
      </div>
      <div className="reels-sig-actions">
        <button type="button" className="reels-sig-clear" onClick={clear} disabled={!hasInk}>Clear</button>
        <span className={`reels-sig-status${hasInk ? ' ok' : ''}`}>
          {hasInk ? 'Signature captured' : 'Draw with mouse or finger'}
        </span>
      </div>
    </div>
  )
}

export default function ReelsChecklist() {
  const [details, setDetails] = useState({ title: '', topic: '', editor: '', preparedBy: '', date: todayYmd() })
  const [types, setTypes] = useState(() => REELS_VIDEO_TYPES.reduce((acc, t) => ({ ...acc, [t]: false }), {}))
  const [checks, setChecks] = useState(() => REELS_INIT_CHECKS)
  const [approvers, setApprovers] = useState(() =>
    APPROVER_ROLES.reduce((acc, r) => ({ ...acc, [r.id]: { name: '', date: todayYmd(), sig: null } }), {})
  )
  const [downloading, setDownloading] = useState(false)
  const printRef = useRef(null)

  const totalChecks = REELS_SECTIONS.reduce((n, s) => n + s.items.length, 0)
  const doneCount = REELS_SECTIONS.reduce(
    (n, s) => n + checks[s.id].filter(Boolean).length,
    0
  )
  const missingApprovers = APPROVER_ROLES.filter(
    (r) => !approvers[r.id].name.trim() || !approvers[r.id].date
  ).length
  const ready = doneCount === totalChecks && missingApprovers === 0
  const pendingCount = (totalChecks - doneCount) + missingApprovers

  const setDet = (k, v) => setDetails((cur) => ({ ...cur, [k]: v }))
  const toggleType = (t) => setTypes((cur) => ({ ...cur, [t]: !cur[t] }))
  const toggleItem = (sec, i) =>
    setChecks((cur) => ({ ...cur, [sec]: cur[sec].map((v, k) => (k === i ? !v : v)) }))
  const setApprover = (id, patch) =>
    setApprovers((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }))

  const downloadPdf = async () => {
    if (!printRef.current) return
    setDownloading(true)
    try {
      const { default: html2canvas } = await import('html2canvas')
      const { default: jsPDF } = await import('jspdf')
      const el = printRef.current
      await new Promise((r) => setTimeout(r, 60))
      const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false })
      const imgData = canvas.toDataURL('image/jpeg', 0.95)
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = 210, pageH = 297, margin = 6
      const contentW = pageW - margin * 2
      const contentH = pageH - margin * 2
      const pxPerMm = canvas.width / contentW
      const pageHeightPx = contentH * pxPerMm
      let heightLeft = canvas.height
      let position = 0
      pdf.addImage(imgData, 'JPEG', margin, margin, contentW, 0)
      heightLeft -= pageHeightPx
      while (heightLeft > 0) {
        position = heightLeft - pageHeightPx
        pdf.addPage()
        pdf.addImage(imgData, 'JPEG', margin, position * -1 + margin, contentW, 0)
        heightLeft -= pageHeightPx
      }
      const stamp = String(details.date || todayYmd()).split('-').join('')
      pdf.save(`Reels-Checklist-Approval-${stamp}.pdf`)
    } catch (e) {
      console.error('ReelsChecklist downloadPdf error:', e)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <section className="reels-wrap">
      <style>{REELS_CSS}</style>
      <div className="reels-head">
        <div className="reels-head-text">
          <h3 className="reels-title">Reels Checklist</h3>
          <span className="reels-sub">Program Video &amp; Reels – Pre-Upload Checklist &amp; Approval Form</span>
        </div>
        <button
          className="eh-btn eh-btn-primary"
          onClick={downloadPdf}
          disabled={downloading}
          title="Download the filled checklist, all sections and the three signatures as a PDF"
        >
          {downloading ? 'Building PDF…' : '⬇ Download PDF'}
        </button>
      </div>

      <div className="reels-body">
        <div className="reels-block">
          <div className="reels-block-head">
            <span className="reels-block-num">1</span>
            <span className="reels-block-name">Video Details</span>
          </div>
          <div className="reels-item" style={{ cursor: 'default', flexDirection: 'column', gap: 10 }}>
            <div className="reels-details">
              <label className="reels-field">
                <span>Video Title</span>
                <input value={details.title} onChange={(e) => setDet('title', e.target.value)} placeholder="Title of the video" />
              </label>
              <label className="reels-field">
                <span>Video Topic / Project</span>
                <input value={details.topic} onChange={(e) => setDet('topic', e.target.value)} placeholder="What the video is about" />
              </label>
              <label className="reels-field">
                <span>Video Editor</span>
                <input value={details.editor} onChange={(e) => setDet('editor', e.target.value)} placeholder="Editor\u2019s name" />
              </label>
              <label className="reels-field">
                <span>Prepared By</span>
                <input value={details.preparedBy} onChange={(e) => setDet('preparedBy', e.target.value)} placeholder="Who filled this in" />
              </label>
              <label className="reels-field">
                <span>Date</span>
                <input type="date" value={details.date} onChange={(e) => setDet('date', e.target.value)} />
              </label>
            </div>
            <div className="reels-field">
              <span>Video Type</span>
              <div className="reels-pills">
                {REELS_VIDEO_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`reels-pill${types[t] ? ' on' : ''}`}
                    onClick={() => toggleType(t)}
                  >
                    {types[t] ? '✓ ' : ''}{t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {REELS_SECTIONS.map((s, i) => {
          const items = checks[s.id]
          const done = items.filter(Boolean).length
          const pct = s.items.length ? Math.round((done / s.items.length) * 100) : 0
          return (
            <div key={s.id} className="reels-block">
              <div className={`reels-block-head${done === s.items.length ? ' done' : ''}`}>
                <span className="reels-block-num">{i + 2}</span>
                <span className="reels-block-name">{s.label}</span>
                <span className={`reels-block-count${done === s.items.length ? ' ok' : ''}`}>{done}/{s.items.length}</span>
                <div className="reels-progress" style={{ width: 90 }}>
                  <div className={`reels-progress-fill${done === s.items.length ? ' done' : ''}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
              {s.items.map((item, j) => (
                <label key={item} className={`reels-item${items[j] ? ' done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={Boolean(items[j])}
                    onChange={() => toggleItem(s.id, j)}
                  />
                  <span className="reels-box">✓</span>
                  <span className="reels-item-text">{item}</span>
                </label>
              ))}
            </div>
          )
        })}

        <div className="reels-block">
          <div className="reels-block-head">
            <span className="reels-block-num">{REELS_SECTIONS.length + 2}</span>
            <span className="reels-block-name">Final Approval</span>
          </div>
          <div className="reels-item" style={{ cursor: 'default', flexDirection: 'column', gap: 10 }}>
            <div className="reels-approvers">
              {APPROVER_ROLES.map((r) => (
                <div key={r.id} className="reels-approver">
                  <h4>{r.label}</h4>
                  <label className="reels-field">
                    <span>Name (type as signature)</span>
                    <input
                      value={approvers[r.id].name}
                      onChange={(e) => setApprover(r.id, { name: e.target.value })}
                      placeholder="Type full name — becomes your signature"
                    />
                  </label>
                  <label className="reels-field">
                    <span>Date</span>
                    <input
                      type="date"
                      value={approvers[r.id].date}
                      onChange={(e) => setApprover(r.id, { date: e.target.value })}
                    />
                  </label>
                  <ReelsSig
                    value={approvers[r.id].sig}
                    onChange={(v) => setApprover(r.id, { sig: v })}
                  />
                  {approvers[r.id].sig ? null : approvers[r.id].name.trim() ? (
                    <div>
                      <div className="reels-typed-sig">{approvers[r.id].name.trim()}</div>
                      <div className="reels-sig-note">Typed signature — a drawn signature above will replace it.</div>
                    </div>
                  ) : (
                    <div className="reels-sig-note">Type your name or draw above — either counts as your signature.</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={`reels-publish${ready ? ' ok' : ' pending'}`}>
          <span style={{ fontSize: 16, lineHeight: 1.1 }}>{ready ? '✓' : '🚨'}</span>
          <div>
            <strong>{ready ? 'READY TO PUBLISH' : 'PUBLISH ONLY WHEN EVERYTHING BELOW IS DONE'}</strong>
            {!ready && (
              <span> {pendingCount} item{pendingCount === 1 ? '' : 's'} still pending ({totalChecks - doneCount} check{totalChecks - doneCount === 1 ? '' : 's'} and {missingApprovers} approver{missingApprovers === 1 ? '' : 's'} to sign).</span>
            )}
            <ul className="reels-rules">
              {REELS_PUBLISH_RULES.map((rule) => (
                <li key={rule}>
                  <span style={{ color: 'var(--eh-success, #16a34a)' }}>✓</span> {rule}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div
        ref={printRef}
        aria-hidden="true"
        style={{ position: 'absolute', left: '-10000px', top: 0, width: 1000, background: '#fff', padding: 26, fontFamily: 'inherit' }}
      >
        <div style={{ fontSize: 18, fontWeight: 800, color: '#1F2430' }}>Reels Checklist — Program Video &amp; Reels: Pre-Upload Checklist &amp; Approval Form</div>
        <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 4 }}>Generated: {new Date().toLocaleString()}</div>

        <div style={{ fontSize: 12, fontWeight: 800, color: '#1F2430', marginTop: 16, marginBottom: 4 }}>1 · VIDEO DETAILS</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <tbody>
            {[
              ['Video Title', details.title || '—'],
              ['Video Topic / Project', details.topic || '—'],
              ['Video Editor', details.editor || '—'],
              ['Prepared By', details.preparedBy || '—'],
              ['Date', details.date || '—'],
              ['Video Type', REELS_VIDEO_TYPES.filter((t) => types[t]).join(', ') || '—'],
            ].map(([k, v]) => (
              <tr key={k}>
                <td style={{ border: '1px solid #D5D9E4', padding: '5px 8px', fontWeight: 700, width: 180 }}>{k}</td>
                <td style={{ border: '1px solid #D5D9E4', padding: '5px 8px' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {REELS_SECTIONS.map((s, i) => (
          <div key={s.id} style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#1F2430', marginBottom: 4 }}>
              {i + 2} · {s.label} — {checks[s.id].filter(Boolean).length}/{s.items.length}
            </div>
            {s.items.map((item, j) => (
              <div key={item} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 11, color: '#1F2430' }}>
                <span style={{ color: checks[s.id][j] ? '#16a34a' : '#9CA3AF', fontWeight: 800, width: 14 }}>{checks[s.id][j] ? '✓' : '○'}</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        ))}

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#1F2430', marginBottom: 6 }}>
            {REELS_SECTIONS.length + 2} · FINAL APPROVAL
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                {APPROVER_ROLES.map((r) => (
                  <th key={r.id} style={{ border: '1px solid #D5D9E4', background: '#E8ECF6', padding: '6px 8px', textAlign: 'left' }}>{r.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {APPROVER_ROLES.map((r) => (
                  <td key={r.id} style={{ border: '1px solid #D5D9E4', padding: '8px', verticalAlign: 'top' }}>
                    <div>Name: {approvers[r.id].name || '—'}</div>
                    <div style={{ marginTop: 2 }}>Date: {approvers[r.id].date || '—'}</div>
                    <div style={{ marginTop: 8 }}>
                      {approvers[r.id].sig ? (
                        <img src={approvers[r.id].sig} alt={`${r.label} signature`} style={{ height: 54, maxWidth: 180 }} />
                      ) : approvers[r.id].name.trim() ? (
                        <div style={{ fontFamily: "'Segoe Script','Brush Script MT',cursive", fontSize: 22, color: '#1F2430' }}>{approvers[r.id].name.trim()}</div>
                      ) : (
                        <span style={{ color: '#9CA3AF' }}>Not signed</span>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 16, fontSize: 11, padding: '9px', border: '1px solid #D5D9E4', borderRadius: 8, background: ready ? '#ECFDF3' : '#FFF7ED', color: ready ? '#166534' : '#9A3412' }}>
          <strong>🚨 PUBLISH ONLY WHEN:</strong> All mandatory checks are completed · Final video has been approved · Thumbnail + title are approved · No copyright/privacy/content issue is pending.
          {' '}<b>{ready ? 'STATUS: READY TO PUBLISH ✓' : `STATUS: NOT READY — ${pendingCount} item${pendingCount === 1 ? '' : 's'} pending`}</b>
        </div>
      </div>
    </section>
  )
}