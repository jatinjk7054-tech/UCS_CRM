import 'package:lucide_flutter/lucide_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api_client.dart';
import '../../core/mumbai_metro.dart';
import '../../core/theme.dart';
import '../../models/dashboard.dart';
import '../../models/stock.dart';
import '../../services/dashboard_service.dart';
import '../../services/stock_service.dart';
import '../../state/app_state.dart';
import '../layout/main_layout.dart';
import '../widgets/common.dart';
import 'screens.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});
  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  bool _loading = true;
  Object? _error;
  DashboardOverview? _overview;
  StockSummary? _stock;
  String _selectedLine = 'all';

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
      final results = await Future.wait<Object>([
        DashboardService.getOverview(),
        StockService.getSummary(),
      ]);
      if (!mounted) return;
      setState(() {
        _overview = results[0] as DashboardOverview;
        _stock = results[1] as StockSummary?;
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

  void _go(String slug) {
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (_) => screenFor(slug)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      selected: 'dashboard',
      body: _loading || _overview == null
          ? _loading && _overview == null
              ? const LoadingSpinner(message: 'Loading...')
              : Center(
                  child: ErrorState(
                    message: toApiException(_error!).message,
                    onRetry: _load,
                  ),
                )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _hero(),
                  const SizedBox(height: 16),
                  _kpis(),
                  const SizedBox(height: 16),
                  _padStockCard(),
                  const SizedBox(height: 16),
                  _mapCard(),
                ],
              ),
            ),
    );
  }

  Widget _hero() {
    final name = AppState.auth.user?.name ?? '';
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.primary, AppColors.primaryLight],
        ),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Good to see you, $name',
            style: const TextStyle(
              color: Colors.white,
              fontSize: 18,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Here is the overview of your metro pad machines.',
            style: TextStyle(color: Colors.white70, fontSize: 13),
          ),
        ],
      ),
    );
  }

  Widget _kpis() {
    final s = _overview!.stats;
    final cards = [
      KpiCard(
        title: 'Inactive Machines',
        value: '${s.inactiveMachines}',
        icon: LucideIcons.circleStop,
        color: AppColors.danger,
      ),
      KpiCard(
        title: 'Maintenance Due',
        value: '${s.maintenanceMachines}',
        icon: LucideIcons.wrench,
        color: AppColors.orange,
      ),
      KpiCard(
        title: 'Metro Lines',
        value: '${s.totalMetroLines}',
        icon: LucideIcons.train,
        color: AppColors.purple,
        onClick: () => _go('network'),
      ),
      KpiCard(
        title: 'Stations',
        value: '${s.totalStations}',
        icon: LucideIcons.mapPin,
        color: AppColors.teal,
        onClick: () => _go('network'),
      ),
    ];
    return GridView.count(
      crossAxisCount: MediaQuery.of(context).size.width > 700 ? 4 : 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 1.5,
      children: cards,
    );
  }

  Widget _padStockCard() {
    final s = _stock;
    if (s == null) return const SizedBox.shrink();
    final stats = [
      _stockStat('Remaining Central', s.remainingCentral, 'pads', LucideIcons.database),
      _stockStat('Central Value', s.remainingCentralValue, '₹', LucideIcons.wallet),
      _stockStat('Distributed', s.totalDistributed, 'pads', LucideIcons.arrowDownLeft),
      _stockStat('Active Machines', s.activeMachines, 'count', LucideIcons.checkCircle),
    ];
    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(LucideIcons.package,
                      color: AppColors.primary, size: 20),
                ),
                const SizedBox(width: 10),
                const Text('Pad Stock',
                    style: TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700)),
              ],
            ),
            const SizedBox(height: 14),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 2.4,
              children: stats,
            ),
          ],
        ),
      ),
    );
  }

  Widget _stockStat(String label, num? value, String unit, IconData icon) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.sidebarHover,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AppColors.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11, color: AppColors.textLight)),
                Text(
                  unit == '₹'
                      ? '₹${value?.toInt() ?? 0}'
                      : '${value?.toInt() ?? 0} ${unit == 'count' ? '' : unit}'
                          .trim(),
                  style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      color: AppColors.text),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _mapCard() {
    final metro = buildMumbaiMetroData();
    final visibleLines = _selectedLine == 'all'
        ? displayLineIds
        : [_selectedLine];
    final pointsByLine = <String, List<LatLng>>{};
    for (final lineId in visibleLines) {
      final line = metro.lines[lineId];
      if (line == null) continue;
      final pts = <LatLng>[];
      for (final sid in line.stations) {
        final s = metro.stations[sid];
        if (s != null) pts.add(LatLng(s.lat, s.lng));
      }
      pointsByLine[lineId] = pts;
    }

    LatLng initial = const LatLng(19.15, 72.86);
    if (pointsByLine.isNotEmpty) {
      final first = pointsByLine.values.first;
      if (first.isNotEmpty) initial = first.first;
    }

    return Card(
      elevation: 0,
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Network Map',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilterChip(
                  label: const Text('All'),
                  selected: _selectedLine == 'all',
                  onSelected: (_) =>
                      setState(() => _selectedLine = 'all'),
                ),
                for (final lid in displayLineIds)
                  FilterChip(
                    label:
                        Text('Line ${metro.lines[lid]?.number ?? ''}'),
                    selected: _selectedLine == lid,
                    showCheckmark: false,
                    selectedColor:
                        colorFromHex(metroColors[lid] ?? '#4f46e5'),
                    onSelected: (_) =>
                        setState(() => _selectedLine = lid),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 340,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: FlutterMap(
                  options: MapOptions(
                    initialCenter: initial,
                    initialZoom: 10.5,
                    minZoom: 10,
                  ),
                  children: [
                    TileLayer(
                      urlTemplate:
                          'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                      userAgentPackageName: 'com.beingsevak.metropad',
                    ),
                    PolylineLayer(
                      polylines: [
                        for (final e in pointsByLine.entries)
                          Polyline(
                            points: e.value,
                            color:
                                colorFromHex(metroColors[e.key] ?? '#4f46e5'),
                            strokeWidth: 3,
                          ),
                      ],
                    ),
                    MarkerLayer(
                      markers: [
                        for (final lineId in visibleLines)
                          for (final sid
                              in (metro.lines[lineId]?.stations ?? const []))
                            if (metro.stations[sid] != null)
                              Marker(
                                point: LatLng(
                                  metro.stations[sid]!.lat,
                                  metro.stations[sid]!.lng,
                                ),
                                width: 26,
                                height: 26,
                                child: GestureDetector(
                                  onTap: () => _showStation(metro.stations[sid]!),
                                  child: Icon(
                                    LucideIcons.mapPin,
                                    size: 26,
                                    color: colorFromHex(
                                        metroColors[lineId] ?? '#4f46e5'),
                                  ),
                                ),
                              ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showStation(MetroStationData s) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(s.name), duration: const Duration(seconds: 1)),
    );
  }
}
