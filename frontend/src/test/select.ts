import { fireEvent, screen, waitFor, within } from "@testing-library/react";

type Name = string | RegExp;

/** Opens the themed Select named `name` and returns its listbox. */
export async function openSelect(name: Name): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("combobox", { name }));
  return screen.findByRole("listbox");
}

/** Chooses an option by its value, the way a user would (open, then click). */
export async function chooseOption(name: Name, value: string): Promise<void> {
  const listbox = await openSelect(name);
  const option = await waitFor(() => {
    const el = listbox.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
    if (!el) throw new Error(`No option with value "${value}" in "${String(name)}"`);
    return el;
  });
  fireEvent.click(option);
}

/** Waits until the Select named `name` offers an option with this label, then closes it. */
export async function findOption(name: Name, label: Name): Promise<HTMLElement> {
  const listbox = await openSelect(name);
  const option = await within(listbox).findByRole("option", { name: label });
  fireEvent.keyDown(listbox, { key: "Escape" });
  return option;
}
