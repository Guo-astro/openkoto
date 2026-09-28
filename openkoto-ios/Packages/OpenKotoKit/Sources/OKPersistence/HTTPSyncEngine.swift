import Foundation
import OKModels
import os

/// OpenKoto 云同步（HTTP 协议 v1，`docs/specs/sync-protocol-spec.md` §8）。
///
/// 与 `CloudKitSyncEngine` 共用同一套**传输无关**的数据层：
/// `pendingCloudPayloads` / `pendingCloudDeletions` 收集本地变更，
/// `applyCloudPayloads` / `applyCloudDeletions` 合并远端变更（含复习事件重放）。
/// 引擎本身只做协议搬运：游标、rev、HLC、回声抑制、冲突重推。
///
/// **HLC 的取法**：iOS 的表里没有逐行 HLC，只有 `updated_at`，所以每条记录的 HLC
/// 按协议 §3 末条从 `updated_at` 合成（`<ms>-0000-<本机 node>`）。这让服务端的 LWW
/// 与本地合并（`ImportRules` 按 `updated_at` 判胜负）用的是**同一把尺子** ——
/// 若改用推送时刻的 `tick()`，"离线很久的旧修改一上线就盖掉别人的新修改"，
/// 而对端本地合并又会拒收它，两边从此对不上。时钟本身仍按协议推进并持久化，
/// 用于本地删除（墓碑）这类"此刻发生"的变更。
public actor HTTPSyncEngine: SyncEngine {
    /// 协议 §2.2 首批同步的类型。Media / MediaPart 本版保留类型名但不同步。
    public static let syncedTypes: Set<CloudRecordType> = [
        .vocabulary, .wordPack, .wordPackMembership, .reviewEvent, .article, .segment,
        .book, .bookChapter, .bookMark, .bookProgress,
    ]
    /// 协议 §2.1：payload 序列化后超过 512 KB 走 blob。
    public static let inlinePayloadLimit = 512 * 1024
    /// 协议 §5.2：单次最多 500 op，请求体不超过 4 MB（留余量给信封）。
    public static let maxOpsPerPush = 500
    public static let maxPushBytes = 3_500_000
    /// 协议 §5.2 末：每个同步周期最多重推 2 轮。
    public static let maxConflictRounds = 2
    /// 协议 §3：远端时钟超前 24 小时以上的不参与推进本地时钟。
    static let maxClockSkewMs: Int64 = 24 * 3600 * 1000

    /// 一轮同步的统计，给 UI / 测试看。
    public struct Report: Sendable, Equatable {
        public var pulled = 0
        public var pushed = 0
        public var conflicts = 0
        public var rebuilt = false
        public var quotaRejected: [String] = []
        public var rejected: [String] = []
        public init() {}
    }

    private let repository: ContentRepository
    private let transport: any OpenKotoSyncTransport
    private let pageSize: Int
    private let now: @Sendable () -> Date
    private let logger = Logger(subsystem: "app.openkoto", category: "HTTPSync")

    private var clock: HybridLogicalClock?
    public private(set) var lastReport = Report()

    public init(
        repository: ContentRepository,
        transport: any OpenKotoSyncTransport,
        pageSize: Int = 500,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.repository = repository
        self.transport = transport
        self.pageSize = pageSize
        self.now = now
    }

    // MARK: - SyncEngine

    /// 拉到 `hasMore == false` 为止；410 → 全量重建（清进度后从头拉，随后的 push 会全量推）。
    public func pull() async throws {
        try await prepare()
        lastReport = Report()
        var cursor = try await repository.httpSyncState().cursor
        var rebuilt = false
        while true {
            switch try await transport.pull(cursor: cursor, limit: pageSize) {
            case .cursorExpired:
                // 同一轮里第二次 410 说明服务端状态不对，别打转。
                guard !rebuilt else { throw HTTPSyncError.cursorExpiredAfterRebuild }
                logger.notice("cursor expired, rebuilding from scratch")
                try await repository.resetHTTPSyncState(account: try await transport.accountID())
                cursor = nil
                rebuilt = true
                lastReport.rebuilt = true
            case .page(let page):
                lastReport.pulled += try await apply(page.records)
                cursor = page.cursor
                try await repository.setHTTPSyncCursor(page.cursor)
                try await persistClock()
                if !page.hasMore { return }
            }
        }
    }

    /// 推送水位线之后的本地变更。conflict → 把服务端那份当作 pull 合并，再以新 rev 重推。
    public func push() async throws {
        try await prepare()
        let startedAt = now()
        let state = try await repository.httpSyncState()
        var meta = try await repository.httpSyncMeta()
        var quota: [String] = []
        var unresolved = false

        var round = 0
        while true {
            let ops = try await collectOps(since: state.watermark, meta: meta)
            guard !ops.isEmpty else {
                unresolved = false
                break
            }
            var conflicts: [SyncRecordDTO] = []
            quota = []
            for batch in Self.batches(ops.map(\.op)) {
                let response = try await transport.push(
                    SyncPushRequest(deviceId: try await transport.deviceID(), ops: batch))
                let byOp = Dictionary(uniqueKeysWithValues: ops.map { ($0.op.opId, $0) })
                var saved: [HTTPSyncMeta] = []
                var eventHLCs: [String: String] = [:]
                for result in response.results {
                    guard let pending = byOp[result.opId] else { continue }
                    switch result.status {
                    case .applied:
                        lastReport.pushed += 1
                        let row = HTTPSyncMeta(
                            recordName: pending.recordName, rev: result.rev ?? 0,
                            hlc: pending.op.hlc, payloadHash: pending.hash,
                            deleted: pending.op.deleted, syncedAt: now())
                        saved.append(row)
                        meta[row.recordName] = row
                        if pending.op.type == CloudRecordType.reviewEvent.rawValue {
                            eventHLCs[pending.op.id] = pending.op.hlc
                        }
                    case .conflict:
                        lastReport.conflicts += 1
                        if let current = result.current { conflicts.append(current) }
                    case .rejected:
                        let code = result.code ?? "UNKNOWN"
                        if code == SyncOpErrorCode.quotaExceeded {
                            quota.append(pending.recordName)
                        } else {
                            // 其余拒绝都是这条数据本身的问题（非法 payload、时钟偏差、
                            // 试图改复习事件），重推也一样，记日志后放过。
                            lastReport.rejected.append(pending.recordName)
                            logger.error(
                                "push rejected \(pending.recordName, privacy: .public): \(code, privacy: .public) \(result.message ?? "", privacy: .public)"
                            )
                        }
                    }
                }
                try await repository.saveHTTPSyncMeta(saved)
                try await repository.setReviewEventHLCs(eventHLCs)
            }
            try await persistClock()
            guard !conflicts.isEmpty else {
                unresolved = false
                break
            }
            _ = try await apply(conflicts)
            meta = try await repository.httpSyncMeta()
            round += 1
            if round > Self.maxConflictRounds {
                // 留到下个周期。水位线不动，下次还会扫到它们。
                unresolved = true
                break
            }
        }
        lastReport.quotaRejected = quota

        // 整轮干净收尾才推进水位线：漏推是永久性的，多推只是浪费。
        // 超配额的记录要留在水位线之后 —— 用户升级 / 清理之后它们还得推上去。
        if !unresolved && quota.isEmpty {
            try await repository.setHTTPSyncWatermark(startedAt)
        }
        if !quota.isEmpty { throw HTTPSyncError.quotaExceeded(count: quota.count) }
    }

    /// 丢掉 HTTP 同步的全部进度，下一次同步全量拉、全量推。不碰本地数据。
    public func resetSyncState() async throws {
        try await repository.resetHTTPSyncState(account: try await transport.accountID())
    }

    // MARK: - 准备

    private func prepare() async throws {
        let account = try await transport.accountID()
        let state = try await repository.httpSyncState()
        if state.account != account {
            // 换了账号（或第一次登录）：旧账号的游标 / rev 在新账号里全都对不上。
            try await repository.resetHTTPSyncState(account: account)
        }
        if clock == nil {
            let node = HLCTimestamp.nodeID(fromDevice: try await transport.deviceID())
            let nowMs: @Sendable () -> Int64 = { [now] in Self.milliseconds(now()) }
            // 持久化的时钟可能来自另一个设备 id（重新登录后服务端分配了新 id），
            // 只继承它的 wall/counter，node 用现在的。
            clock = HybridLogicalClock(node: node, initial: state.clock, now: nowMs)
            if let saved = state.clock.flatMap(HLCTimestamp.init), saved.node != node {
                clock = HybridLogicalClock(
                    node: node,
                    initial: HLCTimestamp(wall: saved.wall, counter: saved.counter, node: node)
                        .description,
                    now: nowMs)
            }
        }
    }

    private func persistClock() async throws {
        if let clock { try await repository.setHTTPSyncClock(clock.current) }
    }

    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    // MARK: - 收集本地变更

    struct PendingOp: Sendable {
        var op: SyncPushOp
        var recordName: String
        var hash: String?
        var size: Int
    }

    private func collectOps(since watermark: Date?, meta: [String: HTTPSyncMeta]) async throws
        -> [PendingOp]
    {
        let node = clock?.node ?? "00000000"
        var byName: [String: PendingOp] = [:]

        for deletion in try await repository.pendingCloudDeletionRecords(since: watermark)
        where Self.syncedTypes.contains(deletion.type) {
            let id = deletion.id.lowercased()
            let name = CloudRecord.recordName(deletion.type, id)
            if meta[name]?.deleted == true { continue }
            // 墓碑合成 HLC 时取"删除时刻"与本机时钟的较大者：删除是此刻发生的变更。
            let synthesized = HLCTimestamp.legacy(deletion.deletedAt, node: node)
            let ticked = clock?.tick() ?? synthesized.description
            let hlc = max(synthesized.description, ticked)
            byName[name] = PendingOp(
                op: SyncPushOp(
                    opId: UUID().uuidString.lowercased(), type: deletion.type.rawValue, id: id,
                    baseRev: meta[name]?.rev ?? 0, hlc: hlc, deleted: true, payload: nil),
                recordName: name, hash: nil, size: 200)
        }

        let payloads = try await repository.pendingCloudPayloads(
            since: watermark, options: .openKoto)
        let nowMs = Self.milliseconds(now())
        for payload in payloads where Self.syncedTypes.contains(payload.type) {
            let id = payload.id.lowercased()
            let name = CloudRecord.recordName(payload.type, id)
            let hash = Self.stableHash(payload.data)
            if let known = meta[name], !known.deleted, known.payloadHash == hash { continue }
            // 未来时间戳（设备时钟被调快过）截到现在，否则服务端会以 CLOCK_SKEW 拒收。
            var stamp = HLCTimestamp.legacy(payload.updatedAt, node: node)
            if stamp.wall > nowMs { stamp.wall = nowMs }
            var op = SyncPushOp(
                opId: UUID().uuidString.lowercased(), type: payload.type.rawValue, id: id,
                baseRev: meta[name]?.rev ?? 0, hlc: stamp.description, deleted: false,
                payload: nil)
            if payload.data.count > Self.inlinePayloadLimit {
                op.blobKey = try await transport.uploadBlob(
                    type: payload.type.rawValue, id: id, payload: payload.data)
            } else {
                op.payload = try JSONValue(jsonData: payload.data)
            }
            // 同名的墓碑与现存行同时出现（删了又加回来的词包成员）：以现存行为准。
            byName[name] = PendingOp(
                op: op, recordName: name, hash: hash,
                size: op.blobKey == nil ? payload.data.count + 300 : 400)
        }

        // 父记录先推：服务端不校验外键，但别的设备 pull 时是按 rev 顺序拿到的。
        return byName.values.sorted {
            let lhs = CloudRecordType(rawValue: $0.op.type)?.mergeOrder ?? 99
            let rhs = CloudRecordType(rawValue: $1.op.type)?.mergeOrder ?? 99
            return lhs == rhs ? $0.recordName < $1.recordName : lhs < rhs
        }
    }

    /// 按条数与字节数切批。
    static func batches(_ ops: [SyncPushOp]) -> [[SyncPushOp]] {
        var result: [[SyncPushOp]] = []
        var current: [SyncPushOp] = []
        var bytes = 0
        for op in ops {
            let size = (op.payload.flatMap { try? $0.jsonData().count } ?? 0) + 300
            if !current.isEmpty
                && (current.count >= maxOpsPerPush || bytes + size > maxPushBytes)
            {
                result.append(current)
                current = []
                bytes = 0
            }
            current.append(op)
            bytes += size
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    // MARK: - 合并远端记录

    /// 合并一批服务端记录（pull 的一页，或 push 冲突时回传的 `current`）。返回处理的条数。
    private func apply(_ records: [SyncRecordDTO]) async throws -> Int {
        var payloads: [CloudPayload] = []
        var deletions: [(type: CloudRecordType, id: String)] = []
        var metas: [HTTPSyncMeta] = []
        let syncedAt = now()
        let nowMs = Self.milliseconds(syncedAt)

        for record in records {
            // 不认识的类型：跳过但照样推进游标（协议 §2.2 末）。
            guard let type = CloudRecordType(rawValue: record.type),
                Self.syncedTypes.contains(type)
            else { continue }
            let id = record.id.lowercased()
            let name = CloudRecord.recordName(type, id)
            if let stamp = HLCTimestamp(record.hlc) {
                if stamp.wall - nowMs > Self.maxClockSkewMs {
                    logger.error(
                        "remote hlc too far ahead, not advancing clock: \(record.hlc, privacy: .public)")
                } else {
                    clock?.receive(record.hlc)
                }
            }

            if record.deleted {
                deletions.append((type, id))
                metas.append(
                    HTTPSyncMeta(
                        recordName: name, rev: record.rev, hlc: record.hlc, payloadHash: nil,
                        deleted: true, syncedAt: syncedAt))
                continue
            }

            let data: Data
            if let payload = record.payload {
                data = try payload.jsonData()
            } else if let blobUrl = record.blobUrl {
                do {
                    data = try await transport.downloadBlob(blobUrl)
                } catch {
                    // 下载失败的这一条不记元数据：下次全量重建时还有机会。
                    logger.error("blob download failed for \(name, privacy: .public): \(error)")
                    continue
                }
            } else {
                continue
            }

            let updatedAt =
                (try? JSONValue(jsonData: data))?["updatedAt"]?.stringValue
                .flatMap(CloudRecord.parseISO8601)
                ?? HLCTimestamp(record.hlc)?.date ?? syncedAt
            payloads.append(
                CloudPayload(type: type, id: id, data: data, updatedAt: updatedAt, hlc: record.hlc))
            metas.append(
                HTTPSyncMeta(
                    recordName: name, rev: record.rev, hlc: record.hlc,
                    payloadHash: Self.canonicalHash(type: type, data: data),
                    deleted: false, syncedAt: syncedAt))
        }

        if !payloads.isEmpty { try await repository.applyCloudPayloads(payloads, now: syncedAt) }
        if !deletions.isEmpty { try await repository.applyCloudDeletions(deletions, now: syncedAt) }
        try await repository.saveHTTPSyncMeta(metas)
        return metas.count
    }

    /// 远端 payload 的"本机编码指纹"：按类型解码再用本机编码器编回去后取哈希。
    ///
    /// 直接哈希远端字节的话，别的客户端的日期带毫秒、键序不同，
    /// 同一份内容与本机编码永远对不上，每条拉下来的记录都会被原样推回去一次。
    static func canonicalHash(type: CloudRecordType, data: Data) -> String {
        let decoder = CloudRecord.decoder()
        let encoder = CloudRecord.encoder()
        func reencode<T: Codable>(_ model: T.Type) -> Data? {
            guard let value = try? decoder.decode(model, from: data) else { return nil }
            return try? encoder.encode(value)
        }
        let canonical: Data?
        switch type {
        case .vocabulary: canonical = reencode(FavoriteVocabulary.self)
        case .wordPack: canonical = reencode(WordPack.self)
        case .wordPackMembership: canonical = reencode(MembershipPayload.self)
        case .article: canonical = reencode(Article.self)
        case .segment: canonical = reencode(ArticleSegment.self)
        case .reviewEvent: canonical = reencode(ReviewEvent.self)
        case .book: canonical = reencode(Book.self)
        case .bookChapter: canonical = reencode(BookChapter.self)
        case .bookMark: canonical = reencode(BookMark.self)
        case .bookProgress: canonical = reencode(BookProgress.self)
        case .media: canonical = reencode(Media.self)
        case .mediaPart: canonical = reencode(MediaPart.self)
        }
        return stableHash(canonical ?? data)
    }

    /// 与键序无关的内容哈希。
    ///
    /// **不能直接哈希 `JSONEncoder` 的输出**：它对 `Codable` 结构体的键序并不稳定
    /// （同一个值两次编码可能得到不同的键序），直接哈希的话"内容没变"也会被当成变了，
    /// 回声抑制形同虚设。先转成 `JSONValue` 再按排序键输出。
    static func stableHash(_ data: Data) -> String {
        CloudRecord.hash((try? JSONValue(jsonData: data).jsonData()) ?? data)
    }
}

public enum HTTPSyncError: Error, Equatable, LocalizedError {
    /// 有记录因超出套餐配额被拒（协议 §7）。本地数据保留，UI 要提示。
    case quotaExceeded(count: Int)
    /// 全量重建后服务端仍然回 410。
    case cursorExpiredAfterRebuild

    public var errorDescription: String? {
        switch self {
        case .quotaExceeded(let count): return "QUOTA_EXCEEDED (\(count) records)"
        case .cursorExpiredAfterRebuild: return "CURSOR_EXPIRED after rebuild"
        }
    }
}
