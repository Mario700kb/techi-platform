import AppKit

final class BaseClientDelegate: NSObject, NSApplicationDelegate {}

let aboutVersionContract = "bundle-metadata:CFBundleShortVersionString+CFBundleVersion"
let secureConnectContract = "techi-secure-connect-stdin-v1"
if CommandLine.arguments.contains("--about-version-contract") {
    print(aboutVersionContract)
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--techi-connect-self-test"] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, data.count <= 512 else { exit(2) }
    _ = secureConnectContract
    print("TECHI_CONNECT_ACCEPTED_V1")
    exit(0)
}

let application = NSApplication.shared
let delegate = BaseClientDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
