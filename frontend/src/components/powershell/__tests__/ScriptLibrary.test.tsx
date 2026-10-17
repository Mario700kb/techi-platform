import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ScriptLibrary from "../ScriptLibrary";
import { ApiError } from "../../../api/client";
import type { ConsoleScript } from "../../../api/terminal";

const createScript = vi.fn();
const updateScript = vi.fn();
const deleteScript = vi.fn();

vi.mock("../../../api/terminal", async (importActual) => ({
  ...(await importActual<typeof import("../../../api/terminal")>()),
  createConsoleScript: (...a: unknown[]) => createScript(...a),
  updateConsoleScript: (...a: unknown[]) => updateScript(...a),
  deleteConsoleScript: (...a: unknown[]) => deleteScript(...a),
}));

const FLUSH: ConsoleScript = {
  id: 2,
  name: "Flush DNS",
  description: "Clears the resolver cache",
  body: "Clear-DnsClientCache",
  version: 3,
  uses: 30,
  last_used_at: "2026-10-17T09:00:00Z",
  updated_by: "ana.owner",
  updated_at: "2026-10-16T09:00:00Z",
};
const SPOOLER: ConsoleScript = {
  ...FLUSH,
  id: 4,
  name: "Restart spooler",
  description: null,
  body: "Restart-Service spooler",
  uses: 1,
};

function renderLibrary(scripts = [FLUSH, SPOOLER]) {
  const props = { onSaved: vi.fn(), onDeleted: vi.fn(), onClose: vi.fn() };
  render(<ScriptLibrary scripts={scripts} {...props} />);
  return { ...props, dialog: screen.getByRole("dialog", { name: "Script library" }) };
}

describe("ScriptLibrary", () => {
  beforeEach(() => {
    createScript.mockReset();
    updateScript.mockReset();
    deleteScript.mockReset();
  });

  it("lists, searches and shows a script's version, uses and author", () => {
    const { dialog } = renderLibrary();
    const list = within(dialog).getByRole("list", { name: "Library scripts" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.querySelector(".ps-script-name")?.textContent),
    ).toEqual(["Flush DNS", "Restart spooler"]);
    expect(within(dialog).getByTestId("ps-script-meta")).toHaveTextContent(/v3 · 30 uses · last used .* by ana\.owner/);
    fireEvent.change(within(dialog).getByLabelText("Search scripts"), { target: { value: "spooler" } });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText("Search scripts"), { target: { value: "zzz" } });
    expect(within(dialog).getByText("No script matches.")).toBeInTheDocument();
  });

  it("creates a script", async () => {
    const created = {
      ...FLUSH,
      id: 9,
      name: "Uptime",
      description: null,
      body: "(Get-Date) - (gcim Win32_OperatingSystem).LastBootUpTime",
      version: 1,
      uses: 0,
    };
    createScript.mockResolvedValue(created);
    const { dialog, onSaved } = renderLibrary();
    fireEvent.click(within(dialog).getByRole("button", { name: /New/ }));
    const save = within(dialog).getByRole("button", { name: "Create script" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " Uptime " } });
    fireEvent.change(within(dialog).getByLabelText("Script"), { target: { value: created.body } });
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    expect(createScript).toHaveBeenCalledWith({ name: "Uptime", description: null, body: created.body });
  });

  it("saves a new version of an existing script", async () => {
    updateScript.mockResolvedValue({ ...FLUSH, body: "Clear-DnsClientCache -Verbose", version: 4 });
    const { dialog, onSaved } = renderLibrary();
    const save = within(dialog).getByRole("button", { name: "Save new version" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Script"), { target: { value: "Clear-DnsClientCache -Verbose" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateScript).toHaveBeenCalledWith(2, {
      name: "Flush DNS",
      description: "Clears the resolver cache",
      body: "Clear-DnsClientCache -Verbose",
    });
  });

  it("says when the name is taken (409)", async () => {
    createScript.mockRejectedValue(new ApiError("Conflict", 409));
    const { dialog, onSaved } = renderLibrary();
    fireEvent.click(within(dialog).getByRole("button", { name: /New/ }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Flush DNS" } });
    fireEvent.change(within(dialog).getByLabelText("Script"), { target: { value: "ipconfig /flushdns" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create script" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A script named “Flush DNS” already exists.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("deletes only after confirmation", async () => {
    deleteScript.mockResolvedValue(undefined);
    const { dialog, onDeleted } = renderLibrary();
    fireEvent.click(within(dialog).getByRole("button", { name: /Delete/ }));
    const confirm = await screen.findByRole("dialog", { name: "Delete script?" });
    expect(deleteScript).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(2));
    expect(deleteScript).toHaveBeenCalledWith(2);
    expect(screen.queryByRole("dialog", { name: "Delete script?" })).toBeNull();
  });
});
