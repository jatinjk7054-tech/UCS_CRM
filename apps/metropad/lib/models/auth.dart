class AuthUser {
  final String id;
  final String name;
  final String email;
  final String role;

  const AuthUser({
    required this.id,
    required this.name,
    required this.email,
    required this.role,
  });

  factory AuthUser.fromJson(Map<String, dynamic> json) {
    return AuthUser(
      id: asStr(json['id']),
      name: asStr(json['name']),
      email: asStr(json['email']),
      role: asStr(json['role']),
    );
  }

  bool hasRole(String role) => this.role == role;

  static String asStr(dynamic v) {
    if (v == null) return '';
    if (v is num) return v.toString();
    return v.toString();
  }
}

class AuthResponse {
  final String token;
  final AuthUser user;

  const AuthResponse({required this.token, required this.user});

  factory AuthResponse.fromJson(Map<String, dynamic> json) {
    return AuthResponse(
      token: AuthUser.asStr(json['token']),
      user: AuthUser.fromJson((json['user'] as Map).cast<String, dynamic>()),
    );
  }
}

class LoginCredentials {
  final String email;
  final String password;

  const LoginCredentials({required this.email, required this.password});
}