import '../models/dashboard.dart';
import '../models/monthly.dart';
import 'base_service.dart';

class MonthlyDataService {
  static Future<Map<String, dynamic>> get({Map<String, dynamic>? params}) async {
    final json = await Api.get('/monthly-data', params: params);
    return json;
  }

  static Future<MonthlyRecordsResponse> getRecords({Map<String, dynamic>? params}) async {
    final json = await Api.get('/monthly-data/records', params: params);
    return MonthlyRecordsResponse.fromJson(json);
  }

  static Future<Map<String, dynamic>> create(Map<String, dynamic> payload) async {
    final json = await Api.post('/monthly-data/records', body: payload);
    return json;
  }
}

class CashCollectionService {
  static Future<CashCollection> getMonthly(Map<String, dynamic>? params) async {
    final json = await Api.get('/cash-collections', params: params);
    return CashCollection.fromJson(json);
  }

  static Future<void> create(Map<String, dynamic> body) async {
    await Api.post('/cash-collections', body: body);
  }

  static Future<void> remove(String id) async {
    await Api.delete('/cash-collections/$id');
  }
}

class ReportService {
  static Future<Map<String, dynamic>> getReport(
    String type, {
    Map<String, dynamic>? params,
  }) async {
    final json = await Api.get('/reports/$type', params: params);
    return Api.detail(json);
  }

  static Future<void> export(String type, Map<String, dynamic>? params, String format) async {
    await Api.get('/reports/export/$type', params: {...?params, 'format': format});
  }
}

class UserService {
  static Future<Paginated<AdminUser>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/users', params: params);
    return Api.paginated(json, 'users', AdminUser.fromJson);
  }

  static Future<void> create(Map<String, dynamic> body) async {
    await Api.post('/users', body: body);
  }

  static Future<void> update(String id, Map<String, dynamic> body) async {
    await Api.put('/users/$id', body: body);
  }

  static Future<void> resetPassword(String id, Map<String, dynamic> body) async {
    await Api.patch('/users/$id/password', body: body);
  }

  static Future<void> remove(String id) async {
    await Api.delete('/users/$id');
  }
}

class AuditService {
  static Future<Paginated<AuditLog>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/audit-logs', params: params);
    return Api.paginated(json, 'logs', AuditLog.fromJson);
  }
}