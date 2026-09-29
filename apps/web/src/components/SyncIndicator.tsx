import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOptionalLibrary } from "../lib/library";
import { cn } from "../lib/utils";

export function SyncIndicator() {
  const { t } = useTranslation();
  const library = useOptionalLibrary();
  if (!library) return null;
  const { sync, syncNow } = library;
  const label =
    sync.status === "syncing"
      ? t("sync.syncing")
      : sync.status === "error"
        ? t("sync.error", { message: sync.message })
        : sync.lastSync
          ? t("sync.synced", { time: sync.lastSync.toLocaleTimeString() })
          : t("sync.never");
  const rejected = sync.status === "idle" && (sync.report?.rejected.length ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      title={rejected ? t("sync.quota") : label}
      aria-label={label}
      className={cn(
        "flex items-center gap-1 text-xs rounded-md px-2 py-1 hover:bg-accent",
        sync.status === "error" || rejected ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {sync.status === "syncing" ? (
        <RefreshCw size={14} className="animate-spin" aria-hidden />
      ) : sync.status === "error" || rejected ? (
        <AlertTriangle size={14} aria-hidden />
      ) : (
        <Check size={14} aria-hidden />
      )}
      <span className="hidden sm:inline">{sync.status === "syncing" ? t("sync.syncing") : rejected ? t("sync.quotaShort") : t("sync.ok")}</span>
    </button>
  );
}
