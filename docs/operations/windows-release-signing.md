# Windows Release Signing Gate

TECHI Agent Windows releases use this order:

1. Build `techi-agent.exe` with stable PE metadata.
2. Authenticode-sign and RFC 3161 timestamp the EXE.
3. Embed that exact EXE in the Agent and Agent Update MSIs.
4. Authenticode-sign and timestamp both MSIs.
5. Compute SHA-256, validate MSI lineage, and publish identity metadata.

Fleet rollout is not approved unless the CI identity file reports all of:

- `agent_authenticode_status: Valid`
- `agent_timestamped: true`
- `msi_authenticode_status: Valid`
- `msi_timestamped: true`
- `fleet_rollout_eligible: true`

Set repository variable `REQUIRE_SIGNED_WINDOWS_ARTIFACTS=1` to make the CI
release gate fail unless the Agent EXE and Agent MSI both carry valid
signatures. Keep `AGENT_ROLLOUT_MODE=disabled` until that gate is enabled and a
signed artifact passes it.

## Certificate Requirements

Use a publicly trusted organization-validation or extended-validation Windows
code-signing certificate whose subject identifies `TECHI Solutions SH.P.K.`.
The certificate must permit Code Signing EKU (`1.3.6.1.5.5.7.3.3`), include the
private key, support SHA-256, and be exportable to a password-protected PFX for
the current GitHub-hosted runner integration. Hardware-backed or key-vault
signing should replace the PFX transport when available.

Configure these GitHub values:

- Secret `WINDOWS_CODE_SIGNING_PFX_BASE64`: base64 of the binary PFX bytes.
- Secret `WINDOWS_CODE_SIGNING_PFX_PASSWORD`: the PFX password.
- Variable `WINDOWS_CODE_SIGNING_TIMESTAMP_URL`: trusted RFC 3161 timestamp URL.
- Variable `REQUIRE_SIGNED_WINDOWS_ARTIFACTS`: set to `1` only after the three
  values above are configured and a signing test succeeds.

Never commit a PFX, private key, password, or base64 certificate payload.
