export default function Dashboard() {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-techi-orange">Welcome back</p>
            <h2 className="mt-3 text-3xl font-semibold text-white">Platform foundation ready</h2>
          </div>
          <div className="rounded-3xl bg-white/5 px-4 py-2 text-sm text-slate-200">Phase 1</div>
        </div>
        <p className="mt-4 max-w-2xl text-slate-300">
          This development foundation includes FastAPI backend scaffolding, a React/Vite frontend shell, PostgreSQL compose setup, and the initial data model for devices, clients, and groups.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Health</p>
          <p className="mt-4 text-3xl font-semibold text-white">Ready</p>
          <p className="mt-2 text-sm text-slate-400">Backend health endpoint at /health.</p>
        </div>
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Connections</p>
          <p className="mt-4 text-3xl font-semibold text-white">RustDesk native only</p>
          <p className="mt-2 text-sm text-slate-400">No web remote desktop is included in Phase 1.</p>
        </div>
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Inventory</p>
          <p className="mt-4 text-3xl font-semibold text-white">Devices</p>
          <p className="mt-2 text-sm text-slate-400">Device groups and device type support are prepared for later development.</p>
        </div>
      </div>
    </section>
  );
}
