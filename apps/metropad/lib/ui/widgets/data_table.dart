import 'package:flutter/material.dart';

import '../../core/theme.dart';
import 'common.dart';
import 'status_badge.dart';

typedef CellBuilder<T> = Widget Function(BuildContext context, T row);

class TableColumn<T> {
  final String label;
  final CellBuilder<T>? cell;
  final String Function(T row)? value;
  final bool sortable;
  final double? flex;
  const TableColumn(this.label, {this.cell, this.value, this.sortable = false, this.flex});
}

class DataTableWidget<T> extends StatelessWidget {
  final List<TableColumn<T>> columns;
  final List<T> items;
  final bool loading;
  final String? emptyMessage;
  final ValueChanged<T>? onRowTap;

  const DataTableWidget({
    super.key,
    required this.columns,
    required this.items,
    this.loading = false,
    this.emptyMessage = 'No records to show.',
    this.onRowTap,
  });

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const SizedBox(height: 220, child: LoadingSpinner());
    }
    if (items.isEmpty) {
      return SizedBox(
        height: 220,
        child: EmptyState(message: emptyMessage ?? 'No records to show.'),
      );
    }
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: MediaQuery.of(context).size.width - 32),
            child: DataTable(
              headingRowColor: WidgetStatePropertyAll(AppColors.sidebarHover),
              dataRowMinHeight: 48,
              dataRowMaxHeight: 56,
              headingTextStyle: const TextStyle(
                fontWeight: FontWeight.w600,
                fontSize: 12,
                color: AppColors.textLight,
                letterSpacing: 0.4,
              ),
              columns: [
                for (final c in columns)
                  DataColumn(
                    label: Text(c.label.toUpperCase()),
                  ),
              ],
              rows: [
                for (final item in items)
                  DataRow(
                    onSelectChanged: onRowTap == null
                        ? null
                        : (_) => onRowTap!(item),
                    cells: [
                      for (final c in columns)
                        DataCell(
                          c.cell != null
                              ? c.cell!(context, item)
                              : Text(
                                  c.value!(item),
                                  style: const TextStyle(
                                    fontSize: 13.5,
                                    color: AppColors.text,
                                  ),
                                ),
                        ),
                    ],
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Text cellText(String text, {bool muted = false, bool bold = false, Color? color}) {
  return Text(
    text,
    style: TextStyle(
      fontSize: 13.5,
      fontWeight: bold ? FontWeight.w600 : FontWeight.w400,
      color: color ?? (muted ? AppColors.textLight : AppColors.text),
    ),
  );
}

Widget statusCell(String status) => StatusBadge(status);

Widget lineCell(String name) => LineBadge(name);

class RowActions extends StatelessWidget {
  final List<Widget> actions;
  const RowActions(this.actions, {super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final a in actions) ...[a, if (a != actions.last) const SizedBox(width: 4)],
      ],
    );
  }
}

class IconActionButton extends StatelessWidget {
  final IconData icon;
  final Color? color;
  final VoidCallback? onTap;
  const IconActionButton(this.icon, {super.key, this.color, this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(icon, size: 18, color: color ?? AppColors.textLight),
      ),
    );
  }
}