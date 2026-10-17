import { useMemo, useRef, useState, type FormEvent } from "react";
import { FileCode2, Plus, Search, Trash2 } from "lucide-react";
import {
  createConsoleScript,
  deleteConsoleScript,
  updateConsoleScript,
  type ConsoleScript,
  type ConsoleScriptBody,
} from "../../api/terminal";
import { ApiError } from "../../api/client";
import { formatLocalDateTime } from "../../utils/time";
import ConfirmationModal from "../ConfirmationModal";
import { Button, Modal } from "../ui";

function saveError(err: unknown, name: string): string {
  if (err instanceof ApiError && err.status === 409) return `A script named “${name}” already exists.`;
  return err instanceof Error && err.message ? err.message : "Couldn't save the script.";
}

/** A mono textarea with a line-number gutter that scrolls with it. */
function CodeEditor({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const gutter = useRef<HTMLDivElement | null>(null);
  const lines = Math.max(1, value.split("\n").length);
  return (
    <div className="ps-editor">
      <div ref={gutter} className="ps-editor-gutter" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        id={id}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the editor (Esc then Tab still leaves).
          if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: a, selectionEnd: b } = el;
          const next = `${value.slice(0, a)}    ${value.slice(b)}`;
          onChange(next);
          requestAnimationFrame(() => (el.selectionStart = el.selectionEnd = a + 4));
        }}
        className="ps-editor-text"
      />
    </div>
  );
}

type Draft = ConsoleScriptBody & { id: number | null };

const BLANK: Draft = { id: null, name: "", description: "", body: "" };

/**
 * Library of saved PowerShell scripts (admins): search, create, edit,
 * delete. Every change is versioned and attributed by the platform.
 */
export default function ScriptLibrary({
  scripts,
  onSaved,
  onDeleted,
  onClose,
}: {
  scripts: ConsoleScript[];
  onSaved: (script: ConsoleScript) => void;
  onDeleted: (id: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const byName = (list: ConsoleScript[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  // Start on the first script in the list, as the list shows it.
  const [draft, setDraft] = useState<Draft>(() => {
    const first = byName(scripts)[0];
    return first ? { ...first, description: first.description ?? "" } : BLANK;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = byName(scripts);
    return q ? sorted.filter((s) => `${s.name} ${s.description ?? ""} ${s.body}`.toLowerCase().includes(q)) : sorted;
  }, [scripts, query]);

  const current = draft.id != null ? scripts.find((s) => s.id === draft.id) : undefined;
  const dirty = current
    ? current.name !== draft.name ||
      (current.description ?? "") !== (draft.description ?? "") ||
      current.body !== draft.body
    : Boolean(draft.name || draft.body || draft.description);
  const valid = draft.name.trim().length > 0 && draft.body.trim().length > 0;

  const select = (s: ConsoleScript | null) => {
    setError(null);
    setDraft(s ? { ...s, description: s.description ?? "" } : BLANK);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    const body: ConsoleScriptBody = {
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      body: draft.body,
    };
    setBusy(true);
    setError(null);
    try {
      const saved = draft.id != null ? await updateConsoleScript(draft.id, body) : await createConsoleScript(body);
      onSaved(saved);
      setDraft({ ...saved, description: saved.description ?? "" });
    } catch (err) {
      setError(saveError(err, body.name));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (draft.id == null) return;
    setBusy(true);
    setError(null);
    try {
      await deleteConsoleScript(draft.id);
      onDeleted(draft.id);
      setConfirmDelete(false);
      const rest = byName(scripts.filter((s) => s.id !== draft.id));
      select(rest[0] ?? null);
    } catch (err) {
      setConfirmDelete(false);
      setError(err instanceof Error && err.message ? err.message : "Couldn't delete the script.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Script library"
      subtitle="Saved PowerShell scripts · run as SYSTEM from an open console"
      icon={FileCode2}
      size="xl"
      flush
      // While the delete question is up, Escape and the scrim belong to it.
      busy={busy || confirmDelete}
      onClose={onClose}
    >
      <div className="ps-library">
        <div className="ps-library-list">
          <div className="flex items-center gap-2 p-3">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search scripts</span>
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                style={{ color: "var(--th-text-muted)" }}
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="th-input h-8 w-full rounded-md border pl-8 pr-2 text-[13px]"
              />
            </label>
            <Button size="sm" variant="secondary" className="!min-h-8 flex-none" onClick={() => select(null)}>
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          </div>
          {filtered.length === 0 ? (
            <p className="ps-empty px-3">{scripts.length ? "No script matches." : "No saved scripts yet."}</p>
          ) : (
            <ul aria-label="Library scripts" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="ps-library-item"
                    aria-current={draft.id === s.id ? "true" : undefined}
                    onClick={() => select(s)}
                  >
                    <span className="ps-script-name">{s.name}</span>
                    <span className="ps-script-desc">
                      v{s.version} · {s.uses} {s.uses === 1 ? "use" : "uses"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form className="ps-library-form" onSubmit={(e) => void save(e)} aria-label="Script details">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="premium-kicker mb-1 block">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={120}
                className="th-input h-9 w-full rounded-md border px-2.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="premium-kicker mb-1 block">Description</span>
              <input
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                maxLength={240}
                placeholder="One line: what it does"
                className="th-input h-9 w-full rounded-md border px-2.5 text-[13px]"
              />
            </label>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <label htmlFor="ps-script-body" className="premium-kicker mb-1 block">
              Script
            </label>
            <CodeEditor id="ps-script-body" value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
          </div>
          {current && (
            <p
              className="text-[12px] tabular-nums"
              style={{ color: "var(--th-text-muted)" }}
              data-testid="ps-script-meta"
            >
              v{current.version} · {current.uses} {current.uses === 1 ? "use" : "uses"} · last used{" "}
              {current.last_used_at ? formatLocalDateTime(current.last_used_at) : "never"} · updated{" "}
              {formatLocalDateTime(current.updated_at)} by {current.updated_by ?? "unknown"}
            </p>
          )}
          {error && (
            <p role="alert" className="th-drawer-callout text-[13px]" data-tone="critical">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            {current && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                style={{ color: "var(--th-status-critical)" }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={busy}>
                Close
              </Button>
              <Button type="submit" size="sm" disabled={busy || !valid || !dirty}>
                {busy ? "Saving…" : current ? "Save new version" : "Create script"}
              </Button>
            </div>
          </div>
        </form>
      </div>
      {confirmDelete && current && (
        <ConfirmationModal
          title="Delete script?"
          confirmLabel="Delete"
          loading={busy}
          onConfirm={() => void remove()}
          onClose={() => setConfirmDelete(false)}
        >
          “{current.name}” is removed from the library. Past runs stay in the audit log and recordings.
        </ConfirmationModal>
      )}
    </Modal>
  );
}
