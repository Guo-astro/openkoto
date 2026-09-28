import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const CLOUD_DATA_CHANGED_EVENT = "cloud://data-changed";

/** Re-run `onChange` whenever a cloud sync applied remote changes. */
export function useCloudDataChanged(onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    try {
      Promise.resolve(listen(CLOUD_DATA_CHANGED_EVENT, () => ref.current()))
        .then((fn) => {
          if (typeof fn !== "function") return;
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => undefined);
    } catch {
      // Not running inside Tauri (tests / storybook).
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
