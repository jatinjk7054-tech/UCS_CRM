class AppConstants {
  AppConstants._();

  static const int initialStock = 10000;
  static const int pricePerPad = 5;
  static const int lowStockThreshold = 10;

  // Every station has exactly one machine with 2 slots of 25 pads each.
  static const int slotsPerMachine = 2;
  static const int slotCapacity = 25;
  static const int machineCapacity = slotsPerMachine * slotCapacity;

  static List<int> slotStock(num? currentStock) {
    final stock = (currentStock ?? 0).toInt();
    return [
      for (var i = 0; i < slotsPerMachine; i++)
        (stock - i * slotCapacity).clamp(0, slotCapacity),
    ];
  }

  static const List<String> machineStatuses = [
    'ACTIVE', 'INACTIVE', 'OFFLINE', 'MAINTENANCE',
  ];

  static const List<String> monthlyMachineStatuses = [
    'WORKING', 'NOT_WORKING', 'MAINTENANCE', 'EMPTY', 'OTHER_ISSUE',
  ];

  static const List<String> monthlyIssueTypes = [
    'NONE', 'COIN_ACCEPTOR_PROBLEM', 'MACHINE_NOT_WORKING',
    'DISPENSING_PROBLEM', 'ELECTRICAL_PROBLEM', 'STOCK_PROBLEM', 'OTHER',
  ];

  static const List<String> entityStatuses = ['ACTIVE', 'INACTIVE'];

  static const List<String> issueTypes = [
    'MISSING_PADS', 'STOCK_MISMATCH', 'DAMAGED_PADS',
    'DISPENSING_PROBLEM', 'WRONG_STOCK_COUNT', 'OTHER',
  ];

  static const List<String> issueStatuses = [
    'OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED',
  ];

  static const List<String> maintenancePriorities = [
    'LOW', 'MEDIUM', 'HIGH', 'CRITICAL',
  ];

  static const List<String> maintenanceStatuses = [
    'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED',
  ];

  static const List<String> machineTypes = ['Standard', 'Compact'];

  static const List<String> roles = ['ADMIN', 'OPERATIONS', 'VIEWER'];

  static const List<String> roleLabels = ['Administrator', 'Operator', 'Viewer'];

  static const List<String> months = [
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December',
  ];

  static const List<int> pageSizes = [10, 20, 50, 100];

  static const List<String> reportTypes = ['station', 'machine', 'metro-line', 'monthly'];

  static const List<String> displayLineIds = ['line-2a', 'line-2b', 'line-7', 'line-9'];
}

class StatusColors {
  static const success = '#22c55e';
  static const warning = '#f59e0b';
  static const danger = '#ef4444';
  static const info = '#3b82f6';
  static const gray = '#64748b';
}

class StatusMap {
  static const Map<String, String> color = {
    'ACTIVE': StatusColors.success,
    'INACTIVE': StatusColors.danger,
    'OFFLINE': StatusColors.gray,
    'MAINTENANCE': StatusColors.warning,
    'NORMAL': StatusColors.success,
    'LOW_STOCK': StatusColors.warning,
    'EMPTY': StatusColors.danger,
    'OPEN': StatusColors.info,
    'INVESTIGATING': StatusColors.warning,
    'RESOLVED': StatusColors.success,
    'CLOSED': StatusColors.gray,
    'LOW': StatusColors.success,
    'MEDIUM': StatusColors.warning,
    'HIGH': StatusColors.warning,
    'CRITICAL': StatusColors.danger,
    'ASSIGNED': StatusColors.info,
    'IN_PROGRESS': StatusColors.info,
    'COMPLETED': StatusColors.success,
    'PENDING': StatusColors.warning,
    'UNABLE_TO_REFILL': StatusColors.danger,
    'GOOD': StatusColors.success,
  };

  static const Map<String, String> labelOverride = {
    'LOW_STOCK': 'Low Stock',
    'IN_PROGRESS': 'In Progress',
    'UNABLE_TO_REFILL': 'Unable to Refill',
  };
}

String humanizeLabel(String value) {
  final override = StatusMap.labelOverride[value];
  if (override != null) return override;
  final words = value.split('_').where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return value;
  return words.map((w) => w[0].toUpperCase() + w.substring(1).toLowerCase()).join(' ');
}