import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../models/auth.dart';
import '../services/auth_service.dart';

class AuthState extends ChangeNotifier {
  AuthUser? _user;
  bool _ready = false;

  AuthUser? get user => _user;
  bool get ready => _ready;
  bool get isLoggedIn => _user != null;
  bool get isAdmin => _user?.role == 'ADMIN';
  bool get canManage => _user?.role == 'ADMIN' || _user?.role == 'OPERATIONS';

  bool hasRole(String role) => _user?.role == role;

  Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(tokenStorageKey);
    if (token == null || token.isEmpty) {
      _ready = true;
      notifyListeners();
      return;
    }
    try {
      _user = await AuthService.me();
    } catch (_) {
      await prefs.remove(tokenStorageKey);
      _user = null;
    }
    _ready = true;
    notifyListeners();
  }

  Future<AuthUser> login(String email, String password) async {
    final res = await AuthService.login(email, password);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(tokenStorageKey, res.token);
    _user = res.user;
    notifyListeners();
    return res.user;
  }

  Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(tokenStorageKey);
    _user = null;
    notifyListeners();
  }
}

class ToastItem {
  final int id;
  final String message;
  final String type;
  ToastItem(this.id, this.message, this.type);
}

class ToastState extends ChangeNotifier {
  final List<ToastItem> _toasts = [];
  int _counter = 0;
  final Map<int, Timer> _timers = {};

  List<ToastItem> get toasts => List.unmodifiable(_toasts);

  void addToast(String message, {String type = 'info', Duration duration = const Duration(seconds: 4)}) {
    final id = ++_counter;
    _toasts.add(ToastItem(id, message, type));
    _timers[id] = Timer(duration, () => removeToast(id));
    notifyListeners();
  }

  void removeToast(int id) {
    _timers.remove(id)?.cancel();
    _toasts.removeWhere((t) => t.id == id);
    notifyListeners();
  }
}

class AppState {
  AppState._();
  static final AuthState auth = AuthState();
  static final ToastState toasts = ToastState();
}