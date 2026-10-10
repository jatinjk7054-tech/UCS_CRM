import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:metropad/main.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('renders login screen when signed out', (WidgetTester tester) async {
    await tester.pumpWidget(const MetroPadApp());
    await tester.pumpAndSettle();

    expect(find.text('MetroPad Care'), findsOneWidget);
    expect(find.text('Sign In'), findsOneWidget);
  });
}