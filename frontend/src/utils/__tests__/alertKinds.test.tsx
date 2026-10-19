import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AlertKindIcon from "../../components/AlertKindIcon";
import { ALERT_KIND_LABELS } from "../../types/alert";
import type { Alert } from "../../types/alert";
import { describeAlert } from "../alertText";

const alert = (overrides: Partial<Alert>): Alert =>
  ({
    id: 1,
    device_id: 7,
    state: "open",
    created_at: "",
    updated_at: "",
    kind: "device_offline",
    severity: "warning",
    message: "",
    ...overrides,
  }) as Alert;

describe("monitor alert kinds", () => {
  it("have plain labels", () => {
    expect(ALERT_KIND_LABELS.disk_forecast).toBe("Disk full forecast");
    expect(ALERT_KIND_LABELS.high_network).toBe("High network");
  });

  it("have their own icons", () => {
    const forecast = render(<AlertKindIcon kind="disk_forecast" />).container.querySelector("svg");
    const network = render(<AlertKindIcon kind="high_network" />).container.querySelector("svg");
    expect(forecast).toHaveClass("lucide-calendar-clock");
    expect(network).toHaveClass("lucide-network");
  });

  it("lift the measured value out of the monitor message", () => {
    expect(
      describeAlert(alert({ kind: "disk_forecast", message: "Disk C: full within 14 days on SRV-01 (now 9 days)" })),
    ).toMatchObject({ summary: "Disk forecast to fill up", value: "9 days" });
    expect(
      describeAlert(
        alert({
          kind: "high_network",
          severity: "info",
          message: "Network receive above 800 Mb/s for 5 min on SRV-01 (now 912 Mb/s)",
        }),
      ),
    ).toMatchObject({ summary: "Network receive high", value: "912 Mb/s" });
    expect(
      describeAlert(alert({ kind: "high_network", message: "Network send above 500 Mb/s on SRV-01" })),
    ).toMatchObject({
      summary: "Network send high",
      value: null,
    });
  });
});
