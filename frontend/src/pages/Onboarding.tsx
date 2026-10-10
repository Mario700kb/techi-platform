import { useSearchParams } from "react-router-dom";
import AgentPackages from "./AgentPackages";
import Deployment from "./Deployment";
import EnrollmentBootstrap from "./EnrollmentBootstrap";
import { PageHeader } from "../components/ui";
import { PageHeaderContext } from "../components/ui/PageHeader";

export type OnboardingTab = "packages" | "tokens" | "installer";

const TABS: { id: OnboardingTab; step: number; label: string; hint: string }[] = [
  { id: "packages", step: 1, label: "Packages", hint: "Upload and activate agent installers" },
  { id: "tokens", step: 2, label: "Tokens & commands", hint: "Enrollment tokens and GPO / manual commands" },
  { id: "installer", step: 3, label: "Installer", hint: "One-click PowerShell installer" },
];

/**
 * One home for getting new devices under management. Each tab hosts the
 * existing page unchanged; only the page title moves up here.
 */
export default function Onboarding() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab") as OnboardingTab | null;
  const active: OnboardingTab = TABS.some((t) => t.id === requested) ? (requested as OnboardingTab) : "tokens";

  const select = (tab: OnboardingTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", tab);
      return next;
    }, { replace: true });
  };

  return (
    <section className="premium-page space-y-5">
      <PageHeader
        title="Onboarding"
        description="Bring new devices under management: publish the agent package, issue a token, then deploy."
      />

      <div role="tablist" aria-label="Onboarding steps" className="grid gap-2 md:grid-cols-3">
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => select(tab.id)}
              className="th-kpi items-center gap-3"
              style={{ "--kpi-tone": "var(--th-accent)", flexDirection: "row" } as React.CSSProperties}
            >
              <span
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[12px] font-semibold"
                style={
                  selected
                    ? { background: "var(--th-accent)", color: "var(--th-on-accent)" }
                    : { background: "var(--th-chip-bg)", color: "var(--th-text-muted)", border: "1px solid var(--th-border-default)" }
                }
              >
                {tab.step}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>{tab.label}</span>
                <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{tab.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <PageHeaderContext.Provider value={{ embedded: true }}>
        <div role="tabpanel">
          {active === "packages" && <AgentPackages />}
          {active === "tokens" && <Deployment />}
          {active === "installer" && <EnrollmentBootstrap />}
        </div>
      </PageHeaderContext.Provider>
    </section>
  );
}
