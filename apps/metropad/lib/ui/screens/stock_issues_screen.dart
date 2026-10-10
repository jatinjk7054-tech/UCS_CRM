import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/constants.dart';
import '../../core/formatters.dart';
import '../../core/theme.dart';
import '../../models/refill.dart';
import '../../services/stock_service.dart';
import '../../state/app_state.dart';
import '../widgets/data_table.dart';
import '../widgets/filter_bar.dart';
import '../widgets/modals.dart';
import 'paged_list_screen.dart';

class StockIssuesScreen extends StatelessWidget {
  const StockIssuesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return PagedListScreen<StockIssue>(
      slug: 'stock-issues',
      title: 'Stock Issues',
      subtitle: 'Reported stock mismatches & missing pads',
      filters: [
        const FilterDef(key: 'search', label: 'Machines', type: FilterType.search),
        FilterDef(
          key: 'status',
          label: 'Status',
          options: AppConstants.issueStatuses.map((s) => humanizeLabel(s)).toList(),
        ),
        FilterDef(
          key: 'issue_type',
          label: 'Type',
          options: AppConstants.issueTypes.map((t) => humanizeLabel(t)).toList(),
        ),
      ],
      fetch: (page, limit, filters) async {
        final params = <String, dynamic>{'page': page, 'limit': limit};
        final search = filters['search'];
        final status = filters['status'];
        final type = filters['issue_type'];
        if (search != null && search.isNotEmpty) params['search'] = search;
        if (status != null && status.isNotEmpty) {
          params['status'] = AppConstants.issueStatuses.firstWhere(
            (s) => humanizeLabel(s) == status,
            orElse: () => status,
          );
        }
        if (type != null && type.isNotEmpty) {
          params['issue_type'] = AppConstants.issueTypes.firstWhere(
            (t) => humanizeLabel(t) == type,
            orElse: () => type,
          );
        }
        return StockIssueService.getAll(params: params);
      },
      addLabel: 'Report Issue',
      canAdd: () => AppState.auth.canManage,
      onAdd: _reportIssue,
      onRowTap: (i) => _actions(context, i),
      columns: () => [
        TableColumn<StockIssue>('Date', cell: (c, r) => cellText(formatDateStr(r.reportDate))),
        TableColumn<StockIssue>('Machine', cell: (c, r) => cellText(r.machineCode, bold: true)),
        TableColumn<StockIssue>('Station', cell: (c, r) => cellText(r.stationName)),
        TableColumn<StockIssue>('Type', cell: (c, r) => cellText(r.issueType)),
        TableColumn<StockIssue>('Missing', cell: (c, r) => cellText(formatNumber(r.missingQuantity))),
        TableColumn<StockIssue>('Status', cell: (c, r) => statusCell(r.status)),
        TableColumn<StockIssue>(
          '',
          cell: (c, r) => RowActions([
            IconActionButton(
              LucideIcons.moreVertical,
              onTap: () => _actions(c, r),
            ),
          ]),
        ),
      ],
    );
  }

  Future<void> _reportIssue(BuildContext context) async {
    if (!context.mounted) return;
    final machineId = TextEditingController();
    final expected = TextEditingController();
    final actual = TextEditingController();
    final reason = TextEditingController();
    String? issueType = AppConstants.issueTypes.first;
    await showFormModal(
      context,
      title: 'Report Stock Issue',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Report Stock Issue',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Machine',
              required: true,
              child: TextField(controller: machineId),
            ),
            const SizedBox(height: 12),
            FormFieldWrap(
              label: 'Issue Type',
              required: true,
              child: DropdownButtonFormField<String>(
                initialValue: issueType,
                items: [
                  for (final t in AppConstants.issueTypes)
                    DropdownMenuItem(value: t, child: Text(humanizeLabel(t))),
                ],
                onChanged: (v) => setState(() => issueType = v),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FormFieldWrap(
                    label: 'Expected Stock',
                    child: TextField(controller: expected, keyboardType: TextInputType.number),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FormFieldWrap(
                    label: 'Actual Stock',
                    child: TextField(controller: actual, keyboardType: TextInputType.number),
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
                        'machineId': machineId.text.trim(),
                        'issueType': issueType,
                        'expectedStock': exp,
                        'actualStock': act,
                        'missingQuantity': missing,
                        'reason': reason.text.trim(),
                        'reportDate':
                            DateTime.now().toIso8601String().substring(0, 10),
                        'reportedBy': AppState.auth.user?.email,
                      });
                    }, success: 'Issue reported');
                    if (msg == null) {
                      Navigator.pop(ctx);
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

  Future<void> _actions(BuildContext context, StockIssue issue) async {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: Text(issue.machineCode,
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(issue.issueType),
              ),
              const Divider(height: 1),
              for (final s in ['INVESTIGATING', 'RESOLVED', 'CLOSED'])
                ListTile(
leading: Icon(LucideIcons.circle,
                      color: statusColor(s), size: 12),
                  title: Text('Set status: ${humanizeLabel(s)}'),
                  onTap: () async {
                    Navigator.pop(ctx);
                    if (!AppState.auth.canManage) return;
                    final msg = await apiRun(
                      context,
                      () => StockIssueService.updateStatus(issue.id, s),
                      success: 'Status updated',
                    );
                    if (msg != null) {
                      ScaffoldMessenger.of(context)
                          .showSnackBar(SnackBar(content: Text(msg)));
                    }
                  },
                ),
            ],
          ),
        );
      },
    );
  }
}