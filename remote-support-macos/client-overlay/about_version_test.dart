import 'package:flutter_hbb/desktop/about_version.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

PackageInfo packageInfo(String version, String buildNumber) => PackageInfo(
      appName: 'TECHI Remote Support',
      packageName: 'al.techi.remote-support',
      version: version,
      buildNumber: buildNumber,
    );

void main() {
  test('macOS About reads marketing and internal versions from bundle metadata',
      () async {
    final result = await loadAboutVersionData(
      macOS: true,
      nativeVersionLoader: () async => '9.9.9',
      packageInfoLoader: () async => packageInfo('1.4.9', '149.0'),
    );

    expect(result.marketingVersion, '1.4.9');
    expect(result.internalBuild, '148.4');
    expect(result.displayVersion, '1.4.9 (149.0)');
    expect(result.source, bundleMetadataVersionSource);
  });

  test('macOS About falls back to the native build contract', () async {
    final result = await loadAboutVersionData(
      macOS: true,
      nativeVersionLoader: () async => '8.8.8',
      packageInfoLoader: () async => throw StateError('metadata unavailable'),
    );

    expect(result.displayVersion, '8.8.8');
    expect(result.source, nativeBuildVersionSource);
  });

  test('Windows About keeps the native version path', () async {
    var packageLookupCalled = false;
    final result = await loadAboutVersionData(
      macOS: false,
      nativeVersionLoader: () async => '7.7.7',
      packageInfoLoader: () async {
        packageLookupCalled = true;
        return packageInfo('1.4.9', '149.0');
      },
    );

    expect(result.displayVersion, '7.7.7');
    expect(result.source, nativeBuildVersionSource);
    expect(packageLookupCalled, isFalse);
  });

  test('an empty bundle marketing version uses the native build contract',
      () async {
    final result = await loadAboutVersionData(
      macOS: true,
      nativeVersionLoader: () async => '6.6.6',
      packageInfoLoader: () async => packageInfo('  ', '148.4'),
    );

    expect(result.displayVersion, '6.6.6');
    expect(result.source, nativeBuildVersionSource);
  });
}
