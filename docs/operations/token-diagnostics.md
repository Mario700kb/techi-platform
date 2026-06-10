# Token Diagnostics Operations Guide

## Opening Diagnostics

On the Enrollment page, select an enrollment token or click **Diagnostics**.
The drawer loads diagnostics and enrollment history on demand. Opening the main
token list alone does not run these queries.

The drawer is available only to admin and owner accounts.

## Reading the Metrics

- **Uses / max**: Current `use_count` and configured token limit.
- **Unique devices**: Distinct audited device IDs successfully associated with
  the token.
- **Duplicate / re-enrollments**: Successful events that reused an existing
  device.
- **Failed attempts**: Audited validation or enrollment-processing failures.
- **Orphaned uses**: Token uses not covered by successful audit events.
- **Archived devices**: Currently archived devices associated with successful
  events for the token.

For legacy tokens, some values may show **Unknown** or be marked **Inferred**.
Read the inference note before treating those values as exact.

## Example

```text
Uses:                    204 / 250
Unique devices:          121
Duplicate enrollments:    83
Failed attempts:           0
Orphaned uses:              0
```

Interpretation:

```text
121 unique devices + 83 duplicate/re-enrollments = 204 token uses
```

The token was not lost or consumed without registration. The difference
between uses and unique devices is explained by devices enrolling more than
once.

## Warning Signs

Investigate when any of the following occur:

- **Orphaned uses > 0**: Token consumption is not fully represented by
  successful audit events. For a newly audited token this can indicate an audit
  gap or a partial enrollment failure. For an older token it may reflect
  pre-audit history.
- **Failed attempts rising**: Check for expired, revoked, exhausted, malformed,
  or incorrectly distributed token values.
- **Repeated duplicate enrollments from the same hostname**: Check for repeated
  service installation, configuration regeneration, identity loss, deployment
  loops, or agent startup retries.

## Troubleshooting

1. Open the token's **Diagnostics** drawer.
2. Read the inference note to determine whether counts are exact, inferred, or
   unknown.
3. Review **Enrollment History**, starting with failed and
   `updated_existing` events.
4. Filter or search exported/API event data by `hostname`, `rustdesk_id`, or
   `device_id`.
5. Compare token `use_count` with successful audit events:

   ```text
   successful events = success + duplicate + updated_existing
   orphaned uses = max(use_count - successful events, 0)
   ```

6. For repeated hostnames, compare the event timestamps, agent IDs,
   fingerprints, RustDesk IDs, and assigned device IDs.
7. For failures, inspect `reason` first. Use the truncated `raw_error` only as
   supporting context; it is intentionally limited to 500 characters.

API endpoints:

```text
GET /api/v1/enrollment-tokens/{id}/diagnostics
GET /api/v1/enrollment-tokens/{id}/events?limit=50&offset=0
```

The event limit defaults to 50 and cannot exceed 200 per request.

## Rollback

The audit feature is additive. Rolling back the UI and diagnostics endpoints
does not alter existing devices, device IDs, agent behavior, or token
`use_count`.

If the database migration is also rolled back, the audit table and its event
history are removed. Device registration and token accounting continue through
their existing tables.
