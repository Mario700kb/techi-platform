export default function Inventory() {
  return (
    <section className="space-y-6">
      <div
        className="rounded-3xl p-6 shadow-soft"
        style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
      >
        <h2 className="text-2xl font-semibold" style={{ color: "var(--th-text-primary)" }}>Inventory</h2>
        <p className="mt-3" style={{ color: "var(--th-text-muted)" }}>This screen will map clients, groups, and device types in later development.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div
          className="rounded-3xl p-6 shadow-soft"
          style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
        >
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Prepared For</p>
          <p className="mt-3" style={{ color: "var(--th-text-primary)" }}>Smart grouping by client and device role.</p>
        </div>
        <div
          className="rounded-3xl p-6 shadow-soft"
          style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
        >
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Agent</p>
          <p className="mt-3" style={{ color: "var(--th-text-primary)" }}>Windows Golang agent and heartbeat flow will connect inventory later.</p>
        </div>
      </div>
    </section>
  );
}
