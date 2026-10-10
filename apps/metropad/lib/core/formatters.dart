import 'package:intl/intl.dart';

import 'constants.dart';

String formatDate(DateTime? value) {
  if (value == null) return '—';
  return DateFormat('yyyy-MM-dd').format(value);
}

DateTime? parseDateTime(String value) {
  if (value.isEmpty) return null;
  final t = value.replaceFirst('T', ' ');
  for (final f in ['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd']) {
    try {
      return DateFormat(f).parse(t);
    } catch (_) {}
  }
  return DateTime.tryParse(value);
}

String formatDateStr(String? value) {
  if (value == null || value.isEmpty) return '—';
  final dt = parseDateTime(value);
  return dt == null ? value : formatDate(dt);
}

String formatDateTimeStr(String? value) {
  if (value == null || value.isEmpty) return '—';
  final dt = parseDateTime(value);
  if (dt == null) return value;
  return DateFormat('yyyy-MM-dd HH:mm').format(dt);
}

String formatNumber(num? value) {
  if (value == null) return '0';
  return NumberFormat('#,##0', 'en_IN').format(value);
}

String formatRupee(num? value) {
  if (value == null) return '₹0';
  return '₹${formatNumber(value)}';
}

String formatStockPercent(num? value) {
  return '${(value ?? 0).toStringAsFixed(0)}%';
}

String stockLevel(num? currentStock) {
  final stock = currentStock ?? 0;
  if (stock == 0) return 'EMPTY';
  if (stock <= AppConstants.lowStockThreshold) return 'LOW_STOCK';
  return 'NORMAL';
}

String getErrorMessage(Object? error) {
  if (error is String) return error;
  return 'Something went wrong';
}

String formatRole(String? role) {
  if (role == null || role.isEmpty) return '—';
  return role[0].toUpperCase() + role.substring(1).toLowerCase();
}

String toTitleCase(String value) {
  return value.split(RegExp(r'[ _]+')).map((w) {
    if (w.isEmpty) return w;
    return w[0].toUpperCase() + w.substring(1);
  }).join(' ');
}