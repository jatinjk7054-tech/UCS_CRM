import '../models/refill.dart';
import '../models/stock.dart';
import 'base_service.dart';

class StockIssueService {
  static Future<Paginated<StockIssue>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/stock-issues', params: params);
    return Api.paginated(json, 'issues', StockIssue.fromJson);
  }

  static Future<StockIssue> getById(String id) async {
    final json = await Api.get('/stock-issues/$id');
    return StockIssue.fromJson(Api.detail(json));
  }

  static Future<List<StockIssue>> getByMachine(String machineId) async {
    final json = await Api.get('/stock-issues/machine/$machineId');
    return Api.listFromDetail(json, 'issues').map(StockIssue.fromJson).toList();
  }

  static Future<StockIssue> create(Map<String, dynamic> body) async {
    final json = await Api.post('/stock-issues', body: body);
    return StockIssue.fromJson(Api.detail(json));
  }

  static Future<void> updateStatus(String id, String status) async {
    await Api.patch('/stock-issues/$id/status', body: {'status': status});
  }
}

class MaintenanceService {
  static Future<Paginated<MaintenanceRecord>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/maintenance', params: params);
    return Api.paginated(json, 'maintenance', MaintenanceRecord.fromJson);
  }

  static Future<MaintenanceRecord> getById(String id) async {
    final json = await Api.get('/maintenance/$id');
    return MaintenanceRecord.fromJson(Api.detail(json));
  }

  static Future<List<MaintenanceRecord>> getByMachine(String machineId) async {
    final json = await Api.get('/maintenance/machine/$machineId');
    return Api.listFromDetail(json, 'maintenance').map(MaintenanceRecord.fromJson).toList();
  }

  static Future<MaintenanceRecord> create(Map<String, dynamic> body) async {
    final json = await Api.post('/maintenance', body: body);
    return MaintenanceRecord.fromJson(Api.detail(json));
  }

  static Future<void> update(String id, Map<String, dynamic> body) async {
    await Api.put('/maintenance/$id', body: body);
  }
}

class StockService {
  static Future<StockConfig> getConfig() async {
    final json = await Api.get('/stock/config');
    return StockConfig.fromJson(Api.detail(json));
  }

  static Future<StockConfig> updateConfig(StockConfig config) async {
    final json = await Api.put('/stock/config', body: {
      'initialStock': config.initialStock,
      'pricePerPad': config.pricePerPad,
      'lowStockThreshold': config.lowStockThreshold,
    });
    return StockConfig.fromJson(Api.detail(json));
  }

  static Future<StockSummary> getSummary() async {
    final json = await Api.get('/stock/summary');
    return StockSummary.fromJson(Api.detail(json));
  }

  static Future<List<StationStock>> getStationWise() async {
    final json = await Api.get('/stock/stations');
    final data = json['data'];
    if (data is List) {
      return data.map((e) => StationStock.fromJson((e as Map).cast<String, dynamic>())).toList();
    }
    return Api.list(json, 'stations').map(StationStock.fromJson).toList();
  }

  static Future<MonthlyStock> getMonthly(int year, int month) async {
    final json = await Api.get('/stock/monthly', params: {'year': year, 'month': month});
    return MonthlyStock.fromJson(Api.detail(json));
  }

  static Future<num> getRemaining() async {
    final json = await Api.get('/stock/remaining');
    return (Api.detail(json)['remaining'] as num?) ?? 0;
  }

  static Future<void> setMonthlyRefillStatus(Map<String, dynamic> body) async {
    await Api.post('/stock/monthly/status', body: body);
  }

  static Future<void> saveMonthlyRefill(String machineId, Map<String, dynamic> body) async {
    await Api.put('/stock/monthly/refill/$machineId', body: body);
  }
}