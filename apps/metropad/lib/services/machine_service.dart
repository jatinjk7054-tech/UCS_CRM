import '../models/machine.dart';
import '../models/refill.dart';
import 'base_service.dart';

class MachineService {
  static Future<Paginated<Machine>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/machines', params: params);
    return Api.paginated(json, 'machines', Machine.fromJson);
  }

  static Future<Machine> getById(String id) async {
    final json = await Api.get('/machines/$id');
    return Machine.fromJson(Api.detail(json));
  }

  static Future<Machine> create(Machine machine) async {
    final json = await Api.post('/machines', body: machine.toJson());
    return Machine.fromJson(Api.detail(json));
  }

  static Future<void> update(String id, Machine machine) async {
    await Api.put('/machines/$id', body: machine.toJson());
  }

  static Future<void> changeStatus(String id, String status, String reason) async {
    await Api.patch('/machines/$id/status', body: {'status': status, 'reason': reason});
  }

  static Future<Paginated<MachineStatusHistory>> getStatusHistory(
    String id, {
    Map<String, dynamic>? params,
  }) async {
    final json = await Api.get('/machines/$id/status-history', params: params);
    return Api.paginated(json, 'history', MachineStatusHistory.fromJson);
  }

  static Future<void> remove(String id) async {
    await Api.delete('/machines/$id');
  }
}

class RefillService {
  static Future<Paginated<Refill>> getAll({
    Map<String, dynamic>? params,
    int? year,
    int? month,
  }) async {
    var query = {...?params};
    if (year != null && month != null) {
      final y = year.toString().padLeft(4, '0');
      final m = month.toString().padLeft(2, '0');
      final lastDay = DateTime(year, month + 1, 0).day;
      query['dateFrom'] = '$y-$m-01';
      query['dateTo'] = '$y-$m-${lastDay.toString().padLeft(2, '0')}';
    }
    final json = await Api.get('/refills', params: query);
    return Api.paginated(json, 'refills', Refill.fromJson);
  }

  static Future<List<Refill>> getByMachine(String machineId) async {
    final json = await Api.get('/refills/machine/$machineId');
    return Api.listFromDetail(json, 'refills').map(Refill.fromJson).toList();
  }

  static Future<List<Refill>> getRecent(int limit) async {
    final json = await Api.get('/refills/recent', params: {'limit': limit});
    return Api.list(json, 'refills').map(Refill.fromJson).toList();
  }

  static Future<Refill> create(Map<String, dynamic> body) async {
    final json = await Api.post('/refills', body: body);
    return Refill.fromJson(Api.detail(json));
  }

  static Future<void> update(String id, Map<String, dynamic> body) async {
    await Api.put('/refills/$id', body: body);
  }

  static Future<void> remove(String id) async {
    await Api.delete('/refills/$id');
  }
}