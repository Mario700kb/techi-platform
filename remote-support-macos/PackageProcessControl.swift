import AppKit
import Darwin
import Foundation

private let expectedBundleIdentifier = "al.techi.remote-support"

private func canonicalURL(_ url: URL) -> URL {
    url.resolvingSymlinksInPath().standardizedFileURL
}

private func processExists(_ processIdentifier: pid_t) -> Bool {
    if Darwin.kill(processIdentifier, 0) == 0 { return true }
    return errno != ESRCH
}

private func matchingApplications(at appURL: URL) -> [NSRunningApplication] {
    let expectedURL = canonicalURL(appURL)
    return NSWorkspace.shared.runningApplications.filter { application in
        guard
            !application.isTerminated,
            processExists(application.processIdentifier),
            application.bundleIdentifier == expectedBundleIdentifier,
            let bundleURL = application.bundleURL
        else { return false }
        return canonicalURL(bundleURL) == expectedURL
    }
}

private func waitUntilStopped(at appURL: URL, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if matchingApplications(at: appURL).isEmpty { return true }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    return matchingApplications(at: appURL).isEmpty
}

private func stopApplications(at appURL: URL) -> Int32 {
    let applications = matchingApplications(at: appURL)
    for application in applications {
        _ = application.terminate()
    }
    if waitUntilStopped(at: appURL, timeout: 8) { return 0 }

    // Force termination is scoped to applications whose bundle ID and bundle
    // URL both match the exact installation being upgraded.
    for application in matchingApplications(at: appURL) {
        _ = application.forceTerminate()
        _ = Darwin.kill(application.processIdentifier, SIGKILL)
    }
    return waitUntilStopped(at: appURL, timeout: 4) ? 0 : 10
}

private func verifyRegistration(of appURL: URL) -> Int32 {
    guard let protocolURL = URL(string: "techiremotesupport://install-validation") else { return 20 }
    let expectedURL = canonicalURL(appURL)
    let deadline = Date().addingTimeInterval(8)
    repeat {
        if let resolved = NSWorkspace.shared.urlForApplication(toOpen: protocolURL),
           canonicalURL(resolved) == expectedURL {
            return 0
        }
        Thread.sleep(forTimeInterval: 0.25)
    } while Date() < deadline
    return 21
}

guard CommandLine.arguments.count == 3 else { exit(64) }
let command = CommandLine.arguments[1]
let appURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)

switch command {
case "stop":
    exit(stopApplications(at: appURL))
case "verify-stopped":
    exit(matchingApplications(at: appURL).isEmpty ? 0 : 11)
case "verify-registration":
    exit(verifyRegistration(of: appURL))
default:
    exit(64)
}
