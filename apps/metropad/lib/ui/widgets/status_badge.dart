import 'package:flutter/material.dart';

import '../../core/constants.dart';
import '../../core/mumbai_metro.dart';
import '../../core/theme.dart';

class StatusBadge extends StatelessWidget {
  final String value;
  final bool outlined;
  const StatusBadge(this.value, {super.key, this.outlined = false});

  @override
  Widget build(BuildContext context) {
    final label = humanizeLabel(value);
    final base = statusColor(value);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: outlined ? Colors.transparent : base.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: base.withValues(alpha: outlined ? 0.7 : 0.35)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: outlined ? base : base,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class LineBadge extends StatelessWidget {
  final String name;
  final String? code;
  const LineBadge(this.name, {super.key, this.code});

  @override
  Widget build(BuildContext context) {
    if (name.isEmpty) {
      return const Text('—', style: TextStyle(color: AppColors.textLight));
    }
    final color = colorFromHex(getLineColor(name));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        code == null || code!.isEmpty ? name : '$name (${code!})',
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }
}

const Map<String, String> statusLabelOverride = {
  'LOW_STOCK': 'Low Stock',
  'IN_PROGRESS': 'In Progress',
  'UNABLE_TO_REFILL': 'Unable to Refill',
};

String statusLabel(String value) => humanizeLabel(value);