import "@testing-library/jest-dom/vitest";

// Node 22+'s experimental global `localStorage` shadows jsdom's own
// window.localStorage/sessionStorage in some vitest+jsdom+Node combinations,
// leaving `window.localStorage` undefined. Polyfill defensively so
// api/client.ts and store/sessionStore.ts (which read it at module load
// time) never see `undefined`.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function ensureStorage(prop: "localStorage" | "sessionStorage"): void {
  try {
    if (window[prop] && typeof window[prop].getItem === "function") return;
  } catch {
    // fall through to polyfill
  }
  Object.defineProperty(window, prop, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");
