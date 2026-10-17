import {
  AlertTriangle,
  CalendarClock,
  Cpu,
  HardDrive,
  KeyRound,
  MemoryStick,
  Network,
  RefreshCcw,
  WifiOff,
  Zap,
} from "lucide-react";

import type { AlertKind } from "../types/alert";

export default function AlertKindIcon({ kind, className = "h-4 w-4" }: { kind: AlertKind; className?: string }) {
  if (kind === "device_offline" || kind === "heartbeat_stale") return <WifiOff className={className} />;
  if (kind === "high_cpu") return <Cpu className={className} />;
  if (kind === "high_ram") return <MemoryStick className={className} />;
  if (kind === "low_disk") return <HardDrive className={className} />;
  if (kind === "disk_forecast") return <CalendarClock className={className} />;
  if (kind === "high_network") return <Network className={className} />;
  if (kind === "repeated_reconnects") return <Zap className={className} />;
  if (kind === "rustdesk_sync_failure") return <RefreshCcw className={className} />;
  if (kind === "token_usage_warning" || kind === "token_usage_critical") return <KeyRound className={className} />;
  return <AlertTriangle className={className} />;
}
