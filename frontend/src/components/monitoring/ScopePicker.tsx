import { Select } from "../ui";
import type { SelectOption } from "../ui";
import type { PolicyScope } from "../../api/monitoring";
import { DEVICE_TYPES, SCOPE_LABEL, ScopeNames } from "./policyForm";

const SCOPE_HINT: Record<PolicyScope, string> = {
  default: "The base for every device",
  device_type: "Servers or client PCs",
  client: "Every device of one client",
  group: "One group of devices",
};

/** What a policy applies to: the scope, then which device type, client or group. */
export default function ScopePicker({
  scope,
  value,
  names,
  onChange,
  disabled = false,
  invalid = false,
}: {
  scope: PolicyScope;
  value: string;
  names: ScopeNames;
  onChange: (scope: PolicyScope, value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  // There is exactly one default policy: it keeps its scope and no other policy can take it.
  if (scope === "default") {
    return (
      <div className="th-onb-field">
        <span>Applies to</span>
        <div
          className="flex h-9 items-center rounded-lg border px-3 text-[13px]"
          style={{
            borderColor: "var(--th-border-subtle)",
            background: "var(--th-bg-surface)",
            color: "var(--th-text-secondary)",
          }}
        >
          Every device · the default policy
        </div>
      </div>
    );
  }

  const scopes: SelectOption<PolicyScope>[] = (["device_type", "client", "group"] as const).map((s) => ({
    value: s,
    label: SCOPE_LABEL[s],
    hint: SCOPE_HINT[s],
  }));

  const clientName = (id: number) => names.clients.find((c) => c.id === id)?.name ?? `Client #${id}`;
  let values: SelectOption[] = [];
  if (scope === "device_type") values = DEVICE_TYPES.map((t) => ({ value: t.value, label: t.label }));
  if (scope === "client")
    values = [...names.clients]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: String(c.id), label: c.name }));
  if (scope === "group")
    values = [...names.groups]
      .map((g) => ({ value: String(g.id), label: `${clientName(g.client_id)} › ${g.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  // Keep a value the lists do not know (a client the operator cannot see) visible.
  if (value && !values.some((v) => v.value === value)) values = [{ value, label: `#${value}` }, ...values];

  const valueLabel = scope === "device_type" ? "Device type" : scope === "client" ? "Client" : "Group";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="th-onb-field">
        <span>Applies to</span>
        <Select
          value={scope}
          options={scopes}
          disabled={disabled}
          aria-label="Applies to"
          className="w-full"
          onChange={(next) => onChange(next, "")}
        />
      </div>
      <div className="th-onb-field">
        <span>{valueLabel}</span>
        <Select
          value={value}
          options={values}
          disabled={disabled}
          placeholder={values.length ? `Choose a ${valueLabel.toLowerCase()}` : `No ${valueLabel.toLowerCase()}s`}
          aria-label={valueLabel}
          className="w-full"
          style={
            invalid ? { borderColor: "color-mix(in srgb, var(--th-status-critical) 60%, transparent)" } : undefined
          }
          onChange={(next) => onChange(scope, next)}
        />
      </div>
    </div>
  );
}
