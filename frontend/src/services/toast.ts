import { useSyncExternalStore } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  tone?: ToastTone;
  /** One follow-up, e.g. Undo or Open; choosing it closes the toast. */
  action?: ToastAction;
  /** How long it stays; errors stay longer so they can be read. */
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  durationMs: number;
}

const DEFAULT_MS: Record<ToastTone, number> = { success: 4000, info: 4500, error: 7000 };
/** More than this on screen and the oldest goes first. */
const MAX_VISIBLE = 4;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: ToastItem[]): void {
  items = next;
  listeners.forEach((listener) => listener());
}

/**
 * Tells the operator what just happened: a short message in one place for the
 * whole console (components/Toaster.tsx), stacked, read by screen readers,
 * paused while the pointer or focus is on it. Returns its id.
 */
export function toast(message: string, options: ToastOptions = {}): number {
  const tone = options.tone ?? "success";
  const item: ToastItem = {
    id: nextId++,
    message,
    tone,
    action: options.action,
    durationMs: options.durationMs ?? DEFAULT_MS[tone],
  };
  // The same message again replaces the earlier one instead of stacking.
  emit([...items.filter((t) => t.message !== message), item].slice(-MAX_VISIBLE));
  return item.id;
}

toast.error = (message: string, options: Omit<ToastOptions, "tone"> = {}) =>
  toast(message, { ...options, tone: "error" });
toast.info = (message: string, options: Omit<ToastOptions, "tone"> = {}) =>
  toast(message, { ...options, tone: "info" });

export function dismissToast(id: number): void {
  if (items.some((t) => t.id === id)) emit(items.filter((t) => t.id !== id));
}

export function clearToasts(): void {
  emit([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
}
