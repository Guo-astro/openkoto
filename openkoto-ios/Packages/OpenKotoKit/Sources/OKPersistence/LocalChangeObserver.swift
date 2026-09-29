import Foundation
import GRDB

extension ContentRepository {
    /// 参与同步的表。任一表提交了写入就回调一次（用来触发"写入后 3 秒同步"）。
    static let syncedTables = [
        "favorite_vocabulary", "word_pack", "word_pack_membership", "review_log", "article",
        "segment", "book", "book_chapter", "book_mark", "book_progress", "lyrics_meta",
        "deleted_record",
    ]

    /// 观察本地写入。回调在数据库的写队列上触发，调用方自己切线程。
    ///
    /// 同步合并远端记录同样会触发它 —— 调用方要自己忽略"同步进行中"的通知，
    /// 否则每轮同步都会再引出一轮。
    public func observeSyncedTableChanges(_ onChange: @escaping @Sendable () -> Void)
        -> LocalChangeSubscription
    {
        let regions = Self.syncedTables.map { Table($0) as any DatabaseRegionConvertible }
        let observation = DatabaseRegionObservation(tracking: regions)
        let cancellable = observation.start(
            in: database.writer,
            onError: { error in Self.cloudLogger.error("change observation failed: \(error)") },
            onChange: { _ in onChange() })
        return LocalChangeSubscription(cancellable)
    }
}

/// 观察句柄。释放或 `cancel()` 即停止观察（上层不必依赖 GRDB）。
public final class LocalChangeSubscription: @unchecked Sendable {
    private let cancellable: AnyDatabaseCancellable

    init(_ cancellable: AnyDatabaseCancellable) {
        self.cancellable = cancellable
    }

    public func cancel() { cancellable.cancel() }
}
