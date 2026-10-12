import { Compass, Home, ShieldOff } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button, EmptyState } from "../components/ui";

function HomeButton() {
  const navigate = useNavigate();
  return (
    <Button size="sm" onClick={() => navigate("/", { replace: true })}>
      <Home className="h-4 w-4" aria-hidden /> Go to Dashboard
    </Button>
  );
}

/** Unknown URL — an old bookmark, a removed page or a typo. */
export function NotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <EmptyState
        icon={<Compass className="h-5 w-5" aria-hidden />}
        title="Page not found"
        description="This page does not exist or has been removed. Check the address, or continue from the Dashboard."
        action={<HomeButton />}
      />
    </div>
  );
}

/** Signed in, but the operator's role and teams do not grant this page. */
export function AccessDenied() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <EmptyState
        icon={<ShieldOff className="h-5 w-5" aria-hidden />}
        title="You do not have access to this page"
        description="Your role or team does not include this permission. Ask an administrator if you need it."
        action={<HomeButton />}
      />
    </div>
  );
}
