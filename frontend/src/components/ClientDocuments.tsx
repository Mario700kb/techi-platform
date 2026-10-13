import { CSSProperties, useRef, useState } from "react";
import {
  Bold,
  BookOpen,
  Code,
  FilePlus2,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Pencil,
  Pin,
  PinOff,
  Search,
  Table,
  Trash2,
  X,
} from "lucide-react";

import {
  ClientDocument,
  ClientDocumentInput,
  createClientDocument,
  deleteClientDocument,
  DocumentCategory,
  getClientDocument,
  getClientDocuments,
  updateClientDocument,
} from "../api/clients";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { formatDateTime, timeAgo } from "../utils/time";
import ConfirmationModal from "./ConfirmationModal";
import MarkdownView from "./MarkdownView";
import { Button, EmptyState, Select } from "./ui";

export const DOCUMENT_CATEGORIES: { value: DocumentCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "network", label: "Network" },
  { value: "procedures", label: "Procedures" },
  { value: "contacts", label: "Contacts" },
  { value: "hardware", label: "Hardware" },
  { value: "software", label: "Software" },
];
const CATEGORY_LABEL = Object.fromEntries(DOCUMENT_CATEGORIES.map((c) => [c.value, c.label])) as Record<
  DocumentCategory,
  string
>;

const EMPTY: ClientDocumentInput = { title: "", category: "general", body: "", pinned: false };

// Inserted at the cursor by the toolbar: before, after, and the text used
// when nothing is selected.
const FORMATS = [
  { label: "Heading", icon: Heading2, before: "\n## ", after: "", sample: "Heading" },
  { label: "Bold", icon: Bold, before: "**", after: "**", sample: "bold" },
  { label: "Italic", icon: Italic, before: "*", after: "*", sample: "italic" },
  { label: "Bulleted list", icon: List, before: "\n- ", after: "", sample: "Item" },
  { label: "Numbered list", icon: ListOrdered, before: "\n1. ", after: "", sample: "Step" },
  { label: "Checklist", icon: ListChecks, before: "\n- [ ] ", after: "", sample: "To do" },
  { label: "Code", icon: Code, before: "`", after: "`", sample: "code" },
  { label: "Link", icon: Link2, before: "[", after: "](https://)", sample: "text" },
  {
    label: "Table",
    icon: Table,
    before: "\n| Name | Value |\n| --- | --- |\n| ",
    after: " | |\n",
    sample: "Gateway",
  },
] as const;

/** Documentation pages kept on a client's profile. Memory-only cache: pages
 *  may describe the client's network in detail. */
export default function ClientDocuments({ clientId, canWrite }: { clientId: number; canWrite: boolean }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<(ClientDocumentInput & { id: number | null }) | null>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientDocument | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const list = useCachedQuery(`mem.client.${clientId}.docs:${search.trim()}`, () =>
    getClientDocuments(clientId, search),
  );
  const docs = list.data ?? [];
  const activeId = selectedId ?? docs[0]?.id ?? null;
  const doc = useCachedQuery(activeId != null && !draft ? `mem.client.${clientId}.doc.${activeId}` : null, () =>
    getClientDocument(clientId, activeId as number),
  );

  const startNew = () => {
    setDraft({ id: null, ...EMPTY });
    setMode("write");
    setError(null);
  };
  const startEdit = (current: ClientDocument) => {
    setDraft({
      id: current.id,
      title: current.title,
      category: current.category,
      body: current.body,
      pinned: current.pinned,
    });
    setMode("write");
    setError(null);
  };

  const format = (item: (typeof FORMATS)[number]) => {
    const area = textareaRef.current;
    if (!area || !draft) return;
    const { selectionStart: start, selectionEnd: end, value } = area;
    const chosen = value.slice(start, end) || item.sample;
    const body = value.slice(0, start) + item.before + chosen + item.after + value.slice(end);
    setDraft({ ...draft, body });
    requestAnimationFrame(() => {
      area.focus();
      const from = start + item.before.length;
      area.setSelectionRange(from, from + chosen.length);
    });
  };

  const save = async () => {
    if (!draft || !draft.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { id, ...input } = draft;
      const saved =
        id == null ? await createClientDocument(clientId, input) : await updateClientDocument(clientId, id, input);
      setDraft(null);
      setSelectedId(saved.id);
      doc.setData(saved);
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the page");
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async (current: ClientDocument) => {
    try {
      doc.setData(await updateClientDocument(clientId, current.id, { pinned: !current.pinned }));
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the page");
    }
  };

  const current = doc.data && doc.data.id === activeId ? doc.data : undefined;

  return (
    <div className="th-alerts-card">
      <div className="th-docs">
        {/* ── pages ─────────────────────────────────────────────────────── */}
        <aside className="th-docs-list" aria-label="Documentation pages">
          <div className="flex items-center gap-2 p-3" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
            <label className="th-search th-search-sm min-w-0 flex-1">
              <Search className="h-3.5 w-3.5 flex-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search pages"
                aria-label="Search documentation"
              />
              {search && (
                <button type="button" className="th-explorer-clear" onClick={() => setSearch("")} aria-label="Clear">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
            {canWrite && (
              <Button size="sm" onClick={startNew} aria-label="New page" title="New page">
                <FilePlus2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.loading ? (
              <div className="p-3" aria-busy="true">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.2 }} />
                ))}
              </div>
            ) : docs.length === 0 ? (
              <p className="px-4 py-6 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                {search ? "No pages match." : "No pages yet."}
              </p>
            ) : (
              docs.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className="th-docs-item th-share-row"
                  style={{ "--i": index } as CSSProperties}
                  aria-current={!draft && item.id === activeId}
                  onClick={() => {
                    setDraft(null);
                    setSelectedId(item.id);
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    {item.pinned && <Pin className="h-3 w-3 flex-none" style={{ color: "var(--th-accent)" }} />}
                    <span className="truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                      {item.title}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--th-text-faint)" }}>
                    <span className="th-tag" data-neutral="true">
                      {CATEGORY_LABEL[item.category] ?? item.category}
                    </span>
                    <span className="truncate" title={formatDateTime(item.updated_at)}>
                      {timeAgo(item.updated_at)}
                      {item.updated_by ? ` · ${item.updated_by}` : ""}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* ── open page / editor ───────────────────────────────────────── */}
        <section className="min-w-0 p-5" aria-live="polite">
          {error && (
            <div
              className="th-onb-note mb-4"
              style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
              role="alert"
            >
              <span className="flex-1">{error}</span>
            </div>
          )}

          {draft ? (
            <div className="th-docs-editor flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                <label className="th-onb-field">
                  Title
                  <input
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder="e.g. Network and Wi-Fi"
                    maxLength={200}
                    autoFocus
                  />
                </label>
                <div className="th-onb-field">
                  Category
                  <Select
                    id="doc-category"
                    aria-label="Category"
                    value={draft.category}
                    onChange={(value) => setDraft({ ...draft, category: value as DocumentCategory })}
                    options={DOCUMENT_CATEGORIES}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div role="radiogroup" aria-label="Editor mode" className="th-segmented">
                  {(["write", "preview"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      className="!px-3 capitalize"
                      onClick={() => setMode(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                {mode === "write" && (
                  <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Formatting">
                    {FORMATS.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="th-onb-action"
                        title={item.label}
                        aria-label={item.label}
                        onClick={() => format(item)}
                      >
                        <item.icon className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {mode === "write" ? (
                <label className="th-onb-field">
                  <span className="sr-only">Content</span>
                  <textarea
                    ref={textareaRef}
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    placeholder={"## Network\n\n| Device | Address |\n| --- | --- |\n| Gateway | 10.0.0.1 |"}
                    aria-label="Content"
                  />
                </label>
              ) : (
                <div className="min-h-[360px] rounded-lg p-4" style={{ border: "1px solid var(--th-border-subtle)" }}>
                  {draft.body.trim() ? (
                    <MarkdownView source={draft.body} />
                  ) : (
                    <p style={{ color: "var(--th-text-faint)" }}>Nothing to preview yet.</p>
                  )}
                </div>
              )}
              <p className="th-onb-hint">
                Markdown: # headings, **bold**, lists, - [ ] checklists, | tables |, `code`. Keep passwords in the
                Credential Vault and refer to them by name.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
                  <input
                    type="checkbox"
                    role="switch"
                    className="th-switch"
                    checked={draft.pinned}
                    onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })}
                  />
                  Pin to the top
                </label>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button onClick={() => void save()} disabled={saving || !draft.title.trim()}>
                    {saving ? "Saving…" : draft.id == null ? "Create page" : "Save page"}
                  </Button>
                </div>
              </div>
            </div>
          ) : activeId == null ? (
            <EmptyState
              className="py-16"
              icon={<BookOpen className="h-5 w-5" />}
              title="No documentation yet"
              description="Network layout, procedures, contacts and anything the next technician should know."
              action={
                canWrite ? (
                  <Button size="sm" onClick={startNew}>
                    <FilePlus2 className="h-3.5 w-3.5" />
                    New page
                  </Button>
                ) : undefined
              }
            />
          ) : !current ? (
            <div aria-busy="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
              ))}
            </div>
          ) : (
            <article className="th-fade-in">
              <header
                className="mb-5 flex flex-wrap items-start justify-between gap-3 pb-4"
                style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
              >
                <div className="min-w-0">
                  <h2 className="text-[20px] font-semibold leading-7" style={{ color: "var(--th-text-primary)" }}>
                    {current.title}
                  </h2>
                  <p
                    className="mt-1 flex flex-wrap items-center gap-2 text-[12px]"
                    style={{ color: "var(--th-text-muted)" }}
                  >
                    <span className="th-tag" data-neutral="true">
                      {CATEGORY_LABEL[current.category] ?? current.category}
                    </span>
                    <span title={formatDateTime(current.updated_at)}>
                      Edited {timeAgo(current.updated_at)}
                      {current.updated_by ? ` by ${current.updated_by}` : ""}
                    </span>
                    {current.created_by && current.created_by !== current.updated_by && (
                      <span>· created by {current.created_by}</span>
                    )}
                  </p>
                </div>
                {canWrite && (
                  <div className="th-onb-actions">
                    <button
                      type="button"
                      className="th-onb-action"
                      onClick={() => void togglePin(current)}
                      title={current.pinned ? "Unpin" : "Pin to the top"}
                      aria-label={current.pinned ? "Unpin" : "Pin to the top"}
                    >
                      {current.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      className="th-onb-action"
                      onClick={() => startEdit(current)}
                      title="Edit"
                      aria-label="Edit page"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="th-onb-action"
                      data-tone="danger"
                      onClick={() => setConfirmDelete(current)}
                      title="Delete"
                      aria-label="Delete page"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </header>
              {current.body.trim() ? (
                <MarkdownView source={current.body} />
              ) : (
                <p style={{ color: "var(--th-text-faint)" }}>This page is empty.</p>
              )}
            </article>
          )}
        </section>
      </div>

      {confirmDelete && (
        <ConfirmationModal
          title="Delete page"
          confirmLabel="Delete page"
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => {
            try {
              await deleteClientDocument(clientId, confirmDelete.id);
              setSelectedId(null);
              await list.reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't delete the page");
            }
            setConfirmDelete(null);
          }}
        >
          Delete <strong style={{ color: "var(--th-text-primary)" }}>{confirmDelete.title}</strong>? This cannot be
          undone.
        </ConfirmationModal>
      )}
    </div>
  );
}
