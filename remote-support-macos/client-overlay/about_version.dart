import 'package:package_info_plus/package_info_plus.dart';

typedef NativeVersionLoader = Future<String> Function();
typedef PackageInfoLoader = Future<PackageInfo> Function();

const bundleMetadataVersionSource =
    'bundle-metadata:CFBundleShortVersionString+CFBundleVersion';
const nativeBuildVersionSource = 'native-build-contract';

class AboutVersionData {
  const AboutVersionData({
    required this.marketingVersion,
    required this.internalBuild,
    required this.source,
  });

  final String marketingVersion;
  final String internalBuild;
  final String source;

  String get displayVersion => internalBuild.isEmpty
      ? marketingVersion
      : '$marketingVersion ($internalBuild)';
}

Future<AboutVersionData> loadAboutVersionData({
  required bool macOS,
  required NativeVersionLoader nativeVersionLoader,
  PackageInfoLoader? packageInfoLoader,
}) async {
  final buildTimeVersion = (await nativeVersionLoader()).trim();
  if (!macOS) {
    return AboutVersionData(
      marketingVersion: buildTimeVersion,
      internalBuild: '',
      source: nativeBuildVersionSource,
    );
  }

  try {
    final packageInfo = await (packageInfoLoader ?? PackageInfo.fromPlatform)();
    final bundleVersion = packageInfo.version.trim();
    final bundleBuild = packageInfo.buildNumber.trim();
    if (bundleVersion.isNotEmpty) {
      return AboutVersionData(
        marketingVersion: bundleVersion,
        internalBuild: bundleBuild,
        source: bundleMetadataVersionSource,
      );
    }
  } catch (_) {
    // The native build contract remains the safe fallback if bundle lookup fails.
  }

  return AboutVersionData(
    marketingVersion: buildTimeVersion,
    internalBuild: '',
    source: nativeBuildVersionSource,
  );
}
