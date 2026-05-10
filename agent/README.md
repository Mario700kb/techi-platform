# Techi Agent (Phase 3)

Minimal Go-based agent for Techi Remote Dashboard.

## What it does

- Collects local inventory data:
  - `hostname`
  - `current_user`
  - `domain`
  - `local_ip`
  - `public_ip`
  - `os_name`
  - `os_version`
  - `platform`
  - `cpu`
  - `ram`
  - `storage`
  - `rustdesk_id` placeholder
- Sends a heartbeat POST to `http://localhost:8000/api/v1/agent/heartbeat`
- Supports configuration via `agent/config.json`
- Retries failed requests with logging

## Build

From the `agent/` directory:

```bash
cd agent
go mod tidy
go build -o techi-agent
```

## Run

Use the default config file:

```bash
cd agent
./techi-agent
```

Or pass a custom config path:

```bash
cd agent
./techi-agent -config custom-config.json
```

## Configuration

The agent reads `agent/config.json` by default. Example:

```json
{
  "backend_url": "http://localhost:8000/api/v1/agent/heartbeat",
  "rustdesk_id": "rustdesk-placeholder",
  "public_ip_service": "https://api.ipify.org?format=text",
  "timeout_seconds": 10,
  "retries": 3,
  "retry_delay_seconds": 5
}
```

## Testing

1. Start the backend server on `http://localhost:8000`.
2. Run the agent:

```bash
cd agent
./techi-agent
```

3. Confirm the backend receives the heartbeat and logs the request.

If the backend is unreachable, the agent will retry the configured number of times and log each failure.
