import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/formatters.dart';
import '../../models/machine.dart';
import '../../models/refill.dart';
import '../../services/machine_service.dart';
import '../../state/app_state.dart';
import '../layout/main_layout.dart';
import '../widgets/common.dart';
import '../widgets/data_table.dart';
import '../widgets/modals.dart';

class RefillsScreen extends StatefulWidget {
  const RefillsScreen({super.key});
  @override
  State<RefillsScreen> createState() => _RefillsScreenState();
}

class _RefillsScreenState extends State<RefillsScreen> {
  int _year = DateTime.now().year;
  int _month = DateTime.now().month;
  bool _loading = true;
  Object? _error;
  List<Refill> _refills = [];

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
      final p = await RefillService.getAll(year: _year, month: _month);
      if (!mounted) return;
      setState(() {
        _refills = p.items;
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
    return AppScaffold(
      selected: 'refills',
      title: 'Refill Management',
      subtitle: 'Monthly refill records',
      actions: [
        if (AppState.auth.canManage)
          FilledButton.icon(
            onPressed: () => _addRefill(context),
            icon: const Icon(LucideIcons.plus, size: 18),
            label: const Text('Add Refill'),
          ),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              elevation: 0,
              margin: const EdgeInsets.only(bottom: 12),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    SizedBox(
                      width: 110,
                      child: DropdownButtonFormField<int>(
                        initialValue: _year,
                        decoration: const InputDecoration(isDense: true),
                        items: [
                          for (var y = DateTime.now().year; y >= 2024; y--)
                            DropdownMenuItem(value: y, child: Text('$y')),
                        ],
                        onChanged: (v) {
                          if (v == null) return;
                          setState(() => _year = v);
                          _load();
                        },
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: DropdownButtonFormField<int>(
                        initialValue: _month,
                        decoration: const InputDecoration(isDense: true),
                        items: [
                          for (var m = 1; m <= 12; m++)
                            DropdownMenuItem(value: m, child: Text(AppConstants.months[m - 1])),
                        ],
                        onChanged: (v) {
                          if (v == null) return;
                          setState(() => _month = v);
                          _load();
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ),
            _loading
                ? const LoadingSpinner(message: 'Loading refills...')
                : _error != null
                    ? ErrorState(
                        message: toApiException(_error!).message,
                        onRetry: _load,
                      )
                    : DataTableWidget<Refill>(
                        items: _refills,
                        emptyMessage: 'No refills recorded for this month.',
                        columns: [
                          TableColumn<Refill>('Date',
                              cell: (c, r) => cellText(formatDateStr(r.refillDate))),
                          TableColumn<Refill>('Machine',
                              cell: (c, r) => cellText(r.machineCode, bold: true)),
                          TableColumn<Refill>('Station',
                              cell: (c, r) => cellText(r.stationName)),
                          TableColumn<Refill>('Previous',
                              cell: (c, r) => cellText(formatNumber(r.previousStock))),
                          TableColumn<Refill>('Refilled',
                              cell: (c, r) => cellText(formatNumber(r.refillQuantity), bold: true)),
                          TableColumn<Refill>('New Stock',
                              cell: (c, r) => cellText(formatNumber(r.newStock))),
                          TableColumn<Refill>('Cash',
                              cell: (c, r) => cellText(formatRupee(r.cashCollected))),
                          TableColumn<Refill>('Refilled By',
                              cell: (c, r) => cellText(r.refilledBy)),
                        ],
                      ),
          ],
        ),
      ),
    );
  }

  Future<void> _addRefill(BuildContext context) async {
    final machines = await MachineService
        .getAll(params: {'limit': 1000})
        .then((p) => p.items)
        .catchError((_) => <Machine>[]);
    if (!context.mounted) return;
    final qty = TextEditingController();
    final remark = TextEditingController();
    Machine? selected = machines.isNotEmpty ? machines.first : null;
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
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Machine',
              required: true,
              child: DropdownButtonFormField<String>(
                initialValue: selected?.id,
                isExpanded: true,
                items: [
                  for (final m in machines)
                    DropdownMenuItem(
                      value: m.id,
                      child: Text(m.machineId),
                    ),
                ],
                onChanged: (v) => setState(() =>
                    selected = machines.where((m) => m.id == v).firstOrNull),
              ),
            ),
            const SizedBox(height: 12),
            FormFieldWrap(
              label: 'Refill Quantity',
              required: true,
              child: TextField(controller: qty, keyboardType: TextInputType.number),
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
                    final q = int.tryParse(qty.text.trim());
                    if (selected == null || q == null || q <= 0) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Select machine & valid quantity')),
                      );
                      return;
                    }
                    final msg = await apiRun(context, () async {
                      await RefillService.create({
                        'machineId': selected!.id,
                        'stationId': selected!.stationId,
                        'refillQuantity': q,
                        'remark': remark.text.trim(),
                        'refillDate':
                            DateTime.now().toIso8601String().substring(0, 10),
                      });
                    }, success: 'Refill recorded');
                    if (msg == null) {
                      Navigator.pop(ctx);
                      _load();
                    } else {
                      ScaffoldMessenger.of(context)
                          .showSnackBar(SnackBar(content: Text(msg)));
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
}