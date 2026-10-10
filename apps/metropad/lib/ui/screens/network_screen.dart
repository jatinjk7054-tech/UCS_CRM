import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/api_client.dart';
import '../../core/constants.dart';
import '../../core/mumbai_metro.dart';
import '../../core/theme.dart';
import '../../models/metro.dart';
import '../../services/metro_service.dart';
import '../../state/app_state.dart';
import '../layout/main_layout.dart';
import '../widgets/common.dart';
import '../widgets/modals.dart';
import 'line_detail_screen.dart';
import 'station_detail_screen.dart';

class NetworkScreen extends StatefulWidget {
  const NetworkScreen({super.key});
  @override
  State<NetworkScreen> createState() => _NetworkScreenState();
}

class _NetworkScreenState extends State<NetworkScreen> {
  bool _loading = true;
  Object? _error;
  List<MetroLine> _lines = [];
  List<Station> _stations = [];
  final TextEditingController _searchCtrl = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        MetroLineService.getAll().then((p) => p.items),
        StationService.getAll(params: {'limit': 1000}).then((p) => p.items),
      ]);
      if (!mounted) return;
      setState(() {
        _lines = results[0] as List<MetroLine>;
        _stations = results[1] as List<Station>;
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
      selected: 'network',
      title: 'Metro Network',
      subtitle: 'Lines and stations',
      actions: [
        if (AppState.auth.canManage)
          FilledButton.icon(
            onPressed: () => _addLine(context),
            icon: const Icon(LucideIcons.plus, size: 18),
            label: const Text('Add Line'),
          ),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const LoadingSpinner(message: 'Loading network...')
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
                      _searchBar(),
                      const SizedBox(height: 12),
                      if (_query.isNotEmpty)
                        ..._searchResults()
                      else if (_lines.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 48),
                          child: EmptyState(
                            icon: LucideIcons.map,
                            title: 'No lines yet',
                            message: 'Tap "Add Line" to create your first metro line.',
                          ),
                        )
                      else
                        for (final line in _lines) ...[
                          _lineCard(line),
                          const SizedBox(height: 12),
                        ],
                    ],
                  ),
      ),
    );
  }

  Widget _searchBar() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: TextField(
          controller: _searchCtrl,
          onChanged: (v) => setState(() => _query = v.trim()),
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: 'Search stations',
            prefixIcon: const Icon(LucideIcons.search, size: 20),
            suffixIcon: _query.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear',
                    icon: const Icon(LucideIcons.x, size: 18),
                    onPressed: () {
                      _searchCtrl.clear();
                      setState(() => _query = '');
                    },
                  ),
            filled: false,
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
            focusedBorder: InputBorder.none,
          ),
        ),
      ),
    );
  }

  List<Widget> _searchResults() {
    final q = _query.toLowerCase();
    final matches = _stations
        .where((s) =>
            s.name.toLowerCase().contains(q) ||
            s.lineName.toLowerCase().contains(q))
        .toList();
    if (matches.isEmpty) {
      return const [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 48),
          child: EmptyState(
            icon: LucideIcons.search,
            title: 'No stations found',
            message: 'Try a different station name.',
          ),
        ),
      ];
    }
    return [
      Card(
        child: Column(
          children: [
            for (final s in matches)
              _stationTile(s, subtitle: s.lineName, showDivider: true),
          ],
        ),
      ),
    ];
  }

  void _openStation(Station s) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => StationDetailScreen(
          stationId: s.id,
          initialName: s.name,
        ),
      ),
    );
  }

  Widget _stationTile(Station s, {String? subtitle, bool showDivider = false}) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ListTile(
          dense: true,
          leading: _dot(s.lineId),
          title: Text(s.name,
              style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: (subtitle ?? '').isEmpty
              ? null
              : Text(subtitle!,
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.textLight)),
          trailing: s.machineCount > 0
              ? Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(LucideIcons.package,
                        size: 14, color: AppColors.textLight),
                    const SizedBox(width: 4),
                    Text('${s.machineCount}',
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.textLight)),
                  ],
                )
              : null,
          onTap: () => _openStation(s),
        ),
        if (showDivider) const Divider(height: 1),
      ],
    );
  }

  Widget _lineCard(MetroLine line) {
    final baseColor =
        colorFromHex(metroColors[line.id] ?? getLineColor(line.name));
    final initial = line.name.trim().isEmpty
        ? 'L'
        : line.name.trim().substring(0, 1).toUpperCase();
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => _openLine(line),
        onLongPress: () => _lineActions(line),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  color: baseColor.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(14),
                ),
                alignment: Alignment.center,
                child: Text(
                  initial,
                  style: TextStyle(
                    color: baseColor,
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(line.name,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text(
                      '${line.stationCount} ${line.stationCount == 1 ? 'station' : 'stations'} · ${humanizeLabel(line.status)}',
                      style: const TextStyle(
                          fontSize: 12.5, color: AppColors.textLight),
                    ),
                  ],
                ),
              ),
              const Icon(LucideIcons.chevronRight,
                  color: AppColors.textLight),
            ],
          ),
        ),
      ),
    );
  }

  void _openLine(MetroLine line) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => LineDetailScreen(line: line),
      ),
    ).then((_) => _load());
  }

  void _lineActions(MetroLine line) {
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
              leading: const Icon(LucideIcons.pencil, size: 20),
              title: const Text('Edit Line'),
              onTap: () {
                Navigator.pop(ctx);
                _editLine(line);
              },
            ),
            ListTile(
              leading: const Icon(LucideIcons.trash2,
                  size: 20, color: AppColors.danger),
              title: const Text('Delete Line',
                  style: TextStyle(color: AppColors.danger)),
              onTap: () {
                Navigator.pop(ctx);
                _deleteLine(line);
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Future<void> _editLine(MetroLine line) async {
    final name = TextEditingController(text: line.name);
    await showFormModal(
      context,
      title: 'Edit Line',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Edit Line',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Line Name',
              required: true,
              child: TextField(
                controller: name,
                textCapitalization: TextCapitalization.words,
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
                    final n = name.text.trim();
                    if (n.isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Line name is required')),
                      );
                      return;
                    }
                    final msg = await apiRun(context, () async {
                      await MetroLineService.update(
                        line.id,
                        MetroLine(
                          id: line.id,
                          code: line.code,
                          name: n,
                          description: line.description,
                          status: line.status,
                        ),
                      );
                    }, success: 'Line updated');
                    if (!mounted) return;
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

  Future<void> _deleteLine(MetroLine line) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        title: const Text('Delete line?'),
        content: Text(
            'This permanently deletes "${line.name}", all its stations, machines and their records.'),
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
      await MetroLineService.remove(line.id);
    }, success: 'Line deleted');
    if (!mounted) return;
    if (msg == null) {
      _load();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }


  String _genCode(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch.toRadixString(36).toUpperCase()}';

  Future<void> _addLine(BuildContext context) async {
    final name = TextEditingController();
    await showFormModal(
      context,
      title: 'Add Line',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add Line',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Line Name',
              required: true,
              child: TextField(
                controller: name,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(hintText: 'e.g. Pink Line'),
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
                    final n = name.text.trim();
                    if (n.isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Line name is required')),
                      );
                      return;
                    }
                    MetroLine? created;
                    final msg = await apiRun(context, () async {
                      created = await MetroLineService.create(MetroLine(
                        id: '',
                        code: _genCode('LN'),
                        name: n,
                        status: 'ACTIVE',
                      ));
                    });
                    if (!context.mounted) return;
                    if (msg == null) {
                      final newLine = created;
                      Navigator.pop(ctx);
                      AppState.toasts.addToast(
                        newLine == null
                            ? 'Line "$n" added.'
                            : 'Line "$n" added. Add stations under it.',
                        type: 'success',
                      );
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

  Widget _dot(String lineId) {
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        color: colorFromHex(metroColors[lineId] ?? '#4f46e5'),
        shape: BoxShape.circle,
      ),
    );
  }
}