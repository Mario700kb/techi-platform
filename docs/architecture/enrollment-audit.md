# Enrollment Audit Architecture

## Purpose

Enrollment audit provides traceability between enrollment-token usage and the
devices registered through the enrollment API. It records a compact event for
each audited enrollment outcome without changing device identity, token
accounting, or agent behavior.

The audit answers operational questions such as:

- Which device or hostname used a token?
- Was the enrollment a new device or a re-enrollment of an existing device?
- Did token validation or enrollment processing fail?
- Are token uses accounted for by successful enrollment events?

## Why Uses and Unique Devices Differ

`enrollment_tokens.use_count` counts successful token-consuming enrollment
requests. It is not a unique-device counter.

A device may enroll multiple times because the service was reinstalled, local
configuration was regenerated, an agent identity changed, or an enrollment was
retried. When the backend matches that request to an existing device, the token
is consumed again but no new device ID is created.

Therefore:

```text
token uses = new-device enrollments + duplicate/re-enrollment events
```

Failed attempts do not normally increment `use_count`, but they are recorded
when the token can be identified.

## Data Model

The `enrollment_audit` table is additive and does not replace the token or
device tables.

| Field | Description |
| --- | --- |
| `id` | Audit event primary key. |
| `created_at` | Time the audit event was written. |
| `token_id` | Enrollment token ID, when identifiable. |
| `token_name` | Token name captured at event time. |
| `token_prefix` | Non-secret token prefix captured at event time. |
| `client_id` | Client assignment from the token, when present. |
| `group_id` | Group assignment from the token, when present. |
| `device_id` | Created or reused device ID, when available. |
| `hostname` | Hostname supplied by the enrollment request. |
| `username` | Current user supplied by the enrollment request. |
| `domain` | Domain supplied by the enrollment request. |
| `rustdesk_id` | RustDesk ID supplied by the enrollment request. |
| `public_ip` | Public IP supplied by the enrollment request. |
| `local_ip` | Local IP supplied by the enrollment request. |
| `result` | Normalized enrollment result. |
| `reason` | Short machine-readable or operator-readable explanation. |
| `raw_error` | Optional safe error text, truncated to 500 characters. |
| `fingerprint` | Compact identity hints available during enrollment. |
| `agent_id` | Agent ID supplied by the request, when available. |

The table does not store the plaintext enrollment token or the full enrollment
payload.

## Result Types

- `success`: A new device was successfully registered.
- `duplicate`: A duplicate enrollment was detected. This value is supported by
  the diagnostics model for explicit duplicate classifications.
- `updated_existing`: Enrollment matched and updated an existing device.
- `failed`: Token validation or enrollment processing failed.
- `ignored`: An enrollment attempt was intentionally ignored without changing
  device registration.

`duplicate` and `updated_existing` are both counted as duplicate or
re-enrollment activity in diagnostics.

## Best-Effort Behavior

Audit insertion uses an independent database session and is wrapped in
exception handling. An audit write may fail because of a temporary database
problem, migration mismatch, or another diagnostics-only fault. That failure is
logged and swallowed.

Audit failure must never break enrollment because enrollment is the primary
operation and audit is supplemental observability. Blocking enrollment on an
audit insert could strand deployed agents, consume operator time, or create a
larger availability incident from a diagnostics failure.

This also means the audit is not a transactional ledger. A gap between
`use_count` and successful audit events is reported conservatively as an
inferred orphaned-use count.

## Existing Tokens

Events are recorded only after the audit feature is deployed. Existing token
uses are not aggressively backfilled.

For older tokens:

- Tokens scoped to a client or group may use current matching devices and their
  enrollment counts as a best-effort inference.
- Unscoped tokens may have no reliable historical device attribution.
- Failed historical attempts are unknown because they were not previously
  persisted.

The diagnostics response includes `inferred` and `inference_note` so the UI can
distinguish exact audit counts from inferred or unknown values.

## Performance

The main enrollment-token list remains lightweight and uses its existing token
fields only. It does not calculate diagnostics for every token.

Diagnostics and enrollment history are loaded lazily when an admin or owner
opens a token's diagnostics drawer. Event retrieval defaults to 50 rows and is
limited to 200 rows per request.

## Indexes

The audit table has indexes on:

- `enrollment_audit.token_id`
- `enrollment_audit.created_at`
- `enrollment_audit.device_id`
- `enrollment_audit.result`

These support per-token history, recent-event ordering, device investigation,
and result-based diagnostics without adding work to the normal token-list
query.

## Security and Permissions

Token diagnostics and enrollment-event endpoints are restricted to operators
with the `admin` or `owner` role.

The audit captures operational identifiers and IP addresses, so access should
remain limited. Plaintext enrollment tokens and large raw request payloads are
never stored.
