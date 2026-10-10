import '../models/dashboard.dart';
import 'base_service.dart';

class DashboardService {
  static Future<DashboardStats> getStats() async {
    final json = await Api.get('/dashboard/stats');
    return DashboardStats.fromJson(Api.detail(json));
  }

  static Future<List<MachineAlert>> getLowStockAlerts() async {
    final json = await Api.get('/dashboard/alerts/low-stock');
    return MachineAlert.listFromJson(Api.detail(json));
  }

  static Future<List<MachineAlert>> getAttentionMachines() async {
    final json = await Api.get('/dashboard/alerts/attention');
    return MachineAlert.listFromJson(Api.detail(json));
  }

  static Future<List<RefillLite>> getRecentRefills(int limit) async {
    final json = await Api.get('/dashboard/recent-refills', params: {'limit': limit});
    final d = Api.detail(json);
    final refills = d['refills'];
    if (refills is List) {
      return refills
          .map((e) => RefillLite.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    }
    return const [];
  }

  static Future<DashboardOverview> getOverview() async {
    final json = await Api.get('/dashboard/overview');
    return DashboardOverview.fromJson(Api.detail(json));
  }
}