import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/theme.dart';
import '../../state/app_state.dart';
import '../screens/screens.dart';

const Map<String, String> titleMap = {
  'dashboard': 'Dashboard',
  'network': 'Metro Network',
  'metro-lines': 'Metro Lines',
  'stations': 'Stations',
  'machines': 'Machines',
  'pad-stock': 'Pad Stock',
  'maintenance': 'Maintenance',
  'monthly-data': 'Monthly Data',
  'reports': 'Reports',
  'users': 'Users',
  'audit-logs': 'Audit Logs',
  'settings': 'Settings',
};

class AppScaffold extends StatelessWidget {
  final String selected;
  final String? title;
  final String subtitle;
  final List<Widget> actions;
  final Widget body;
  final bool showBack;

  const AppScaffold({
    super.key,
    required this.selected,
    this.title,
    this.subtitle = '',
    this.actions = const [],
    required this.body,
    this.showBack = false,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: showBack
            ? IconButton(
                icon: const Icon(LucideIcons.chevronLeft),
                tooltip: 'Back',
                onPressed: () => Navigator.of(context).maybePop(),
              )
            : IconButton(
                icon: const Icon(LucideIcons.home),
                tooltip: 'Dashboard',
                onPressed: () {
                  Navigator.of(context).pushAndRemoveUntil(
                    MaterialPageRoute(builder: (_) => const DashboardScreen()),
                    (route) => false,
                  );
                },
              ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title ?? titleMap[selected] ?? ''),
            if (subtitle.isNotEmpty)
              Text(
                subtitle,
                style: const TextStyle(fontSize: 12, color: AppColors.textLight),
              ),
          ],
        ),
        actions: [
          ...actions,
          const _UserMenuButton(),
        ],
      ),
      body: body,
      bottomNavigationBar: BottomNavBar(selected: selected),
    );
  }
}

class _UserMenuButton extends StatelessWidget {
  const _UserMenuButton();

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: AppState.auth,
      builder: (context, _) {
        final user = AppState.auth.user;
        return PopupMenuButton<String>(
          icon: const Icon(LucideIcons.circleUser),
          tooltip: 'Account',
          onSelected: (v) async {
            if (v == 'logout') {
              await AppState.auth.logout();
            }
          },
          itemBuilder: (context) => [
            PopupMenuItem(
              enabled: false,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(user?.name ?? '',
                      style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text('${user?.email ?? ''} · ${user?.role ?? ''}',
                      style:
                          const TextStyle(fontSize: 12, color: AppColors.textLight)),
                ],
              ),
            ),
            const PopupMenuDivider(),
            const PopupMenuItem(value: 'logout', child: Text('Log Out')),
          ],
        );
      },
    );
  }
}

class _NavItem {
  final String label;
  final String route;
  final IconData icon;
  const _NavItem(this.label, this.route, this.icon);
}

class BottomNavBar extends StatelessWidget {
  final String selected;
  const BottomNavBar({super.key, required this.selected});

  static const List<_NavItem> _tabs = [
    _NavItem('Dashboard', 'dashboard', LucideIcons.layoutDashboard),
    _NavItem('Metro Network', 'network', LucideIcons.trainFront),
  ];

  void _go(BuildContext context, String route) {
    if (route == selected) return;
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (_) => screenFor(route)),
    );
  }

@override
  Widget build(BuildContext context) {
    final items = _tabs;

    return Container(
      decoration: const BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        boxShadow: [
          BoxShadow(
            color: Color(0x14000000),
            blurRadius: 18,
            offset: Offset(0, -4),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
          child: Row(
            children: [
              for (final t in items)
                Expanded(
                  child: InkWell(
                    onTap: () => _go(context, t.route),
                    borderRadius: BorderRadius.circular(14),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: t.route == selected
                                  ? AppColors.primary50
                                  : Colors.transparent,
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Icon(
                              t.icon,
                              size: 20,
                              color: t.route == selected
                                  ? AppColors.primary
                                  : AppColors.textLight,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            t.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: t.route == selected
                                  ? FontWeight.w700
                                  : FontWeight.w500,
                              color: t.route == selected
                                  ? AppColors.primary
                                  : AppColors.textLight,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}