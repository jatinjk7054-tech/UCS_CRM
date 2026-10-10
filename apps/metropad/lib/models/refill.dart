import 'metro.dart';

class Refill {
  final String id;
  final String machineId;
  final String? stationId;
  final String refillDate;
  final num? previousStock;
  final num? refillQuantity;
  final num? newStock;
  final num? cashCollected;
  final String refilledBy;
  final String remark;
  final String createdAt;
  final String machineCode;
  final String location;
  final String stationName;
  final String stationCode;
  final String lineName;
  final String lineCode;

  const Refill({
    required this.id,
    required this.machineId,
    this.stationId,
    required this.refillDate,
    this.previousStock,
    this.refillQuantity,
    this.newStock,
    this.cashCollected,
    this.refilledBy = '',
    this.remark = '',
    this.createdAt = '',
    this.machineCode = '',
    this.location = '',
    this.stationName = '',
    this.stationCode = '',
    this.lineName = '',
    this.lineCode = '',
  });

  factory Refill.fromJson(Map<String, dynamic> json) {
    return Refill(
      id: asStr(json['id']),
      machineId: asStr(json['machine_id']),
      stationId: json['station_id'] == null ? null : asStr(json['station_id']),
      refillDate: asStr(json['refill_date']),
      previousStock: asNum(json['previous_stock']),
      refillQuantity: asNum(json['refill_quantity']),
      newStock: asNum(json['new_stock']),
      cashCollected: asNum(json['cash_collected']),
      refilledBy: asStr(json['refilled_by']),
      remark: asStr(json['remark']),
      createdAt: asStr(json['created_at']),
      machineCode: asStr(json['machine_code']),
      location: asStr(json['location']),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
    );
  }
}

class StockIssue {
  final String id;
  final String machineId;
  final String? stationId;
  final String reportDate;
  final num? expectedStock;
  final num? actualStock;
  final num? missingQuantity;
  final String issueType;
  final String reason;
  final String status;
  final String reportedBy;
  final String remark;
  final String createdAt;
  final String resolvedAt;
  final String resolvedBy;
  final String machineCode;
  final String stationName;
  final String stationCode;
  final String lineName;
  final String lineCode;

  const StockIssue({
    required this.id,
    required this.machineId,
    this.stationId,
    required this.reportDate,
    this.expectedStock,
    this.actualStock,
    this.missingQuantity,
    this.issueType = '',
    this.reason = '',
    this.status = '',
    this.reportedBy = '',
    this.remark = '',
    this.createdAt = '',
    this.resolvedAt = '',
    this.resolvedBy = '',
    this.machineCode = '',
    this.stationName = '',
    this.stationCode = '',
    this.lineName = '',
    this.lineCode = '',
  });

  factory StockIssue.fromJson(Map<String, dynamic> json) {
    return StockIssue(
      id: asStr(json['id']),
      machineId: asStr(json['machine_id']),
      stationId: json['station_id'] == null ? null : asStr(json['station_id']),
      reportDate: asStr(json['report_date']),
      expectedStock: asNum(json['expected_stock']),
      actualStock: asNum(json['actual_stock']),
      missingQuantity: asNum(json['missing_quantity']),
      issueType: asStr(json['issue_type']),
      reason: asStr(json['reason']),
      status: asStr(json['status']),
      reportedBy: asStr(json['reported_by']),
      remark: asStr(json['remark']),
      createdAt: asStr(json['created_at']),
      resolvedAt: asStr(json['resolved_at']),
      resolvedBy: asStr(json['resolved_by']),
      machineCode: asStr(json['machine_code']),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
    );
  }
}

class MaintenanceRecord {
  final String id;
  final String machineId;
  final String? stationId;
  final String problem;
  final String priority;
  final String technician;
  final String status;
  final String reportedDate;
  final String resolvedDate;
  final String remark;
  final String createdAt;
  final String machineCode;
  final String stationName;
  final String stationCode;
  final String lineName;
  final String lineCode;

  const MaintenanceRecord({
    required this.id,
    required this.machineId,
    this.stationId,
    required this.problem,
    this.priority = '',
    this.technician = '',
    this.status = '',
    required this.reportedDate,
    this.resolvedDate = '',
    this.remark = '',
    this.createdAt = '',
    this.machineCode = '',
    this.stationName = '',
    this.stationCode = '',
    this.lineName = '',
    this.lineCode = '',
  });

  factory MaintenanceRecord.fromJson(Map<String, dynamic> json) {
    return MaintenanceRecord(
      id: asStr(json['id']),
      machineId: asStr(json['machine_id']),
      stationId: json['station_id'] == null ? null : asStr(json['station_id']),
      problem: asStr(json['problem']),
      priority: asStr(json['priority']),
      technician: asStr(json['technician']),
      status: asStr(json['status']),
      reportedDate: asStr(json['reported_date']),
      resolvedDate: asStr(json['resolved_date']),
      remark: asStr(json['remark']),
      createdAt: asStr(json['created_at']),
      machineCode: asStr(json['machine_code']),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
    );
  }
}