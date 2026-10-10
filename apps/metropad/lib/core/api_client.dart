import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Base URL override via `--dart-define=API_URL=https://host/api/metropad`.
const String apiBaseUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'https://api.beingsevak.org/api/metropad',
);

const String tokenStorageKey = 'mpc_token';

class ApiException implements Exception {
  final String message;
  final int? statusCode;
  ApiException(this.message, {this.statusCode});

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient._() {
    _dio = Dio(BaseOptions(
      baseUrl: apiBaseUrl,
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 60),
      sendTimeout: const Duration(seconds: 60),
      headers: {'Content-Type': 'application/json'},
    ));
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final prefs = await SharedPreferences.getInstance();
        final token = prefs.getString(tokenStorageKey);
        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
        }
        handler.next(options);
      },
      onError: (error, handler) async {
        if (error.type == DioExceptionType.connectionTimeout ||
            error.type == DioExceptionType.receiveTimeout ||
            error.type == DioExceptionType.sendTimeout) {
          handler.resolve(Response(
            requestOptions: error.requestOptions,
            data: {
              'success': false,
              'message':
                  'Request timed out. Check that you have internet and that the server URL is reachable.',
            },
          ));
          return;
        }
        if (error.response?.statusCode == 401) {
          final path = error.requestOptions.path;
          if (!path.contains('/login')) {
            final prefs = await SharedPreferences.getInstance();
            await prefs.remove(tokenStorageKey);
          }
        }
        handler.next(error);
      },
    ));
  }

  static final ApiClient instance = ApiClient._();
  late final Dio _dio;

  Dio get dio => _dio;

  Map<String, dynamic> validateEnvelope(Map<String, dynamic> data) {
    if (data['success'] == false) {
      throw ApiException(data['message'] as String? ?? 'Request failed');
    }
    return data;
  }
}

Future<T> unwrap<T>(Response response, {Map<String, dynamic>? body}) async {
  Map<String, dynamic> data;
  try {
    data = response.data as Map<String, dynamic>;
  } catch (_) {
    throw ApiException('Unexpected response format');
  }
  return ApiClient.instance.validateEnvelope(data) as T;
}

ApiException toApiException(Object error) {
  if (error is DioException) {
    final resp = error.response;
    if (resp?.data is Map && (resp!.data['success'] == false)) {
      return ApiException(
        resp.data['message'] as String? ?? 'Request failed',
        statusCode: resp.statusCode,
      );
    }
    return ApiException(
      error.message ?? 'Network error',
      statusCode: resp?.statusCode ?? error.response?.statusCode,
    );
  }
  if (error is ApiException) return error;
  if (kDebugMode) debugPrint('api error: $error');
  return ApiException('Something went wrong');
}