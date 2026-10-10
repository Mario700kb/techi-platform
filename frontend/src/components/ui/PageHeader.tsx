import { createContext, ReactNode, useContext } from "react";
import clsx from "clsx";

/** Set by a host page (e.g. Onboarding tabs) that already shows the title. */
export const PageHeaderContext = createContext<{ embedded: boolean }>({ embedded: false });

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * One header for every desktop page: title, a single line of context and the
 * page actions. Below md the MobileTopBar already shows the title, so only the
 * actions stay visible there.
 */
export default function PageHeader({ title, description, icon, actions, children, className }: PageHeaderProps) {
  const { embedded } = useContext(PageHeaderContext);
  if (embedded) {
    return (
      <header className={clsx("space-y-3", className)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {description && <p className="max-w-[80ch] text-[13px]" style={{ color: "var(--th-text-muted)" }}>{description}</p>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </header>
    );
  }
  return (
    <header className={clsx("space-y-3", className)}>
      <div className="th-page-header">
        <div className="hidden min-w-0 items-center gap-3 md:flex">
          {icon && (
            <span
              className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border"
              style={{ borderColor: "var(--th-accent-border)", background: "var(--th-accent-dim-bg)", color: "var(--th-accent-bright)" }}
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="th-page-title truncate">{title}</h1>
            {description && <p className="th-page-description">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
