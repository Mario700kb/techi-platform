import { useCallback, useState } from "react";

const STORAGE_KEY = "techi.favorites";

function loadFavorites(): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}

function persist(set: Set<number>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<number>>(loadFavorites);

  const toggle = useCallback((deviceId: number) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      persist(next);
      return next;
    });
  }, []);

  const isFavorite = useCallback(
    (deviceId: number) => favorites.has(deviceId),
    [favorites]
  );

  return { favorites, toggle, isFavorite };
}
