import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { OpenKotoClient, SyncEngine, type LocalChange, type SyncReport } from "@openkoto/client";
import type { JsonObject, RecordType } from "@openkoto/core";
import { IndexedDbStore } from "./store";
import { useSession } from "./session";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 3000;

export type SyncState =
  | { status: "idle"; lastSync: Date | null; report?: SyncReport }
  | { status: "syncing"; lastSync: Date | null }
  | { status: "error"; lastSync: Date | null; message: string };

interface LibraryContextValue {
  store: IndexedDbStore;
  engine: SyncEngine;
  sync: SyncState;
  syncNow: () => Promise<void>;
  write: (type: RecordType, id: string, change: LocalChange) => Promise<void>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const userId = account?.user.id ?? null;
  const [sync, setSync] = useState<SyncState>({ status: "idle", lastSync: null });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setup = useMemo(() => {
    if (!userId) return null;
    const store = new IndexedDbStore(userId);
    const client = new OpenKotoClient({ baseUrl: window.location.origin, clientName: "web/0.1.0", credentials: "include" });
    const engine = new SyncEngine({ transport: client.sync, store });
    return { store, engine };
  }, [userId]);

  const syncNow = useCallback(async () => {
    if (!setup) return;
    setSync((s) => ({ status: "syncing", lastSync: s.lastSync }));
    try {
      const report = await setup.engine.sync();
      setSync({ status: "idle", lastSync: new Date(), report });
    } catch (err) {
      setSync((s) => ({ status: "error", lastSync: s.lastSync, message: err instanceof Error ? err.message : String(err) }));
    }
  }, [setup]);

  useEffect(() => {
    if (!setup) return;
    void syncNow();
    const timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      setup.store.db.close();
    };
  }, [setup, syncNow]);

  const write = useCallback(
    async (type: RecordType, id: string, change: LocalChange) => {
      if (!setup) throw new Error("not signed in");
      await setup.engine.recordLocalChange(type, id, change);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void syncNow(), WRITE_DEBOUNCE_MS);
    },
    [setup, syncNow],
  );

  const value = useMemo(() => (setup ? { ...setup, sync, syncNow, write } : null), [setup, sync, syncNow, write]);
  if (!value) return <>{children}</>;
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary must be used by a signed-in page");
  return ctx;
}

export function useOptionalLibrary(): LibraryContextValue | null {
  return useContext(LibraryContext);
}

export interface Row<T> {
  id: string;
  payload: T;
}

/** Live list of a record type's payloads; re-renders when IndexedDB changes. */
export function useRecords<T = JsonObject>(type: RecordType): Row<T>[] | undefined {
  const { store } = useLibrary();
  return useLiveQuery(async () => (await store.live(type)).map((r) => ({ id: r.id, payload: r.payload as T })), [store, type]);
}

export function useRecord<T = JsonObject>(type: RecordType, id: string | undefined): Row<T> | null | undefined {
  const { store } = useLibrary();
  return useLiveQuery(async () => {
    if (!id) return null;
    const r = await store.getRecord(type, id.toLowerCase());
    return r && !r.deleted && r.payload ? { id: r.id, payload: r.payload as T } : null;
  }, [store, type, id]);
}
