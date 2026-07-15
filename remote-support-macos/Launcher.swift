import AppKit

final class RemoteSupportLauncherDelegate: NSObject, NSApplicationDelegate {
    private var receivedURL = false
    private var bridgeRunning = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, !self.receivedURL else { return }
            self.cleanupAndLaunchClient()
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        receivedURL = true
        guard urls.count == 1, !bridgeRunning else {
            showFailure(expired: false)
            application.terminate(nil)
            return
        }
        bridgeRunning = true
        runBridge(with: urls[0].absoluteString)
    }

    private func bundledExecutable(_ relativePath: String) -> URL {
        Bundle.main.bundleURL.appendingPathComponent(relativePath)
    }

    private func configuredProcess(_ executable: URL, arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = executable.deletingLastPathComponent()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        return process
    }

    private func cleanupAndLaunchClient() {
        let helper = bundledExecutable("Contents/Helpers/techi-remote-support-bridge")
        let cleanup = configuredProcess(helper, arguments: ["--cleanup-stale"])
        try? cleanup.run()
        cleanup.waitUntilExit()

        let client = bundledExecutable("Contents/MacOS/TECHI Remote Support Client")
        let process = configuredProcess(client, arguments: [])
        do {
            try process.run()
        } catch {
            showFailure(expired: false)
        }
        NSApplication.shared.terminate(nil)
    }

    private func runBridge(with protocolURI: String) {
        let helper = bundledExecutable("Contents/Helpers/techi-remote-support-bridge")
        let process = configuredProcess(helper, arguments: ["--stdin-uri"])
        let input = Pipe()
        process.standardInput = input
        process.terminationHandler = { process in
            DispatchQueue.main.async {
                if process.terminationStatus != 0 {
                    self.showFailure(expired: process.terminationStatus == 20)
                }
                NSApplication.shared.terminate(nil)
            }
        }

        do {
            try process.run()
            if let data = protocolURI.data(using: .utf8) {
                input.fileHandleForWriting.write(data)
            }
            try? input.fileHandleForWriting.close()
        } catch {
            try? input.fileHandleForWriting.close()
            showFailure(expired: false)
            NSApplication.shared.terminate(nil)
        }
    }

    private func showFailure(expired: Bool) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "TECHI Remote Support"
        alert.informativeText = expired
            ? "This Connect request expired or was already used. Return to TECHI Platform and click Connect again."
            : "TECHI Remote Support could not start the connection. Return to TECHI Platform and try Connect again."
        alert.runModal()
    }
}

let application = NSApplication.shared
let delegate = RemoteSupportLauncherDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
