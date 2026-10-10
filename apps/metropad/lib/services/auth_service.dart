import '../models/auth.dart';
import 'base_service.dart';

class AuthService {
  static Future<AuthResponse> login(String email, String password) async {
    final json = await Api.post('/auth/login', body: {
      'email': email,
      'password': password,
    });
    return AuthResponse.fromJson(Api.detail(json));
  }

  static Future<AuthUser> me() async {
    final json = await Api.get('/auth/me');
    return AuthUser.fromJson(Api.detail(json));
  }
}