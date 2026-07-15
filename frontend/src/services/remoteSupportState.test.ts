import { describe, expect, it } from "vitest";
import type { Device } from "../api/devices";
import {
  remoteSupportConnectAvailable,
  remoteSupportCredentialPresentation,
  remoteSupportCredentialRevealAvailable,
  remoteSupportPresentation,
} from "./remoteSupportState";

function device(state: string, rustdeskId: string | null = "486641675"): Device {
  return {
    remote_support_state: state,
    rustdesk_id: rustdeskId,
    rustdesk_conflict_detected: false,
  } as Device;
}

describe("remoteSupportPresentation", () => {
  it("does not map unknown or legacy status to missing", () => {
    expect(remoteSupportPresentation(device("unknown")).label).toBe("Status unavailable");
    expect(remoteSupportPresentation(device("legacy_status_unavailable")).label).toBe("Status unavailable");
  });

  it.each(["installed_running", "unknown", "damaged", "legacy_status_unavailable"])(
    "keeps Connect available with persisted Remote ID when state is %s",
    (state) => {
      expect(remoteSupportConnectAvailable(device(state))).toBe(true);
    },
  );

  it("blocks Connect only for a missing, invalid, or conflicting Remote ID", () => {
    expect(remoteSupportConnectAvailable(device("installed_running", null))).toBe(false);
    expect(remoteSupportConnectAvailable(device("installed_running", "pending_device"))).toBe(false);
    expect(remoteSupportConnectAvailable({
      ...device("installed_running"),
      rustdesk_conflict_detected: true,
    })).toBe(false);
  });
});

describe("remoteSupportCredentialPresentation", () => {
  it("shows preparation before the first desired generation exists", () => {
    expect(remoteSupportCredentialPresentation({
      heartbeatAuthState: "authenticated",
      applyStatus: "unknown",
      activeGeneration: 0,
      desiredGeneration: 0,
      appliedGeneration: 0,
    }).label).toBe("Preparing device credential");
  });

  it("shows pending, failed, legacy, and confirmed applied states", () => {
    expect(remoteSupportCredentialPresentation({
      heartbeatAuthState: "authenticated", applyStatus: "pending",
      activeGeneration: 1, desiredGeneration: 2, appliedGeneration: 1,
    }).label).toBe("Credential pending application");
    expect(remoteSupportCredentialPresentation({
      heartbeatAuthState: "authenticated", applyStatus: "failed",
      activeGeneration: 1, desiredGeneration: 2, appliedGeneration: 1,
      failureReason: "tray reload failed",
    }).detail).toBe("tray reload failed");
    expect(remoteSupportCredentialPresentation({
      heartbeatAuthState: "legacy_restricted", applyStatus: "unsupported_legacy",
      activeGeneration: 0, desiredGeneration: 0, appliedGeneration: 0,
    }).label).toBe("Credential unavailable until Agent authentication");
    expect(remoteSupportCredentialPresentation({
      heartbeatAuthState: "authenticated", applyStatus: "applied",
      activeGeneration: 2, desiredGeneration: 2, appliedGeneration: 2,
    }).label).toBe("Credential applied");
  });

  it("allows reveal only for a matching active and applied generation", () => {
    expect(remoteSupportCredentialRevealAvailable({
      applyStatus: "applied", activeGeneration: 2, appliedGeneration: 2,
    })).toBe(true);
    expect(remoteSupportCredentialRevealAvailable({
      applyStatus: "pending", activeGeneration: 1, appliedGeneration: 1,
    })).toBe(true);
    expect(remoteSupportCredentialRevealAvailable({
      applyStatus: "applied", activeGeneration: 2, appliedGeneration: 1,
    })).toBe(false);
  });
});
