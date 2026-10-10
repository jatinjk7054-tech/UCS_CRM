const Map<String, String> metroColors = {
  'line-1': '#1755c4',
  'line-2a': '#f7a800',
  'line-2b': '#f7a800',
  'line-3': '#00a0a7',
  'line-7': '#e0241f',
  'line-9': '#e0241f',
};

String getLineColor(String lineNameOrId) {
  if (lineNameOrId.isEmpty) return '#64748b';
  final lower = lineNameOrId.toLowerCase();
  if (metroColors.containsKey(lower)) return metroColors[lower]!;
  final name = lower.replaceAll('line', '').trim();
  if (name.contains('blue') && !name.contains('yellow')) return '#1755c4';
  if (name.contains('yellow') || regexContains(name, [r'\b2\b', r'b\s*2', r'56'])) return '#f7a800';
  if (name.contains('aqua') || name.contains('teal')) return '#00a0a7';
  if (name.contains('red') || regexContains(name, [r'\b7\b', r'\b9\b'])) return '#e0241f';
  if (name.isNotEmpty && int.tryParse(name) != null) {
    final n = int.parse(name);
    if (n == 1 || n == 11) return '#1755c4';
    if (n == 2) return '#f7a800';
    if (n == 3) return '#00a0a7';
    if (n == 7 || n == 9) return '#e0241f';
  }
  return '#64748b';
}

bool regexContains(String input, List<String> patterns) {
  for (final p in patterns) {
    if (RegExp(p).hasMatch(input)) return true;
  }
  return false;
}