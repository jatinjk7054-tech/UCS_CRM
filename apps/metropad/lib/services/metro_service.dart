import '../models/metro.dart';
import 'base_service.dart';

class MetroLineService {
  static Future<Paginated<MetroLine>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/metro-lines', params: params);
    return Api.paginated(json, 'lines', MetroLine.fromJson);
  }

  static Future<MetroLine> getById(String id) async {
    final json = await Api.get('/metro-lines/$id');
    return MetroLine.fromJson(Api.detail(json));
  }

  static Future<MetroLine> create(MetroLine line) async {
    final json = await Api.post('/metro-lines', body: line.toCreateJson());
    return MetroLine.fromJson(Api.detail(json));
  }

  static Future<void> update(String id, MetroLine line) async {
    await Api.put('/metro-lines/$id', body: line.toCreateJson());
  }

  static Future<void> updateStatus(String id, String status) async {
    await Api.patch('/metro-lines/$id/status', body: {'status': status});
  }

  static Future<void> remove(String id) async {
    await Api.delete('/metro-lines/$id');
  }
}

class StationService {
  static Future<Paginated<Station>> getAll({Map<String, dynamic>? params}) async {
    final json = await Api.get('/stations', params: params);
    return Api.paginated(json, 'stations', Station.fromJson);
  }

  static Future<Station> getById(String id) async {
    final json = await Api.get('/stations/$id');
    return Station.fromJson(Api.detail(json));
  }

  static Future<Station> create(Station station) async {
    final json = await Api.post('/stations', body: station.toJson());
    return Station.fromJson(Api.detail(json));
  }

  static Future<void> update(String id, Station station) async {
    await Api.put('/stations/$id', body: station.toJson());
  }

  static Future<void> remove(String id) async {
    await Api.delete('/stations/$id');
  }
}