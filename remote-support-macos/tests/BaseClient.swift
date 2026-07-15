import AppKit

final class BaseClientDelegate: NSObject, NSApplicationDelegate {}

let application = NSApplication.shared
let delegate = BaseClientDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
