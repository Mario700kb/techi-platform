# TECHI Remote Support for macOS

The macOS package wraps the verified TECHI-branded RustDesk client with the
secure Connect launcher and shared token-redemption bridge.

## Build

Requirements:

- Apple Silicon macOS with Xcode command-line tools, Go 1.21+, and Swift.
- A canonical `TECHI Remote Support.app` base with bundle identifier
  `al.techi.remote-support`. The default is the installed application at
  `/Applications/TECHI Remote Support.app`.

Run:

```bash
MACOS_RS_BASE_APP="/Applications/TECHI Remote Support.app" \
  scripts/build-macos-remote-support.sh
```

The output is `dist/TECHI-Remote-Support-<version>-darwin-arm64.dmg` plus an
identity JSON sidecar. The script verifies product identity and architecture,
installs the AppKit URL dispatcher and Go bridge, registers only the
`techiremotesupport` scheme, and validates the resulting bundle signature.

Without `MACOS_CODESIGN_IDENTITY`, the application receives only an ad-hoc
signature and is not notarized. Developer ID signing can be selected with
`MACOS_CODESIGN_IDENTITY`; notarization additionally requires an existing
notarytool keychain profile named by `MACOS_NOTARY_PROFILE`.

The build never clears quarantine attributes and never changes Gatekeeper.
