import 'package:dio/dio.dart';

import '../core/api_client.dart';

class Paginated<T> {
  final List<T> items;
  final int page;
  final int limit;
  final int total;
  final int totalPages;

  const Paginated({
    this.items = const [],
    this.page = 1,
    this.limit = 20,
    this.total = 0,
    this.totalPages = 1,
  });

  bool get isEmpty => items.isEmpty;
}

class Api {
  static Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? params}) async {
    final res = await ApiClient.instance.dio.get<Map<String, dynamic>>(
      path,
      queryParameters: params,
    );
    _check(res);
    return res.data ?? const {};
  }

  static Future<Map<String, dynamic>> post(String path, {Object? body}) async {
    final res = await ApiClient.instance.dio.post<Map<String, dynamic>>(path, data: body);
    _check(res);
    return res.data ?? const {};
  }

  static Future<Map<String, dynamic>> put(String path, {Object? body}) async {
    final res = await ApiClient.instance.dio.put<Map<String, dynamic>>(path, data: body);
    _check(res);
    return res.data ?? const {};
  }

  static Future<Map<String, dynamic>> patch(String path, {Object? body}) async {
    final res = await ApiClient.instance.dio.patch<Map<String, dynamic>>(path, data: body);
    _check(res);
    return res.data ?? const {};
  }

  static Future<Map<String, dynamic>> delete(String path, {Object? body}) async {
    final res = await ApiClient.instance.dio.delete<Map<String, dynamic>>(path, data: body);
    _check(res);
    return res.data ?? const {};
  }

  static void _check(Response res) {
    final data = res.data;
    if (data is Map && data['success'] == false) {
      throw ApiException(data['message'] as String? ?? 'Request failed');
    }
  }

  static Map<String, dynamic> detail(Map<String, dynamic> json) {
    final d = json['data'];
    return d is Map ? d.cast<String, dynamic>() : const {};
  }

  static List<Map<String, dynamic>> list(Map<String, dynamic> json, String key) {
    final v = json[key];
    return v is List ? v.map((e) => (e as Map).cast<String, dynamic>()).toList() : const [];
  }

  static List<Map<String, dynamic>> listFromDetail(
    Map<String, dynamic> json,
    String key,
  ) {
    final d = json['data'];
    if (d is List) {
      return d.map((e) => (e as Map).cast<String, dynamic>()).toList();
    }
    if (d is Map) {
      final v = d[key];
      if (v is List) return v.map((e) => (e as Map).cast<String, dynamic>()).toList();
    }
    final top = json[key];
    return top is List
        ? top.map((e) => (e as Map).cast<String, dynamic>()).toList()
        : const [];
  }

  static Paginated<T> paginated<T>(
    Map<String, dynamic> json,
    String key,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    final items = list(json, key).map(fromJson).toList();
    final meta = json['meta'];
    int page = 1, limit = 20, total = 0, totalPages = 1;
    if (meta is Map) {
      page = (meta['page'] as num?)?.toInt() ?? 1;
      limit = (meta['limit'] as num?)?.toInt() ?? 20;
      total = (meta['total'] as num?)?.toInt() ?? 0;
      totalPages = (meta['totalPages'] as num?)?.toInt() ?? 1;
    }
    return Paginated<T>(
      items: items,
      page: page,
      limit: limit,
      total: total,
      totalPages: totalPages,
    );
  }
}