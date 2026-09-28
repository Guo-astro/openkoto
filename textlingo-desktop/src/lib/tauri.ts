// Type definitions for Tauri commands

export interface ModelConfig {
  id: string;
  name: string;
  api_key: string;
  api_provider: string;
  model: string;
  is_default: boolean;
  created_at?: string;
  base_url?: string;
}

export interface PromptFeature {
  id: string;
  kind: string;
  name: string;
  description: string;
  prompt_template: string;
  requires_selection: boolean;
  show_in_quick_actions: boolean;
  icon: string;
  sort_order: number;
  enabled: boolean;
  is_builtin: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AppConfig {
  onboarding_completed?: boolean;
  // Legacy fields (deprecated, for backward compatibility)
  api_key?: string;
  api_provider?: string;
  model?: string;
  // New model config system
  active_model_id?: string;
  model_configs: ModelConfig[];
  // Other settings
  target_language: string;
  interface_language: string;
  batch_translation_concurrency?: number;
  // SRS daily limits
  srs_daily_new_limit?: number;
  srs_daily_review_limit?: number;
  // FSRS desired retention (0.70–0.97), default 0.9
  srs_desired_retention?: number;
  // User-configurable prompt features for AI chat
  prompt_features?: PromptFeature[];
  // Subtitle transcription (ASR) provider configs — separate from model_configs
  asr_configs?: ModelConfig[];
  active_asr_model_id?: string;
}

import { AgentTask, AgentWorkerStatusSnapshot, Artifact, Article, MindMapResult } from "../types";

export { type AgentTask, type AgentWorkerStatusSnapshot, type Artifact, type Article, type MindMapResult };

export type AnalysisType = "summary" | "key_points" | "vocabulary" | "grammar" | "full";

export interface TranslationRequest {
  text: string;
  target_language: string;
  context?: string;
}

export interface TranslationResponse {
  translated_text: string;
  original_text: string;
  model_used: string;
}

export interface AnalysisRequest {
  text: string;
  analysis_type: AnalysisType;
}

export interface AnalysisResponse {
  analysis_type: AnalysisType;
  result: string;
  metadata?: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  tokens_used?: number;
}

export interface KtvExportResult {
  outputPath: string;
}

export type KtvDisplayMode = "original" | "bilingual" | "translation";
export type KtvPositionPreset = "bottom" | "lower_third" | "center_lower";

export interface KtvExportConfig {
  displayMode: KtvDisplayMode;
  showReading: boolean;
  originalFontFamily: string;
  translationFontFamily: string;
  readingFontFamily: string;
  fontSize: number;
  readingScale: number;
  lineGap: number;
  bilingualGap: number;
  originalColor: string;
  translationColor: string;
  readingColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  positionPreset: KtvPositionPreset;
  bottomMargin: number;
  horizontalMargin: number;
  videoWidth?: number;
  videoHeight?: number;
}

// Tauri command type imports
export type TauriCommand = {
  init_app: () => Promise<string>;
  get_config: () => Promise<AppConfig | null>;
  save_config_cmd: (config: AppConfig) => Promise<string>;
  set_api_key: (apiKey: string, provider: string, model: string) => Promise<string>;
  create_article: (
    title: string,
    content: string,
    sourceUrl?: string
  ) => Promise<Article>;
  get_article: (id: string) => Promise<Article>;
  list_articles_cmd: () => Promise<Article[]>;
  update_article: (
    id: string,
    title?: string,
    content?: string,
    sourceUrl?: string,
    translated?: boolean
  ) => Promise<Article>;
  update_article_segment: (
    articleId: string,
    segmentId: string,
    explanation?: any,
    reading?: string,
    translation?: string
  ) => Promise<Article>;
  delete_article_cmd: (id: string) => Promise<void>;
  translate_text: (request: TranslationRequest) => Promise<TranslationResponse>;
  analyze_text: (request: AnalysisRequest) => Promise<AnalysisResponse>;
  chat_completion: (request: ChatRequest) => Promise<ChatResponse>;
  translate_article: (
    articleId: string,
    targetLanguage: string
  ) => Promise<Article>;
  analyze_article: (
    articleId: string,
    analysisType: AnalysisType
  ) => Promise<string>;
  create_mind_map_task_cmd: (
    articleId: string,
    displayLanguage?: string,
    maxDepth?: number
  ) => Promise<AgentTask>;
  run_agent_turn_cmd: (
    taskId: string,
    articleId: string,
    userMessage: string,
    conversation: AssistantConversationMessage[],
    displayLanguage?: string,
  ) => Promise<AgentTask>;
  get_agent_task_cmd: (taskId: string) => Promise<AgentTask>;
  artifact_save_cmd: (
    taskId: string,
    articleId: string,
    content: unknown
  ) => Promise<Artifact>;
  get_artifact_cmd: (articleId: string, artifactId: string) => Promise<Artifact>;
  get_agent_worker_status_cmd: () => Promise<AgentWorkerStatusSnapshot>;
  stop_agent_worker_cmd: () => Promise<void>;
  import_article_subtitles_cmd: (articleId: string, subtitlePath: string) => Promise<Article>;
  import_srt_file_cmd: (filePath: string, title?: string) => Promise<Article>;
  prepare_ktv_segments_cmd: (articleId: string, languageHint?: string) => Promise<Article>;
  export_ktv_video_cmd: (articleId: string, outputPath: string, config: KtvExportConfig) => Promise<KtvExportResult>;
};
