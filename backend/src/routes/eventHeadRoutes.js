import { Router } from 'express';
import multer from 'multer';
import { authenticate, authenticateRole } from '../middleware/authMiddleware.js';
import * as ctrl from '../controllers/eventHeadController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Media/banner uploads stay in memory and are pushed to the S3 "event" folder
// by the controller (db.storage.from('event') -> <S3_BUCKET>/event/<file>).
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const eh = authenticateRole('super_admin', 'admin', 'hr', 'event_head', 'event_manager', 'Event Manager', 'Event Head');
// Calendar extras (static paths BEFORE /events/:id)
router.get('/calendar/observances', eh, ctrl.listCalendarObservances);
router.post('/calendar/suggest', eh, ctrl.suggestDayPrograms);
// Monthly Planner: programme suggestions for one activity in one month. Separate
// from /calendar/suggest, which is driven by a single day on the Calendar page.
router.post('/planner/suggest-programs', eh, ctrl.suggestActivityPrograms);
router.get('/planner/suggestions', eh, ctrl.getPlannerSuggestions);
router.put('/planner/suggestions/:id/select', eh, ctrl.setPlannerSuggestionSelected);
// Monthly Planner Activities grid: festival/day-driven suggestions, selected
// per festival row and exported in the monthly download.
router.post('/planner/suggest-festival-programs', eh, ctrl.suggestFestivalPrograms);
router.get('/planner/festival-suggestions', eh, ctrl.getFestivalSuggestions);
// Static paths BEFORE /:id/select so "beneficiary"/"location" are never read as an id.
router.put('/planner/festival-suggestions/beneficiary', eh, ctrl.setFestivalSuggestionsBeneficiary);
router.put('/planner/festival-suggestions/location', eh, ctrl.setFestivalSuggestionsLocation);
router.put('/planner/festival-suggestions/:id/select', eh, ctrl.setFestivalSuggestionSelected);
// Events (static paths BEFORE :id)
router.get('/dashboard/stats', eh, ctrl.getEventHeadDashboardStats);
router.get('/events/dashboard', eh, ctrl.getEventHeadDashboard);
router.get('/events/calendar', eh, (req, res) => {
  const { month, year, start, end } = req.query;
  if (start || end) return ctrl.getEventHeadCalendar(req, res);
  if (month && year) {
    req.params.month = month;
    req.params.year = year;
    return ctrl.getEventHeadEventsByMonth(req, res);
  }
  return ctrl.listEventHeadEvents(req, res);
});
// Event sheet import/export (static paths BEFORE /events/:id)
router.post('/events/import', eh, upload.single('file'), ctrl.importEvents);
router.post('/events/banner/upload', eh, mediaUpload.single('file'), ctrl.uploadEventBanner);
router.get('/events/export', eh, ctrl.exportEvents);
router.get('/events/ngo/:ngoId/media', eh, ctrl.listMediaByNgo);
router.get('/events/ngo/:ngoId', eh, ctrl.getEventHeadEventsByNgo);
router.get('/events/state/:state', eh, ctrl.getEventHeadEventsByState);
router.post('/events', eh, ctrl.createEventHandler);
router.get('/events', eh, ctrl.listEventHeadEvents);
router.post('/events/spell-check', eh, ctrl.suggestEventSpelling);
router.get('/events/:id', eh, ctrl.getEventHeadEvent);
router.put('/events/:id', eh, ctrl.updateEventHeadEvent);
router.put('/events/:id/status', eh, ctrl.updateEventHeadStatus);
router.post('/events/cleanup', eh, ctrl.cleanupEvents);
router.delete('/events/:id', eh, ctrl.deleteEventHeadEvent);

// Approval flow
router.post('/events/:id/submit', eh, ctrl.submitEventHeadApproval);
router.put('/events/:id/approve', eh, ctrl.approveEventHeadEvent);
router.put('/events/:id/reject', eh, ctrl.rejectEventHeadEvent);

// Assets
router.post('/assets', eh, ctrl.createAsset);
router.get('/assets', eh, ctrl.listAssets);
router.get('/assets/utilization', eh, ctrl.getAssetUtilization);
router.get('/assets/:id', eh, ctrl.getAsset);
router.put('/assets/:id', eh, ctrl.editAsset);
router.delete('/assets/:id', eh, ctrl.removeAsset);
router.post('/assets/issue', eh, ctrl.issueAssetItem);
router.put('/assets/return/:id', eh, ctrl.returnAssetItem);

// Materials
router.post('/materials', eh, ctrl.createMaterial);
router.get('/materials', eh, ctrl.listMaterials);
router.get('/materials/stock', eh, ctrl.getMaterialStock);
router.put('/materials/:id', eh, ctrl.editMaterial);
router.put('/materials/:id/stock', eh, ctrl.adjustMaterialStock);
router.delete('/materials/:id', eh, ctrl.removeMaterial);

// Distributions (scoped under event)
router.get('/events/:eventId/distributions', eh, ctrl.listDistributions);
router.post('/events/:eventId/distributions', eh, ctrl.createDistribution);

// Beneficiaries
router.get('/beneficiaries', eh, ctrl.listBeneficiaries);
router.post('/beneficiaries', eh, ctrl.createBeneficiary);

// Volunteers
router.post('/volunteers', eh, ctrl.createVolunteer);
router.get('/volunteers', eh, ctrl.listVolunteers);
router.get('/volunteers/people', eh, ctrl.listVolunteerPeople);
// Today's attendance for the Voluntary section. Kept under `eh` (which includes
// event_head) because the HR attendance routes are gated to
// super_admin/admin/hr/accounts, so Event Head cannot read those.
router.get('/volunteers/attendance', eh, ctrl.listVolunteerAttendance);
router.put('/volunteers/:id', eh, ctrl.editVolunteer);

// Expenses (scoped under event)
router.get('/events/:eventId/expenses', eh, ctrl.listExpenses);
router.post('/events/:eventId/expenses', eh, ctrl.createExpense);
router.delete('/events/:eventId/expenses/:id', eh, ctrl.removeExpense);

// Vehicles
router.post('/vehicles', eh, ctrl.createVehicle);
router.get('/vehicles', eh, ctrl.listVehicles);
router.post('/vehicles/assign', eh, ctrl.assignVehicle);

// Media (scoped under event). Accepts a single `file` field or multiple `files`.
const mediaUploadMiddleware = mediaUpload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 25 }]);
router.get('/events/:eventId/media', eh, ctrl.listMedia);
router.post('/events/:eventId/media', eh, mediaUploadMiddleware, ctrl.uploadMedia);
router.get('/events/:eventId/media/:id/download', eh, ctrl.downloadMedia);
router.put('/events/:eventId/media/:id', eh, mediaUpload.single('file'), ctrl.replaceMedia);
router.delete('/events/:eventId/media/:id', eh, ctrl.removeMedia);

// Attendance (scoped under event)
router.get('/events/:eventId/attendance', eh, ctrl.listAttendance);
router.post('/events/:eventId/attendance', eh, ctrl.createAttendance);

// Checklist (scoped under event)
router.get('/events/:eventId/checklist', eh, ctrl.getChecklist);
router.post('/events/:eventId/checklist', eh, ctrl.createChecklistItem);
router.put('/events/:eventId/checklist/:itemId', eh, ctrl.updateChecklistItem);

// Reports
router.get('/reports/all', eh, ctrl.generateAllEventsReport);
router.get('/reports/monthly', eh, ctrl.generateNgoMonthlyReport);
router.get('/reports/event/:eventId', eh, ctrl.generateEventReport);

// Approvals
router.get('/approvals', eh, ctrl.listApprovals);

// Partners & Donors
router.get('/csr-partners', eh, ctrl.listPartners);
router.get('/donors', eh, ctrl.listDonors);

// NGO context (read-only for the Event Head workspace)
router.get('/ngos', eh, ctrl.listEventHeadNgos);

// Sectors & Activities (NGO → Sector → Activity)
router.get('/sectors', eh, ctrl.listSectors);
router.post('/sectors', eh, ctrl.createSector);
router.get('/activities', eh, ctrl.listActivities);
router.post('/activities', eh, ctrl.createActivity);
router.post('/activities/suggest', eh, ctrl.suggestSectorActivities);
// Sheet import/export (static paths BEFORE /activities/:id)
router.post('/activities/import', eh, upload.single('file'), ctrl.importActivities);
router.get('/activities/export', eh, ctrl.exportActivities);
router.get('/activities/:id', eh, ctrl.getActivity);
router.put('/activities/:id', eh, ctrl.updateActivity);
router.delete('/activities/:id', eh, ctrl.deleteActivity);
router.put('/activities/:id/status', eh, ctrl.setActivityStatus);

export default router;
