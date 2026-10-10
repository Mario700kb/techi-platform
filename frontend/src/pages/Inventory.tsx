import { Link } from "react-router-dom";
import { Cpu } from "lucide-react";
import { PageHeader } from "../components/ui";

export default function Inventory() {
  return (
    <section className="premium-page space-y-5">
      <PageHeader
        title="Inventory"
        description="Hardware and software inventory grouped by client, device group and device role."
      />
      <div className="premium-card flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span
          className="flex h-11 w-11 items-center justify-center rounded-xl border"
          style={{ borderColor: "var(--th-border-default)", background: "var(--th-chip-bg)", color: "var(--th-text-muted)" }}
        >
          <Cpu className="h-5 w-5" />
        </span>
        <h2>Fleet inventory is not available yet</h2>
        <p className="max-w-md text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          Per-device hardware, software and patch details are already in each device&apos;s drawer on the Devices page.
        </p>
        <Link to="/devices" className="th-btn th-btn-secondary mt-1 inline-flex min-h-9 items-center rounded-lg border px-3.5 text-sm">
          Open Devices
        </Link>
      </div>
    </section>
  );
}
