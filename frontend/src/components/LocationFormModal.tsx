import { CSSProperties, useState } from "react";
import { MapPin, Plus, X } from "lucide-react";

import {
  ClientLocation,
  countryName,
  createClientLocation,
  LOCATION_KINDS,
  LocationInput,
  LocationKind,
  updateClientLocation,
} from "../api/clients";
import { Button, Modal, Select } from "./ui";

// Countries the console's clients are in, nearest first. A site saved with
// another code keeps it: the picker adds that code instead of showing Albania.
const COUNTRIES = [
  "AL",
  "XK",
  "MK",
  "ME",
  "RS",
  "GR",
  "IT",
  "DE",
  "AT",
  "CH",
  "FR",
  "GB",
  "NL",
  "BE",
  "ES",
  "HR",
  "SI",
  "BA",
  "BG",
  "RO",
  "TR",
  "FI",
  "IE",
  "SE",
  "PL",
  "CZ",
  "HU",
  "US",
  "AE",
];

const CITIES = [
  "Tiranë",
  "Durrës",
  "Vlorë",
  "Shkodër",
  "Elbasan",
  "Korçë",
  "Fier",
  "Berat",
  "Lushnjë",
  "Kavajë",
  "Pogradec",
  "Gjirokastër",
  "Sarandë",
  "Lezhë",
  "Kukës",
  "Kamëz",
  "Vorë",
  "Prishtinë",
  "Prizren",
  "Pejë",
  "Gjakovë",
  "Ferizaj",
  "Mitrovicë",
  "Shkup",
  "Tetovë",
  "Podgoricë",
  "Ulqin",
];

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;

export interface RuleDraft {
  public_ip: string;
  lan_cidr: string;
}

export interface Draft {
  id?: number;
  name: string;
  kind: LocationKind;
  country: string;
  city: string;
  address: string;
  contact: string;
  notes: string;
  rules: RuleDraft[];
}

export const emptyDraft = (rules: RuleDraft[] = []): Draft => ({
  name: "",
  kind: "office",
  country: "AL",
  city: "",
  address: "",
  contact: "",
  notes: "",
  rules,
});

export const draftOf = (location: ClientLocation): Draft => ({
  id: location.id,
  name: location.name,
  kind: location.kind,
  country: location.country,
  city: location.city,
  address: location.address ?? "",
  contact: location.contact ?? "",
  notes: location.notes ?? "",
  rules: location.rules.map((r) => ({ public_ip: r.public_ip ?? "", lan_cidr: r.lan_cidr ?? "" })),
});

/** What is wrong with the draft, or null. Mirrors the API so most mistakes never leave the form. */
function problem(draft: Draft): string | null {
  if (!draft.name.trim()) return "Give the location a name, e.g. “Tiranë – Zyra qendrore”.";
  if (!/^[A-Za-z]{2}$/.test(draft.country.trim())) return "Choose the country.";
  if (!draft.city.trim()) return "Enter the city.";
  for (const rule of draft.rules) {
    const ip = rule.public_ip.trim();
    const lan = rule.lan_cidr.trim();
    if (!ip && !lan) return "Each rule needs a public IP, a LAN network, or both — or remove it.";
    if (ip && !IPV4.test(ip)) return `“${ip}” is not an IPv4 address.`;
    if (lan && !CIDR.test(lan)) return `“${lan}” is not a network. Write it like 10.130.50.0/24.`;
  }
  return null;
}

/**
 * Create or edit one of a client's locations: name, type, country, city,
 * address, contact, notes and the rules that place devices there. Used by
 * the client's Locations tab and by a device's location picker.
 */
export default function LocationFormModal({
  clientId,
  initial,
  knownCities = [],
  onClose,
  onSaved,
}: {
  clientId: number;
  initial: Draft;
  /** The client's own cities, offered first. */
  knownCities?: string[];
  onClose: () => void;
  onSaved: (location: ClientLocation) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const cityOptions = [...new Set([...knownCities, ...CITIES])];

  const save = async () => {
    const issue = problem(draft);
    if (issue) {
      setFormError(issue);
      return;
    }
    const input: LocationInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      country: draft.country.trim().toUpperCase(),
      city: draft.city.trim(),
      address: draft.address.trim() || null,
      contact: draft.contact.trim() || null,
      notes: draft.notes.trim() || null,
      rules: draft.rules.map((r) => ({
        public_ip: r.public_ip.trim() || null,
        lan_cidr: r.lan_cidr.trim() || null,
      })),
    };
    setSaving(true);
    setFormError(null);
    try {
      const saved = draft.id
        ? await updateClientLocation(clientId, draft.id, input)
        : await createClientLocation(clientId, input);
      onSaved(saved);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn't save the location");
    } finally {
      setSaving(false);
    }
  };

  const setRule = (index: number, patch: Partial<RuleDraft>) =>
    setDraft({ ...draft, rules: draft.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  return (
    <Modal
      title={draft.id ? "Edit location" : "New location"}
      subtitle="A site of this client. Its rules place the devices at it."
      icon={MapPin}
      size="lg"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : draft.id ? "Save changes" : "Create location"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
          <label className="th-onb-field">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Tiranë – Zyra qendrore"
              maxLength={120}
              autoFocus
            />
          </label>
          <div className="th-onb-field">
            Type
            <Select
              id="location-kind"
              aria-label="Type"
              value={draft.kind}
              onChange={(value) => setDraft({ ...draft, kind: value as LocationKind })}
              options={LOCATION_KINDS}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="th-onb-field">
            Country
            <Select
              id="location-country"
              aria-label="Country"
              value={draft.country}
              onChange={(value) => setDraft({ ...draft, country: value })}
              options={(COUNTRIES.includes(draft.country) ? COUNTRIES : [draft.country, ...COUNTRIES]).map((code) => ({
                value: code,
                label: `${code} · ${countryName(code)}`,
              }))}
            />
          </div>
          <label className="th-onb-field">
            City
            <input
              value={draft.city}
              onChange={(e) => setDraft({ ...draft, city: e.target.value })}
              placeholder="e.g. Tiranë"
              maxLength={80}
              list="location-cities"
            />
            <datalist id="location-cities">
              {cityOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
        </div>
        <label className="th-onb-field">
          Address <span style={{ color: "var(--th-text-faint)", fontWeight: 400 }}>· optional</span>
          <input
            value={draft.address}
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            placeholder="Street, building, floor"
            maxLength={200}
          />
        </label>
        <label className="th-onb-field">
          Local contact <span style={{ color: "var(--th-text-faint)", fontWeight: 400 }}>· optional</span>
          <input
            value={draft.contact}
            onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
            placeholder="Name · phone · email"
            maxLength={200}
          />
        </label>

        <div className="th-onb-field">
          <span className="flex items-center justify-between gap-2">
            Rules
            <button
              type="button"
              className="th-link-btn"
              onClick={() => setDraft({ ...draft, rules: [...draft.rules, { public_ip: "", lan_cidr: "" }] })}
            >
              <Plus className="h-3.5 w-3.5" />
              Add rule
            </button>
          </span>
          {draft.rules.length === 0 ? (
            <p className="th-onb-hint">
              No rules: only devices you place here by hand. Add the site&apos;s public IP so its devices come here on
              their own.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {draft.rules.map((rule, index) => (
                <li key={index} className="th-loc-rule-row">
                  <input
                    value={rule.public_ip}
                    onChange={(e) => setRule(index, { public_ip: e.target.value })}
                    placeholder="Public IP, e.g. 80.90.87.187"
                    aria-label={`Rule ${index + 1} public IP`}
                    className="font-mono"
                  />
                  <input
                    value={rule.lan_cidr}
                    onChange={(e) => setRule(index, { lan_cidr: e.target.value })}
                    placeholder="LAN, e.g. 10.130.50.0/24"
                    aria-label={`Rule ${index + 1} LAN network`}
                    className="font-mono"
                  />
                  <button
                    type="button"
                    className="th-onb-action"
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="th-onb-hint">
            A device matches a rule by its public IP, its LAN network, or both. The most specific rule wins: IP and
            network, then network, then IP — so a branch behind the head office&apos;s line is told apart by its
            network. Devices you place by hand stay where you put them.
          </p>
        </div>

        <label className="th-onb-field">
          Notes <span style={{ color: "var(--th-text-faint)", fontWeight: 400 }}>· optional</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            placeholder="Opening hours, access, ISP, where the rack is…"
            maxLength={4000}
            rows={3}
            className="!min-h-[84px]"
          />
        </label>

        {formError && (
          <div
            className="th-onb-note th-onb-reveal"
            style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
            role="alert"
          >
            <span className="flex-1">{formError}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
