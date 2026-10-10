import 'dart:convert';

num? asNum(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  if (v is String) return double.tryParse(v);
  return null;
}

int? asInt(dynamic v) {
  final n = asNum(v);
  return n?.toInt();
}

String asStr(dynamic v) {
  if (v == null || v is List || v is Map) return v == null ? '' : jsonEncode(v);
  return v.toString();
}

bool asBool(dynamic v) {
  if (v == null) return false;
  if (v is bool) return v;
  return v.toString().toLowerCase() == 'true';
}

class MetroLine {
  final String id;
  final String code;
  final String name;
  final String description;
  final String status;
  final String? createdAt;
  final String? updatedAt;
  final int stationCount;
  final int machineCount;
  final int activeMachineCount;
  final int inactiveMachineCount;
  final List<Station> stations;

  const MetroLine({
    required this.id,
    required this.code,
    required this.name,
    this.description = '',
    required this.status,
    this.createdAt,
    this.updatedAt,
    this.stationCount = 0,
    this.machineCount = 0,
    this.activeMachineCount = 0,
    this.inactiveMachineCount = 0,
    this.stations = const [],
  });

  factory MetroLine.fromJson(Map<String, dynamic> json) {
    final list = json['stations'];
    return MetroLine(
      id: asStr(json['id']),
      code: asStr(json['code']),
      name: asStr(json['name']),
      description: asStr(json['description']),
      status: asStr(json['status']),
      createdAt: asStr(json['created_at']),
      updatedAt: asStr(json['updated_at']),
      stationCount: asInt(json['station_count']) ?? 0,
      machineCount: asInt(json['machine_count']) ?? 0,
      activeMachineCount: asInt(json['active_machine_count']) ?? 0,
      inactiveMachineCount: asInt(json['inactive_machine_count']) ?? 0,
      stations: list is List
          ? list.map((e) => Station.fromJson((e as Map).cast<String, dynamic>())).toList()
          : const [],
    );
  }

  Map<String, dynamic> toCreateJson() => {
        'name': name,
        'code': code,
        'description': description,
      };
}

class Station {
  final String id;
  final String name;
  final String stationCode;
  final String lineId;
  final String lineName;
  final String lineCode;
  final String description;
  final String status;
  final String lineStatus;
  final int machineCount;
  final int activeMachineCount;
  final int inactiveMachineCount;
  final int maintenanceMachineCount;
  final num? totalStock;
  final List<dynamic> machines;
  final List<dynamic> recentRefills;
  final List<dynamic> recentIssues;
  final List<dynamic> recentMaintenance;

  const Station({
    required this.id,
    required this.name,
    required this.stationCode,
    required this.lineId,
    required this.lineName,
    required this.lineCode,
    this.description = '',
    required this.status,
    this.lineStatus = '',
    this.machineCount = 0,
    this.activeMachineCount = 0,
    this.inactiveMachineCount = 0,
    this.maintenanceMachineCount = 0,
    this.totalStock,
    this.machines = const [],
    this.recentRefills = const [],
    this.recentIssues = const [],
    this.recentMaintenance = const [],
  });

  factory Station.fromJson(Map<String, dynamic> json) {
    return Station(
      id: asStr(json['id']),
      name: asStr(json['name']),
      stationCode: asStr(json['station_code']),
      lineId: asStr(json['line_id']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
      description: asStr(json['description']),
      status: asStr(json['status']),
      lineStatus: asStr(json['line_status']),
      machineCount: asInt(json['machine_count']) ?? 0,
      activeMachineCount: asInt(json['active_machine_count']) ?? 0,
      inactiveMachineCount: asInt(json['inactive_machine_count']) ?? 0,
      maintenanceMachineCount: asInt(json['maintenance_machine_count']) ?? 0,
      totalStock: asNum(json['total_stock']),
      machines: json['machines'] is List ? List.of(json['machines']) : const [],
      recentRefills: json['recent_refills'] is List ? List.of(json['recent_refills']) : const [],
      recentIssues: json['recent_issues'] is List ? List.of(json['recent_issues']) : const [],
      recentMaintenance: json['recent_maintenance'] is List ? List.of(json['recent_maintenance']) : const [],
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'stationCode': stationCode,
        'lineId': lineId,
        'description': description,
        'status': status,
      };
}