import AppKit

final class BaseClientDelegate: NSObject, NSApplicationDelegate {}

let aboutVersionContract = "bundle-metadata:CFBundleShortVersionString+CFBundleVersion"
if CommandLine.arguments.contains("--about-version-contract") {
    print(aboutVersionContract)
    exit(0)
}

let application = NSApplication.shared
let delegate = BaseClientDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
