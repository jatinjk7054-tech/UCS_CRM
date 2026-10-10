import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/formatters.dart';
import '../../core/theme.dart';

Future<void> showFormModal(
  BuildContext context, {
  required String title,
  required Widget Function(BuildContext context, StateSetter setState) builder,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (ctx) {
      return Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 8,
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
        ),
        child: StatefulBuilder(builder: builder),
      );
    },
  );
}

Future<bool> showConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = 'Delete',
  String cancelLabel = 'Cancel',
  bool danger = true,
  bool loading = false,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(cancelLabel),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: danger ? AppColors.danger : AppColors.primary,
            foregroundColor: Colors.white,
          ),
          onPressed: loading ? null : () => Navigator.pop(ctx, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

class FormFieldWrap extends StatelessWidget {
  final String label;
  final String? hint;
  final Widget child;
  final bool required;
  const FormFieldWrap({
    super.key,
    required this.label,
    this.hint,
    required this.child,
    this.required = false,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          required ? '$label *' : label,
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        child,
        if (hint != null) ...[
          const SizedBox(height: 4),
          Text(hint!, style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
        ],
      ],
    );
  }
}

String? validateRequired(String? v, String field) =>
    (v == null || v.trim().isEmpty) ? '$field is required' : null;

Future<String?> apiRun(
  BuildContext context,
  Future<void> Function() action, {
  String success = 'Done',
}) async {
  try {
    await action();
    return null;
  } catch (e) {
    return getErrorMessage(toApiException(e));
  }
}