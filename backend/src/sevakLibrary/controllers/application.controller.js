import * as applicationService from '../services/application.service.js'

// ── Public ────────────────────────────────────────────────────────────

// Multipart sends form fields as strings; a JSON payload arrives as an object.
const parseBodyData = (value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    try { return JSON.parse(value) } catch { return value }
  }
  return value || {}
}

export const submit = async (req, res, next) => {
  try {
    const files = req.files || {}
    const row = await applicationService.submitApplication({
      data: req.body || {},
      passportFile: files.passport && files.passport[0],
      identityFile: files.identity && files.identity[0],
      signatureFile: files.signature && files.signature[0],
    })
    res.status(201).json({ success: true, data: row })
  } catch (err) {
    next(err)
  }
}

export const getByRef = async (req, res, next) => {
  try {
    const row = await applicationService.getApplicationByRef(req.params.ref)
    if (!row) return res.status(404).json({ success: false, message: 'Application not found' })
    res.json({ success: true, data: row })
  } catch (err) {
    next(err)
  }
}

export const recordPayment = async (req, res, next) => {
  try {
    const row = await applicationService.recordPayment(req.body.ref, req.body.transactionId || req.body.transaction_id)
    res.json({ success: true, data: row })
  } catch (err) {
    next(err)
  }
}

// ── Admin (behind authenticate) ───────────────────────────────────────

export const dashboard = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.getDashboardStats() })
  } catch (err) {
    next(err)
  }
}

export const list = async (req, res, next) => {
  try {
    const { q, status, page, limit } = req.query
    res.json({ success: true, ...(await applicationService.listApplications({ q, status, page, limit })) })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.getApplicationById(req.params.id) })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const files = req.files || {}
    const bodyHasData = req.body && req.body.data != null
    const row = await applicationService.updateApplication(req.params.id, {
      data: bodyHasData ? parseBodyData(req.body.data) : req.body,
      transactionId: req.body.transactionId,
      passportFile: files.passport && files.passport[0],
      identityFile: files.identity && files.identity[0],
      signatureFile: files.signature && files.signature[0],
      removePassport: req.body.removePassport === 'true' || req.body.removePassport === true,
      removeIdentity: req.body.removeIdentity === 'true' || req.body.removeIdentity === true,
      removeSignature: req.body.removeSignature === 'true' || req.body.removeSignature === true,
    })
    res.json({ success: true, data: row })
  } catch (err) {
    next(err)
  }
}

export const remove = async (req, res, next) => {
  try {
    await applicationService.deleteApplication(req.params.id)
    res.json({ success: true, message: 'Application deleted' })
  } catch (err) {
    next(err)
  }
}

export const verify = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.verifyPayment(req.params.id) })
  } catch (err) {
    next(err)
  }
}

export const approve = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.approveApplication(req.params.id) })
  } catch (err) {
    next(err)
  }
}

export const reject = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.rejectApplication(req.params.id, req.body.reason) })
  } catch (err) {
    next(err)
  }
}

export const renew = async (req, res, next) => {
  try {
      res.json({ success: true, data: await applicationService.renewApplication(req.params.id, { fee: req.body.fee, transactionId: req.body.transactionId ?? req.body.transaction_id, startDate: req.body.startDate ?? req.body.start_date }) })
  } catch (err) {
    next(err)
  }
}

export const importMembers = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.importMembers(req.body.rows) })
  } catch (err) {
    next(err)
  }
}

export const mailLog = async (req, res, next) => {
  try {
    res.json({ success: true, data: await applicationService.getMailLog({ limit: req.query.limit }) })
  } catch (err) {
    next(err)
  }
}

export const photoUrl = async (req, res, next) => {
  try {
    const urls = await applicationService.getPhotoUrl(req.params.id, { format: req.query.format })
    if (!urls || (!urls.passport && !urls.identity)) return res.json({ success: true, data: null })
    res.json({ success: true, data: urls })
  } catch (err) {
    next(err)
  }
}

export const exportCsv = async (req, res, next) => {
  try {
    const result = await applicationService.listApplications({ q: req.query.q, status: req.query.status, page: 1, limit: 200 })
    const { applicationsCsv } = await import('../services/report.service.js')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="sevak-applications.csv"')
    res.send(applicationsCsv(result.data))
  } catch (err) {
    next(err)
  }
}