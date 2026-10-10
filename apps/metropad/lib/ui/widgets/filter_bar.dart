import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/constants.dart';
import '../../core/theme.dart';

enum FilterType { search, select }

class FilterDef {
  final String key;
  final String label;
  final FilterType type;
  final List<String> options;
  final Map<String, String>? labels;
  final bool activeOnly;
  const FilterDef({
    required this.key,
    required this.label,
    this.type = FilterType.select,
    this.options = const [],
    this.labels,
    this.activeOnly = true,
  });
}

class FilterBar extends StatefulWidget {
  final List<FilterDef> filters;
  final Map<String, String?> values;
  final ValueChanged<Map<String, String?>> onChanged;
  final VoidCallback? onClear;

  const FilterBar({
    super.key,
    required this.filters,
    required this.values,
    required this.onChanged,
    this.onClear,
  });

  @override
  State<FilterBar> createState() => _FilterBarState();
}

class _FilterBarState extends State<FilterBar> {
  late Map<String, TextEditingController> _searchControllers;
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _searchControllers = {};
    for (final f in widget.filters.where((f) => f.type == FilterType.search)) {
      _searchControllers[f.key] = TextEditingController(text: widget.values[f.key] ?? '');
    }
  }

  @override
  void didUpdateWidget(covariant FilterBar old) {
    super.didUpdateWidget(old);
    for (final f in widget.filters.where((f) => f.type == FilterType.search)) {
      final text = widget.values[f.key];
      if (_searchControllers[f.key]!.text != text) {
        _searchControllers[f.key]!.text = text ?? '';
      }
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    for (final c in _searchControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _set(String key, String? value, {bool fromSearch = false}) {
    if (!widget.values.keys.contains(key)) return;
    if (value == (widget.values[key] ?? '')) return;
    widget.onChanged({...widget.values, key: value});
    if (fromSearch) setState(() {});
  }

  void _clear() {
    widget.onClear?.call();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final hasActive = widget.values.values.any((v) => v != null && v.isNotEmpty);
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(
          spacing: 10,
          runSpacing: 10,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            for (final f in widget.filters)
              if (f.type == FilterType.search)
                SizedBox(
                  width: 220,
                  child: TextField(
                    controller: _searchControllers[f.key],
                    onChanged: (v) => _set(f.key, v.isEmpty ? null : v, fromSearch: true),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: 'Search ${f.label}...',
                      prefixIcon: const Icon(LucideIcons.search, size: 18),
                      suffixIcon: _searchControllers[f.key]!.text.isEmpty
                          ? null
                          : IconButton(
                              icon: const Icon(LucideIcons.x, size: 16),
                              onPressed: () => _set(f.key, null, fromSearch: true),
                            ),
                    ),
                  ),
                )
              else
                SizedBox(
                  width: 180,
                  child: DropdownButtonFormField<String>(
                    initialValue: widget.values[f.key],
                    isExpanded: true,
                    decoration: InputDecoration(
                      isDense: true,
                      labelText: f.label,
                      enabled: f.options.isNotEmpty,
                    ),
                    items: [
                      if (f.activeOnly)
                        const DropdownMenuItem(value: '', child: Text('All')),
                      for (final o in f.options)
                        DropdownMenuItem(
                          value: o,
                          child: Text(
                            f.labels?[o] ?? o.replaceAll('_', ' '),
                          ),
                        ),
                    ],
                    onChanged: (v) => _set(f.key, (v == null || v.isEmpty) ? null : v),
                  ),
                ),
            if (hasActive)
              TextButton.icon(
                onPressed: _clear,
                icon: const Icon(LucideIcons.filterX, size: 16),
                label: const Text('Clear Filters'),
              ),
          ],
        ),
      ),
    );
  }
}

class PaginationBar extends StatelessWidget {
  final int page;
  final int limit;
  final int total;
  final int totalPages;
  final ValueChanged<int> onPageChange;
  final ValueChanged<int> onLimitChange;

  const PaginationBar({
    super.key,
    required this.page,
    required this.limit,
    required this.total,
    required this.totalPages,
    required this.onPageChange,
    required this.onLimitChange,
  });

  @override
  Widget build(BuildContext context) {
    final start = (page - 1) * limit + 1;
    final end = (page * limit) < total ? page * limit : total;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: [
          Expanded(
            child: Text(
              total == 0 ? 'No records' : 'Showing $start–$end of $total',
              style: const TextStyle(color: AppColors.textLight, fontSize: 13),
            ),
          ),
          DropdownButton<int>(
            value: limit,
            underline: const SizedBox.shrink(),
            items: [
              for (final s in AppConstants.pageSizes)
                DropdownMenuItem(value: s, child: Text('$s / page')),
            ],
            onChanged: (v) {
              if (v != null) onLimitChange(v);
            },
          ),
          const SizedBox(width: 12),
          IconButton(
            onPressed: page <= 1 ? null : () => onPageChange(page - 1),
            icon: const Icon(LucideIcons.chevronLeft),
            color: page <= 1 ? AppColors.borderDark : AppColors.text,
          ),
          Text('$page / $totalPages',
              style: const TextStyle(fontSize: 13, color: AppColors.textLight)),
          IconButton(
            onPressed: page >= totalPages ? null : () => onPageChange(page + 1),
            icon: const Icon(LucideIcons.chevronRight),
            color: page >= totalPages ? AppColors.borderDark : AppColors.text,
          ),
        ],
      ),
    );
  }
}