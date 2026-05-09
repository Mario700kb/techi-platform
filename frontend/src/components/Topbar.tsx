export default function Topbar() {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-3xl border border-white/10 bg-slate-950/90 p-5 shadow-soft sm:flex-row sm:items-center">
      <div>
        <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Developer preview</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">TECHI Dashboard</h1>
      </div>
      <div className="flex items-center gap-3">
        <div className="rounded-2xl bg-white/5 px-4 py-2 text-sm text-slate-200">Dark theme</div>
        <div className="rounded-2xl bg-techi-pink px-4 py-2 text-sm text-white">Native RustDesk only</div>
      </div>
    </div>
  );
}
