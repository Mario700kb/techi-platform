# TECHI Platform Changes and Solutions

Use this file as a running record of user-facing fixes, their root causes, and
the checks used to verify them. Add new entries at the top.

## 2026-06-12 - Devices stat cards stay loading after a hard refresh

### Symptom

After an F5 reload on the Devices page, the paginated table loaded but the
Total, Online, Stale, Offline, Critical, and Warnings cards could remain in
their loading state until the user clicked Refresh.

### Investigation

- `loadTableData()` and `loadSnapshot()` own separate state. The table loader
  does not overwrite snapshot stats, health, patches, or snapshot loading.
- `loadSnapshot()` already handled an empty in-memory cache correctly: a cache
  miss continues to `getDevicesSummary()`.
- The mount effect did call `loadSnapshot()`, but it used an empty dependency
  list even though it referenced the callback.
- The application runs under `React.StrictMode`, which replays mount effects in
  development. The initial snapshot request had no idempotency guard.

### Fix

The initial snapshot effect now:

- declares `loadSnapshot` as a dependency;
- uses `initialSnapshotLoadStartedRef` to start the mount request once per
  component instance;
- remains independent from the paginated table effect.

```tsx
const initialSnapshotLoadStartedRef = useRef(false);

useEffect(() => {
  if (initialSnapshotLoadStartedRef.current) return;
  initialSnapshotLoadStartedRef.current = true;
  void loadSnapshot();
}, [loadSnapshot]);
```

### Expected flow

1. The Devices page mounts.
2. `loadSnapshot()` starts the summary request for cards, health, patches, and
   tree counts.
3. `loadTableData()` independently starts the paginated devices request.
4. Each request updates only its own loading and data state.

### Verification

- Run `npm run build` from `frontend`.
- Hard-refresh `/devices` with the browser network panel open.
- Confirm one initial `/api/v1/devices/summary` request and one paginated
  `/api/v1/devices/` request.
- Confirm the stat cards populate without clicking Refresh.
