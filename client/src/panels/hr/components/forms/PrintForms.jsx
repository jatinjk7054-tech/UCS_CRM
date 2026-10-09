import { useEffect, useRef, useState } from 'react'
import WelcomeLetter from './WelcomeLetter'
import Template1 from './Template1'
import Template2 from './Template2'
import Template3 from './Template3'
import Template4 from './Template4'
import Template5 from './Template5'
import Template6 from './Template6'


export default function PrintForms({ data, onClose }) {
  const ref = useRef(null)
  const frameRef = useRef(null)
  const contentRef = useRef(null)
  const [contentOnly, setContentOnly] = useState(() => {
    try { return localStorage.getItem('wl_content_only') === '1' } catch { return false }
  })

  useEffect(() => { try { localStorage.setItem('wl_content_only', contentOnly ? '1' : '0') } catch {} }, [contentOnly])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const openPrint = (content, title) => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) { alert('Please allow pop-ups to print forms'); return }
    const origin = window.location.origin
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head><title>${title}</title>
      <base href="${origin}/">
      <style>
        @page { size: A4; margin: 0; }
        body { margin: 0; padding: 0; background: #fff; }
        .print-page + .print-page { page-break-before: always; }
        .t1 { margin-top: 40px !important; }
        .wl { height: 297mm !important; overflow: hidden !important; margin-top: 40px !important; }
        .wl.mod-frame, .wl.mod-content { height: 285mm !important; overflow: hidden !important; margin: 5mm auto 0 !important; }
        .t2 { height: 297mm !important; overflow: hidden !important; margin-top: 40px !important; }
        .t4 { height: 297mm !important; overflow: hidden !important; margin-top: 40px !important; }
        .t5 { height: 297mm !important; overflow: hidden !important; margin-top: 40px !important; }
        .t6 { height: 297mm !important; overflow: hidden !important; margin-top: 40px !important; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
      </head>
      <body>${content}</body>
      </html>
    `)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => { printWindow.print() }, 500)
  }

  const handlePrintAll = () => openPrint(ref.current.innerHTML, 'Volunteer Forms')
  const handlePrintFrame = () => openPrint(frameRef.current.innerHTML, 'Welcome Form (Sign Sheet)')
  const handlePrintContent = () => openPrint(contentRef.current.innerHTML, 'Welcome Text (Overlay)')

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#fff', zIndex: 9999, overflow: 'auto',
      padding: '20px 0',
    }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 100, background: '#fff',
        borderBottom: '2px solid #333', padding: '12px 24px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {contentOnly ? 'Print Preview — Welcome Form (Signed Paper)' : 'Print Preview — All Forms'}
        </h2>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={contentOnly} onChange={(e) => setContentOnly(e.target.checked)} />
            Welcome letter: signed-paper (content-only)
          </label>
          {contentOnly ? (
            <>
              <button className="btn btn-primary" onClick={handlePrintFrame}
                style={{ padding: '10px 24px', fontSize: 14, fontWeight: 700 }}>
                🖨️ 1. Print welcome form (sign sheet)
              </button>
              <button className="btn btn-primary" onClick={handlePrintContent}
                style={{ padding: '10px 24px', fontSize: 14, fontWeight: 700 }}>
                🖨️ 2. Print welcome text (overlay)
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={handlePrintAll}
              style={{ padding: '10px 24px', fontSize: 14, fontWeight: 700 }}>
              🖨️ Print All Forms
            </button>
          )}
          <button className="btn" onClick={onClose}
            style={{ padding: '10px 24px', fontSize: 14 }}>
            Close
          </button>
        </div>
      </div>
      {!contentOnly && (
        <div ref={ref}>
          <WelcomeLetter personal={data.personal} ngoName={data.ngoName} ngoCode={data.ngoCode} mode="full" />
          <Template1 personal={data.personal} education={data.education} family={data.family || []} organizations={data.organizations || []} photo_url={data.photo_url || ''} />
          <Template2 />
          <Template3 personal={data.personal} declarationDate={data.declarationDate} place={data.place} />
          <Template4 personal={data.personal} signatureUrl={data.signature_url || ''} />
          <Template5 personal={data.personal} declarationDate={data.declarationDate} place={data.place} signatureUrl={data.signature_url || ''} signatureDate={data.signature_signed_at || null} />
          <Template6 personal={data.personal} declarationDate={data.declarationDate} place={data.place} signatureUrl={data.signature_url || ''} />
        </div>
      )}
      {contentOnly && (
        <>
          <div ref={frameRef}>
            <WelcomeLetter personal={data.personal} ngoName={data.ngoName} ngoCode={data.ngoCode} mode="frame" />
          </div>
          <div ref={contentRef}>
            <WelcomeLetter personal={data.personal} ngoName={data.ngoName} ngoCode={data.ngoCode} mode="content" />
          </div>
        </>
      )}
    </div>
  )
}