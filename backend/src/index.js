import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { execSync } from 'child_process';
import cors from 'cors';
import dotenv from 'dotenv';
import db from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import workerRoutes from './routes/workerRoutes.js';
import workerBankImportRoutes from './routes/workerBankImportRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import qrRoutes from './routes/qrRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import teamRoutes from './routes/teamRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import ngoRoutes from './routes/ngoRoutes.js';
import userRoutes from './routes/userRoutes.js';
import hrRoutes from './routes/hrRoutes.js';
import letterRoutes from './routes/letterRoutes.js';
import hrWhatsAppRoutes from './routes/hrWhatsAppRoutes.js';
import hrDailyReportRoutes from './routes/hrDailyReportRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import noticeRoutes from './routes/noticeRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import achievementRoutes from './routes/achievementRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import notificationAdminRoutes from './routes/notificationAdminRoutes.js';
import onboardingRoutes from './routes/onboardingRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import recruiterRoutes from './routes/recruiterRoutes.js';
import holidayRoutes from './routes/holidayRoutes.js';
import calendarRoutes from './routes/calendarRoutes.js';
import salaryRoutes from './routes/salaryRoutes.js';
import incentiveRoutes from './routes/incentiveRoutes.js';
import specialIncentiveRoutes from './routes/specialIncentiveRoutes.js';
import leadIncentiveRoutes from './routes/leadIncentiveRoutes.js';
import callLogRoutes from './routes/callLogRoutes.js';
import causeRoutes from './routes/causeRoutes.js';
import dataSourceRoutes from './routes/dataSourceRoutes.js';
import dataImportRoutes from './routes/dataImportRoutes.js';
import ngoAdminRoutes from './routes/ngoAdminRoutes.js';
import codeRoutes from './routes/codeRoutes.js';
import froRoutes from './routes/froRoutes.js';
import meetingRoutes from './routes/meetingRoutes.js';
import accountsRoutes from './routes/accountsRoutes.js';
import loanRoutes from './routes/loanRoutes.js';
import attendanceCorrectionRoutes from './routes/attendanceCorrectionRoutes.js';
import bankAuditRoutes from './routes/bankAuditRoutes.js';
import emailImportRoutes from './routes/emailImportRoutes.js';
import scraperRoutes from './routes/scraperRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import bankStatementRoutes from './routes/bankStatementRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import eventHeadRoutes from './routes/eventHeadRoutes.js';
import importantDaysRoutes from './routes/importantDaysRoutes.js';
import ocrRoutes from './routes/ocrRoutes.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import froWhatsAppRoutes from './routes/froWhatsAppRoutes.js';
import bulkAgentImportRoutes from './routes/bulkAgentImportRoutes.js';
import agentTransferRoutes from './routes/agentTransferRoutes.js';
import userSettingsRoutes from './routes/userSettingsRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import developerTicketRoutes from './routes/developerTicketRoutes.js';
import whatsappCrmRoutes from './routes/whatsappCrmRoutes.js';
import whatsappCrmDataRoutes from './routes/whatsappCrmDataRoutes.js';
import profileUpdateRequestRoutes from './routes/profileUpdateRequestRoutes.js';
import configRoutes from './routes/configRoutes.js';
import quizRoutes from './routes/quizRoutes.js';
import envAdminRoutes from './routes/envAdminRoutes.js';
import tempCleanupRoutes from './routes/tempCleanupRoutes.js';
import ngoAllocationRoutes from './routes/ngoAllocationRoutes.js';
import whatsappEnhancementsRoutes from './routes/whatsappEnhancementsRoutes.js';
import simCardRoutes from './routes/simCardRoutes.js';
import simInventoryRoutes from './routes/simInventoryRoutes.js';
import reminderRoutes from './routes/reminderRoutes.js';
import assetsRoutes from './routes/assetsRoutes.js';
import certificateRoutes from './routes/certificateRoutes.js';
import beneficiaryRoutes from './routes/beneficiaryRoutes.js';
import beneficiaryImportRoutes from './routes/beneficiaryImportRoutes.js';
import programRoutes from './routes/programRoutes.js';
import s3BrowserRoutes from './routes/s3BrowserRoutes.js';
import { requireAdminKey } from './middleware/requireAdminKey.js';
import benefitRoutes from './routes/benefitRoutes.js';
import distributionRoutes from './routes/distributionRoutes.js';
import biometricRoutes from './routes/biometricRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import operatorRoutes from './routes/operatorRoutes.js';
import aadhaarRoutes from './aadhaar/routes.js';
import metropadRouter from './metropad/router.js';
import votingRoutes from './routes/votingRoutes.js';
import audienceVotingRoutes from './routes/audienceVotingRoutes.js';
import sevakLibraryRouter from './sevakLibrary/router.js';
import { whatsappLogin } from './controllers/froWhatsAppAuthController.js';
import { startMemoryWatchdog } from './services/memoryWatchdog.js';
import { authenticate } from './middleware/authMiddleware.js';
import { localDbAccess, ensureLocalDbAccess, registerLocalDbAccessCleanup } from './middleware/localDbAccess.js';
import { ensureEventHeadSchema } from './bootstrap/ensureEventHeadSchema.js';
import { ensureTicketSchema } from './bootstrap/ensureTicketSchema.js';
import { ensureLoanDeductionSchema } from './bootstrap/ensureLoanDeductionSchema.js';
import { ensureSpecialIncentiveSchema } from './bootstrap/ensureSpecialIncentiveSchema.js';
import { ensureSalaryHoldSchema } from './bootstrap/ensureSalaryHoldSchema.js';
import { ensureCertificateSchema } from './bootstrap/ensureCertificateSchema.js';
import { ensureAuthSessionSchema } from './bootstrap/ensureAuthSessionSchema.js';
import { ensureNoticeSchema } from './bootstrap/ensureNoticeSchema.js';
import { ensureFroLiveStatusSchema } from './bootstrap/ensureFroLiveStatusSchema.js';
import { ensureFroTimeSessionsAgentSchema } from './bootstrap/ensureFroTimeSessionsAgentSchema.js';
import { ensureMeetingSchema } from './bootstrap/ensureMeetingSchema.js';
import { ensureReminderPushSchema } from './bootstrap/ensureReminderPushSchema.js';
import { ensureChatSchema } from './bootstrap/ensureChatSchema.js';
import { ensureSimInventorySchema } from './bootstrap/ensureSimInventorySchema.js';
import { ensureBeneficiarySchema } from './bootstrap/ensureBeneficiarySchema.js';
import { ensureOperatorSchema } from './bootstrap/ensureOperatorSchema.js';
import { ensureVotingSchema } from './bootstrap/ensureVotingSchema.js';
import { ensureAudienceVotingSchema } from './bootstrap/ensureAudienceVotingSchema.js';
import { ensureSignatureSchema } from './bootstrap/ensureSignatureSchema.js';
import { ensureDocumentsSchema } from './bootstrap/ensureDocumentsSchema.js';
import { ensureLeadsRecruiterFkSchema } from './bootstrap/ensureLeadsRecruiterFkSchema.js';
import { ensureSevakRenewalSchema } from './bootstrap/ensureSevakRenewalSchema.js';
import { ensureStationAgentOfRecordSchema } from './bootstrap/ensureStationAgentOfRecordSchema.js';
import { ensureFroDonorLogOperatorSchema } from './bootstrap/ensureFroDonorLogOperatorSchema.js';
import { ensureSevakSignatureSchema } from './bootstrap/ensureSevakSignatureSchema.js';
import { aiSuggestionsStartupReport } from './utils/aiSuggestions.js';

dotenv.config();

const _log = console.log;

/* Reports which AI provider will answer Event Head suggestions, and in what
   order. Provider name and model only — never a key, a key length, a prefix or
   the request URL, all of which would leak the credential into logs.

   Deliberately a module-level statement, not part of the app.listen callback:
   on Vercel the listen block is skipped entirely (see `if (!process.VERCEL)`),
   so a cold-start function invocation would never print it. Here it appears in
   local boots and in the Vercel function log alike, which is the difference
   between noticing a missing env var immediately and discovering it from a user
   saying the button does nothing. */
_log(aiSuggestionsStartupReport());

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 'loopback');

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Type', 'x-admin-key'],
}));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString(); },
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const froDist = path.resolve(__dirname, '../../fro-panel/dist');
const ngoAdminDist = path.resolve(__dirname, '../../ngo-admin-panel/dist');
const accountsDist = path.resolve(__dirname, '../../accounts-panel/dist');
const whatsappDist = path.resolve(__dirname, '../../whatsapp-crm/dist');
const databaseDist = path.resolve(__dirname, '../../database/dist');
const recruitDist = path.resolve(__dirname, '../../recruit-quizz/dist');
const votingDist = path.resolve(__dirname, '../../others/voting/dist');
const audienceVotingDist = path.resolve(__dirname, '../../others/audience-voting/dist');
const sevakLibraryDist = path.resolve(__dirname, '../../others/sevak-library/sevak-library/dist');

const REPO_ROOT = path.resolve(__dirname, '../..');
let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000 }).trim();
} catch {}
const serverStartedAt = new Date();

app.get(['/aws', '/api/aws'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'ucs-crm-backend',
    commit: gitCommit,
    version: '1.0.0',
    started_at: serverStartedAt.toISOString(),
    now: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.get(['/health', '/api/health'], async (req, res) => {
  try {
    await db._pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'ok',
      commit: gitCommit,
      uptime_seconds: Math.round(process.uptime()),
      now: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      db: 'down',
      error: error.message,
      now: new Date().toISOString(),
    });
  }
});

// Mounted after /aws and /health on purpose: those stay reachable as a
// diagnostic when database access is the thing that is broken. The actual
// authorize/revoke work is memoized inside, so running per request is cheap —
// see middleware/localDbAccess.js.
app.use('/api', localDbAccess);

app.get(['/api/shon', '/api/test-shon'], (req, res) => {
  res.json({ message: 'hello how are you shon' });
});

app.get('/api/fro-count', async (req, res) => {
  try {
    const { count } = await db.from('workers').select('id', { count: 'exact', head: true }).eq('department', 'fro');
    const { data: rows } = await db.from('workers').select('id, name, login_id, is_active').eq('department', 'fro');
    res.json({ fro_count: count, workers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/api/auth', authRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/workers', workerBankImportRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/ngos', ngoRoutes);
app.use('/api/users', userRoutes);
app.use('/api/hrs', hrRoutes);
app.use('/api/letters', letterRoutes);
app.use('/api/hr/whatsapp', hrWhatsAppRoutes);
app.use('/api/hr-reports', hrDailyReportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/notices', noticeRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/achievements', achievementRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin/notifications', notificationAdminRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/call-logs', callLogRoutes);
app.use('/api/recruiters', recruiterRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/incentive', incentiveRoutes);
app.use('/api/incentive/special', specialIncentiveRoutes);
app.use('/api/incentive/lead', leadIncentiveRoutes);
app.use('/api/causes', causeRoutes);
app.use('/api/data-sources', dataSourceRoutes);
app.use('/api/data-import', dataImportRoutes);
app.use('/api/ngo-admin', ngoAdminRoutes);
app.use('/api/impersonation-codes', codeRoutes);
app.post('/api/whatsapp/fro-login', whatsappLogin);
app.use('/api/fro/whatsapp', froWhatsAppRoutes);
app.use('/api/fro', froRoutes);
app.use('/api/meeting', meetingRoutes);
app.use('/api/accounts/scraper', scraperRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/advances', loanRoutes);
app.use('/api/attendance-corrections', attendanceCorrectionRoutes);
app.use('/api/accounts/bank-audit', bankAuditRoutes);
app.use('/api/accounts/email-import', emailImportRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/accounts/bank-statement', bankStatementRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/whatsapp', whatsappEnhancementsRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/event-head', eventHeadRoutes);
app.use('/api/important-days', importantDaysRoutes);
app.use('/api/user-settings', userSettingsRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/developer-tickets', developerTicketRoutes);
app.use('/api/whatsapp/agents', bulkAgentImportRoutes);
app.use('/api/whatsapp/agents', agentTransferRoutes);
app.use('/api/whatsapp-crm', whatsappCrmRoutes);
app.use('/api/whatsapp-crm', whatsappCrmDataRoutes);
app.use('/api/profile-update-requests', profileUpdateRequestRoutes);
app.use('/api/config', configRoutes);
app.use('/api/quiz', quizRoutes);
app.use('/api/envadmin', envAdminRoutes);
app.use('/api/s3', s3BrowserRoutes);
app.use('/api/temp-cleanup', tempCleanupRoutes);
app.use('/api/ngo-allocations', ngoAllocationRoutes);
app.use('/api/sim-cards', simCardRoutes);
app.use('/api/sim-inventory', simInventoryRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/beneficiaries', beneficiaryRoutes);
app.use('/api/beneficiaries/import', beneficiaryImportRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/benefits', benefitRoutes);
app.use('/api/distributions', distributionRoutes);
app.use('/api/biometrics', biometricRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/operator', operatorRoutes);
app.use('/api/aadhaar', aadhaarRoutes);
app.use('/api/metropad', metropadRouter);
app.use('/api/voting', votingRoutes);
app.use('/api/audience-voting', audienceVotingRoutes);
app.use('/api/sevak-library', sevakLibraryRouter);

app.get('/api/deploy-test', (req, res) => {
  res.json({ status: 'ok', deployed: true, timestamp: new Date().toISOString(), commit: 'shon2-deploy-test' });
});

import multer from 'multer';
const uploadApi = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/quicktime',
];
app.post('/api/upload', authenticate, uploadApi.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file' });
  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ message: 'File type not allowed' });
  }
  const ext = (req.file.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
  const fileName = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { error: uploadErr } = await db.storage.from('whatsapp-media').upload(fileName, req.file.buffer, {
    contentType: req.file.mimetype, upsert: false,
  });
  if (uploadErr) return res.status(500).json({ message: uploadErr.message });
  const { data: urlData } = db.storage.from('whatsapp-media').getPublicUrl(fileName);
  res.json({ url: urlData?.publicUrl, name: req.file.originalname, type: req.file.mimetype });
});

app.post('/api/whatsapp/send', authenticate, express.json(), async (req, res) => {
  try {
    const { conversationId, contactId, messageText, mediaUrl, mediaMimeType, userId, phoneNumber, messageId } = req.body;
    if (!conversationId) return res.status(400).json({ message: 'Missing conversationId' });

    let toPhone = phoneNumber;
    let convInfo = null;
    if (!toPhone && contactId) {
      const { data: c } = await db.from('contacts').select('phone_normalized').eq('id', contactId).maybeSingle();
      if (c) toPhone = c.phone_normalized;
    }
    if (!toPhone) {
      const { data: conv } = await db.from('conversations').select('*, contact:contacts(phone_normalized)').eq('id', conversationId).maybeSingle();
      toPhone = conv?.contact?.phone_normalized;
      convInfo = conv;
    }
    if (!toPhone) return res.status(400).json({ message: 'No phone number found' });

    let accounts = [];
    const accId = convInfo?.whatsapp_account_id;
    if (accId) {
      const { data } = await db.from('whatsapp_accounts').select('phone_number_id, access_token').eq('id', accId).eq('is_active', true);
      if (data && data.length > 0) accounts = data;
    }
    if (accounts.length === 0) {
      const { data } = await db.from('whatsapp_accounts').select('phone_number_id, access_token').eq('is_active', true);
      if (data) accounts = data;
    }
    if (!accounts.length) return res.status(500).json({ message: 'No active WhatsApp account' });

    const mime = mediaMimeType || '';
    const msgType = mediaUrl ? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document') : 'text';

    let msg;
    if (messageId) {
      const { data: existing } = await db.from('messages').select('*').eq('id', messageId).maybeSingle();
      msg = existing;
    }
    if (!msg) {
      const { data: newMsg, error: msgErr } = await db.from('messages').insert({
        conversation_id: conversationId,
        contact_id: contactId || null,
        user_id: userId || null,
        direction: 'outbound',
        message_type: msgType,
        body_text: mediaUrl ? '' : (messageText || ''),
        media_url: mediaUrl || null,
        media_mime_type: mediaMimeType || null,
        status: 'queued',
      }).select().single();
      if (msgErr) return res.status(500).json({ message: msgErr.message });
      msg = newMsg;
    }

    if (mediaUrl && (mediaMimeType?.startsWith('audio/') || mime.startsWith('audio/'))) {
      try {
        const download = await fetch(mediaUrl);
        if (!download.ok) throw new Error('Failed to download media');
        const buffer = Buffer.from(await download.arrayBuffer());
        const ext = (mediaMimeType || 'audio/mp4').split('/')[1]?.split(';')[0] || 'mp4';
        const boundary = 'up' + Math.random().toString(36).slice(2);
        const metaBody = Buffer.concat([
          Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n' +
            '--' + boundary + '\r\nContent-Disposition: form-data; name="type"\r\n\r\n' + (mediaMimeType || 'audio/mp4') + '\r\n' +
            '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.' + ext + '"\r\nContent-Type: ' + (mediaMimeType || 'audio/mp4') + '\r\n\r\n'),
          buffer,
          Buffer.from('\r\n--' + boundary + '--\r\n'),
        ]);
        const upRes = await fetch(`https://graph.facebook.com/v23.0/${accounts[0].phone_number_id}/media`, {
          method: 'POST', headers: { Authorization: `Bearer ${accounts[0].access_token}`, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          body: metaBody,
        });
        const upData = await upRes.json();
        if (upRes.ok && upData.id) {
          const sendRes = await fetch(`https://graph.facebook.com/v23.0/${accounts[0].phone_number_id}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accounts[0].access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp', to: toPhone.replace(/[^0-9]/g, ''),
              type: 'audio', audio: { id: upData.id },
            }),
          });
          const sendData = await sendRes.json();
          if (sendRes.ok && sendData.messages?.[0]?.id) {
            await db.from('messages').update({ status: 'sent', wa_message_id: sendData.messages[0].id, status_updated_at: new Date().toISOString() }).eq('id', msg.id);
            return res.json({ success: true });
          }
        }
      } catch (audioErr) {
        console.error('Audio send error:', audioErr);
      }
    }

    await db.from('messages').update({ status: 'failed', failure_reason: 'Meta send failed', status_updated_at: new Date().toISOString() }).eq('id', msg.id);
    res.json({ message: 'Meta send failed', msg });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/whatsapp/send-file', authenticate, uploadApi.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file' });
    const { messageId, conversationId, contactId, userId } = req.body;
    if (!messageId || !conversationId) return res.status(400).json({ message: 'Missing fields' });

    const file = req.file;
    const ext = (file.mimetype || 'bin').split('/')[1]?.split(';')[0] || 'bin';
    const fileName = `msg_${messageId}_${Date.now()}.${ext}`;
    const { error: storeErr } = await db.storage.from('whatsapp-media').upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });
    if (storeErr) return res.status(500).json({ message: 'Storage upload failed', error: storeErr.message });

    const { data: urlData } = db.storage.from('whatsapp-media').getPublicUrl(fileName);
    const mediaUrl = urlData?.publicUrl || '';

    const mimeType = file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : file.mimetype.startsWith('audio/') ? 'audio' : 'document';
    await db.from('messages').update({ media_url: mediaUrl, media_mime_type: file.mimetype, message_type: mimeType }).eq('id', messageId);

    let toPhone = '';
    if (contactId) {
      const { data: c } = await db.from('contacts').select('phone_normalized').eq('id', contactId).maybeSingle();
      if (c) toPhone = c.phone_normalized;
    }
    if (!toPhone) {
      const { data: conv } = await db.from('conversations').select('*, contact:contacts(phone_normalized)').eq('id', conversationId).maybeSingle();
      if (conv?.contact) toPhone = conv.contact.phone_normalized;
    }
    if (!toPhone) {
      await db.from('messages').update({ status: 'sent', failure_reason: 'No phone' }).eq('id', messageId);
      return res.json({ message: 'No phone found, saved to storage only', mediaUrl });
    }

    let accounts = [];
    const { data: convAcc } = await db.from('conversations').select('whatsapp_account_id').eq('id', conversationId).maybeSingle();
    const fileAccId = convAcc?.whatsapp_account_id;
    if (fileAccId) {
      const { data } = await db.from('whatsapp_accounts').select('phone_number_id, access_token').eq('id', fileAccId).eq('is_active', true);
      if (data && data.length > 0) accounts = data;
    }
    if (accounts.length === 0) {
      const { data } = await db.from('whatsapp_accounts').select('phone_number_id, access_token').eq('is_active', true);
      if (data) accounts = data;
    }
    if (!accounts.length) {
      await db.from('messages').update({ status: 'sent', failure_reason: 'No WhatsApp account' }).eq('id', messageId);
      return res.json({ message: 'No active account, saved to storage only', mediaUrl });
    }

    let metaDelivered = false;
    try {
      const boundary = 'up' + Math.random().toString(36).slice(2);
      const metaBody = Buffer.concat([
        Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n' +
          '--' + boundary + '\r\nContent-Disposition: form-data; name="type"\r\n\r\n' + file.mimetype + '\r\n' +
          '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="media.' + ext + '"\r\nContent-Type: ' + file.mimetype + '\r\n\r\n'),
        file.buffer,
        Buffer.from('\r\n--' + boundary + '--\r\n'),
      ]);
      const upR = await fetch(`https://graph.facebook.com/v23.0/${accounts[0].phone_number_id}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accounts[0].access_token}`, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: metaBody,
      });
      const upD = await upR.json();
      if (upR.ok && upD.id) {
        const payload = {
          messaging_product: 'whatsapp',
          to: toPhone.replace(/[^0-9]/g, ''),
          type: mimeType,
          [mimeType]: mimeType === 'document' ? { id: upD.id, caption: '' } : { id: upD.id },
        };
        const sR = await fetch(`https://graph.facebook.com/v23.0/${accounts[0].phone_number_id}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${accounts[0].access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const sD = await sR.json();
        if (sR.ok && sD.messages?.[0]?.id) {
          await db.from('messages').update({ status: 'sent', wa_message_id: sD.messages[0].id, status_updated_at: new Date().toISOString() }).eq('id', messageId);
          metaDelivered = true;
        }
      }
    } catch (e) { console.error('Meta send error:', e); }

    if (!metaDelivered) {
      await db.from('messages').update({ status: 'failed', failure_reason: 'Meta send failed', status_updated_at: new Date().toISOString() }).eq('id', messageId);
    }

    await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);
    res.json({ success: true, mediaUrl, metaDelivered });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

// ---------------------------------------------------------------------------
// DB viewer (dev/debug tool): read-only table browser.
//   GET /db-viewer                  -> the HTML page
//   GET /api/db/tables              -> [{ name, approx_rows }]
//   GET /api/db/table/:table        -> { columns, rows, count } with optional
//                                      ?limit, ?offset, ?order, ?desc, ?search, ?column
//   POST /api/db/rows/update        -> update cells of one row by primary key
// ---------------------------------------------------------------------------
app.get('/db-viewer', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../db-viewer.html'));
});

app.get('/env-admin', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../others/env-admin.html'));
});

app.get('/api/db/tables', async (req, res) => {
  try {
    const { rows } = await db._pool.query(`
      SELECT c.relname AS name,
             (CASE WHEN c.reltuples > 0 THEN c.reltuples::bigint ELSE 0 END) AS approx_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
      ORDER BY c.relname
    `);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/db/table/:table', async (req, res) => {
  try {
    const t = String(req.params.table);
    // is_generated / is_identity / is_updatable let the grid know which cells
    // can be edited in place: generated columns (stored generated, identity)
    // and view columns cannot be written by a plain UPDATE.
    const schema = await db._pool.query(
      `SELECT column_name, data_type, is_generated, is_identity, is_updatable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [t]
    );
    if (schema.rows.length === 0) return res.status(404).json({ message: `Table "${t}" not found` });
    const cols = schema.rows.map((r) => r.column_name);

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let order = cols.includes('created_at') ? 'created_at' : cols[0];
    if (req.query.order && cols.includes(String(req.query.order))) order = String(req.query.order);
    const ascending = req.query.desc !== '1';

    const q = db.from(t).select('*', { count: 'exact', head: false });
    if (req.query.search && req.query.column && cols.includes(String(req.query.column))) {
      q.ilike(String(req.query.column), `%${String(req.query.search)}%`);
    } else if (req.query.search) {
      const textCol = cols.find((c) => c !== 'id' && c !== 'created_at' && !c.endsWith('_id'));
      if (textCol) q.ilike(textCol, `%${String(req.query.search)}%`);
    }

    const pk = await getPkCols(t);
    const { data, count, error } = await q.order(order, { ascending }).range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ table: t, columns: schema.rows, pk, rows: data, count, limit, offset, order });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

async function getPkCols(table) {
  const { rows } = await db._pool.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function tableExists(name) {
  const { rows } = await db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return rows.length > 0;
}

// Run arbitrary SQL (dev tool). Returns a result set if the query produces one.
// [[explore]]-Splits a multi-statement SQL script on top-level semicolons,
// respecting dollar-quoted strings ($$...$$, $tag$...$tag$), single-quoted
// strings with '' escapes, and double-dash line comments. Empty statements
// are dropped. Used by the db-viewer query runner so migration scripts with
// many CREATE TABLE / INDEX statements can run as one paste.
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  const flush = () => {
    const s = current.trim();
    if (s) statements.push(s);
    current = '';
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') { current += sql[i]; i += 1; }
      continue;
    }

    if (c === "'") {
      current += c; i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { current += sql[i + 1]; i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }

    if (c === '$') {
      let j = i;
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const delim = tagMatch[0];
        current += delim;
        i += delim.length;
        const closeIdx = sql.indexOf(delim, i);
        if (closeIdx === -1) { current += sql.slice(i); i = n; }
        else { current += sql.slice(i, closeIdx + delim.length); i = closeIdx + delim.length; }
        continue;
      }
    }

    if (c === ';') { flush(); i += 1; continue; }

    current += c; i += 1;
  }
  flush();
  return statements;
}

app.post('/api/db/query', async (req, res) => {
  try {
    const sql = String(req.body && req.body.sql || '').trim();
    if (!sql) return res.status(400).json({ message: 'No SQL provided' });
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) return res.status(400).json({ message: 'No SQL statements provided' });

    const client = await db._pool.connect();
    let command = null;
    let rowCount = null;
    let fields = [];
    let rows = [];
    const commands = [];
    try {
      await client.query('BEGIN');
      for (const stmt of statements) {
        const r = await client.query(stmt);
        command = r.command || command;
        rowCount = r.rowCount ?? rowCount;
        fields = (r.fields || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
        rows = r.rows || [];
        if (r.command) commands.push(r.command);
      }
      await client.query('COMMIT');
      res.json({ command, commands, statementCount: statements.length, rowCount, columns: fields, rows });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection may be dead */ }
      res.status(400).json({ message: err.message, hint: err.hint || '', code: err.code || '' });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(400).json({ message: err.message, hint: err.hint || '', code: err.code || '' });
  }
});

// Drop an entire table (dev tool).
app.post('/api/db/drop-table', async (req, res) => {
  try {
    const t = String(req.body && req.body.table || '').trim();
    if (!/^[A-Za-z0-9_]+$/.test(t)) return res.status(400).json({ message: 'Invalid table name' });
    if (!(await tableExists(t))) return res.status(404).json({ message: `Table "${t}" not found` });
    await db._pool.query(`DROP TABLE "${t}"`);
    res.json({ ok: true, table: t });
  } catch (err) {
    res.status(400).json({ message: err.message, hint: err.hint || '', code: err.code || '' });
  }
});

// Delete specific rows by primary key (dev tool).
app.post('/api/db/rows/delete', async (req, res) => {
  try {
    const t = String(req.body && req.body.table || '').trim();
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!/^[A-Za-z0-9_]+$/.test(t)) return res.status(400).json({ message: 'Invalid table name' });
    if (rows.length === 0) return res.status(400).json({ message: 'No rows selected' });
    if (!(await tableExists(t))) return res.status(404).json({ message: `Table "${t}" not found` });

    const pk = await getPkCols(t);
    if (pk.length === 0) return res.status(400).json({ message: 'Table has no primary key — use the query runner to delete rows' });

    const params = [];
    const clauses = [];
    for (const row of rows) {
      const conds = [];
      for (const col of pk) {
        const val = row[col];
        if (val === undefined) return res.status(400).json({ message: `Selected row is missing PK column "${col}"` });
        params.push(val);
        conds.push(`"${col}" = $${params.length}`);
      }
      clauses.push(`(${conds.join(' AND ')})`);
    }
    const sql = `DELETE FROM "${t}" WHERE ${clauses.join(' OR ')}`;
    const r = await db._pool.query(sql, params);
    res.json({ ok: true, table: t, rowCount: r.rowCount });
  } catch (err) {
    res.status(400).json({ message: err.message, hint: err.hint || '', code: err.code || '' });
  }
});

// Columns a plain UPDATE may write: skips stored-generated columns, identity
// columns and anything marked read-only. Used to validate grid cell edits.
async function getEditableCols(table) {
  const { rows } = await db._pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND is_generated = 'NEVER' AND is_identity = 'NO' AND is_updatable = 'YES'`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

// Update individual columns on one row, located by primary key (dev tool).
// Powers in-place cell editing in the db-viewer grid. A value of null stores
// SQL NULL; anything else is sent as a text parameter and Postgres casts it
// to the column type, so the same endpoint serves text, numeric, boolean,
// uuid, date and json/jsonb columns.
app.post('/api/db/rows/update', async (req, res) => {
  try {
    const t = String(req.body && req.body.table || '').trim();
    const pk = (req.body && req.body.pk) || {};
    const values = (req.body && req.body.values) || {};
    if (!/^[A-Za-z0-9_]+$/.test(t)) return res.status(400).json({ message: 'Invalid table name' });
    const cols = Object.keys(values);
    if (cols.length === 0) return res.status(400).json({ message: 'No column values provided' });
    if (!(await tableExists(t))) return res.status(404).json({ message: `Table "${t}" not found` });

    const pkCols = await getPkCols(t);
    if (pkCols.length === 0) return res.status(400).json({ message: 'Table has no primary key — use the query runner to update rows' });

    const editable = new Set(await getEditableCols(t));
    for (const col of cols) {
      if (!editable.has(col)) return res.status(400).json({ message: `Column "${col}" cannot be edited` });
    }

    const params = [];
    const sets = [];
    for (const col of cols) {
      const v = values[col];
      if (typeof v === 'object' && v !== null) {
        return res.status(400).json({ message: `Value for "${col}" must be text or null` });
      }
      params.push(v);
      sets.push(`"${col}" = $${params.length}`);
    }
    const conds = [];
    for (const col of pkCols) {
      if (pk[col] === undefined || pk[col] === null) {
        return res.status(400).json({ message: `Missing primary key value "${col}"` });
      }
      params.push(pk[col]);
      conds.push(`"${col}" = $${params.length}`);
    }

    const r = await db._pool.query(
      `UPDATE "${t}" SET ${sets.join(', ')} WHERE ${conds.join(' AND ')} RETURNING *`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ message: 'Row no longer exists — reload the table' });
    res.json({ ok: true, table: t, rowCount: r.rowCount, row: r.rows[0] });
  } catch (err) {
    res.status(400).json({ message: err.message, hint: err.hint || '', code: err.code || '' });
  }
});

// Amazon RDS instance capacity (storage / CPU / memory / connections).
app.get('/api/db/capacity', async (req, res) => {
  try {
    const { getRDSCapacity } = await import('./services/rdsCapacity.js');
    res.json(await getRDSCapacity());
  } catch (err) {
    res.status(500).json({ ok: false, configured: false, reason: err.message });
  }
});

// Image/file preview for a stored URL: GET /api/db/media?url=<value>
//
// The table browser hands this whatever a photo/signature/scan column holds.
// Supabase public URLs are redirected straight through (the browser can fetch
// those on its own); private S3 buckets come back 403 from a plain <img>, so
// they are streamed with the app's own credentials. Behind the same
// ENV_ADMIN_KEY guard as the S3 browser — this reads Aadhaar scans and
// signatures, which should not be served to anyone who asks.
app.get('/api/db/media', requireAdminKey, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ message: 'Missing url' });

  let parsed = null;
  try { parsed = new URL(url); } catch (e) { /* handled below */ }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    return res.status(400).json({ message: 'Only http(s) URLs can be previewed' });
  }

  try {
    const { parseS3Url, openStoredObject } = await import('./services/mediaProxy.js');
    if (!parseS3Url(url)) {
      // Not ours to fetch — hand the browser the original URL.
      return res.redirect(302, url);
    }

    const o = await openStoredObject(url);
    if (!o) {
      const bucket = parseS3Url(url).bucket;
      return res.status(404).json({
        message: `No configured S3 account can read "${bucket}" — its access key is not in backend/.env`,
      });
    }

    res.setHeader('Content-Type', o.contentType);
    if (o.contentLength != null) res.setHeader('Content-Length', String(o.contentLength));
    if (o.lastModified) res.setHeader('Last-Modified', new Date(o.lastModified).toUTCString());
    // Private, short-lived: these are PII documents and a dev tool has no
    // business leaving them in a shared disk cache.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // inline (unlike the S3 browser's download route) so it can render in an
    // <img>; scripts are neutralised because the source is a bucket, not us.
    if (/^image\//.test(o.contentType) && o.contentType !== 'image/svg+xml') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    } else {
      res.setHeader('Content-Disposition', 'attachment');
    }

    const body = o.body;
    if (body && typeof body.pipe === 'function') {
      body.on('error', (e) => { console.error(`[db-media] stream failed for ${o.key}: ${e.message}`); res.destroy(); });
      return body.pipe(res);
    }
    return res.send(Buffer.from(await body.transformToByteArray()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Customer provisioning: dedicated Postgres database + S3 bucket + IAM user.
app.post('/api/customer/provision', async (req, res) => {
  try {
    const { provisionCustomer } = await import('./services/customerProvision.js');
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ message: 'Customer name is required' });
    res.json(await provisionCustomer(name));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.get('/api/customer/list', async (req, res) => {
  try {
    const { listCustomers } = await import('./services/customerProvision.js');
    res.json(await listCustomers());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const bankImportDist = path.resolve(__dirname, '../public/bank-import');
app.use('/bank-import', express.static(bankImportDist));

if (fs.existsSync(whatsappDist)) {
  app.use('/whatsapp/assets', express.static(path.join(whatsappDist, 'assets')));
  app.get('/whatsapp*', (req, res) => {
    res.sendFile(path.join(whatsappDist, 'index.html'));
  });
}

if (fs.existsSync(databaseDist)) {
  app.use('/database/assets', express.static(path.join(databaseDist, 'assets')));
  app.get('/database*', (req, res) => {
    res.sendFile(path.join(databaseDist, 'index.html'));
  });
}

if (fs.existsSync(froDist)) {
  app.use('/assets', express.static(path.join(froDist, 'assets')));
  // `audience-voting` is excluded from the FRO catch-all below, which is
  // registered BEFORE this app's own mount and would otherwise answer every
  // /audience-voting request with the FRO SPA. Note that `voting` in this list
  // does not cover it: the path starts with "audience-", not "voting".
  app.get(/^\/(?!api\/|admin$|admin\/|accounts$|accounts\/|whatsapp|bank-import|database|voting|audience-voting|sevak-library).*$/, (req, res) => {
    res.sendFile(path.join(froDist, 'index.html'));
  });
  app.get('/', (req, res) => {
    res.sendFile(path.join(froDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({ message: 'Attendance API is running' });
  });
}

if (fs.existsSync(ngoAdminDist)) {
  app.use('/admin/assets', express.static(path.join(ngoAdminDist, 'assets')));
  app.get('/admin*', (req, res) => {
    res.sendFile(path.join(ngoAdminDist, 'index.html'));
  });
}

if (fs.existsSync(accountsDist)) {
  app.use('/accounts/assets', express.static(path.join(accountsDist, 'assets')));
  app.get('/accounts*', (req, res) => {
    res.sendFile(path.join(accountsDist, 'index.html'));
  });
}

if (fs.existsSync(recruitDist)) {
  app.use('/recruit-quizz/assets', express.static(path.join(recruitDist, 'assets')));
  app.get('/recruit-quizz*', (req, res) => {
    res.sendFile(path.join(recruitDist, 'index.html'));
  });
}

// Award ceremony voting booth. Served from the same origin as the API so the
// app can talk to /api/voting without a cross-origin preflight, mirroring the
// recruit-quizz mount above.
if (fs.existsSync(votingDist)) {
  app.use('/voting/assets', express.static(path.join(votingDist, 'assets')));
  app.get('/voting*', (req, res) => {
    res.sendFile(path.join(votingDist, 'index.html'));
  });
}

// Audience voting booth. Same arrangement as the ceremony booth above: served
// from the API origin so the app can reach /api/audience-voting without a
// cross-origin preflight, which matters because that app has no auth header to
// preflight with.
if (fs.existsSync(audienceVotingDist)) {
  app.use('/audience-voting/assets', express.static(path.join(audienceVotingDist, 'assets')));
  app.get('/audience-voting*', (req, res) => {
    res.sendFile(path.join(audienceVotingDist, 'index.html'));
  });
}

// Sevak Library membership admission app. Built from others/sevak-library and
// served from the API origin so the PWA can talk to /api/sevak-library without
// a cross-origin hop. The `sevak-library` exclusion above stops the FRO SPA
// catch-all from answering these paths first. Serve the whole dist directory
// (assets, manifest, service worker) and fall back to the SPA shell for
// hash-routed deep links.
if (fs.existsSync(sevakLibraryDist)) {
  app.use('/sevak-library', express.static(sevakLibraryDist));
  app.get('/sevak-library*', (req, res) => {
    res.sendFile(path.join(sevakLibraryDist, 'index.html'));
  });
}

const CRON_API_KEY = process.env.CRON_API_KEY;
if (!CRON_API_KEY) {
  console.warn('WARNING: CRON_API_KEY is not set. Cron endpoints will be inaccessible.');
}
const requireCronAuth = (req, res, next) => {
  if (!CRON_API_KEY) {
    return res.status(503).json({ message: 'Cron endpoints not configured' });
  }
  if (req.headers['x-api-key'] !== CRON_API_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
};

    app.post('/api/cron/notifications', requireCronAuth, async (req, res) => {
      try {
        const { runNotificationCycle, sendScheduledNotifications, sendPunchInReminders, sendPunchOutReminders } =
          await import('./services/notificationScheduler.js');
        await Promise.all([
          runNotificationCycle().catch(() => {}),
          sendScheduledNotifications().catch(() => {}),
          sendPunchInReminders().catch(() => {}),
          sendPunchOutReminders().catch(() => {}),
        ]);
        res.json({ success: true, message: 'All notification checks completed' });
      } catch (error) {
        console.error('Notifications cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/email-import', requireCronAuth, async (req, res) => {
      try {
        const { pollEmailInbox } = await import('./services/emailImporter.js');
        const result = await pollEmailInbox();
        res.json(result);
      } catch (error) {
        console.error('Email import cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/razorpay-sync', requireCronAuth, async (req, res) => {
      try {
        const { syncAllRazorpayAccounts } = await import('./services/razorpayWebhook.js');
        const result = await syncAllRazorpayAccounts();
        res.json(result);
      } catch (error) {
        console.error('Razorpay sync cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/db-health', requireCronAuth, async (req, res) => {
      try {
        const { runDbHealthCheck } = await import('./services/dbHealthWatchdog.js');
        const result = await runDbHealthCheck();
        res.json(result);
      } catch (error) {
        console.error('DB health cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/fro-auto-logout', requireCronAuth, async (req, res) => {
      try {
        const { runFroAutoLogout } = await import('./services/froAutoLogoutScheduler.js');
        await runFroAutoLogout();
        res.json({ success: true, message: 'FRO auto-logout sweep completed' });
      } catch (error) {
        console.error('FRO auto-logout cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/fro-month-rollover', requireCronAuth, async (req, res) => {
      try {
        const { runMonthlyRollover } = await import('./services/froMonthlyRollover.js');
        const force = req.body?.force === true || req.query?.force === 'true';
        const result = await runMonthlyRollover({ force });
        res.json({ success: true, ...result });
      } catch (error) {
        console.error('FRO month-rollover cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/fro-idle-reconcile', requireCronAuth, async (req, res) => {
      try {
        const { runFroIdleReconciliation } = await import('./services/froIdleReconcileScheduler.js');
        const now = req.body?.nowMs || req.query?.now || Date.now();
        const result = await runFroIdleReconciliation(Number(now));
        res.json({ success: true, ...result });
      } catch (error) {
        console.error('FRO idle reconcile cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.post('/api/cron/sevak-renewals', requireCronAuth, async (req, res) => {
      try {
        const { runRenewalScan } = await import('./sevakLibrary/services/email.service.js');
        const result = await runRenewalScan();
        res.json({ success: true, ...result });
      } catch (error) {
        console.error('Sevak renewals cron error:', error.message);
        res.status(500).json({ success: false, message: error.message });
      }
    });

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.get('/api/debug', authenticate, async (req, res) => {
  const tables = ['rejected_lead_tickets', 'alerts', 'fcm_tokens'];
  const results = {};
  for (const t of tables) {
    try {
      const { error } = await db.from(t).select('id').limit(1);
      results[t] = error ? `error: ${error.message}` : 'ok';
    } catch (e) { results[t] = `exception: ${e.message}`; }
  }
  res.json({ version: 'd6f25bd', node: process.version, tables: results, vercel: !!process.env.VERCEL });
});

async function checkLeavesTable() {
  try {
    await db.from('leaves').select('id').limit(1);
  } catch {
    console.warn(
      '\n=== MISSING TABLE: leaves ===\n' +
      'The "leaves" table does not exist in your database.\n' +
      'Run the SQL in backend/migrations/.\n' +
      '========================\n'
    );
  }
}

if (!process.env.VERCEL) {
  const server = app.listen(PORT, '0.0.0.0', async () => {
    _log(`Server running on port ${PORT}`);
    // Opened before the first query so the very first connection succeeds
    // instead of failing and only recovering on the first HTTP request.
    await ensureLocalDbAccess();
    await db.testConnection();
    checkLeavesTable();
    await ensureEventHeadSchema().catch(e => console.error('ensureEventHeadSchema failed:', e?.message || e));
    await ensureTicketSchema().catch(e => console.error('ensureTicketSchema failed:', e?.message || e));
    await ensureLoanDeductionSchema().catch(e => console.error('ensureLoanDeductionSchema failed:', e?.message || e));
    await ensureSpecialIncentiveSchema().catch(e => console.error('ensureSpecialIncentiveSchema failed:', e?.message || e));
    await ensureSalaryHoldSchema().catch(e => console.error('ensureSalaryHoldSchema failed:', e?.message || e));
    await ensureCertificateSchema().catch(e => console.error('ensureCertificateSchema failed:', e?.message || e));
    await ensureNoticeSchema().catch(e => console.error('ensureNoticeSchema failed:', e?.message || e));
    await ensureFroLiveStatusSchema().catch(e => console.error('ensureFroLiveStatusSchema failed:', e?.message || e));
await ensureFroTimeSessionsAgentSchema().catch(e => console.error('ensureFroTimeSessionsAgentSchema failed:', e?.message || e));
    await ensureMeetingSchema().catch(e => console.error('ensureMeetingSchema failed:', e?.message || e));
    await ensureAuthSessionSchema().catch(e => console.error('ensureAuthSessionSchema failed:', e?.message || e));
    await ensureBeneficiarySchema().catch(e => console.error('ensureBeneficiarySchema failed:', e?.message || e));
    await ensureOperatorSchema().catch(e => console.error('ensureOperatorSchema failed:', e?.message || e));
    await ensureVotingSchema().catch(e => console.error('ensureVotingSchema failed:', e?.message || e));
    await ensureAudienceVotingSchema().catch(e => console.error('ensureAudienceVotingSchema failed:', e?.message || e));
    await ensureReminderPushSchema().catch(e => console.error('ensureReminderPushSchema failed:', e?.message || e));
    await ensureChatSchema().catch(e => console.error('ensureChatSchema failed:', e?.message || e));
    await ensureSimInventorySchema().catch(e => console.error('ensureSimInventorySchema failed:', e?.message || e));
    await ensureSignatureSchema().catch(e => console.error('ensureSignatureSchema failed:', e?.message || e));
    await ensureDocumentsSchema().catch(e => console.error('ensureDocumentsSchema failed:', e?.message || e));
    await ensureLeadsRecruiterFkSchema().catch(e => console.error('ensureLeadsRecruiterFkSchema failed:', e?.message || e));
    await ensureSevakRenewalSchema().catch(e => console.error('ensureSevakRenewalSchema failed:', e?.message || e));
    await ensureSevakSignatureSchema().catch(e => console.error('ensureSevakSignatureSchema failed:', e?.message || e));
    await ensureStationAgentOfRecordSchema().catch(e => console.error('ensureStationAgentOfRecordSchema failed:', e?.message || e));
    await ensureFroDonorLogOperatorSchema().catch(e => console.error('ensureFroDonorLogOperatorSchema failed:', e?.message || e));
    import('./services/notificationScheduler.js');
    import('./services/froAutoLogoutScheduler.js');
    import('./services/dbHealthWatchdog.js');
    import('./services/reminderNotificationScheduler.js').then((m) => m.startReminderNotificationScheduler?.());
    import('./services/froMonthlyRollover.js').then((m) => m.start?.());
    import('./services/froIdleReconcileScheduler.js').then((m) => m.start?.());
    // Hard ceiling on resident memory: restart (via PM2) if RSS stays over
    // MEM_WATCHDOG_MB (default 900) for 20s, so the 2 GB box can never OOM.
    startMemoryWatchdog();
    // Removes the local-dev security group rule on SIGINT/SIGTERM/SIGUSR2, so a
    // stopped server never leaves the database reachable from this machine.
    registerLocalDbAccessCleanup();
  });
  const { initRealtime } = await import('./socket.js');
  initRealtime(server);
}

export default app;
