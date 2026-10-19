import {
  Activity,
  AlertTriangle,
  Archive,
  Building2,
  CalendarClock,
  Cpu,
  Gauge,
  HardDrive,
  HardDriveDownload,
  KeyRound,
  MemoryStick,
  Network,
  Power,
  RefreshCcw,
  RotateCcw,
  ServerCrash,
  ShieldAlert,
  Signal,
  WifiOff,
  Zap,
} from "lucide-react";

import type { AlertKind } from "../types/alert";

export default function AlertKindIcon({
  kind,
  fingerprint,
  className = "h-4 w-4",
}: {
  kind: AlertKind;
  fingerprint?: string | null;
  className?: string;
}) {
  if (kind === "critical_events") {
    if (fingerprint === "evt:shutdown") return <Power className={className} />;
    if (fingerprint === "evt:disk_bad" || fingerprint === "evt:disk_retry" || fingerprint === "evt:filesystem")
      return <HardDriveDownload className={className} />;
    return <ServerCrash className={className} />;
  }
  if (kind === "device_offline" || kind === "heartbeat_stale") return <WifiOff className={className} />;
  if (kind === "site_outage") return <Building2 className={className} />;
  if (kind === "high_cpu") return <Cpu className={className} />;
  if (kind === "high_ram") return <MemoryStick className={className} />;
  if (kind === "low_disk" || kind === "disk_health") return <HardDrive className={className} />;
  if (kind === "disk_forecast") return <CalendarClock className={className} />;
  if (kind === "disk_busy") return <Gauge className={className} />;
  if (kind === "high_network") return <Network className={className} />;
  if (kind === "network_latency" || kind === "packet_loss") return <Signal className={className} />;
  if (kind === "repeated_reconnects") return <Zap className={className} />;
  if (kind === "rustdesk_sync_failure") return <RefreshCcw className={className} />;
  if (kind === "service_stopped") return <Activity className={className} />;
  if (kind === "reboot_pending") return <RotateCcw className={className} />;
  if (kind === "security_posture") return <ShieldAlert className={className} />;
  if (kind === "archived_checkin") return <Archive className={className} />;
  if (kind === "token_usage_warning" || kind === "token_usage_critical") return <KeyRound className={className} />;
  return <AlertTriangle className={className} />;
}
