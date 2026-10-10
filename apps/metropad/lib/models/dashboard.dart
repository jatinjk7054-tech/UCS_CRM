import 'machine.dart';
import 'metro.dart';

class AdminUser {
  final String id;
  final String name;
  final String email;
  final String role;
  final bool isActive;
  final String createdAt;
  final String updatedAt;

  const AdminUser({
    this.id = '',
    this.name = '',
    this.email = '',
    this.role = '',
    this.isActive = true,
    this.createdAt = '',
    this.updatedAt = '',
  });

  factory AdminUser.fromJson(Map<String, dynamic> json) {
    return AdminUser(
      id: asStr(json['id']),
      name: asStr(json['name']),
      email: asStr(json['email']),
      role: asStr(json['role']),
      isActive: asBool(json['is_active']),
      createdAt: asStr(json['created_at']),
      updatedAt: asStr(json['updated_at']),
    );
  }
}

class AuditLog {
  final String id;
  final String userId;
  final String userName;
  final String action;
  final String entity;
  final String entityId;
  final Map<String, dynamic> oldValue;
  final Map<String, dynamic> newValue;
  final String createdAt;

  const AuditLog({
    this.id = '',
    this.userId = '',
    this.userName = '',
    this.action = '',
    this.entity = '',
    this.entityId = '',
    this.oldValue = const {},
    this.newValue = const {},
    this.createdAt = '',
  });

  factory AuditLog.fromJson(Map<String, dynamic> json) {
    return AuditLog(
      id: asStr(json['id']),
      userId: asStr(json['user_id']),
      userName: asStr(json['user_name']),
      action: asStr(json['action']),
      entity: asStr(json['entity']),
      entityId: asStr(json['entity_id']),
      oldValue: json['old_value'] is Map
          ? (json['old_value'] as Map).cast<String, dynamic>()
          : const {},
      newValue: json['new_value'] is Map
          ? (json['new_value'] as Map).cast<String, dynamic>()
          : const {},
      createdAt: asStr(json['created_at']),
    );
  }
}

class DashboardStats {
  final num totalMetroLines;
  final num totalStations;
  final num totalMachines;
  final num activeMachines;
  final num inactiveMachines;
  final num maintenanceMachines;
  final num lowStockMachines;
  final num padsRefilledThisMonth;
  final num activePercentage;

  const DashboardStats({
    this.totalMetroLines = 0,
    this.totalStations = 0,
    this.totalMachines = 0,
    this.activeMachines = 0,
    this.inactiveMachines = 0,
    this.maintenanceMachines = 0,
    this.lowStockMachines = 0,
    this.padsRefilledThisMonth = 0,
    this.activePercentage = 0,
  });

  factory DashboardStats.fromJson(Map<String, dynamic> json) {
    return DashboardStats(
      totalMetroLines: asNum(json['totalMetroLines']) ?? 0,
      totalStations: asNum(json['totalStations']) ?? 0,
      totalMachines: asNum(json['totalMachines']) ?? 0,
      activeMachines: asNum(json['activeMachines']) ?? 0,
      inactiveMachines: asNum(json['inactiveMachines']) ?? 0,
      maintenanceMachines: asNum(json['maintenanceMachines']) ?? 0,
      lowStockMachines: asNum(json['lowStockMachines']) ?? 0,
      padsRefilledThisMonth: asNum(json['padsRefilledThisMonth']) ?? 0,
      activePercentage: asNum(json['activePercentage']) ?? 0,
    );
  }
}

class MachineAlert {
  final Machine machine;
  final num stockPercentage;
  final int count;

  const MachineAlert({required this.machine, this.stockPercentage = 0, this.count = 0});

  factory MachineAlert.fromJson(Map<String, dynamic> json) {
    final m = json['machines'];
    return MachineAlert(
      machine: m is Map ? Machine.fromJson(m.cast<String, dynamic>()) : const Machine(id: '', machineId: ''),
      stockPercentage: asNum(json['stock_percentage']) ?? 0,
      count: asInt(json['count']) ?? 0,
    );
  }

  static List<MachineAlert> listFromJson(Map<String, dynamic> json) {
    final machines = json['machines'];
    if (machines is! List) return const [];
    final count = asInt(json['count']) ?? 0;
    return machines.map((e) {
      final entry = (e as Map).cast<String, dynamic>();
      return MachineAlert(
        machine: Machine.fromJson(entry),
        stockPercentage: asNum(entry['stock_percentage']) ?? asNum(json['stockPercentage']) ?? 0,
        count: count,
      );
    }).toList();
  }
}

class DashboardOverview {
  final DashboardStats stats;
  final List<MachineAlert> lowStock;
  final List<MachineAlert> attention;
  final List<RefillLite> refills;

  const DashboardOverview({
    required this.stats,
    this.lowStock = const [],
    this.attention = const [],
    this.refills = const [],
  });

  factory DashboardOverview.fromJson(Map<String, dynamic> json) {
    List<MachineAlert> parseList(dynamic v) {
      if (v is Map) {
        final list = v['machines'];
        final count = asInt(v['count']) ?? 0;
        if (list is List) {
          return list.map((e) {
            final entry = (e as Map).cast<String, dynamic>();
            return MachineAlert(
              machine: Machine.fromJson(entry),
              stockPercentage: asNum(entry['stock_percentage']) ?? 0,
              count: count,
            );
          }).toList();
        }
      }
      if (v is List) {
        return v.map((e) {
          final entry = (e as Map).cast<String, dynamic>();
          return MachineAlert(
            machine: Machine.fromJson(entry),
            stockPercentage: asNum(entry['stock_percentage']) ?? 0,
            count: asInt(entry['count']) ?? 0,
          );
        }).toList();
      }
      return const [];
    }

    List<RefillLite> parseRefills(dynamic v) {
      if (v is Map) v = v['refills'];
      if (v is! List) return const [];
      return v
          .map((e) => RefillLite.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    }

    return DashboardOverview(
      stats: DashboardStats.fromJson(
        (json['stats'] as Map?)?.cast<String, dynamic>() ?? const {},
      ),
      lowStock: parseList(json['lowStock']),
      attention: parseList(json['attention']),
      refills: parseRefills(json['refills']),
    );
  }
}

class RefillLite {
  final String id;
  final String machineCode;
  final String stationName;
  final String lineName;
  final String refillDate;
  final num refillQuantity;
  final num currentStock;

  const RefillLite({
    this.id = '',
    this.machineCode = '',
    this.stationName = '',
    this.lineName = '',
    this.refillDate = '',
    this.refillQuantity = 0,
    this.currentStock = 0,
  });

  factory RefillLite.fromJson(Map<String, dynamic> json) {
    return RefillLite(
      id: asStr(json['id']),
      machineCode: asStr(json['machine_code']),
      stationName: asStr(json['station_name']),
      lineName: asStr(json['line_name']),
      refillDate: asStr(json['refill_date']),
      refillQuantity: asNum(json['refill_quantity']) ?? 0,
      currentStock: asNum(json['current_stock']) ?? asNum(json['new_stock']) ?? 0,
    );
  }
}