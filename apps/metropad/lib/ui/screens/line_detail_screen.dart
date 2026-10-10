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
import 'station_detail_screen.dart';

class LineDetailScreen extends StatefulWidget {
  final MetroLine line;
  const LineDetailScreen({super.key, required this.line});

  @override
  State<LineDetailScreen> createState() => _LineDetailScreenState();
}

class _LineDetailScreenState extends State<LineDetailScreen> {
  bool _loading = true;
  Object? _error;
  List<Station> _stations = [];
  final TextEditingController _searchCtrl = TextEditingController();
  String _query = '';

  MetroLine get _line => widget.line;

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
      final all = await StationService.getAll(params: {'limit': 1000});
      if (!mounted) return;
      setState(() {
        _stations = all.items.where((s) => s.lineId == _line.id).toList();
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
      showBack: true,
      title: _line.name,
      subtitle:
          '${_stations.length} ${_stations.length == 1 ? 'station' : 'stations'}',
      actions: [
        if (AppState.auth.canManage)
          FilledButton.icon(
            onPressed: _addStation,
            icon: const Icon(LucideIcons.plus, size: 18),
            label: const Text('Add Station'),
          ),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const LoadingSpinner(message: 'Loading stations...')
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
                      if (_visible.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 48),
                          child: EmptyState(
                            icon: LucideIcons.mapPin,
                            title: 'No stations',
                            message:
                                'No stations on this line yet. Tap "Add Station" to add one.',
                          ),
                        )
                      else
                        Card(
                          child: Column(
                            children: [
                              for (var i = 0; i < _visible.length; i++) ...[
                                _stationTile(_visible[i]),
                                if (i != _visible.length - 1)
                                  const Divider(height: 1),
                              ],
                            ],
                          ),
                        ),
                    ],
                  ),
      ),
    );
  }

  List<Station> get _visible {
    if (_query.isEmpty) return _stations;
    final q = _query.toLowerCase();
    return _stations.where((s) => s.name.toLowerCase().contains(q)).toList();
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

  Widget _stationTile(Station s) {
    final color = colorFromHex(
        metroColors[_line.id] ?? getLineColor(_line.name));
    return ListTile(
      leading: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
      title: Text(s.name,
          style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: s.status.isEmpty
          ? null
          : Text(humanizeLabel(s.status),
              style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (s.machineCount > 0) ...[
            const Icon(LucideIcons.package,
                size: 14, color: AppColors.textLight),
            const SizedBox(width: 4),
            Text('${s.machineCount}',
                style: const TextStyle(
                    fontSize: 12, color: AppColors.textLight)),
            const SizedBox(width: 8),
          ],
          const Icon(LucideIcons.chevronRight,
              size: 18, color: AppColors.textLight),
        ],
      ),
      onTap: () => _openStation(s),
      onLongPress: () => _stationActions(s),
    );
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
    ).then((_) => _load());
  }

  void _stationActions(Station s) {
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
              title: const Text('Edit Station'),
              onTap: () {
                Navigator.pop(ctx);
                _editStation(s);
              },
            ),
            ListTile(
              leading: const Icon(LucideIcons.trash2,
                  size: 20, color: AppColors.danger),
              title: const Text('Delete Station',
                  style: TextStyle(color: AppColors.danger)),
              onTap: () {
                Navigator.pop(ctx);
                _deleteStation(s);
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Future<void> _editStation(Station s) async {
    final name = TextEditingController(text: s.name);
    await showFormModal(
      context,
      title: 'Edit Station',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Edit Station',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            FormFieldWrap(
              label: 'Station Name',
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
                        const SnackBar(
                            content: Text('Station name is required')),
                      );
                      return;
                    }
                    final msg = await apiRun(context, () async {
                      await StationService.update(
                        s.id,
                        Station(
                          id: s.id,
                          name: n,
                          stationCode: s.stationCode,
                          lineId: s.lineId,
                          lineName: s.lineName,
                          lineCode: s.lineCode,
                          description: s.description,
                          status: s.status,
                        ),
                      );
                    }, success: 'Station updated');
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

  Future<void> _deleteStation(Station s) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        title: const Text('Delete station?'),
        content: Text(
            'This permanently deletes "${s.name}", its machine and their records.'),
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
      await StationService.remove(s.id);
    }, success: 'Station deleted');
    if (!mounted) return;
    if (msg == null) {
      _load();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }

  String _genCode(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch.toRadixString(36).toUpperCase()}';

  Future<void> _addStation() async {
    final names = <TextEditingController>[TextEditingController()];
    await showFormModal(
      context,
      title: 'Add Stations',
      builder: (ctx, setState) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Add Stations to ${_line.name}',
                style: const TextStyle(
                    fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            const Text('Add one or more stations at a time.',
                style: TextStyle(fontSize: 12, color: AppColors.textLight)),
            const SizedBox(height: 4),
            Text(
              'A machine with ${AppConstants.slotsPerMachine} slots of ${AppConstants.slotCapacity} pads is created automatically for each station.',
              style: const TextStyle(fontSize: 12, color: AppColors.textLight),
            ),
            const SizedBox(height: 16),
            for (var i = 0; i < names.length; i++) ...[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: FormFieldWrap(
                      label:
                          names.length > 1 ? 'Station ${i + 1}' : 'Station Name',
                      required: true,
                      child: TextField(
                        controller: names[i],
                        textCapitalization: TextCapitalization.words,
                        decoration:
                            const InputDecoration(hintText: 'e.g. Andheri'),
                      ),
                    ),
                  ),
                  if (names.length > 1) ...[
                    const SizedBox(width: 8),
                    Padding(
                      padding: const EdgeInsets.only(top: 24),
                      child: IconButton(
                        tooltip: 'Remove',
                        onPressed: () => setState(() => names.removeAt(i)),
                        icon: const Icon(LucideIcons.x, size: 18),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 12),
            ],
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () =>
                    setState(() => names.add(TextEditingController())),
                icon: const Icon(LucideIcons.plus, size: 16),
                label: const Text('Add another station'),
              ),
            ),
            const SizedBox(height: 12),
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
                    final messenger = ScaffoldMessenger.of(context);
                    final valid = names
                        .map((c) => c.text.trim())
                        .where((n) => n.isNotEmpty)
                        .toList();
                    if (valid.isEmpty) {
                      messenger.showSnackBar(
                        const SnackBar(
                            content: Text('Enter at least one station name')),
                      );
                      return;
                    }
                    final added = <String>[];
                    String? firstError;
                    for (final n in valid) {
                      try {
                        await StationService.create(Station(
                          id: '',
                          name: n,
                          stationCode: _genCode('ST'),
                          lineId: _line.id,
                          lineName: _line.name,
                          lineCode: _line.code,
                          status: 'ACTIVE',
                        ));
                        added.add(n);
                      } catch (e) {
                        firstError ??= toApiException(e).message;
                      }
                    }
                    if (!context.mounted) return;
                    if (added.isNotEmpty) {
                      Navigator.pop(ctx);
                      AppState.toasts.addToast(
                        '${added.length} station${added.length == 1 ? '' : 's'} added to ${_line.name}',
                        type: 'success',
                      );
                      _load();
                    }
                    if (firstError != null) {
                      messenger.showSnackBar(
                        SnackBar(content: Text(firstError)),
                      );
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
