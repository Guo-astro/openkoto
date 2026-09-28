export interface Article {
    id: string;
    title: string;
    content: string;
    /** 素材来源类型: web | article | youtube | local_video | audio | book */
    source_type?: "web" | "article" | "youtube" | "local_video" | "audio" | "book" | "lyrics";
    source_url?: string;
    media_path?: string;
    /** 书籍文件路径 (EPUB/TXT/PDF) */
    book_path?: string;
    /** 书籍类型: "epub" | "txt" | "pdf" */
    book_type?: "epub" | "txt" | "pdf";
    created_at: string;
    translated: boolean;
    active_mind_map_artifact_id?: string;
    segments?: ArticleSegment[];
}

export type AgentTaskType =
    | "mind_map_generate"
    | "assistant_agent_turn"
    | "ppt_outline"
    | "ppt_slides"
    | "article_ask";
export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface AgentTaskInput {
    article_id: string;
    display_language: string;
    max_depth: number;
    evidence_mode: string;
    prefer_structure: string;
}

export interface AgentTask {
    id: string;
    task_type: AgentTaskType;
    status: AgentTaskStatus;
    article_id: string;
    input: AgentTaskInput;
    progress: number;
    stage?: string;
    message?: string;
    error?: string;
    worker_session_id?: string;
    artifact_ids: string[];
    created_at: string;
    updated_at: string;
    started_at?: string;
    finished_at?: string;
}

export type ArtifactType = "mind_map" | "mind_map_preview" | "ppt_outline" | "ppt_slides" | "article_answer";

export interface Artifact {
    id: string;
    task_id: string;
    article_id: string;
    artifact_type: ArtifactType;
    version: string;
    content: unknown;
    metadata?: unknown;
    created_at: string;
    updated_at: string;
}

export type MindMapStatus = "applicable" | "partial" | "not_applicable";
export type DiagnosticsContentType = "narrative" | "lecture" | "dialogue" | "article" | "lyrics" | "music_only" | "mixed" | "unknown";
export type DiagnosticsCoverage = "full" | "partial" | "none";
export type MindMapNodeType = "root" | "theme" | "topic" | "event" | "entity" | "relation" | "evidence";

export interface SourceOffset {
    start: number;
    end: number;
}

export interface TimeRange {
    start: number;
    end: number;
}

export interface MindMapNode {
    id: string;
    title: string;
    node_type: MindMapNodeType;
    summary: string;
    confidence: number;
    source_segment_ids: string[];
    source_offsets: SourceOffset[];
    time_range?: TimeRange;
    children: MindMapNode[];
}

export interface MindMap {
    version: string;
    article_id: string;
    title: string;
    display_language: string;
    generation_mode: string;
    source_hash: string;
    summary: string;
    root: MindMapNode;
}

export interface MindMapDiagnostics {
    content_type: DiagnosticsContentType;
    coverage: DiagnosticsCoverage;
    notes: string[];
    window_count: number;
    evidence_density: number;
    low_confidence_node_ids: string[];
}

export interface MindMapResult {
    status: MindMapStatus;
    reason?: string | null;
    map?: MindMap | null;
    diagnostics: MindMapDiagnostics;
}

export type WorkerLogLevel = "debug" | "info" | "warn" | "error";

export interface WorkerLogEntry {
    timestamp: string;
    level: WorkerLogLevel;
    source: string;
    message: string;
}

export interface AgentWorkerStatusSnapshot {
    health: "starting" | "healthy" | "unhealthy" | "stopped";
    worker_session_id?: string;
    started_at?: string;
    last_heartbeat_at?: string;
    logs: WorkerLogEntry[];
}

export interface ArticleSegment {
    id: string;
    article_id: string;
    order: number;
    text: string;
    reading_text?: string;
    translation?: string;
    explanation?: SegmentExplanation;
    start_time?: number;
    end_time?: number;
    created_at: string;
    /** 是否是新段落开始（true则另起一行显示，false则紧跟上一段显示） */
    is_new_paragraph?: boolean;
}

export interface SegmentExplanation {
    translation: string;
    explanation: string;
    reading_text?: string;
    vocabulary?: VocabularyItem[];
    grammar_points?: GrammarPoint[];
    cultural_context?: string;
    difficulty_level?: string;
    learning_tips?: string;
}

export interface VocabularyItem {
    word: string;
    meaning: string;
    usage: string;
    example?: string;
    reading?: string;
}

export interface GrammarPoint {
    point: string;
    explanation: string;
    example?: string;
}

// 单词收藏
export interface FavoriteVocabulary {
    id: string;
    word: string;
    meaning: string;
    usage: string;
    explanation?: string;
    example?: string;
    reading?: string;
    source_article_id?: string;
    source_article_title?: string;
    pack_ids?: string[];
    srs_state?: "new" | "learning" | "review";
    /** 旧 SM-2 字段(已冻结,仅兼容保留) */
    ease_factor?: number;
    repetitions?: number;
    interval_days?: number;
    /** FSRS 记忆稳定性;0 = 未初始化 */
    stability?: number;
    /** FSRS 难度 [1,10] */
    difficulty?: number;
    scheduler_version?: string;
    /** 非空 = 已掌握/暂停复习 */
    suspended_at?: string;
    due_date?: string;
    last_reviewed_at?: string;
    review_count?: number;
    created_at: string;
}

// 复习统计(规范 §6)
export interface ReviewStats {
    new_today: number;
    review_today: number;
    streak_days: number;
    total: number;
    count_new: number;
    count_learning: number;
    count_review: number;
    count_suspended: number;
}

export interface WordPack {
    id: string;
    name: string;
    description?: string;
    cover_url?: string;
    author?: string;
    language_from?: string;
    language_to?: string;
    tags?: string[];
    version?: string;
    created_at: string;
    updated_at: string;
    is_system?: boolean;
}

// 语法收藏
export interface FavoriteGrammar {
    id: string;
    point: string;
    explanation: string;
    example?: string;
    source_article_id?: string;
    source_article_title?: string;
    created_at: string;
}

// 书签
export interface Bookmark {
    id: string;
    /** 书籍文件路径 */
    book_path: string;
    /** 书籍类型: "txt" | "pdf" | "epub" */
    book_type: "txt" | "pdf" | "epub";
    /** 书签标题 */
    title: string;
    /** 可选笔记 */
    note?: string;
    /** 用户选中的文字摘录 */
    selected_text?: string;
    /** PDF/TXT 页码（从1开始） */
    page_number?: number;
    /** EPUB CFI 位置字符串 */
    epub_cfi?: string;
    /** 创建时间 */
    created_at: string;
    /** 书签颜色标签（可选） */
    color?: string;
}
