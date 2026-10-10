import 'metro.dart';

class Machine {
  final String id;
  final String machineId;
  final String? stationId;
  final String? lineId;
  final String location;
  final String machineType;
  final num? capacity;
  final num? currentStock;
  final num? lowStockThreshold;
  final String installationDate;
  final String status;
  final String remark;
  final String? lastRefillAt;
  final String? lastMaintenanceAt;
  final String stationName;
  final String stationCode;
  final String lineName;
  final String lineCode;
  final num? stockPercentage;
  final int refillCount;
  final int issueCount;
  final int maintenanceCount;

  const Machine({
    required this.id,
    required this.machineId,
    this.stationId,
    this.lineId,
    this.location = '',
    this.machineType = '',
    this.capacity,
    this.currentStock,
    this.lowStockThreshold,
    this.installationDate = '',
    this.status = '',
    this.remark = '',
    this.lastRefillAt,
    this.lastMaintenanceAt,
    this.stationName = '',
    this.stationCode = '',
    this.lineName = '',
    this.lineCode = '',
    this.stockPercentage,
    this.refillCount = 0,
    this.issueCount = 0,
    this.maintenanceCount = 0,
  });

  factory Machine.fromJson(Map<String, dynamic> json) {
    return Machine(
      id: asStr(json['id']),
      machineId: asStr(json['machine_id']),
      stationId: json['station_id'] == null ? null : asStr(json['station_id']),
      lineId: json['line_id'] == null ? null : asStr(json['line_id']),
      location: asStr(json['location']),
      machineType: asStr(json['machine_type']),
      capacity: asNum(json['capacity']),
      currentStock: asNum(json['current_stock']),
      lowStockThreshold: asNum(json['low_stock_threshold']),
      installationDate: asStr(json['installation_date']),
      status: asStr(json['status']),
      remark: asStr(json['remark']),
      lastRefillAt: json['last_refill_at']?.toString(),
      lastMaintenanceAt: json['last_maintenance_at']?.toString(),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
      stockPercentage: asNum(json['stock_percentage']),
      refillCount: asInt(json['refill_count']) ?? 0,
      issueCount: asInt(json['issue_count']) ?? 0,
      maintenanceCount: asInt(json['maintenance_count']) ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'machineId': machineId,
        'stationId': stationId,
        'lineId': lineId,
        'location': location,
        'machineType': machineType,
        'capacity': capacity,
        'currentStock': currentStock,
        'lowStockThreshold': lowStockThreshold,
        'installationDate': installationDate,
        'status': status,
        'remark': remark,
      };
}

class MachineStatusHistory {
  final String id;
  final String machineId;
  final String previousStatus;
  final String newStatus;
  final String changedBy;
  final String reason;
  final String changedAt;
  final String machineCode;
  final String changedByName;

  const MachineStatusHistory({
    required this.id,
    required this.machineId,
    required this.previousStatus,
    required this.newStatus,
    required this.changedBy,
    required this.reason,
    required this.changedAt,
    required this.machineCode,
    required this.changedByName,
  });

  factory MachineStatusHistory.fromJson(Map<String, dynamic> json) {
    return MachineStatusHistory(
      id: asStr(json['id']),
      machineId: asStr(json['machine_id']),
      previousStatus: asStr(json['previous_status']),
      newStatus: asStr(json['new_status']),
      changedBy: asStr(json['changed_by']),
      reason: asStr(json['reason']),
      changedAt: asStr(json['changed_at']),
      machineCode: asStr(json['machine_code']),
      changedByName: asStr(json['changed_by_name']),
    );
  }
}