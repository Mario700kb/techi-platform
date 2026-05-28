/**
 * Centralized label mapping for TECHI Remote Support branding.
 * Maps internal action/event type keys to user-facing display strings.
 * Internal TypeScript identifiers, API field names, and DB keys are NOT changed here.
 */

export const REMOTE_SUPPORT_ACTION_LABELS: Record<string, string> = {
  sync_rustdesk:       "Sync TECHI Remote Support",
  restart_rustdesk:    "Restart TECHI Remote Support",
  reinstall_rustdesk:  "Reinstall TECHI Remote Support",
  reopen_rustdesk:     "Reopen TECHI Remote Support",
};

export const REMOTE_SUPPORT_EVENT_SUMMARIES: Record<string, string> = {
  rustdesk_updated:  "TECHI Remote Support metadata updated",
  rustdesk_repaired: "TECHI Remote Support self-healed",
};

export const REMOTE_SUPPORT_FIELD_LABELS: Record<string, string> = {
  rustdesk_id:             "TECHI Remote ID",
  rustdesk_status:         "TECHI Remote Support Status",
  rustdesk_version:        "TECHI Remote Support Version",
  rustdesk_install_status: "Install Status",
  rustdesk_sync_state:     "Sync State",
};
