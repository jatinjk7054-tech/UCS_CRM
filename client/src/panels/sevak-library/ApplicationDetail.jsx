import { useEffect, useRef, useState } from 'react'
import {
  X, ShieldCheck, BadgeCheck, Mail, MessageCircle, Ban, Trash2, ExternalLink, Loader2, XCircle, Pencil, Check, ImagePlus, Copy, UserRound, Contact, Eye, RefreshCw, Download
} from 'lucide-react'
import {
  getPhotoUrls, getMailLog, rejectApplication, removeApplication, resendMembershipEmail, sendPaymentReminder,
  updateApplication, verifyApplication, approveApplication, renewApplication
} from './api.js'
import { pdfMemberDoc } from './MembershipFormDoc.jsx'
import SignaturePad from './SignaturePad.jsx'
import { statusLabel } from './meta.js'
import { RenewalDate } from './DateTags.jsx'
import { formatINR, formatDate, formatTime, computeEndDate, renewalPreview } from './formUtils.js'
import { MEMBERSHIP_PRICES, INDIA_STATES } from './formConfig.js'
import { validateField, validateIdentityDocument } from './validate.js'
import { useToast } from './toast.jsx'

const steps = ['SUBMITTED', 'PAYMENT_SUBMITTED', 'VERIFIED', 'APPROVED']
const stepLabel = {
  SUBMITTED: 'Submitted',
  PAYMENT_SUBMITTED: 'Payment Pending',
  VERIFIED: 'Verification',
  APPROVED: 'Approval'
}

function mailActivityLabel(subject) {
  const s = String(subject || '').toLowerCase()
  if (s.startsWith('complete your')) return 'Payment reminder sent'
  if (s.includes('membership id')) return 'Membership ID email sent'
  if (s.includes('expire')) return 'Expiry reminder sent'
  if (s.includes('renew')) return 'Renewal email sent'
  if (s.includes('coupon')) return 'Discount coupon email sent'
  return 'Email sent'
}

const PLAN_OPTIONS = ['Daily', 'Half Monthly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Annual']
const GENDER_OPTIONS = ['Male', 'Female', 'Other']
const ID_PROOF_OPTIONS = ['Aadhaar Card', 'PAN Card', 'Driving Licence', 'Passport', 'Student ID', 'Other']

const EDIT_FIELDS = [
  { id: 'membershipType', label: 'Membership Plan', input: 'select', type: 'radio', options: PLAN_OPTIONS },
  { id: 'startDate', label: 'Start Date', input: 'date', type: 'date' },
  { id: 'endDate', label: 'End Date', input: 'date', type: 'date' },
  { id: 'membershipFee', label: 'Membership Fee', input: 'text', type: 'text', pattern: '^[0-9]+(\\.[0-9]{1,2})?$', errorMsg: 'Please enter a valid fee amount.' },
  { id: 'fullName', label: 'Full Name', input: 'text', type: 'text' },
  { id: 'guardianName', label: "Guardian's Name", input: 'text', type: 'text' },
  { id: 'dateOfBirth', label: 'Date of Birth', input: 'date', type: 'date' },
  { id: 'gender', label: 'Gender', input: 'select', type: 'radio', options: GENDER_OPTIONS },
  { id: 'occupation', label: 'Occupation', input: 'text', type: 'text' },
  { id: 'educationalQualification', label: 'Educational Qualification', input: 'text', type: 'text' },
  { id: 'mobileNumber', label: 'Mobile Number', input: 'text', type: 'tel', pattern: '^[0-9]{10}$', errorMsg: 'Please enter a valid 10-digit mobile number.' },
  { id: 'alternateMobileNumber', label: 'Alternate Mobile Number', input: 'text', type: 'tel', pattern: '^[0-9]{10}$', errorMsg: 'Please enter a valid 10-digit mobile number.' },
  { id: 'emailAddress', label: 'Email Address', input: 'email', type: 'email' },
  { id: 'currentAddress', label: 'Current Address', input: 'textarea', type: 'textarea' },
  { id: 'city', label: 'City', input: 'text', type: 'text' },
  { id: 'state', label: 'State', input: 'select', type: 'select', options: INDIA_STATES },
  { id: 'pinCode', label: 'PIN Code', input: 'text', type: 'tel', pattern: '^[0-9]{6}$', errorMsg: 'Please enter a valid 6-digit PIN code.' },
  { id: 'identityProofType', label: 'Identity Proof Type', input: 'select', type: 'radio', options: ID_PROOF_OPTIONS },
  { id: 'identityNumber', label: 'Identity Number', input: 'text', type: 'text' },
  { id: 'applicantSignature', label: 'Applicant Signature', input: 'signature', type: 'text' }
]

function buildEditValues(row) {
  const d = row.data || {}
  const v = {}
  EDIT_FIELDS.forEach((f) => {
    v[f.id] = d[f.id] ?? ''
  })
  v.transactionId = row.transaction_id || ''
  return v
}

const DRAFT_KEY = 'sevakAdminEditDraft'
const DRAFT_TTL = 24 * 60 * 60 * 1000

function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}
  } catch {
    return {}
  }
}

function writeDrafts(map) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map))
  } catch {
    // storage unavailable - drafts are best-effort only
  }
}

function getDraft(appId) {
  const map = readDrafts()
  const d = map[String(appId)]
  if (!d) return null
  if (Date.now() - (d.at || 0) > DRAFT_TTL) {
    const m = readDrafts()
    delete m[String(appId)]
    writeDrafts(m)
    return null
  }
  return d
}

function saveDraft(appId, draft) {
  const map = readDrafts()
  map[String(appId)] = draft
  Object.keys(map).forEach((k) => {
    if (Date.now() - (map[k].at || 0) > DRAFT_TTL) delete map[k]
  })
  writeDrafts(map)
}

function clearDraft(appId) {
  const map = readDrafts()
  delete map[String(appId)]
  writeDrafts(map)
}

function Section({ title, children }) {
  return (
    <div className="d-section">
      <h5 className="d-section-title">{title}</h5>
      <div className="d-rows">{children}</div>
    </div>
  )
}

function FieldRow({ label, children }) {
  return (
    <div className="d-row">
      <span className="d-row-label">{label}</span>
      <span className="d-row-value">{children || '—'}</span>
    </div>
  )
}

export default function ApplicationDetail({ row, onClose, refresh, startEditOnOpen = false }) {
  const toast = useToast()
  const [files, setFiles] = useState({ passport: null, identity: null, signature: null })
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [reason, setReason] = useState('')
  const [renewFee, setRenewFee] = useState('')
  const [renewTxn, setRenewTxn] = useState('')
  const [renewFrom, setRenewFrom] = useState('')
  const [editing, setEditing] = useState(false)
  const [editValues, setEditValues] = useState(() => buildEditValues(row))
  const [editErrors, setEditErrors] = useState({})
  const [newPhotos, setNewPhotos] = useState({ passport: null, identity: null })
  const [newPhotoPrev, setNewPhotoPrev] = useState({ passport: null, identity: null })
  const [newPhotoErr, setNewPhotoErr] = useState({ passport: '', identity: '' })
  // Pending signature replacement for the edit form: sigRemove marks the stored
  // image for deletion; sigEpoch remounts the pad when it should go blank.
  const [sigRemove, setSigRemove] = useState(false)
  const [sigEpoch, setSigEpoch] = useState(0)
  const [mailLog, setMailLog] = useState([])
  const [logTick, setLogTick] = useState(0)
  const [copiedRef, setCopiedRef] = useState(false)
  const [preview, setPreview] = useState(null)
  const baseUpdatedAt = useRef(null)
  const previewUrls = useRef({ passport: null, identity: null })

  const d = row.data || {}

  useEffect(() => {
    let on = true
    getPhotoUrls(row.id)
      .then((urls) => {
        if (!on || !urls) return
        setFiles((f) => ({
          passport: urls.passport || f.passport,
          identity: urls.identity || f.identity,
          signature: urls.signature || f.signature
        }))
      })
      .catch(() => {})
    return () => (on = false)
  }, [row.id])

  // Activity feed: this application's rows from the global mail log.
  useEffect(() => {
    let on = true
    getMailLog(500)
      .then((entries) => {
        if (on) setMailLog((entries || []).filter((e) => e.application_id === row.id))
      })
      .catch(() => {})
    return () => (on = false)
  }, [row.id, logTick])

  // Open directly in edit mode (row menu → "Edit details").
  useEffect(() => {
    if (startEditOnOpen) startEdit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy && !confirm && !editing && !preview) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, confirm, editing, preview, onClose])

  // Escape closes only the document preview while it is open.
  useEffect(() => {
    if (!preview) return
    const onKey = (e) => {
      if (e.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  useEffect(() => {
    return () => {
      Object.values(previewUrls.current).forEach((u) => u && URL.revokeObjectURL(u))
    }
  }, [])

  const handleEditChange = (id, value) => {
    const next = { ...editValues, [id]: value }
    if (id === 'membershipType' && value && MEMBERSHIP_PRICES[value]) {
      next.membershipFee = MEMBERSHIP_PRICES[value]
    }
    if (id === 'membershipType' || id === 'startDate') {
      next.endDate = computeEndDate(next.startDate, next.membershipType)
    }
    setEditValues(next)
    saveDraft(row.id, { baseUpdatedAt: baseUpdatedAt.current, values: next, at: Date.now() })

    const field = EDIT_FIELDS.find((f) => f.id === id)
    if (field) {
      const err = validateField(field, value, next)
      setEditErrors((prev) => ({ ...prev, [id]: err }))
    }
  }

  const resetPhotos = () => {
    Object.values(previewUrls.current).forEach((u) => u && URL.revokeObjectURL(u))
    previewUrls.current = { passport: null, identity: null }
    setNewPhotos({ passport: null, identity: null })
    setNewPhotoPrev({ passport: null, identity: null })
    setNewPhotoErr({ passport: '', identity: '' })
  }

  const onPhotoChange = async (key, file) => {
    if (!file) return
    const err = await validateIdentityDocument(file)
    if (err) {
      setNewPhotoErr((prev) => ({ ...prev, [key]: err }))
      setNewPhotos((prev) => ({ ...prev, [key]: null }))
      return
    }
    if (previewUrls.current[key]) URL.revokeObjectURL(previewUrls.current[key])
    const url = URL.createObjectURL(file)
    previewUrls.current = { ...previewUrls.current, [key]: url }
    setNewPhotoPrev((prev) => ({ ...prev, [key]: url }))
    setNewPhotos((prev) => ({ ...prev, [key]: file }))
    setNewPhotoErr((prev) => ({ ...prev, [key]: '' }))
  }

  const clearNewPhoto = (key) => {
    if (previewUrls.current[key]) URL.revokeObjectURL(previewUrls.current[key])
    previewUrls.current = { ...previewUrls.current, [key]: null }
    setNewPhotoPrev((prev) => ({ ...prev, [key]: null }))
    setNewPhotos((prev) => ({ ...prev, [key]: null }))
    setNewPhotoErr((prev) => ({ ...prev, [key]: '' }))
  }

  const startEdit = () => {
    const draft = getDraft(row.id)
    if (draft && draft.values && draft.baseUpdatedAt === row.updated_at) {
      setEditValues({ ...draft.values })
      toast('Restored unsaved edits from your last session.')
    } else {
      setEditValues(buildEditValues(row))
    }
    baseUpdatedAt.current = row.updated_at || null
    setEditErrors({})
    resetPhotos()
    setSigRemove(false)
    setSigEpoch((e) => e + 1)
    setEditing(true)
  }

  const cancelEdit = () => {
    clearDraft(row.id)
    setEditValues(buildEditValues(row))
    setEditErrors({})
    resetPhotos()
    setSigRemove(false)
    setSigEpoch((e) => e + 1)
    setEditing(false)
  }

  const padValue =
    typeof editValues.applicantSignature === 'string' && editValues.applicantSignature.startsWith('data:image')
      ? editValues.applicantSignature
      : ''

  // The pad writes a data URL straight into editValues (so drafts/undo keep
  // working); saveEdit() converts it to a Blob for upload.
  const handleSigChange = (v) => {
    if (v) {
      setSigRemove(false)
      handleEditChange('applicantSignature', v)
    } else {
      setSigRemove(true)
      handleEditChange('applicantSignature', '')
      setSigEpoch((e) => e + 1)
    }
  }

  const removeStoredSig = () => {
    setSigRemove(true)
    handleEditChange('applicantSignature', '')
    setSigEpoch((e) => e + 1)
  }

  const saveEdit = async () => {
    const errs = {}
    EDIT_FIELDS.forEach((f) => {
      const e = validateField(f, editValues[f.id], editValues)
      if (e) errs[f.id] = e
    })
    if (newPhotoErr.passport || newPhotoErr.identity) {
      toast('Please check the selected photos.', 'error')
      return
    }
    if (Object.values(errs).some(Boolean)) {
      setEditErrors(errs)
      toast('Please fix the highlighted fields.', 'error')
      return
    }
    setBusy('save')
    try {
      // Never let a base64 data URL reach the JSON `data` payload — it ships
      // as the `signature` file instead (stored in S3 like passport/identity).
      const payload = { ...editValues }
      let sigBlob = null
      const sigVal = payload.applicantSignature
      if (typeof sigVal === 'string' && sigVal.startsWith('data:image')) {
        sigBlob = await (await fetch(sigVal)).blob()
        payload.applicantSignature = 'Drawn signature'
      }
      await updateApplication(row.id, payload, payload.transactionId, {
        passport: newPhotos.passport,
        identity: newPhotos.identity,
        signature: sigBlob,
        removeSignature: sigRemove && !sigBlob
      })
      clearDraft(row.id)
      toast('Application details updated.')
      setEditing(false)
      setSigRemove(false)
      setSigEpoch((e) => e + 1)
      resetPhotos()
      refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }

  const verify = async () => {
    setBusy('verify')
    try {
      await verifyApplication(row.id)
      toast('Payment verified.')
      refresh()
      onClose()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }

  const approve = async () => {
    setBusy('approve')
    let membershipId
    try {
      const data = await approveApplication(row.id)
      membershipId = data && data.membership_id
    } catch (e) {
      toast(e.message, 'error')
      setBusy('')
      return
    }
    setBusy('')
    toast(membershipId ? `Membership ${membershipId} issued.` : 'Membership issued.')
    refresh()
    onClose()
    try {
      const res = await resendMembershipEmail(row.id)
      setLogTick((t) => t + 1)
      if (res && res.sent) {
        toast('Membership email sent.')
      } else {
        toast(`Membership issued, but email not sent: ${(res && res.error) || 'unknown error'}`, 'error')
      }
    } catch (e) {
      toast(`Membership issued, but email failed: ${e.message}`, 'error')
    }
  }

  const sendReminder = async () => {
    setBusy('reminder')
    try {
      await sendPaymentReminder(row.id)
      toast('Payment reminder email sent.')
      setLogTick((t) => t + 1)
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }

  const printPdf = async () => {
    setBusy('pdf')
    try {
      const urls = await getPhotoUrls(row.id, 'data')
      await pdfMemberDoc([row], [urls || null])
      toast('Membership registration PDF downloaded.')
    } catch (e) {
      toast(`Could not generate PDF: ${e.message}`, 'error')
    }
    setBusy('')
  }

  const m = row.mobile ? row.mobile.replace(/\D/g, '') : ''
  const waNumber = m.length === 10 ? `91${m}` : m
  const messageText = [
    `Hello ${row.full_name},`,
    '',
    `Your Sevak Library membership has been approved.`,
    `Membership ID: ${row.membership_id || '—'}`,
    `Plan: ${row.membership_type} · ${formatINR(row.membership_fee)}`,
    row.start_date && row.end_date
      ? `Period: ${formatDate(row.start_date)} → ${formatDate(row.end_date)}`
      : '',
    '',
    'Thank you for becoming a part of our library.',
    'Sevak Library | Being Sevak Charitable Trust'
  ]
    .filter(Boolean)
    .join('\n')
  const encoded = encodeURIComponent(messageText)
  const waUrl = waNumber ? `https://wa.me/${waNumber}?text=${encoded}` : ''
  const mailUrl = `mailto:${row.email}?subject=${encodeURIComponent(
    `Sevak Library Membership - ${row.membership_id || row.ref}`
  )}&body=${encoded}`

  const doRenew = async () => {
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
    setBusy('renew')
    try {
      const data = await renewApplication(row.id, { fee: feeNum, transactionId: txn, startDate: renewFrom })
      toast(data && data.end_date ? `Membership renewed until ${formatDate(data.end_date)}.` : 'Membership renewed.')
      setConfirm(null)
      refresh()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }

  const doReject = async () => {
    if (!reason.trim()) {
      toast('Please enter a reason for rejection.', 'error')
      return
    }
    setBusy('reject')
    try {
      await rejectApplication(row.id, reason)
      toast('Application rejected.')
      refresh()
      onClose()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }

  const doDelete = async () => {
    setBusy('delete')
    try {
      await removeApplication(row.id)
      toast('Application deleted.')
      refresh()
      onClose()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy('')
  }

  const paymentInfo =
    !row.transaction_id && (d.amountReceived || d.paymentMode)
      ? [d.paymentMode, d.amountReceived].filter(Boolean).join(' · ')
      : ''

  const initial = (row.full_name || '?').trim().charAt(0).toUpperCase()
  const heroMeta = [d.category, d.educationalQualification].filter(Boolean).join(' · ')
  const phone = m.length === 10 ? `+91 ${m.slice(0, 5)} ${m.slice(5)}` : row.mobile || ''
  const paid = !!row.transaction_id || row.status === 'VERIFIED' || row.status === 'APPROVED'
  const renewP = row.status === 'APPROVED' ? renewalPreview(row) : null
  const renewalCount = Number(row.renewal_count) || 0
  const renewalHist = Array.isArray(row.renewal_payments) ? row.renewal_payments.slice().reverse() : []
  const addrStreet = d.currentAddress || ''
  const addrCity = [d.city, [d.state, d.pinCode].filter(Boolean).join(' - ')].filter(Boolean).join(', ')
  const hasAddress = !!(addrStreet || addrCity)

  const activity = [
    { title: 'Application submitted', at: row.created_at },
    ...mailLog.map((e) => ({
      title: `${mailActivityLabel(e.subject)}${e.sent ? '' : ' (failed)'}`,
      at: e.created_at,
      failed: !e.sent,
      err: e.error || ''
    }))
  ]
    .filter((a) => a.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))

  const stepIdx = steps.indexOf(row.status)
  const showTimeline = row.status !== 'REJECTED'
  const canReject = row.status === 'SUBMITTED' || row.status === 'PAYMENT_SUBMITTED'

  const copyPaymentRef = async () => {
    if (!row.payment_ref) return
    try {
      await navigator.clipboard.writeText(String(row.payment_ref))
      setCopiedRef(true)
      setTimeout(() => setCopiedRef(false), 1500)
    } catch {
      // clipboard unavailable (insecure context) - ignore
    }
  }

  return (
    <div className="drawer-overlay" onClick={() => !busy && onClose()}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="drawer-head-main">
            <h3>Application</h3>
            <span className="mono">{row.ref}</span>
            <span className={`admin-badge ${row.status}`}>{statusLabel(row.status)}</span>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          {row.status === 'REJECTED' && row.reject_reason && (
            <div className="reject-box">
              <strong>Rejection reason:</strong> {row.reject_reason}
            </div>
          )}

          {editing ? (
            <div className="edit-form">
              <p className="edit-hint">End date and fee recalculate automatically when you change the plan or start date.</p>
              <div className="edit-grid">
                {EDIT_FIELDS.map((f) => (
                  f.input === 'signature' ? (
                    <div key={f.id} className="edit-field edit-wide sig-edit">
                      <span className="edit-label">{f.label}</span>
                      {!padValue && !sigRemove && (files.signature || d.applicantSignature) && (
                        <div className="sig-current">
                          {files.signature ? (
                            <img src={files.signature} alt="Stored signature" />
                          ) : (
                            <span className="sig-legacy">{d.applicantSignature}</span>
                          )}
                          <button type="button" className="doc-remove-btn" onClick={removeStoredSig}>
                            <X size={13} /> Remove
                          </button>
                        </div>
                      )}
                      {sigRemove && !padValue && (
                        <p className="sig-note">Signature marked for removal — save to confirm.</p>
                      )}
                      <SignaturePad key={sigEpoch} value={padValue} onChange={handleSigChange} />
                    </div>
                  ) : (
                    <label key={f.id} className={`edit-field ${f.input === 'textarea' ? 'edit-wide' : ''}`}>
                      <span className="edit-label">{f.label}</span>
                      {f.input === 'select' ? (
                        <select value={editValues[f.id] || ''} onChange={(e) => handleEditChange(f.id, e.target.value)}>
                          <option value="">— Select —</option>
                          {f.options.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      ) : f.input === 'textarea' ? (
                        <textarea value={editValues[f.id] || ''} onChange={(e) => handleEditChange(f.id, e.target.value)} rows={2} />
                      ) : (
                        <input
                          type={f.input}
                          value={editValues[f.id] || ''}
                          onChange={(e) => handleEditChange(f.id, e.target.value)}
                        />
                      )}
                      {editErrors[f.id] && <span className="edit-error">{editErrors[f.id]}</span>}
                    </label>
                  )
                ))}
                <label className="edit-field">
                  <span className="edit-label">Transaction / UTR</span>
                  <input
                    type="text"
                    value={editValues.transactionId || ''}
                    onChange={(e) => handleEditChange('transactionId', e.target.value)}
                  />
                </label>
              </div>
            </div>
          ) : (
            <>
              <div className="detail-hero">
                <div className="detail-avatar">{initial}</div>
                <h4 className="detail-name">{row.full_name}</h4>
                {heroMeta && <p className="detail-meta">{heroMeta}</p>}
                <p className="detail-contact">{row.email}</p>
                {phone && <p className="detail-contact">{phone}</p>}
              </div>

              {showTimeline && (
                <div className="d-section">
                  <h5 className="d-section-title">Application Progress</h5>
                  <div className="progress-list">
                    {steps.map((s, i) => (
                      <div key={s} className={`pr-item ${i <= stepIdx ? 'done' : ''} ${i === stepIdx ? 'current' : ''}`}>
                        <span className="pr-rail">
                          <span className="pr-dot">
                            {i < stepIdx ? <Check size={12} /> : i === stepIdx ? <span className="pr-core" /> : null}
                          </span>
                          {i < steps.length - 1 && <span className="pr-line" />}
                        </span>
                        <span className="pr-label">{stepLabel[s]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Section title="Personal Information">
                <FieldRow label="Date of birth">{d.dateOfBirth && formatDate(d.dateOfBirth)}</FieldRow>
                <FieldRow label="Gender">{d.gender}</FieldRow>
                <FieldRow label="Guardian">{d.guardianName}</FieldRow>
                {d.alternateMobileNumber && <FieldRow label="Alternate mobile">{d.alternateMobileNumber}</FieldRow>}
                {files.signature ? (
                  <FieldRow label="Signature">
                    <img className="d-signature" src={files.signature} alt="Applicant signature" />
                  </FieldRow>
                ) : d.applicantSignature ? (
                  <FieldRow label="Signature">{d.applicantSignature}</FieldRow>
                ) : null}
                {d.remarks && <FieldRow label="Remarks">{d.remarks}</FieldRow>}
              </Section>

              <Section title="Profile">
                <FieldRow label="Category">{d.category}</FieldRow>
                <FieldRow label="Occupation">{d.occupation}</FieldRow>
                <FieldRow label="Qualification">{d.educationalQualification}</FieldRow>
                {d.degree && <FieldRow label="Degree">{d.degree}</FieldRow>}
              </Section>

              <div className="d-section">
                <h5 className="d-section-title">Address</h5>
                <div className="d-rows d-rows-pad">
                  {hasAddress ? (
                    <>
                      {addrStreet && <p className="d-address-line">{addrStreet}</p>}
                      {addrCity && <p className="d-address-line">{addrCity}</p>}
                    </>
                  ) : (
                    <p className="d-address-line d-muted">No address on file</p>
                  )}
                </div>
              </div>

              <Section title="Membership & Payment">
                <FieldRow label="Plan">{row.membership_type}</FieldRow>
                <FieldRow label="Fee">{formatINR(row.membership_fee)}</FieldRow>
                <FieldRow label="Payment">
                  <span className={`pay-pill ${paid ? 'paid' : 'pending'}`}><i />{paid ? 'Paid' : 'Pending'}</span>
                </FieldRow>
                <FieldRow label="Payment ref">
                  {row.payment_ref ? (
                    <span className="ref-inline">
                      <span className="mono">{row.payment_ref}</span>
                      <button type="button" className="ref-copy-mini" onClick={copyPaymentRef} aria-label="Copy payment reference">
                        {copiedRef ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </span>
                  ) : ''}
                </FieldRow>
                <FieldRow label="Transaction / UTR">{row.transaction_id}</FieldRow>
                {paymentInfo && <FieldRow label="Payment mode">{paymentInfo}</FieldRow>}
                {row.membership_id && (
                  <FieldRow label="Membership ID"><span className="mono">{row.membership_id}</span></FieldRow>
                )}
                {(renewalCount > 0 || renewalHist.length > 0) && (
                  <FieldRow label="Renewals">
                    <span>
                      {renewalCount}× · fee {formatINR(row.renewal_fees)}
                      {row.last_renewed_at ? ` · last ${formatDate(row.last_renewed_at)}` : ''}
                      {renewalHist.length > 0 && (
                        <span className="renewal-hist">
                          {renewalHist.map((p, i) => (
                            <span className="rh-row" key={i}>
                              <span>{p && p.date ? formatDate(p.date) : '—'}</span>
                              <b>{formatINR((p && Number(p.amount)) || 0)}</b>
                              <span className="mono">{(p && p.txn) || '—'}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </FieldRow>
                )}
                {row.start_date && row.end_date && (
                  <FieldRow label={row.status === 'APPROVED' ? 'Membership period' : 'Planned period'}>
                    <span className="date-period">
                      {row.status === 'APPROVED' ? (
                        <>
                          <span className="dp-range">{formatDate(row.start_date)} →</span>
                          <RenewalDate row={row} />
                        </>
                      ) : row.status === 'REJECTED' ? (
                        <span className="dp-range">{formatDate(row.start_date)} → {formatDate(row.end_date)}</span>
                      ) : (
                        <>
                          <RenewalDate row={row} />
                          <span className="dp-range">→ {formatDate(row.end_date)}</span>
                        </>
                      )}
                    </span>
                  </FieldRow>
                )}
              </Section>
            </>
          )}

          <div className="d-section">
            <h5 className="d-section-title">Documents</h5>
            {editing ? (
              <div className="doc-grid">
                {[
                  { key: 'passport', label: 'Passport photo', current: files.passport },
                  { key: 'identity', label: 'Identity proof', current: files.identity }
                ].map(({ key, label, current }) => (
                  <div key={key} className="doc-card">
                    <span className="doc-label">{label}</span>
                    {newPhotoPrev[key] ? (
                      <div className="doc-preview">
                        <img src={newPhotoPrev[key]} alt={label} />
                        <span className="doc-new-tag">New photo</span>
                      </div>
                    ) : current ? (
                      <a href={current} target="_blank" rel="noreferrer">
                        <img src={current} alt={label} />
                        <span className="doc-open"><ExternalLink size={13} /> Open</span>
                      </a>
                    ) : (
                      <p className="admin-empty">No file</p>
                    )}
                    <div className="doc-replace">
                      <label className="doc-replace-btn">
                        <ImagePlus size={13} /> Replace
                        <input
                          type="file"
                          accept="image/jpeg,image/png"
                          hidden
                          onChange={(e) => onPhotoChange(key, e.target.files[0])}
                        />
                      </label>
                      {newPhotos[key] && (
                        <button type="button" className="doc-remove-btn" onClick={() => clearNewPhoto(key)}>
                          <X size={13} /> Remove
                        </button>
                      )}
                    </div>
                    {newPhotoErr[key] && <p className="edit-error doc-err">{newPhotoErr[key]}</p>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="doc-list">
                {[
                  { key: 'passport', label: 'Passport photo', sub: '', current: files.passport },
                  {
                    key: 'identity',
                    label: row.identity_proof_type || 'Identity proof',
                    sub: row.identity_number || '',
                    current: files.identity
                  }
                ].map(({ key, label, sub, current }) => (
                  <div key={key} className="doc-item">
                    <span className="doc-item-icon">
                      {key === 'identity' ? <Contact size={17} /> : <UserRound size={17} />}
                    </span>
                    <span className="doc-item-main">
                      <strong>{label}</strong>
                      {sub && <small>{sub}</small>}
                    </span>
                    {current ? (
                      <button
                        type="button"
                        className="doc-view-btn doc-view-icon"
                        onClick={() => setPreview({ url: current, label })}
                        title="Preview document"
                        aria-label={`Preview ${label}`}
                      >
                        <Eye size={14} />
                      </button>
                    ) : (
                      <span className="doc-none">No file</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {!editing && (
            <div className="d-section">
              <h5 className="d-section-title">Activity</h5>
              <div className="activity-list">
                {activity.length === 0 && <p className="d-address-line d-muted">No activity yet</p>}
                {activity.map((a, i) => (
                  <div key={`${a.at}-${i}`} className={`act-item ${a.failed ? 'failed' : ''}`}>
                    <i className="act-dot" />
                    <div className="act-body">
                      <strong>{a.title}</strong>
                      <small>{formatDate(a.at)} · {formatTime(a.at)}</small>
                      {a.failed && a.err && <em>{a.err}</em>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="drawer-actions">
          {editing ? (
            <div className="d-actions">
              <button className="btn-act" onClick={cancelEdit} disabled={!!busy}>
                <X size={15} /> Cancel
              </button>
              <button className="btn-act approve d-actions-end" onClick={saveEdit} disabled={!!busy}>
                {busy === 'save' ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Save changes
              </button>
            </div>
          ) : (
            <div className="d-actions">
              <button className="btn-act" onClick={startEdit} disabled={!!busy}>
                <Pencil size={15} /> Edit
              </button>
              {row.status === 'PAYMENT_SUBMITTED' && (
                <button className="btn-act verify" onClick={verify} disabled={!!busy}>
                  {busy === 'verify' ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} Verify transaction
                </button>
              )}
              {(row.status === 'SUBMITTED' || row.status === 'VERIFIED' || row.status === 'PAYMENT_SUBMITTED') && (
                <button className="btn-act approve" onClick={approve} disabled={!!busy}>
                  {busy === 'approve' ? <Loader2 size={15} className="spin" /> : <BadgeCheck size={15} />} Approve & send email
                </button>
              )}
              {row.status === 'SUBMITTED' && (
                <button className="btn-act remind" onClick={sendReminder} disabled={!!busy}>
                  {busy === 'reminder' ? <Loader2 size={15} className="spin" /> : <Mail size={15} />} Send payment reminder
                </button>
              )}
              {row.status === 'APPROVED' && (
                <>
                  <button className="btn-act approve" onClick={() => { setRenewFee(row.membership_fee != null ? String(row.membership_fee) : ''); setRenewTxn(''); setRenewFrom((renewalPreview(row) || {}).from || ''); setConfirm('renew') }} disabled={!!busy}>
                    <RefreshCw size={15} /> Renew
                  </button>
                  <button className="btn-act pdf" onClick={printPdf} disabled={!!busy}>
                    {busy === 'pdf' ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Download PDF
                  </button>
                  <a className="btn-act whatsapp" href={waUrl} target="_blank" rel="noreferrer">
                    <MessageCircle size={15} /> WhatsApp
                  </a>
                  <a className="btn-act email" href={mailUrl}>
                    <Mail size={15} /> Email
                  </a>
                </>
              )}
              <div className={`d-actions-danger ${canReject ? '' : 'd-actions-end'}`}>
                {canReject && (
                  <button className="btn-act reject" onClick={() => setConfirm('reject')} disabled={!!busy}>
                    <Ban size={15} /> Reject
                  </button>
                )}
                <button className="btn-act danger" onClick={() => setConfirm('delete')} disabled={!!busy}>
                  <Trash2 size={15} /> Delete
                </button>
              </div>
            </div>
          )}
        </div>

        {confirm && (
          <div className="confirm-bar">
            {confirm === 'renew' ? (
              (() => {
                const txnOk = !!String(renewTxn || '').trim()
                const feeNum = Number(renewFee)
                const feeOk = Number.isFinite(feeNum) && feeNum >= 0
                const from = renewFrom || (renewP ? renewP.from : '')
                const to = from ? computeEndDate(from, row.membership_type) : ''
                const dateOk = !!from && !!to
                return (
                  <>
                    <p className="confirm-label">
                      Renew {row.membership_type || 'membership'} for {row.full_name}?{' '}
                      {dateOk ? (
                        <>
                          New period <b>{formatDate(from)} → {formatDate(to)}</b>
                          {renewP && from === renewP.from
                            ? renewP.keeps
                              ? ' (remaining days kept).'
                              : ' (starts from today).'
                            : '.'}
                        </>
                      ) : (
                        'Dates could not be computed for this plan.'
                      )}{' '}
                      Records {feeOk ? formatINR(feeNum) : '—'} as renewal fee.
                    </p>
                    <div className="renew-fields">
                      <div className="renew-field">
                        <span>Renewal start date *</span>
                        <input
                          className="confirm-input"
                          type="date"
                          value={renewFrom}
                          onChange={(e) => setRenewFrom(e.target.value)}
                        />
                      </div>
                      <div className="renew-field">
                        <span>Fee (₹)</span>
                        <input
                          className="confirm-input"
                          type="number"
                          min="0"
                          step="1"
                          value={renewFee}
                          onChange={(e) => setRenewFee(e.target.value)}
                          placeholder="Renewal fee"
                        />
                      </div>
                      <div className="renew-field">
                        <span>Transaction / UTR ID *</span>
                        <input
                          className="confirm-input"
                          type="text"
                          value={renewTxn}
                          onChange={(e) => setRenewTxn(e.target.value)}
                          placeholder="UTR of the renewal payment"
                          maxLength={64}
                          required
                        />
                      </div>
                    </div>
                    <div className="confirm-btns">
                      <button className="btn-act" onClick={() => setConfirm(null)}>Cancel</button>
                      <button className="btn-act approve" onClick={doRenew} disabled={busy === 'renew' || !txnOk || !feeOk || !dateOk}>
                        {busy === 'renew' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Renew membership
                      </button>
                    </div>
                  </>
                )
              })()
            ) : confirm === 'reject' ? (
              <>
                <label className="confirm-label">Rejection reason</label>
                <textarea
                  className="confirm-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this application being rejected?"
                />
                <div className="confirm-btns">
                  <button className="btn-act" onClick={() => setConfirm(null)}>Cancel</button>
                  <button className="btn-act danger" onClick={doReject} disabled={busy === 'reject'}>
                    {busy === 'reject' ? <Loader2 size={15} className="spin" /> : <XCircle size={15} />} Reject
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="confirm-label">Delete this application? This removes its uploaded files and cannot be undone.</p>
                <div className="confirm-btns">
                  <button className="btn-act" onClick={() => setConfirm(null)}>Cancel</button>
                  <button className="btn-act danger" onClick={doDelete} disabled={busy === 'delete'}>
                    {busy === 'delete' ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} Delete permanently
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {preview && (
        <div
          className="doc-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.label}
          onClick={(e) => {
            e.stopPropagation()
            setPreview(null)
          }}
        >
          <button
            type="button"
            className="doc-lightbox-close"
            onClick={(e) => {
              e.stopPropagation()
              setPreview(null)
            }}
            aria-label="Close preview"
          >
            <X size={20} />
          </button>
          <figure className="doc-lightbox-fig" onClick={(e) => e.stopPropagation()}>
            <img src={preview.url} alt={preview.label} />
            <figcaption>{preview.label}</figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}