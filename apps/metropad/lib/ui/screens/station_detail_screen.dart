import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/formatters.dart';
import '../../core/mumbai_metro.dart';
import '../../core/theme.dart';
import '../../models/machine.dart';
import '../../models/metro.dart';
import '../../services/machine_service.dart';
import '../../services/metro_service.dart';
import '../../services/stock_service.dart';
import '../../state/app_state.dart';
import '../layout/main_layout.dart';
import '../widgets/common.dart';
import '../widgets/modals.dart';
import '../widgets/status_badge.dart';

class StationDetailScreen extends StatefulWidget {
  final String stationId;
  final String? initialName;
  const StationDetailScreen({
    super.key,
    required this.stationId,
    this.initialName,
  });

  @override
  State<StationDetailScreen> createState() => _StationDetailScreenState();
}

class _StationDetailScreenState extends State<StationDetailScreen> {
  bool _loading = true;
  Object? _error;
  Station? _station;
  List<Machine> _machines = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final s = await StationService.getById(widget.stationId);
      if (!mounted) return;
      setState(() {
        _station = s;
        _machines = s.machines
            .whereType<Map>()
            .map((e) => Machine.fromJson(e.cast<String, dynamic>()))
            .toList();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _station;
    return AppScaffold(
      selected: 'network',
      showBack: true,
      title: s?.name ?? widget.initialName ?? 'Station',
      subtitle: s?.lineName ?? 'Station details',
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const LoadingSpinner(message: 'Loading station...')
            : _error != null
                ? Center(
                    child: ErrorState(
                      message: toApiException(_error!).message,
                      onRetry: _load,
                    ),
                  )
                : ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      _header(s!),
                      const SizedBox(height: 12),
                      _stats(s),
                      const SizedBox(height: 12),
                      _actionsCard(),
                      const SizedBox(height: 12),
                      _machinesCard(),
                      const SizedBox(height: 12),
                      _activityCard(s),
                    ],
                  ),
      ),
    );
  }

  Widget _header(Station s) {
    final color = colorFromHex(getLineColor(s.lineName));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Icon(LucideIcons.mapPin, color: color),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(s.name,
                          style: const TextStyle(
                              fontSize: 17, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 4),
                      Text(s.lineName,
                          style: const TextStyle(
                              fontSize: 12.5, color: AppColors.textLight)),
                    ],
                  ),
                ),
                if (s.status.isNotEmpty) StatusBadge(s.status),
              ],
            ),
            if (s.description.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(s.description,
                  style: const TextStyle(
                      fontSize: 13, color: AppColors.textLight)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _stats(Station s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Overview',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                _stat('Machines', '${s.machineCount}', LucideIcons.cpu,
                    AppColors.primary),
                _stat('Active', '${s.activeMachineCount}', LucideIcons.checkCircle,
                    AppColors.success),
                _stat('Inactive', '${s.inactiveMachineCount}',
                    LucideIcons.circleStop, AppColors.textLight),
                _stat('Maintenance', '${s.maintenanceMachineCount}',
                    LucideIcons.wrench, AppColors.warning),
                _stat('Total Stock', formatNumber(s.totalStock),
                    LucideIcons.package, AppColors.info),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value, IconData icon, Color color) {
    return SizedBox(
      width: 104,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 15, color: color),
              const SizedBox(width: 6),
              Expanded(
                child: Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.textLight)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(value,
              style: const TextStyle(
                  fontSize: 18, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }

  Widget _actionsCard() {
    if (!AppState.auth.canManage) return const SizedBox.shrink();
    final hasMachine = _machines.isNotEmpty;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Actions',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            if (!hasMachine) ...[
              const Text(
                'No machine installed at this station yet. Add a machine (2 slots × 25 pads) to record refills, maintenance and stock issues.',
                style: TextStyle(fontSize: 12.5, color: AppColors.textLight),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _addMachine,
                  icon: const Icon(LucideIcons.plus, size: 18),
                  label: const Text('Add Machine'),
                ),
              ),
            ] else
              Row(
                children: [
                  Expanded(
                    child: _actionButton(
                      icon: LucideIcons.refreshCw,
                      label: 'Add Refill',
                      onTap: _addRefill,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _actionButton(
                      icon: LucideIcons.wrench,
                      label: 'Maintenance',
                      onTap: _addMaintenance,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _actionButton(
                      icon: LucideIcons.triangleAlert,
                      label: 'Stock Issue',
                      onTap: _addStockIssue,
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _addMachine() async {
    final s = _station;
    if (s == null) return;
    final msg = await apiRun(context, () async {
      await MachineService.create(Machine(
        id: '',
        machineId:
            'M-${DateTime.now().microsecondsSinceEpoch.toRadixString(36).toUpperCase()}',
        stationId: s.id,
        lineId: s.lineId,
        location: s.name,
        machineType: 'Standard',
        capacity: AppConstants.machineCapacity,
        currentStock: 0,
        lowStockThreshold: AppConstants.lowStockThreshold,
        installationDate:
            DateTime.now().toIso8601String().substring(0, 10),
        status: 'ACTIVE',
      ));
    }, success: 'Machine added');
    if (!mounted) return;
    if (msg == null) {
      _load();
    } else {
      _snack(msg);
    }
  }

  Future<void> _deleteMachine(Machine m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        title: const Text('Delete machine?'),
        content: const Text(
            'This permanently deletes the machine and its refill, issue and maintenance records.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final msg = await apiRun(context, () async {
      await MachineService.remove(m.id);
    }, success: 'Machine deleted');
    if (!mounted) return;
    if (msg == null) {
      _load();
    } else {
      _snack(msg);
    }
  }

  Widget _actionButton({
    required IconData icon,
    required String label,
    VoidCallback? onTap,
  }) {
    return OutlinedButton(
      onPressed: onTap,
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
        minimumSize: const Size(0, 64),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18),
          const SizedBox(height: 4),
          Text(label,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12)),
        ],
      ),
    );
  }

  Machine? get _machine => _machines.isNotEmpty ? _machines.first : null;

  void _snack(String message) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _addRefill() async {
    final m = _machine;
    if (m == null) {
      _snack('No machine installed at this station.');
      return;
    }
    final isNew = (m.currentStock ?? 0) == 0;
    final cash = TextEditingController();
    final qty = TextEditingController();
    await showFormModal(
      context,
      title: 'Add Refill',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add Refill',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(
              'Machine holds ${AppConstants.machineCapacity} pads (${AppConstants.slotsPerMachine} slots × ${AppConstants.slotCapacity}).',
              style: const TextStyle(fontSize: 12, color: AppColors.textLight),
            ),
            const SizedBox(height: 16),
            if (!isNew) ...[
              FormFieldWrap(
                label: 'Amount Collected (₹)',
                child: TextField(
                  controller: cash,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (v) {
                    final amt = double.tryParse(v.trim());
                    if (amt != null && amt > 0) {
                      qty.text =
                          (amt / AppConstants.pricePerPad).round().toString();
                    }
                  },
                  decoration: const InputDecoration(hintText: 'e.g. 150'),
                ),
              ),
              const SizedBox(height: 12),
            ],
            FormFieldWrap(
              label: isNew ? 'Stock to Add (pads)' : 'Refill Quantity (pads)',
              required: true,
              child: TextField(
                controller: qty,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(hintText: 'e.g. 50'),
              ),
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 10),
                FilledButton(
                  onPressed: () async {
                    final q = int.tryParse(qty.text.trim());
                    if (q == null || q <= 0) {
                      _snack('Enter a valid quantity');
                      return;
                    }
                    if (q > AppConstants.machineCapacity) {
                      _snack(
                          'Machine holds only ${AppConstants.machineCapacity} pads.');
                      return;
                    }
                    final c = isNew
                        ? 0.0
                        : (double.tryParse(cash.text.trim()) ?? 0);
                    final msg = await apiRun(context, () async {
                      await RefillService.create({
                        'machineId': m.id,
                        'stationId': m.stationId ?? _station?.id,
                        'cashCollected': c,
                        'refillQuantity': q,
                        'refillDate':
                            DateTime.now().toIso8601String().substring(0, 10),
                      });
                    }, success: 'Refill recorded');
                    if (!mounted) return;
                    if (msg == null) {
                      Navigator.pop(ctx);
                      _load();
                    } else {
                      _snack(msg);
                    }
                  },
                  child: const Text('Save'),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  Future<void> _addMaintenance() async {
    final m = _machine;
    if (m == null) {
      _snack('No machine installed at this station.');
      return;
    }
    final problem = TextEditingController();
    final technician = TextEditingController();
    final remark = TextEditingController();
    String priority = 'MEDIUM';
    await showFormModal(
      context,
      title: 'Add Maintenance',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add Maintenance',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Problem',
              required: true,
              child: TextField(
                controller: problem,
                decoration: const InputDecoration(hintText: 'Describe the issue'),
              ),
            ),
            const SizedBox(height: 12),
            FormFieldWrap(
              label: 'Priority',
              child: DropdownButtonFormField<String>(
                initialValue: priority,
                items: [
                  for (final p in AppConstants.maintenancePriorities)
                    DropdownMenuItem(value: p, child: Text(humanizeLabel(p))),
                ],
                onChanged: (v) => setState(() => priority = v ?? priority),
              ),
            ),
            const SizedBox(height: 12),
            FormFieldWrap(
              label: 'Technician',
              child: TextField(controller: technician),
            ),
            const SizedBox(height: 12),
            FormFieldWrap(
              label: 'Remark',
              child: TextField(controller: remark),
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 10),
                FilledButton(
                  onPressed: () async {
                    if (problem.text.trim().isEmpty) {
                      _snack('Problem is required');
                      return;
                    }
                    final msg = await apiRun(context, () async {
                      await MaintenanceService.create({
                        'machineId': m.id,
                        'stationId': m.stationId ?? _station?.id,
                        'problem': problem.text.trim(),
                        'priority': priority,
                        'technician': technician.text.trim(),
                        'remark': remark.text.trim(),
                        'reportedDate':
                            DateTime.now().toIso8601String().substring(0, 10),
                      });
                    }, success: 'Maintenance added');
                    if (!mounted) return;
                    if (msg == null) {
                      Navigator.pop(ctx);
                      _load();
                    } else {
                      _snack(msg);
                    }
                  },
                  child: const Text('Save'),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  Future<void> _addStockIssue() async {
    final m = _machine;
    if (m == null) {
      _snack('No machine installed at this station.');
      return;
    }
    final expected = TextEditingController();
    final actual = TextEditingController();
    final reason = TextEditingController();
    String issueType = AppConstants.issueTypes.first;
    await showFormModal(
      context,
      title: 'Add Stock Issue',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add Stock Issue',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Issue Type',
              child: DropdownButtonFormField<String>(
                initialValue: issueType,
                items: [
                  for (final t in AppConstants.issueTypes)
                    DropdownMenuItem(value: t, child: Text(humanizeLabel(t))),
                ],
                onChanged: (v) => setState(() => issueType = v ?? issueType),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FormFieldWrap(
                    label: 'Expected Stock',
                    child: TextField(
                      controller: expected,
                      keyboardType: TextInputType.number,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FormFieldWrap(
                    label: 'Actual Stock',
                    child: TextField(
                      controller: actual,
                      keyboardType: TextInputType.number,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            FormFieldWrap(
              label: 'Reason',
              child: TextField(controller: reason),
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 10),
                FilledButton(
                  onPressed: () async {
                    final exp = int.tryParse(expected.text.trim());
                    final act = int.tryParse(actual.text.trim());
                    final missing =
                        (exp != null && act != null && exp > act) ? exp - act : 0;
                    final msg = await apiRun(context, () async {
                      await StockIssueService.create({
                        'machineId': m.id,
                        'stationId': m.stationId ?? _station?.id,
                        'issueType': issueType,
                        'expectedStock': exp,
                        'actualStock': act,
                        'missingQuantity': missing,
                        'reason': reason.text.trim(),
                        'reportDate':
                            DateTime.now().toIso8601String().substring(0, 10),
                      });
                    }, success: 'Issue reported');
                    if (!mounted) return;
                    if (msg == null) {
                      Navigator.pop(ctx);
                      _load();
                    } else {
                      _snack(msg);
                    }
                  },
                  child: const Text('Save'),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  Widget _machinesCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Machines',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            if (_machines.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text('No machines installed yet',
                    style: TextStyle(fontSize: 13, color: AppColors.textLight)),
              )
            else
              for (var i = 0; i < _machines.length; i++)
                _machineTile(_machines[i], i),
          ],
        ),
      ),
    );
  }

  Widget _machineTile(Machine m, int index) {
    final label = m.location.trim().isEmpty
        ? 'Machine ${index + 1}'
        : m.location.trim();
    return InkWell(
      onLongPress: () => _machineActions(m),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(LucideIcons.cpu,
                    size: 18, color: AppColors.primary),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label,
                        style: const TextStyle(
                            fontSize: 13.5, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(
                      'Holds ${AppConstants.machineCapacity} pads · ${AppConstants.slotsPerMachine} slots × ${AppConstants.slotCapacity}',
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.textLight),
                    ),
                  ],
                ),
              ),
              if (m.status.isNotEmpty) StatusBadge(m.status),
              if (AppState.auth.canManage) ...[
                const SizedBox(width: 4),
                IconButton(
                  tooltip: 'Delete machine',
                  onPressed: () => _deleteMachine(m),
                  icon: const Icon(LucideIcons.trash2,
                      size: 18, color: AppColors.textLight),
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          _stockChip(m),
        ],
      ),
      ),
    );
  }

  void _machineActions(Machine m) {
    if (!AppState.auth.canManage) return;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(LucideIcons.trash2,
                  size: 20, color: AppColors.danger),
              title: const Text('Delete Machine',
                  style: TextStyle(color: AppColors.danger)),
              onTap: () {
                Navigator.pop(ctx);
                _deleteMachine(m);
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Widget _stockChip(Machine m) {
    final stock = (m.currentStock ?? 0).toInt();
    final full = stock >= AppConstants.machineCapacity;
    final color = stock == 0
        ? AppColors.textLight
        : (full ? AppColors.success : AppColors.primary);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text('Stock',
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: color)),
          Text('$stock of ${AppConstants.machineCapacity}',
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: color)),
        ],
      ),
    );
  }

  Widget _activityCard(Station s) {
    final refills = s.recentRefills.whereType<Map>().toList();
    final issues = s.recentIssues.whereType<Map>().toList();
    if (refills.isEmpty && issues.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Recent Activity',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            for (final r in refills)
              _activityRow(
                LucideIcons.refreshCw,
                AppColors.success,
                'Refilled ${formatNumber(asNum(r['refill_quantity']))} pads',
                formatDateStr(r['refill_date']?.toString()),
              ),
            for (final i in issues)
              _activityRow(
                LucideIcons.triangleAlert,
                AppColors.warning,
                humanizeLabel(i['issue_type']?.toString() ?? 'Issue'),
                formatDateStr(i['report_date']?.toString()),
              ),
          ],
        ),
      ),
    );
  }

  Widget _activityRow(IconData icon, Color color, String title, String date) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Text(title,
                style: const TextStyle(fontSize: 13)),
          ),
          if (date.isNotEmpty)
            Text(date,
                style: const TextStyle(
                    fontSize: 12, color: AppColors.textLight)),
        ],
      ),
    );
  }
}
