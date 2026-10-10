import 'metro.dart';

class MonthlyRecord {
  final String recordId;
  final String recordDate;
  final String yearMonth;
  final String stationId;
  final String stationCode;
  final String stationName;
  final String lineId;
  final String lineName;
  final String lineCode;
  final String machineId;
  final String machineStatus;
  final String issueType;
  final num? cashCollected;
  final num? padsRefilled;
  final String notes;
  final String nextAction;

  const MonthlyRecord({
    this.recordId = '',
    this.recordDate = '',
    this.yearMonth = '',
    this.stationId = '',
    this.stationCode = '',
    this.stationName = '',
    this.lineId = '',
    this.lineName = '',
    this.lineCode = '',
    this.machineId = '',
    this.machineStatus = '',
    this.issueType = '',
    this.cashCollected,
    this.padsRefilled,
    this.notes = '',
    this.nextAction = '',
  });

  factory MonthlyRecord.fromJson(Map<String, dynamic> json) {
    return MonthlyRecord(
      recordId: asStr(json['record_id']),
      recordDate: asStr(json['record_date']),
      yearMonth: asStr(json['year_month']),
      stationId: asStr(json['station_id']),
      stationCode: asStr(json['station_code']),
      stationName: asStr(json['station_name']),
      lineId: asStr(json['line_id']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
      machineId: asStr(json['machine_id']),
      machineStatus: asStr(json['machine_status']),
      issueType: asStr(json['issue_type']),
      cashCollected: asNum(json['cash_collected']),
      padsRefilled: asNum(json['pads_refilled']),
      notes: asStr(json['notes']),
      nextAction: asStr(json['next_action']),
    );
  }
}

class MonthlyRecordsResponse {
  final String yearMonth;
  final Map<String, dynamic> summary;
  final List<MonthlyRecord> rows;
  final List<dynamic> stationWise;
  final List<dynamic> machineWise;

  const MonthlyRecordsResponse({
    this.yearMonth = '',
    this.summary = const {},
    this.rows = const [],
    this.stationWise = const [],
    this.machineWise = const [],
  });

  factory MonthlyRecordsResponse.fromJson(Map<String, dynamic> json) {
    final rows = json['rows'];
    final sw = json['stationWise'];
    final mw = json['machineWise'];
    return MonthlyRecordsResponse(
      yearMonth: asStr(json['yearMonth']),
      summary: json['summary'] is Map
          ? (json['summary'] as Map).cast<String, dynamic>()
          : const {},
      rows: rows is List
          ? rows
              .map((e) => MonthlyRecord.fromJson((e as Map).cast<String, dynamic>()))
              .toList()
          : const [],
      stationWise: sw is List ? List.of(sw) : const [],
      machineWise: mw is List ? List.of(mw) : const [],
    );
  }
}

class CashCollection {
  final String year;
  final String month;
  final num totalCash;
  final int count;
  final List<CashCollectionStation> stations;

  const CashCollection({
    this.year = '',
    this.month = '',
    this.totalCash = 0,
    this.count = 0,
    this.stations = const [],
  });

  factory CashCollection.fromJson(Map<String, dynamic> json) {
    final rows = json['rows'];
    return CashCollection(
      year: asStr(json['year']),
      month: asStr(json['month']),
      totalCash: asNum(json['totalCash']) ?? 0,
      count: asInt(json['count']) ?? 0,
      stations: rows is List
          ? rows
              .map((e) =>
                  CashCollectionStation.fromJson((e as Map).cast<String, dynamic>()))
              .toList()
          : const [],
    );
  }
}

class CashCollectionStation {
  final String stationId;
  final String stationName;
  final String stationCode;
  final String lineId;
  final String lineName;
  final String lineCode;
  final num totalCash;
  final int recordCount;
  final String lastRecordDate;
  final List<CashRecord> records;

  const CashCollectionStation({
    this.stationId = '',
    this.stationName = '',
    this.stationCode = '',
    this.lineId = '',
    this.lineName = '',
    this.lineCode = '',
    this.totalCash = 0,
    this.recordCount = 0,
    this.lastRecordDate = '',
    this.records = const [],
  });

  factory CashCollectionStation.fromJson(Map<String, dynamic> json) {
    final recs = json['records'];
    return CashCollectionStation(
      stationId: asStr(json['station_id']),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      lineId: asStr(json['line_id']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
      totalCash: asNum(json['total_cash']) ?? 0,
      recordCount: asInt(json['record_count']) ?? 0,
      lastRecordDate: asStr(json['last_record_date']),
      records: recs is List
          ? recs
              .map((e) => CashRecord.fromJson((e as Map).cast<String, dynamic>()))
              .toList()
          : const [],
    );
  }
}

class CashRecord {
  final String id;
  final String recordDate;
  final num cashCollected;
  final String remark;

  const CashRecord({
    this.id = '',
    this.recordDate = '',
    this.cashCollected = 0,
    this.remark = '',
  });

  factory CashRecord.fromJson(Map<String, dynamic> json) {
    return CashRecord(
      id: asStr(json['id']),
      recordDate: asStr(json['record_date']),
      cashCollected: asNum(json['cash_collected']) ?? 0,
      remark: asStr(json['remark']),
    );
  }
}