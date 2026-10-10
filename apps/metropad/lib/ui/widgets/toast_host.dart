import 'package:flutter/material.dart';
import 'package:lucide_flutter/lucide_flutter.dart';

import '../../core/theme.dart';
import '../../state/app_state.dart';

class ToastHost extends StatelessWidget {
  const ToastHost({super.key});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: AppState.toasts,
      builder: (context, _) {
        final toasts = AppState.toasts.toasts;
        if (toasts.isEmpty) return const SizedBox.shrink();
        final top = MediaQuery.of(context).padding.top + 8;
        return Positioned(
          top: top,
          left: 0,
          right: 0,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final t in toasts)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Material(
                    color: _bg(t.type),
                    elevation: 4,
                    borderRadius: BorderRadius.circular(10),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(_icon(t.type), size: 18, color: Colors.white),
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              t.message,
                              style: const TextStyle(color: Colors.white, fontSize: 13.5),
                            ),
                          ),
                          const SizedBox(width: 6),
                          InkWell(
                            onTap: () => AppState.toasts.removeToast(t.id),
                            child: const Icon(LucideIcons.x, size: 16, color: Colors.white70),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Color _bg(String type) {
    switch (type) {
      case 'success':
        return AppColors.success;
      case 'error':
        return AppColors.danger;
      case 'warning':
        return AppColors.warning;
      default:
        return AppColors.info;
    }
  }

  IconData _icon(String type) {
    switch (type) {
      case 'success':
        return LucideIcons.checkCircle;
      case 'error':
        return LucideIcons.circleAlert;
      case 'warning':
        return LucideIcons.triangleAlert;
      default:
        return LucideIcons.info;
    }
  }
}