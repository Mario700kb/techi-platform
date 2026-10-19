import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import RemoteSupportIdOrigin from "../RemoteSupportIdOrigin";

const base = {
  rustdesk_id: "1529551896",
  rustdesk_id_source: null,
  rustdesk_presence_at: null,
  agent_rustdesk_id: null,
  rustdesk_conflict_detected: false,
  rustdesk_sync_message: undefined,
  rustdesk_manual_override: false,
};

describe("RemoteSupportIdOrigin", () => {
  it("says when Remote Support itself confirmed the ID, and names the agent's stale reading", () => {
    render(
      <RemoteSupportIdOrigin
        device={{
          ...base,
          rustdesk_id_source: "remote_support",
          rustdesk_presence_at: new Date(Date.now() - 20_000).toISOString(),
          agent_rustdesk_id: "499953668",
        }}
      />,
    );
    expect(screen.getByText(/Confirmed by TECHI Remote Support/)).toBeInTheDocument();
    expect(screen.getByText(/The agent reads 499 953 668 from an old configuration/)).toBeInTheDocument();
  });

  it("says an ID only the agent read is not confirmed yet", () => {
    render(<RemoteSupportIdOrigin device={base} />);
    expect(screen.getByText(/not yet confirmed by Remote Support itself/)).toBeInTheDocument();
  });

  it("shows a conflict instead", () => {
    render(
      <RemoteSupportIdOrigin
        device={{
          ...base,
          rustdesk_conflict_detected: true,
          rustdesk_sync_message: "Two machines share this MachineGuid: 499953668 and 1529551896.",
        }}
      />,
    );
    expect(screen.getByText(/Two machines share this MachineGuid/)).toBeInTheDocument();
  });
});

describe("RemoteSupportIdOrigin with the ID server", () => {
  it("says the ID server verified it, and explains a cloned machine", () => {
    const { unmount } = render(<RemoteSupportIdOrigin device={{ ...base, rustdesk_id_source: "id_server" }} />);
    expect(screen.getByText(/Verified by the ID server/)).toBeInTheDocument();
    unmount();
    render(
      <RemoteSupportIdOrigin
        device={{
          ...base,
          rustdesk_id_source: "id_server",
          rustdesk_sync_message:
            "5 Remote Support IDs registered by this machine's MachineGuid: cloned machines take each other's IDs.",
        }}
      />,
    );
    expect(screen.getByText(/cloned machines take each other's IDs/)).toBeInTheDocument();
  });
});
