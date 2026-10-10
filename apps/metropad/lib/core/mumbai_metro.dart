const Map<String, String> metroColors = {
  'line-1': '#1755c4',
  'line-2a': '#f7a800',
  'line-2b': '#f7a800',
  'line-3': '#00a0a7',
  'line-7': '#e0241f',
  'line-9': '#e0241f',
};

const List<String> displayLineIds = ['line-2a', 'line-2b', 'line-7', 'line-9'];

String lineNumber(String lineId) {
  const map = {
    'line-1': '1',
    'line-2a': '2A',
    'line-2b': '2B',
    'line-3': '3',
    'line-7': '7',
    'line-9': '9',
  };
  return map[lineId] ?? lineId.replaceAll('line-', '').toUpperCase();
}

class MetroLineData {
  final String id;
  final String number;
  final String name;
  final String longName;
  final String color;
  final String status;
  final List<String> stations;
  const MetroLineData({
    required this.id,
    required this.number,
    required this.name,
    required this.longName,
    required this.color,
    required this.status,
    required this.stations,
  });
}

class MetroStationData {
  final String id;
  final String name;
  final double lat;
  final double lng;
  final List<String> lines;
  const MetroStationData({
    required this.id,
    required this.name,
    required this.lat,
    required this.lng,
    this.lines = const [],
  });
}

class MetroStationMap {
  final Map<String, MetroStationData> stations;
  final Map<String, MetroLineData> lines;
  const MetroStationMap({required this.stations, required this.lines});
}

MetroStationData? getStation(String id, MetroStationMap data) => data.stations[id];

MetroStationData? findStationByName(String name, MetroStationMap data) {
  if (name.isEmpty) return null;
  final normalized = name.toLowerCase().trim().replaceAll(RegExp(r'\s+'), ' ');
  for (final s in data.stations.values) {
    if (s.name.toLowerCase() == normalized || s.id.replaceAll('-', ' ') == normalized) {
      return s;
    }
  }
  return null;
}

String getLineColor(String lineNameOrCode) {
  final text = lineNameOrCode.toLowerCase();
  if (RegExp(r'red').hasMatch(text)) return '#e0241f';
  if (RegExp(r'yellow|ochre').hasMatch(text)) return '#f7a800';
  if (RegExp(r'aqua|teal|turquoise|cyan').hasMatch(text)) return '#00a0a7';
  if (RegExp(r'blue').hasMatch(text)) return '#1755c4';
  if (RegExp(r'green').hasMatch(text)) return '#16a34a';
  if (RegExp(r'orange').hasMatch(text)) return '#f97316';
  if (RegExp(r'purple|violet').hasMatch(text)) return '#7b2ff7';
  if (RegExp(r'pink|magenta').hasMatch(text)) return '#ec4899';
  if (RegExp(r'grey|gray|silver').hasMatch(text)) return '#64748b';
  if (RegExp(r'brown').hasMatch(text)) return '#92400e';
  return '#4f46e5';
}

String hexToRgba(String hex, double alpha) {
  final h = hex.replaceFirst('#', '');
  if (h.length != 6) return 'rgba(79, 70, 229, $alpha)';
  final r = int.parse(h.substring(0, 2), radix: 16);
  final g = int.parse(h.substring(2, 4), radix: 16);
  final b = int.parse(h.substring(4, 6), radix: 16);
  return 'rgba($r, $g, $b, $alpha)';
}

MetroStationMap buildMumbaiMetroData() {
  const lines = [
    MetroLineData(
      id: 'line-1',
      number: '1',
      name: 'Blue Line',
      longName: 'Versova – Ghatkopar',
      color: '#1755c4',
      status: 'OPERATIONAL',
      stations: [
        'versova', 'dn-nagar', 'azad-nagar', 'andheri', 'western-express-highway',
        'chakala', 'airport-road', 'marol-naka', 'saki-naka', 'asalpha',
        'jagruti-nagar', 'ghatkopar',
      ],
    ),
    MetroLineData(
      id: 'line-2a',
      number: '2A',
      name: 'Yellow Line',
      longName: 'Dahisar East – Andheri West',
      color: '#f7a800',
      status: 'OPERATIONAL',
      stations: [
        'dahisar-east', 'anand-nagar', 'kandarpada', 'mandapeshwar', 'eksar',
        'borivali-west', 'shimpoli', 'kandivli-west', 'dahanukarwadi',
        'valnai-meeth-chowky', 'malad-west', 'lower-malad', 'bangur-nagar',
        'goregaon-west', 'oshiwara', 'lower-oshiwara', 'andheri-west',
      ],
    ),
    MetroLineData(
      id: 'line-2b',
      number: '2B',
      name: 'Yellow Line',
      longName: 'Chembur – Mandale',
      color: '#f7a800',
      status: 'PARTIALLY_OPERATIONAL',
      stations: [
        'chembur', 'diamond-garden', 'csm-chowk', 'shivaji-chowk', 'deonar',
        'mankhurd', 'mandale',
      ],
    ),
    MetroLineData(
      id: 'line-3',
      number: '3',
      name: 'Aqua Line',
      longName: 'Aarey JVLR – Cuffe Parade',
      color: '#00a0a7',
      status: 'OPERATIONAL',
      stations: [
        'aarey-jvlr', 'seepz', 'midc-andheri', 'marol-naka', 'csia-t2',
        'sahar-road', 'csia-t1', 'santacruz', 'bandra-colony', 'bkc',
        'dharavi', 'shitaladevi-mandir', 'dadar', 'siddhivinayak', 'worli',
        'acharya-atre-chowk', 'science-centre', 'mahalaxmi',
        'jagannath-shankar-sheth', 'grant-road', 'girgaon', 'kalbadevi',
        'csmt', 'hutatma-chowk', 'churchgate', 'vidhan-bhavan', 'cuffe-parade',
      ],
    ),
    MetroLineData(
      id: 'line-7',
      number: '7',
      name: 'Red Line',
      longName: 'Gundavali – Dahisar East',
      color: '#e0241f',
      status: 'OPERATIONAL',
      stations: [
        'gundavali', 'mogra', 'jogeshwari-east', 'goregaon-east', 'aarey',
        'dindoshi', 'kurar', 'akurli', 'poisar', 'magathane', 'devipada',
        'rashtriya-udyan', 'ovaripada', 'dahisar-east',
      ],
    ),
    MetroLineData(
      id: 'line-9',
      number: '9',
      name: 'Red Line',
      longName: 'Kashigaon – Dahisar East',
      color: '#e0241f',
      status: 'PARTIALLY_OPERATIONAL',
      stations: ['kashigaon', 'miragaon', 'pandurang-wadi', 'dahisar-east'],
    ),
  ];

  const stations = [
    MetroStationData(id: 'versova', name: 'Versova', lat: 19.13027778, lng: 72.82138889, lines: ['line-1']),
    MetroStationData(id: 'dn-nagar', name: 'D.N. Nagar', lat: 19.12805556, lng: 72.83027778, lines: ['line-1', 'line-2a']),
    MetroStationData(id: 'azad-nagar', name: 'Azad Nagar', lat: 19.1269, lng: 72.8378, lines: ['line-1']),
    MetroStationData(id: 'andheri', name: 'Andheri', lat: 19.1205638, lng: 72.8488433, lines: ['line-1']),
    MetroStationData(id: 'western-express-highway', name: 'Western Express Highway', lat: 19.11555556, lng: 72.85638889, lines: ['line-1']),
    MetroStationData(id: 'chakala', name: 'Chakala (J.B. Nagar)', lat: 19.112045, lng: 72.867696, lines: ['line-1']),
    MetroStationData(id: 'airport-road', name: 'Airport Road', lat: 19.11027, lng: 72.87475, lines: ['line-1']),
    MetroStationData(id: 'marol-naka', name: 'Marol Naka', lat: 19.1085041, lng: 72.878578, lines: ['line-1', 'line-3']),
    MetroStationData(id: 'saki-naka', name: 'Saki Naka', lat: 19.103528, lng: 72.887962, lines: ['line-1']),
    MetroStationData(id: 'asalpha', name: 'Asalpha', lat: 19.092544, lng: 72.901887, lines: ['line-1']),
    MetroStationData(id: 'jagruti-nagar', name: 'Jagruti Nagar', lat: 19.092582, lng: 72.901866, lines: ['line-1']),
    MetroStationData(id: 'ghatkopar', name: 'Ghatkopar', lat: 19.08666111, lng: 72.90798889, lines: ['line-1']),
    MetroStationData(id: 'dahisar-east', name: 'Dahisar East', lat: 19.25128, lng: 72.86715, lines: ['line-2a', 'line-7', 'line-9']),
    MetroStationData(id: 'anand-nagar', name: 'Anand Nagar', lat: 19.2572087, lng: 72.8663486, lines: ['line-2a']),
    MetroStationData(id: 'kandarpada', name: 'Kandarpada', lat: 19.2566337, lng: 72.850504, lines: ['line-2a']),
    MetroStationData(id: 'mandapeshwar', name: 'Mandapeshwar', lat: 19.2495856, lng: 72.8458001, lines: ['line-2a']),
    MetroStationData(id: 'eksar', name: 'Eksar', lat: 19.2403773, lng: 72.8434456, lines: ['line-2a']),
    MetroStationData(id: 'borivali-west', name: 'Borivali West', lat: 19.2313925, lng: 72.8408607, lines: ['line-2a']),
    MetroStationData(id: 'shimpoli', name: 'Shimpoli', lat: 19.2228332, lng: 72.8409432, lines: ['line-2a']),
    MetroStationData(id: 'kandivli-west', name: 'Kandivli West', lat: 19.2140036, lng: 72.8373054, lines: ['line-2a']),
    MetroStationData(id: 'dahanukarwadi', name: 'Dahanukarwadi', lat: 19.2062315, lng: 72.8348068, lines: ['line-2a']),
    MetroStationData(id: 'valnai-meeth-chowky', name: 'Valnai – Meeth Chowky', lat: 19.1968293, lng: 72.8337752, lines: ['line-2a']),
    MetroStationData(id: 'malad-west', name: 'Malad West', lat: 19.1852851, lng: 72.8358611, lines: ['line-2a']),
    MetroStationData(id: 'lower-malad', name: 'Lower Malad', lat: 19.1730984, lng: 72.8364801, lines: ['line-2a']),
    MetroStationData(id: 'bangur-nagar', name: 'Bangur Nagar', lat: 19.1624723, lng: 72.8348708, lines: ['line-2a']),
    MetroStationData(id: 'goregaon-west', name: 'Goregaon West', lat: 19.1530241, lng: 72.8356664, lines: ['line-2a']),
    MetroStationData(id: 'oshiwara', name: 'Oshiwara', lat: 19.1460351, lng: 72.833952, lines: ['line-2a']),
    MetroStationData(id: 'lower-oshiwara', name: 'Lower Oshiwara', lat: 19.1406979, lng: 72.8317139, lines: ['line-2a']),
    MetroStationData(id: 'andheri-west', name: 'Andheri West', lat: 19.1291337, lng: 72.8314307, lines: ['line-2a']),
    MetroStationData(id: 'chembur', name: 'Chembur', lat: 19.0541298, lng: 72.8928064, lines: ['line-2b']),
    MetroStationData(id: 'diamond-garden', name: 'Diamond Garden', lat: 19.0517191, lng: 72.9018378, lines: ['line-2b']),
    MetroStationData(id: 'csm-chowk', name: 'Chhatrapati Shivaji Maharaj Chowk', lat: 19.0526419, lng: 72.8942789, lines: ['line-2b']),
    MetroStationData(id: 'shivaji-chowk', name: 'Shivaji Chowk', lat: 19.0479383, lng: 72.9069806, lines: ['line-2b']),
    MetroStationData(id: 'deonar', name: 'Deonar', lat: 19.0448332, lng: 72.917495, lines: ['line-2b']),
    MetroStationData(id: 'mankhurd', name: 'Mankhurd', lat: 19.0492166, lng: 72.931231, lines: ['line-2b']),
    MetroStationData(id: 'mandale', name: 'Maharashtranagar Mandale', lat: 19.0495916, lng: 72.9386612, lines: ['line-2b']),
    MetroStationData(id: 'aarey-jvlr', name: 'Aarey JVLR', lat: 19.130699, lng: 72.884309, lines: ['line-3']),
    MetroStationData(id: 'seepz', name: 'SEEPZ', lat: 19.1259985, lng: 72.8737266, lines: ['line-3']),
    MetroStationData(id: 'midc-andheri', name: 'MIDC Andheri', lat: 19.1173537, lng: 72.8735966, lines: ['line-3']),
    MetroStationData(id: 'csia-t2', name: 'CSIA Terminal 2', lat: 19.1023335, lng: 72.8744692, lines: ['line-3']),
    MetroStationData(id: 'sahar-road', name: 'Sahar Road', lat: 19.102196, lng: 72.8652361, lines: ['line-3']),
    MetroStationData(id: 'csia-t1', name: 'CSIA Terminal 1', lat: 19.093899, lng: 72.8535765, lines: ['line-3']),
    MetroStationData(id: 'santacruz', name: 'Santacruz', lat: 19.0792887, lng: 72.8471185, lines: ['line-3']),
    MetroStationData(id: 'bandra-colony', name: 'Bandra Colony', lat: 19.0699627, lng: 72.8493601, lines: ['line-3']),
    MetroStationData(id: 'bkc', name: 'Bandra Kurla Complex', lat: 19.0606629, lng: 72.8546797, lines: ['line-3', 'line-2b']),
    MetroStationData(id: 'dharavi', name: 'Dharavi', lat: 19.0462612, lng: 72.849741, lines: ['line-3']),
    MetroStationData(id: 'shitaladevi-mandir', name: 'Shitaladevi Mandir', lat: 19.0384641, lng: 72.8419646, lines: ['line-3']),
    MetroStationData(id: 'dadar', name: 'Dadar', lat: 19.0246547, lng: 72.8399280, lines: ['line-3']),
    MetroStationData(id: 'siddhivinayak', name: 'Siddhivinayak', lat: 19.0158935, lng: 72.8309199, lines: ['line-3']),
    MetroStationData(id: 'worli', name: 'Worli', lat: 19.0086057, lng: 72.8192741, lines: ['line-3']),
    MetroStationData(id: 'acharya-atre-chowk', name: 'Acharya Atre Chowk', lat: 18.9978202, lng: 72.8177201, lines: ['line-3']),
    MetroStationData(id: 'science-centre', name: 'Science Centre', lat: 18.9908949, lng: 72.8213521, lines: ['line-3']),
    MetroStationData(id: 'mahalaxmi', name: 'Mahalaxmi', lat: 18.979467, lng: 72.8254006, lines: ['line-3']),
    MetroStationData(id: 'jagannath-shankar-sheth', name: 'Jagannath Shankar Sheth', lat: 18.9699923, lng: 72.8211795, lines: ['line-3']),
    MetroStationData(id: 'grant-road', name: 'Grant Road', lat: 18.9632181, lng: 72.8180437, lines: ['line-3']),
    MetroStationData(id: 'girgaon', name: 'Girgaon', lat: 18.9521015, lng: 72.8222065, lines: ['line-3']),
    MetroStationData(id: 'kalbadevi', name: 'Kalbadevi', lat: 18.946329, lng: 72.827193, lines: ['line-3']),
    MetroStationData(id: 'csmt', name: 'Chhatrapati Shivaji Maharaj Terminus', lat: 18.9408329, lng: 72.831861, lines: ['line-3']),
    MetroStationData(id: 'hutatma-chowk', name: 'Hutatma Chowk', lat: 18.9341849, lng: 72.8325037, lines: ['line-3']),
    MetroStationData(id: 'churchgate', name: 'Churchgate', lat: 18.9314946, lng: 72.8269394, lines: ['line-3']),
    MetroStationData(id: 'vidhan-bhavan', name: 'Vidhan Bhavan', lat: 18.9247813, lng: 72.8254934, lines: ['line-3']),
    MetroStationData(id: 'cuffe-parade', name: 'Cuffe Parade', lat: 18.9135692, lng: 72.8207152, lines: ['line-3']),
    MetroStationData(id: 'gundavali', name: 'Gundavali', lat: 19.1145125, lng: 72.8551556, lines: ['line-7']),
    MetroStationData(id: 'mogra', name: 'Mogra', lat: 19.1284364, lng: 72.8554558, lines: ['line-7']),
    MetroStationData(id: 'jogeshwari-east', name: 'Jogeshwari East', lat: 19.1429455, lng: 72.855185, lines: ['line-7']),
    MetroStationData(id: 'goregaon-east', name: 'Goregaon East', lat: 19.1524492, lng: 72.8565966, lines: ['line-7']),
    MetroStationData(id: 'aarey', name: 'Aarey', lat: 19.1693242, lng: 72.8587918, lines: ['line-7']),
    MetroStationData(id: 'dindoshi', name: 'Dindoshi', lat: 19.1797579, lng: 72.8582976, lines: ['line-7']),
    MetroStationData(id: 'kurar', name: 'Kurar', lat: 19.1872999, lng: 72.8584547, lines: ['line-7']),
    MetroStationData(id: 'akurli', name: 'Akurli', lat: 19.1981585, lng: 72.8604905, lines: ['line-7']),
    MetroStationData(id: 'poisar', name: 'Poisar', lat: 19.2037713, lng: 72.8633227, lines: ['line-7']),
    MetroStationData(id: 'magathane', name: 'Magathane', lat: 19.2167968, lng: 72.8668012, lines: ['line-7']),
    MetroStationData(id: 'devipada', name: 'Devipada', lat: 19.2240357, lng: 72.8643251, lines: ['line-7']),
    MetroStationData(id: 'rashtriya-udyan', name: 'Rashtriya Udyan', lat: 19.2346141, lng: 72.8631372, lines: ['line-7']),
    MetroStationData(id: 'ovaripada', name: 'Ovaripada', lat: 19.2431487, lng: 72.8641377, lines: ['line-7']),
    MetroStationData(id: 'kashigaon', name: 'Kashigaon', lat: 19.2776661, lng: 72.8802398, lines: ['line-9']),
    MetroStationData(id: 'miragaon', name: 'Miragaon', lat: 19.2710068, lng: 72.8806976, lines: ['line-9']),
    MetroStationData(id: 'pandurang-wadi', name: 'Pandurang Wadi', lat: 19.26115, lng: 72.8715306, lines: ['line-9']),
  ];

  final stationMap = {for (final s in stations) s.id: s};
  final lineMap = {for (final l in lines) l.id: l};
  return MetroStationMap(stations: stationMap, lines: lineMap);
}