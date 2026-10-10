import 'package:flutter/material.dart';

import 'core/theme.dart';
import 'state/app_state.dart';
import 'ui/screens/screens.dart';
import 'ui/widgets/common.dart';
import 'ui/widgets/toast_host.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MetroPadApp());
}

class MetroPadApp extends StatelessWidget {
  const MetroPadApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MetroPad',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      builder: (context, child) {
        return Stack(
          fit: StackFit.expand,
          children: [
            ?child,
            const ToastHost(),
          ],
        );
      },
      home: const RootGate(),
    );
  }
}

class RootGate extends StatefulWidget {
  const RootGate({super.key});
  @override
  State<RootGate> createState() => _RootGateState();
}

class _RootGateState extends State<RootGate> {
  @override
  void initState() {
    super.initState();
    AppState.auth.restore();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: AppState.auth,
      builder: (context, _) {
        if (!AppState.auth.ready) {
          return const LoadingSpinner(fullPage: true, message: 'Loading...');
        }
        if (AppState.auth.isLoggedIn) {
          return const DashboardScreen();
        }
        return const LoginScreen();
      },
    );
  }
}