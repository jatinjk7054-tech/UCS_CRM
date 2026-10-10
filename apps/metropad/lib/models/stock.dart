import 'metro.dart';

class StockConfig {
  final num? initialStock;
  final num? pricePerPad;
  final num? lowStockThreshold;

  const StockConfig({
    this.initialStock,
    this.pricePerPad,
    this.lowStockThreshold,
  });

  factory StockConfig.fromJson(Map<String, dynamic> json) {
    return StockConfig(
      initialStock: asNum(json['initialStock']),
      pricePerPad: asNum(json['pricePerPad']),
      lowStockThreshold: asNum(json['lowStockThreshold']),
    );
  }
}

class StationStock {
  final String machineId;
  final String lineName;
  final String lineCode;
  final String stationName;
  final String stationCode;
  final num? currentStock;
  final num? capacity;
  final num? lowStockThreshold;
  final num? pricePerPad;
  final num? stockValue;
  final String stockStatus;
  final String lastRefillAt;
  final String status;

  const StationStock({
    required this.machineId,
    this.lineName = '',
    this.lineCode = '',
    this.stationName = '',
    this.stationCode = '',
    this.currentStock,
    this.capacity,
    this.lowStockThreshold,
    this.pricePerPad,
    this.stockValue,
    this.stockStatus = '',
    this.lastRefillAt = '',
    this.status = '',
  });

  factory StationStock.fromJson(Map<String, dynamic> json) {
    return StationStock(
      machineId: asStr(json['machine_id']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      currentStock: asNum(json['current_stock']),
      capacity: asNum(json['capacity']),
      lowStockThreshold: asNum(json['low_stock_threshold']),
      pricePerPad: asNum(json['price_per_pad']),
      stockValue: asNum(json['stock_value']),
      stockStatus: asStr(json['stock_status']),
      lastRefillAt: asStr(json['last_refill_at']),
      status: asStr(json['status']),
    );
  }
}

class StockSummary {
  final num? initialStock;
  final num? pricePerPad;
  final num? lowStockThreshold;
  final num? initialStockValue;
  final num? totalDistributed;
  final num? distributedValue;
  final num? remainingCentral;
  final num? remainingCentralValue;
  final num? totalMachinePads;
  final num? totalMachineValue;
  final num? totalMachines;
  final num? activeMachines;
  final List<StationStock> stationWise;
  final num? lowStockMachines;
  final num? emptyMachines;
  final num? pendingRefillCount;
  final List<dynamic> pendingRefill;

  const StockSummary({
    this.initialStock,
    this.pricePerPad,
    this.lowStockThreshold,
    this.initialStockValue,
    this.totalDistributed,
    this.distributedValue,
    this.remainingCentral,
    this.remainingCentralValue,
    this.totalMachinePads,
    this.totalMachineValue,
    this.totalMachines,
    this.activeMachines,
    this.stationWise = const [],
    this.lowStockMachines,
    this.emptyMachines,
    this.pendingRefillCount,
    this.pendingRefill = const [],
  });

  factory StockSummary.fromJson(Map<String, dynamic> json) {
    final sw = json['stationWise'];
    return StockSummary(
      initialStock: asNum(json['initialStock']),
      pricePerPad: asNum(json['pricePerPad']),
      lowStockThreshold: asNum(json['lowStockThreshold']),
      initialStockValue: asNum(json['initialStockValue']),
      totalDistributed: asNum(json['totalDistributed']),
      distributedValue: asNum(json['distributedValue']),
      remainingCentral: asNum(json['remainingCentral']),
      remainingCentralValue: asNum(json['remainingCentralValue']),
      totalMachinePads: asNum(json['totalMachinePads']),
      totalMachineValue: asNum(json['totalMachineValue']),
      totalMachines: asNum(json['totalMachines']),
      activeMachines: asNum(json['activeMachines']),
      stationWise: sw is List
          ? sw
              .map((e) => StationStock.fromJson((e as Map).cast<String, dynamic>()))
              .toList()
          : const [],
      lowStockMachines: asNum(json['lowStockMachines']),
      emptyMachines: asNum(json['emptyMachines']),
      pendingRefillCount: asNum(json['pendingRefillCount']),
      pendingRefill: json['pendingRefill'] is List ? List.of(json['pendingRefill']) : const [],
    );
  }
}

class MonthlyStock {
  final int? year;
  final int? month;
  final String? yearMonth;
  final num? openingCentral;
  final num? distributedInMonth;
  final num? closingCentral;
  final num? distributedBefore;
  final num? pricePerPad;
  final num? openingCentralValue;
  final num? closingCentralValue;
  final num? distributedMonthValue;
  final num? totalCashCollected;
  final num? totalMachinePads;
  final num? totalMachineValue;
  final num? totalMachines;
  final num? machinesRefilled;
  final num? machinesPending;
  final num? lowStockMachines;
  final num? emptyMachines;
  final num? pendingRefillCount;
  final Map<String, dynamic> summary;
  final List<MonthlyStationStock> stationList;

  const MonthlyStock({
    this.year,
    this.month,
    this.yearMonth,
    this.openingCentral,
    this.distributedInMonth,
    this.closingCentral,
    this.distributedBefore,
    this.pricePerPad,
    this.openingCentralValue,
    this.closingCentralValue,
    this.distributedMonthValue,
    this.totalCashCollected,
    this.totalMachinePads,
    this.totalMachineValue,
    this.totalMachines,
    this.machinesRefilled,
    this.machinesPending,
    this.lowStockMachines,
    this.emptyMachines,
    this.pendingRefillCount,
    this.summary = const {},
    this.stationList = const [],
  });

  factory MonthlyStock.fromJson(Map<String, dynamic> json) {
    final list = json['stationList'];
    return MonthlyStock(
      year: asInt(json['year']),
      month: asInt(json['month']),
      yearMonth: asStr(json['yearMonth']),
      openingCentral: asNum(json['openingCentral']),
      distributedInMonth: asNum(json['distributedInMonth']),
      closingCentral: asNum(json['closingCentral']),
      distributedBefore: asNum(json['distributedBefore']),
      pricePerPad: asNum(json['pricePerPad']),
      openingCentralValue: asNum(json['openingCentralValue']),
      closingCentralValue: asNum(json['closingCentralValue']),
      distributedMonthValue: asNum(json['distributedMonthValue']),
      totalCashCollected: asNum(json['totalCashCollected']),
      totalMachinePads: asNum(json['totalMachinePads']),
      totalMachineValue: asNum(json['totalMachineValue']),
      totalMachines: asNum(json['totalMachines']),
      machinesRefilled: asNum(json['machinesRefilled']),
      machinesPending: asNum(json['machinesPending']),
      lowStockMachines: asNum(json['lowStockMachines']),
      emptyMachines: asNum(json['emptyMachines']),
      pendingRefillCount: asNum(json['pendingRefillCount']),
      summary: json['summary'] is Map
          ? (json['summary'] as Map).cast<String, dynamic>()
          : const {},
      stationList: list is List
          ? list
              .map((e) =>
                  MonthlyStationStock.fromJson((e as Map).cast<String, dynamic>()))
              .toList()
          : const [],
    );
  }
}

class MonthlyStationStock {
  final String machineId;
  final String machineUuid;
  final String stationId;
  final String lineName;
  final String lineCode;
  final String stationName;
  final String stationCode;
  final num? refillQuantity;
  final String refillDate;
  final num? pricePerPad;
  final num? stockValue;
  final String refillStatus;
  final num? cashCollected;
  final num? currentStock;
  final num? capacity;
  final String machineStatus;

  const MonthlyStationStock({
    required this.machineId,
    this.machineUuid = '',
    this.stationId = '',
    this.lineName = '',
    this.lineCode = '',
    this.stationName = '',
    this.stationCode = '',
    this.refillQuantity,
    this.refillDate = '',
    this.pricePerPad,
    this.stockValue,
    this.refillStatus = '',
    this.cashCollected,
    this.currentStock,
    this.capacity,
    this.machineStatus = '',
  });

  factory MonthlyStationStock.fromJson(Map<String, dynamic> json) {
    return MonthlyStationStock(
      machineId: asStr(json['machine_id']),
      machineUuid: asStr(json['machine_uuid']),
      stationId: asStr(json['station_id']),
      lineName: asStr(json['line_name']),
      lineCode: asStr(json['line_code']),
      stationName: asStr(json['station_name']),
      stationCode: asStr(json['station_code']),
      refillQuantity: asNum(json['refill_quantity']),
      refillDate: asStr(json['refill_date']),
      pricePerPad: asNum(json['price_per_pad']),
      stockValue: asNum(json['stock_value']),
      refillStatus: asStr(json['refill_status']),
      cashCollected: asNum(json['cash_collected']),
      currentStock: asNum(json['current_stock']),
      capacity: asNum(json['capacity']),
      machineStatus: asStr(json['machine_status']),
    );
  }
}