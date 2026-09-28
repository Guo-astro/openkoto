import Foundation
import GRDB
import OKModels

/// 数据库入口。全部写操作经由单一 repository 入口协调；
/// 建库/迁移只由主 App 执行，Share Extension 不加载本模块（设计文档 §3.2 / §6.3）。
public struct AppDatabase: Sendable {
    public let writer: any DatabaseWriter

    public init(_ writer: any DatabaseWriter) throws {
        self.writer = writer
        try Self.migrator.migrate(writer)
    }

    public static func inMemory() throws -> AppDatabase {
        try AppDatabase(DatabaseQueue())
    }

    public static func onDisk(at url: URL) throws -> AppDatabase {
        var config = Configuration()
        config.foreignKeysEnabled = true
        return try AppDatabase(DatabasePool(path: url.path, configuration: config))
    }

    /// v1 schema（设计文档 §3.2 + SRS 规范 docs/specs/vocabulary-srs-spec.md）。
    /// - id 一律存小写 UUID 字符串；时间列由 GRDB 以 UTC datetime 文本存储。
    /// - 嵌套精讲按 JSON 列（`explanation_json`）存储，内含溯源元数据。
    /// - 不预埋 `dirty` / `deleted_at`（同步字段待二期 RFC 后迁移）。
    /// - 本次为 FSRS 统一改造对 v1 的原地改写：无 TestFlight 存量用户,不做迁移。
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        // 不启用 eraseDatabaseOnSchemaChange：本地数据(文章/生词/复习/阅读会话)须跨版本持久，
        // 与发布版一致。schema 演进只追加新 migration(如 v2 加 reading_session)，GRDB 增量应用；
        // 若将来需破坏性变更，写显式迁移或手动重装，绝不静默清库。
        migrator.registerMigration("v0-placeholder") { _ in }
        migrator.registerMigration("v1") { db in
            try db.create(table: "article") { t in
                t.primaryKey("id", .text)
                t.column("title", .text).notNull()
                t.column("content", .text).notNull()
                t.column("source_type", .text)
                t.column("source_url", .text)
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
            }
            try db.create(table: "segment") { t in
                t.primaryKey("id", .text)
                t.column("article_id", .text).notNull().indexed()
                    .references("article", onDelete: .cascade)
                t.column("order_index", .integer).notNull()
                t.column("text", .text).notNull()
                t.column("reading_text", .text)
                t.column("translation", .text)
                t.column("explanation_json", .text)
                t.column("is_new_paragraph", .boolean).notNull().defaults(to: false)
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
                t.uniqueKey(["article_id", "order_index"])
            }
            try db.create(table: "favorite_vocabulary") { t in
                t.primaryKey("id", .text)
                t.column("word", .text).notNull()
                t.column("normalized_word", .text).notNull()
                t.column("meaning", .text).notNull()
                t.column("usage", .text)
                t.column("explanation", .text)
                t.column("example", .text)
                t.column("reading", .text)
                // 文章删除时置空，标题快照保留（§3.2）
                t.column("source_article_id", .text).indexed()
                    .references("article", onDelete: .setNull)
                t.column("source_article_title", .text)
                t.column("srs_state", .text).notNull()
                // FSRS 记忆状态(规范 §1.1);0 = 未初始化(new 卡)
                t.column("stability", .double).notNull().defaults(to: 0)
                t.column("difficulty", .double).notNull().defaults(to: 0)
                t.column("scheduler_version", .text)
                // 非空 = 已掌握/暂停复习;队列排除(规范 §3)
                t.column("suspended_at", .datetime)
                // 本地日期 "YYYY-MM-DD"；空串 = 未排期
                t.column("due_date", .text).notNull().defaults(to: "")
                t.column("last_reviewed_at", .datetime)
                t.column("review_count", .integer).notNull()
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
                // 收藏去重规则（一期）：同一来源文章内按规范化词形唯一
                t.uniqueKey(["normalized_word", "source_article_id"])
            }
            try db.create(table: "word_pack") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("description", .text)
                t.column("cover_url", .text)
                t.column("author", .text)
                t.column("language_from", .text)
                t.column("language_to", .text)
                t.column("tags_json", .text).notNull().defaults(to: "[]")
                t.column("version", .text)
                t.column("is_system", .boolean).notNull().defaults(to: false)
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
            }
            // 词包成员关系表(规范 §8:多端并发编辑友好,取代 pack_ids JSON)
            try db.create(table: "word_pack_membership") { t in
                t.column("vocabulary_id", .text).notNull()
                    .references("favorite_vocabulary", onDelete: .cascade)
                t.column("pack_id", .text).notNull()
                    .references("word_pack", onDelete: .cascade)
                t.column("created_at", .datetime).notNull()
                t.primaryKey(["vocabulary_id", "pack_id"])
            }
            // 复习事件日志(规范 §1.3):append-only、不可变。
            // vocabulary_id 不建外键——事件必须在卡片删除后存活(同步单元)。
            try db.create(table: "review_log") { t in
                t.primaryKey("id", .text)
                t.column("vocabulary_id", .text).notNull().indexed()
                t.column("reviewed_at", .datetime).notNull()
                t.column("date_local", .text).notNull().indexed()
                t.column("grade", .integer).notNull()
                t.column("elapsed_days", .integer).notNull()
                t.column("previous_state", .text).notNull()
                t.column("scheduler_version", .text).notNull()
                t.column("desired_retention", .double).notNull()
                t.column("result_stability", .double).notNull()
                t.column("result_difficulty", .double).notNull()
                t.column("result_interval_days", .integer).notNull()
                t.column("result_state", .text).notNull()
            }
        }
        // v2：阅读会话日志(append-only)——阅读时长/天数统计用。
        // article_id 不建外键：文章删除后会话仍计入总时长(与 review_log 同理)。
        migrator.registerMigration("v2") { db in
            try db.create(table: "reading_session") { t in
                t.primaryKey("id", .text)
                t.column("article_id", .text)
                t.column("date_local", .text).notNull().indexed()
                t.column("started_at", .datetime).notNull()
                t.column("seconds", .integer).notNull()
            }
        }
        // v3：书籍(TXT / EPUB)。
        // 章节复用 article/segment 表——精讲回填、生词外键、阅读会话、统计一行不改即可对
        // 书籍生效；归属关系由 book_chapter 关联表表达(同 word_pack_membership 模式)。
        migrator.registerMigration("v3") { db in
            try db.create(table: "book") { t in
                t.primaryKey("id", .text)
                t.column("title", .text).notNull()
                t.column("author", .text)
                t.column("language", .text)
                t.column("format", .text).notNull()  // "txt" | "epub"
                // Books/<dir_name>；绝对路径随重装变化，只存相对名
                t.column("dir_name", .text).notNull()
                t.column("opf_path", .text)
                t.column("cover_href", .text)
                t.column("total_chars", .integer).notNull().defaults(to: 0)
                // 导入期抽取质量检测的结果
                t.column("default_mode", .text).notNull().defaults(to: "native")
                // 固定版式/纯图书：禁用原生模式
                t.column("original_only", .boolean).notNull().defaults(to: false)
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
            }
            // 章节 = article 行。article_id 既是主键也是外键。
            // book → article 的级联无法用外键表达，由 BookRepository.deleteBook 显式事务完成。
            try db.create(table: "book_chapter") { t in
                t.primaryKey("article_id", .text).references("article", onDelete: .cascade)
                t.column("book_id", .text).notNull().indexed()
                    .references("book", onDelete: .cascade)
                t.column("chapter_index", .integer).notNull()
                // 相对书籍目录的原始文件（EPUB 的 XHTML / TXT 章节切片）
                t.column("source_href", .text)
                t.column("is_segmented", .boolean).notNull().defaults(to: false)
                t.column("char_count", .integer).notNull().defaults(to: 0)
                t.uniqueKey(["book_id", "chapter_index"])
            }
            // 阅读位置：每本书一行。原生锚点 segment_order 与原版锚点 scroll_fraction
            // 同时维护，保证任意时刻切换模式都有落点。
            try db.create(table: "book_progress") { t in
                t.primaryKey("book_id", .text).references("book", onDelete: .cascade)
                t.column("chapter_article_id", .text).references("article", onDelete: .setNull)
                t.column("chapter_index", .integer).notNull().defaults(to: 0)
                t.column("segment_order", .integer)
                t.column("scroll_fraction", .double)
                t.column("mode", .text).notNull().defaults(to: "native")
                t.column("updated_at", .datetime).notNull()
            }
            // 书签 / 划线。selected_text 永远保存，作为两种模式共同的兜底重锚依据。
            try db.create(table: "book_mark") { t in
                t.primaryKey("id", .text)
                t.column("book_id", .text).notNull().references("book", onDelete: .cascade)
                t.column("chapter_article_id", .text).references("article", onDelete: .setNull)
                t.column("chapter_index", .integer).notNull()
                t.column("kind", .text).notNull()  // "bookmark" | "highlight"
                t.column("segment_order", .integer)
                t.column("char_start", .integer)  // 句内 Unicode 标量偏移
                t.column("char_end", .integer)
                t.column("locator", .text)  // 自定义定位格式，非 EPUB CFI
                t.column("scroll_fraction", .double)
                t.column("selected_text", .text)
                t.column("note", .text)
                t.column("color", .text)
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
            }
            try db.create(
                index: "book_mark_on_book_chapter", on: "book_mark",
                columns: ["book_id", "chapter_index", "created_at"])
            // 启动只查计数、不读正文：已精讲句数走这条部分索引，全程 index-only。
            try db.create(
                index: "segment_on_article_explained", on: "segment",
                columns: ["article_id"],
                condition: Column("explanation_json") != nil)
        }

        // v4：视频/音频。转写文稿复用 article/segment 表——理由同 v3 的书籍。
        //
        // 时间轴只落到**句级**（segment.start_time/end_time）。词级时间戳不进库：
        // 它的格式还会随来源演进（端上给 CMTimeRange、SRT 根本给不了），
        // 且只在播放时需要，可从源文件重推——同 reading runs 的既有判断。
        migrator.registerMigration("v4") { db in
            // 对文章与书籍章节的 segment 行恒为 NULL，无副作用。
            try db.alter(table: "segment") { t in
                t.add(column: "start_time", .double)
                t.add(column: "end_time", .double)
            }
            try db.create(table: "media") { t in
                t.primaryKey("id", .text)
                t.column("title", .text).notNull()
                t.column("kind", .text).notNull()  // "video" | "audio"
                // Media/<dir_name>；绝对路径随重装变化，只存相对名
                t.column("dir_name", .text).notNull()
                // 目录内的媒体文件名；NULL = 引用外部文件（见 bookmark_data）
                t.column("file_name", .text)
                t.column("bookmark_data", .blob)
                t.column("source_label", .text)
                t.column("duration", .double).notNull().defaults(to: 0)
                t.column("language", .text)
                t.column("transcript_source", .text).notNull()
                t.column("has_word_timing", .boolean).notNull().defaults(to: false)
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
            }
            // 文稿 = article 行。article_id 既是主键也是外键（同 book_chapter）。
            // media → article 的级联无法用外键表达，由 MediaRepository.deleteMedia 显式完成。
            try db.create(table: "media_part") { t in
                t.primaryKey("article_id", .text).references("article", onDelete: .cascade)
                t.column("media_id", .text).notNull().indexed()
                    .references("media", onDelete: .cascade)
                t.column("part_index", .integer).notNull().defaults(to: 0)
                t.uniqueKey(["media_id", "part_index"])
            }
            try db.create(table: "media_progress") { t in
                t.primaryKey("media_id", .text).references("media", onDelete: .cascade)
                t.column("position", .double).notNull().defaults(to: 0)
                t.column("rate", .double).notNull().defaults(to: 1)
                t.column("updated_at", .datetime).notNull()
            }
        }

        // v5：精讲复用。
        //
        // `explanation_json` 里一直存着 `source_text_hash`，但从来没人读过——
        // 于是同一句话在别处（重新导入的书、被分享两次的文章、与文稿重叠的字幕）
        // 要重新付一次钱。这里把它变成可查的：**虚拟生成列**（值直接从既有 JSON 取，
        // 不重写任何一行数据）+ **只覆盖已精讲行的部分索引**。
        //
        // 已实测查询计划确实走这条索引（1 万行中查一条 0.09ms），
        // 且未精讲行的生成列为 NULL，不会误命中。
        migrator.registerMigration("v5") { db in
            try db.alter(table: "segment") { t in
                t.add(column: "source_text_hash", .text)
                    .generatedAs(sql: "json_extract(explanation_json, '$.source_text_hash')")
            }
            try db.create(
                index: "segment_on_source_hash", on: "segment",
                columns: ["source_text_hash"],
                condition: Column("explanation_json") != nil)

            // 生词卡回跳到"原句"（媒体字幕句带 start_time，可直接跳到那一秒）。
            // 不建外键：句子被重新切分后卡片仍应存活，同 reading_session 的既定判断。
            try db.alter(table: "favorite_vocabulary") { t in
                t.add(column: "source_segment_id", .text)
            }
        }

        // v6：全库搜索。
        //
        // **索引建在 `article.content` 而不是 `segment.text`**，这一点很关键：
        // `BookRepository.insertBook` 导入时不写 segment（切分推迟到首次打开该章），
        // 建 segment 索引会让新导入的书全部搜不到。而 article.content 天然覆盖
        // 文章 + 书籍章节 + 媒体文稿三类。附带好处：`saveExplanation`/`saveTranslation`
        // 只 UPDATE segment 从不碰 article，所以批量精讲一次都不会触发 FTS 重索引。
        //
        // tokenizer 用 **trigram**：unicode61（默认）对中日文完全无效——整句会被当成
        // 一个 token，`MATCH '日本語'` 查不到任何东西。代价是查询串必须 ≥3 字符，
        // 两字词由上层的 LIKE 兜底（见 `ContentRepository.search`）。
        //
        // **只建表建触发器，不回填**：GRDB 的 `synchronize(withTable:)` 会在 migration
        // 内部同步跑全量 rebuild，而 migration 在 `AppDatabase.init` 同步执行、
        // `ContentStore.live()` 又在主线程构造 —— 老用户升级首启会卡住数秒。
        // 改成把待办 rowid 记进 `fts_backfill`，交给 `SearchIndexer` 在后台分批消化。
        migrator.registerMigration("v6") { db in
            try db.create(
                virtualTable: "article_fts", using: FTS5()
            ) { t in
                t.column("title")
                t.column("content")
                t.content = "article"
                t.contentRowID = "rowid"
                // GRDB 没有 trigram 工厂（只有 ascii/porter/unicode61），用通用构造器
                t.tokenizer = FTS5TokenizerDescriptor(components: ["trigram"])
            }

            // 待办表要先于触发器建出来：触发器会查它。
            //
            // 这张表**永不删除**。它空了只表示索引已建完，而不是可以丢——
            // 触发器引用了它，删掉会让之后每一次文章写入都失败。
            try db.create(table: "fts_backfill") { t in
                t.primaryKey("rowid", .integer)
            }
            try db.execute(sql: "INSERT INTO fts_backfill (rowid) SELECT rowid FROM article")

            // 手写触发器而不是 synchronize(withTable:)：后者生成的 UPDATE 触发器
            // 没有 WHEN 过滤，任何一列的改动都会重索引一次。
            //
            // 每条改动索引的语句都带 `NOT EXISTS (SELECT 1 FROM fts_backfill …)`：
            // **还在待办里的行根本没进过索引**，对它发 'delete' 会写进一笔负的词频，
            // SQLite 随即把整个库判为 malformed——升级后回填还没跑完时删掉一篇文章，
            // 那次删除会直接报 "database disk image is malformed" 而失败。
            // 待办中的行交给回填器处理即可，它读的是当前值，改了也不会丢。
            try db.execute(
                sql: """
                    CREATE TRIGGER article_fts_ai AFTER INSERT ON article BEGIN
                        INSERT INTO article_fts(rowid, title, content)
                        VALUES (new.rowid, new.title, new.content);
                    END;
                    CREATE TRIGGER article_fts_ad AFTER DELETE ON article BEGIN
                        INSERT INTO article_fts(article_fts, rowid, title, content)
                        SELECT 'delete', old.rowid, old.title, old.content
                        WHERE NOT EXISTS (SELECT 1 FROM fts_backfill WHERE rowid = old.rowid);
                        DELETE FROM fts_backfill WHERE rowid = old.rowid;
                    END;
                    CREATE TRIGGER article_fts_au AFTER UPDATE ON article
                    WHEN old.content IS NOT new.content OR old.title IS NOT new.title
                    BEGIN
                        INSERT INTO article_fts(article_fts, rowid, title, content)
                        SELECT 'delete', old.rowid, old.title, old.content
                        WHERE NOT EXISTS (SELECT 1 FROM fts_backfill WHERE rowid = old.rowid);
                        INSERT INTO article_fts(rowid, title, content)
                        SELECT new.rowid, new.title, new.content
                        WHERE NOT EXISTS (SELECT 1 FROM fts_backfill WHERE rowid = old.rowid);
                    END;
                    """)
        }
        // 跨设备同步的删除墓碑（计划见 §P1）。
        //
        // **刻意用独立表，而不是给每张表加 `deleted_at` 列。** 加列意味着：
        // 1. 每一条读查询都要补 `WHERE deleted_at IS NULL`，漏一处删掉的生词就复活；
        // 2. `article` 的软删除是 UPDATE，会撞上上面 v6 那三个 FTS 触发器 ——
        //    删掉的文章会继续留在全文索引里被搜出来，而改触发器又要碰
        //    "database disk image is malformed" 那个雷（见 v6 注释）。
        //
        // 墓碑表是纯增量的：删除仍然是硬删除，读路径一行不改，FTS 行为不变。
        //
        // 用途有二：`TransferImporter` 靠它判断"这条是用户主动删的，不许从文件里复活"；
        // CloudKit 同步靠它把删除传播出去（本地行已经没了，只剩这一笔记录）。
        migrator.registerMigration("v7") { db in
            try db.create(table: "deleted_record") { t in
                // 逻辑表名（"favorite_vocabulary" / "word_pack" / …），不加外键：
                // 被引用的行按定义已经不存在了。
                t.column("table_name", .text).notNull()
                // 主键值。词包成员这种复合主键用 "vocabularyId:packId" 拼接。
                t.column("record_id", .text).notNull()
                t.column("deleted_at", .datetime).notNull().indexed()
                // 复合主键顺带保证重复删除幂等（`save` 覆盖同一行）。
                t.primaryKey(["table_name", "record_id"])
            }
        }
        // 同步引擎的持久状态（CloudKit，计划见 §P3）。单行表。
        //
        // `engine_state` 是 `CKSyncEngine.State.Serialization`，由引擎自己管理，
        // 我们只负责存取；丢了不会丢数据，只会导致一次全量重新对账。
        //
        // `last_synced_at` 是**推送水位线**：每次同步扫 `updated_at` 晚于它的行。
        // 用水位线而不是给每张表加 `dirty` 列，是为了不去动所有 Repository 的写入路径
        // —— 那意味着几十处改动，且漏一处就是"这类数据永远不同步"的静默 bug。
        migrator.registerMigration("v8") { db in
            try db.create(table: "sync_state") { t in
                t.primaryKey("id", .text)
                t.column("engine_state", .blob)
                t.column("last_synced_at", .datetime)
            }
        }
        // 每条云端记录的"上次同步成功时的样子"（CloudKit）。
        //
        // **`system_fields` 不是可选的优化，缺了它同步会稳定报错。** CloudKit 的保存是
        // compare-and-swap：请求里要带上你上次见到的 `recordChangeTag`，服务端比对通过
        // 才写。每次都 `CKRecord(recordType:recordID:)` 现造一条的话没有 tag，服务端一律
        // 当成"新建"，于是**任何一条已经在云上的记录，再推一次必然回 `serverRecordChanged`**。
        // 而水位线有 5 秒重叠（见 `watermarkOverlap`），下一次同步必定会重推最后那几条 ——
        // 也就是说，只要同步跑第二次就一定报错。实测就是这么炸的。
        //
        // `payload_hash` 用来掐掉回声：从云端拉回来的记录会写进本地表，
        // 于是它的 `updated_at` 立刻越过水位线，下一轮扫描又把它原样推回去。
        // 内容一模一样时按哈希跳过，省掉这一整圈无用功。
        migrator.registerMigration("v9") { db in
            try db.create(table: "cloud_record_meta") { t in
                // CKRecord.ID.recordName，即 `类型_主键`（见 `CloudRecord.recordName`）。
                t.primaryKey("record_name", .text)
                // NSKeyedArchiver 存的 CKRecord 系统字段（含 change tag）。
                t.column("system_fields", .blob)
                // 上次同步成功时 payload 的 SHA-256。
                t.column("payload_hash", .text)
                t.column("synced_at", .datetime).notNull()
            }
        }
        // 依赖还没到本机的云端记录，先停在这里等下一轮（计划见 §P4-1）。
        //
        // **不停放就是永久丢数据。** `book_chapter` 要 article 与 book 都在，
        // `segment` 要父 article，词包成员两头都要 —— 原来的写法是
        // `guard … else { return false }` 静默跳过，而 CloudKit 的 change token
        // 照样往前走，那条记录**再也不会被下发**。同一批内靠 `mergeOrder` 排序能解决，
        // 跨批次不能：一本 100 章的书必然跨批次。
        migrator.registerMigration("v10") { db in
            try db.create(table: "pending_cloud_payload") { t in
                t.primaryKey("record_name", .text)
                t.column("record_type", .text).notNull()
                t.column("record_id", .text).notNull()
                t.column("payload", .blob).notNull()
                // 原记录的 updatedAt。重放时要拿它跟本地比，否则 LWW 判定会用错时间。
                t.column("updated_at", .datetime).notNull()
                t.column("first_seen_at", .datetime).notNull().indexed()
                t.column("attempts", .integer).notNull().defaults(to: 0)
            }
        }
        // 查词缓存。用户点过的每个词都付过费，重启 App 不该再付一次。
        //
        // **这是缓存，不是用户数据**：不同步云端（换设备重查一次即可），也不进生词本
        // （收藏与否仍是用户的主动选择，查过 ≠ 要复习）。
        //
        // `context` 是失效维度：prompt 版本 + 模型 + 目标语言拼成的一个串。
        // 三者任一变化后旧释义必然过时（释义是用目标语言写的），应用层比对不等即 miss，
        // 重查并覆盖——没有独立的失效流程。
        migrator.registerMigration("v11") { db in
            try db.create(table: "word_gloss") { t in
                t.primaryKey("normalized_word", .text)
                t.column("word", .text).notNull()
                t.column("meaning", .text).notNull()
                t.column("usage", .text)
                t.column("example", .text)
                t.column("reading", .text)
                t.column("context", .text).notNull()
                t.column("created_at", .datetime).notNull()
                t.column("updated_at", .datetime).notNull()
            }
        }
        // OpenKoto 云（HTTP 同步协议 v1，`docs/specs/sync-protocol-spec.md`）。
        //
        // 与 CloudKit 的 `cloud_record_meta` **分表存**：两套引擎永远不同时启用，
        // 但用户会在两者之间切换（iCloud → OpenKoto 云迁移），混在一张表里的话
        // 一边的 change tag / rev 会被另一边当成自己的。
        //
        // - `rev`：服务端最后一次告诉我们的该记录 rev，推送时作为 `baseRev`；
        // - `hlc`：该 rev 对应的 HLC；
        // - `payload_hash`：上次同步成功时 payload 的规范化 SHA-256，掐回声用；
        // - `deleted`：云上那份是不是墓碑（墓碑已推过就不用再推）。
        //
        // `sync_state` 追加 HTTP 引擎自己的游标 / 水位线 / 时钟，
        // 同样不与 CloudKit 的 `engine_state` / `last_synced_at` 共用。
        migrator.registerMigration("v12") { db in
            try db.create(table: "http_sync_meta") { t in
                t.primaryKey("record_name", .text)
                t.column("rev", .integer).notNull().defaults(to: 0)
                t.column("hlc", .text)
                t.column("payload_hash", .text)
                t.column("deleted", .boolean).notNull().defaults(to: false)
                t.column("synced_at", .datetime).notNull()
            }
            try db.alter(table: "sync_state") { t in
                // 服务端游标（不透明字符串，`c_<rev>`）。nil = 从头拉。
                t.add(column: "http_cursor", .text)
                // 推送水位线：`updated_at` 晚于它的行才需要推。
                t.add(column: "http_watermark", .datetime)
                // 本机 HLC 的最后值（重启后时钟不能倒退）。
                t.add(column: "http_clock", .text)
                // 游标 / 元数据属于哪个账号。换账号时据此整体作废。
                t.add(column: "http_account", .text)
            }
            // 复习事件的撤销标记与云端 HLC（同步协议 §6）：
            // 重放时跳过标记与被它作废的事件，并按 (reviewedAt, hlc, id) 定序。
            try db.alter(table: "review_log") { t in
                t.add(column: "voids_event_id", .text)
                t.add(column: "hlc", .text)
            }
        }
        return migrator
    }
}
