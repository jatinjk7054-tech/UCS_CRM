import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/api_client.dart';
import '../../services/base_service.dart';
import '../../state/app_state.dart';
import '../layout/main_layout.dart';
import '../widgets/common.dart';
import '../widgets/data_table.dart';
import '../widgets/filter_bar.dart';

Map<String, dynamic> filterParams(Map<String, String?> filters, {int page = 1, int limit = 20}) {
  final params = <String, dynamic>{'page': page, 'limit': limit};
  for (final e in filters.entries) {
    final v = e.value;
    if (v != null && v.isNotEmpty) {
      if (RegExp(r'Id$').hasMatch(e.key) || e.key == 'lineId' || e.key == 'stationId') {
        params[e.key] = v;
      } else {
        params[e.key] = v;
      }
    }
  }
  return params;
}

class PagedListScreen<T> extends StatefulWidget {
  final String slug;
  final String title;
  final String subtitle;
  final List<FilterDef> filters;
  final Future<Paginated<T>> Function(int page, int limit, Map<String, String?> filters) fetch;
  final List<TableColumn<T>> Function() columns;
  final ValueChanged<T>? onRowTap;
  final String? addLabel;
  final Future<void> Function(BuildContext context)? onAdd;
  final bool Function()? canAdd;

  const PagedListScreen({
    super.key,
    required this.slug,
    required this.title,
    this.subtitle = '',
    this.filters = const [],
    required this.fetch,
    required this.columns,
    this.onRowTap,
    this.addLabel,
    this.onAdd,
    this.canAdd,
  });

  @override
  State<PagedListScreen<T>> createState() => _PagedListScreenState<T>();
}

class _PagedListScreenState<T> extends State<PagedListScreen<T>> {
  int _page = 1;
  int _limit = 20;
  Map<String, String?> _filters = {};
  bool _loading = true;
  Object? _error;
  Paginated<T>? _data;

  @override
  void initState() {
    super.initState();
    final defs = widget.filters;
    var map = <String, String?>{};
    for (final f in defs) {
      map[f.key] = null;
    }
    _filters = map;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await widget.fetch(_page, _limit, _filters);
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
      AppState.toasts.addToast(toApiException(e).message, type: 'error');
    }
  }

  void _onFilters(Map<String, String?> v) {
    setState(() {
      _filters = v;
      _page = 1;
    });
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final canAdd = (widget.canAdd?.call() ?? true) && widget.onAdd != null;
    return AppScaffold(
      selected: widget.slug,
      title: widget.title,
      subtitle: widget.subtitle,
      actions: [
        if (canAdd)
          FilledButton.icon(
            onPressed: () async {
              await widget.onAdd!(context);
              _load();
            },
            icon: const Icon(LucideIcons.plus, size: 18),
            label: Text(widget.addLabel ?? 'Add'),
          ),
      ],
      body: RefreshIndicator(
        onRefresh: () async => _load(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            FilterBar(
              filters: widget.filters,
              values: _filters,
              onChanged: _onFilters,
              onClear: () => _onFilters({
                for (final f in widget.filters) f.key: null,
              }),
            ),
            if (_error != null)
              Card(
                elevation: 0,
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: ErrorState(
                    message: toApiException(_error!).message,
                    onRetry: _load,
                  ),
                ),
              )
            else
              DataTableWidget<T>(
                loading: _loading,
                items: _data?.items ?? const [],
                columns: widget.columns(),
                onRowTap: widget.onRowTap,
              ),
            PaginationBar(
              page: _data?.page ?? 1,
              limit: _data?.limit ?? _limit,
              total: _data?.total ?? 0,
              totalPages: _data?.totalPages ?? 1,
              onPageChange: (p) {
                setState(() => _page = p);
                _load();
              },
              onLimitChange: (l) {
                setState(() {
                  _limit = l;
                  _page = 1;
                });
                _load();
              },
            ),
          ],
        ),
      ),
    );
  }
}