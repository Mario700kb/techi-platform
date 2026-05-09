export default function Inventory() {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
        <h2 className="text-2xl font-semibold text-white">Inventory</h2>
        <p className="mt-3 text-slate-400">This screen will map clients, groups, and device types in later development.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Prepared For</p>
          <p className="mt-3 text-white">Smart grouping by client and device role.</p>
        </div>
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Agent</p>
          <p className="mt-3 text-white">Windows Golang agent and heartbeat flow will connect inventory later.</p>
        </div>
      </div>
    </section>
  );
}
