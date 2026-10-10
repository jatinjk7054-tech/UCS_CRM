import 'package:flutter/material.dart';

import 'dashboard_screen.dart';
import 'login_screen.dart';
import 'network_screen.dart';

export 'dashboard_screen.dart';
export 'login_screen.dart';
export 'network_screen.dart';

Widget screenFor(String route) {
  switch (route) {
    case 'login':
      return const LoginScreen();
    case 'network':
      return const NetworkScreen();
    case 'dashboard':
    default:
      return const DashboardScreen();
  }
}