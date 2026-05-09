import { Home, Cpu, Folder } from "lucide-react";
import { NavLink } from "react-router-dom";

const navItems = [
  { label: "Dashboard", to: "/", icon: Home },
  { label: "Devices", to: "/devices", icon: Folder },
  { label: "Inventory", to: "/inventory", icon: Cpu },
];

export default function Sidebar() {
  return (
    <aside className="flex flex-col rounded-3xl border border-white/10 bg-slate-950/90 p-5 shadow-soft">
      <div className="mb-8">
        <div className="text-2xl font-semibold text-white">TECHI</div>
        <p className="mt-2 text-sm text-slate-400">Platform foundation for MSP inventory and RustDesk native control.</p>
      </div>

      <nav className="space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition ${
                  isActive ? "bg-techi-orange text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
