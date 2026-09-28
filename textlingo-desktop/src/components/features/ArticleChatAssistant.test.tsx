import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArticleChatAssistant } from "./ArticleChatAssistant";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const translations: Record<string, string> = {
  "novelChat.aiAssistant": "AI 助手",
  "novelChat.selectedText": "选中文本",
  "novelChat.inputPlaceholder": "输入问题...",
  "novelChat.welcome": "你好！我是你的阅读助手。我可以帮你翻译、解释文本，分析语法，或讨论文章内容。",
};
const tMock = (key: string, fallback?: string) => translations[key] ?? fallback ?? key;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: tMock,
  }),
  Trans: ({ defaults }: { defaults: string }) => defaults,
}));

describe("ArticleChatAssistant", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_active_model_config") {
        return Promise.resolve({
          id: "model-1",
          name: "Test Model",
          model: "gpt-4o-mini",
          api_provider: "openai",
        });
      }

      if (command === "get_config") {
        return Promise.resolve({
          target_language: "zh-CN",
          interface_language: "en",
          model_configs: [],
          prompt_features: [
            {
              id: "chat.default",
              kind: "chat_default",
              name: "Chat",
              description: "",
              prompt_template: "You are a tutor for {article_title}",
              requires_selection: false,
              show_in_quick_actions: false,
              icon: "sparkles",
              sort_order: 0,
              enabled: true,
              is_builtin: true,
            },
            {
              id: "custom.summary",
              kind: "quick_action",
              name: "Summary",
              description: "",
              prompt_template: "Summarize {text}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "sparkles",
              sort_order: 1,
              enabled: true,
              is_builtin: false,
            },
          ],
        });
      }

      if (command === "stream_chat_completion") {
        return Promise.resolve("ok");
      }

      return Promise.resolve(null);
    });

    listenMock.mockResolvedValue(() => {});
  });

  const renderAssistant = () =>
    render(
      <ArticleChatAssistant
        articleId="article-1"
        articleTitle="Demo Article"
        targetLanguage="zh-CN"
        selectedText="Selected text"
      />,
    );

  it("renders configured quick actions and injects the default chat prompt into local requests", async () => {
    renderAssistant();

    expect(await screen.findByRole("button", { name: "Summary" })).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("输入问题..."), "Help me");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "stream_chat_completion",
        expect.objectContaining({
          request: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: "system",
                content: "You are a tutor for Demo Article",
              }),
            ]),
          }),
        }),
      );
    });
  });

  it("renders all configured quick actions instead of truncating after the first custom action", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_active_model_config") {
        return Promise.resolve({
          id: "model-1",
          name: "Test Model",
          model: "gpt-4o-mini",
          api_provider: "openai",
        });
      }

      if (command === "get_config") {
        return Promise.resolve({
          target_language: "zh-CN",
          interface_language: "en",
          model_configs: [],
          prompt_features: [
            {
              id: "chat.default",
              kind: "chat_default",
              name: "Chat",
              description: "",
              prompt_template: "You are a tutor for {article_title}",
              requires_selection: false,
              show_in_quick_actions: false,
              icon: "sparkles",
              sort_order: 0,
              enabled: true,
              is_builtin: true,
            },
            {
              id: "selection.translate",
              kind: "quick_action",
              name: "Translate",
              description: "",
              prompt_template: "Translate {text}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "translate",
              sort_order: 10,
              enabled: true,
              is_builtin: true,
            },
            {
              id: "selection.explain",
              kind: "quick_action",
              name: "Explain",
              description: "",
              prompt_template: "Explain {text}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "explain",
              sort_order: 20,
              enabled: true,
              is_builtin: true,
            },
            {
              id: "selection.grammar",
              kind: "quick_action",
              name: "Grammar",
              description: "",
              prompt_template: "Grammar {text}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "grammar",
              sort_order: 30,
              enabled: true,
              is_builtin: true,
            },
            {
              id: "custom.summary",
              kind: "quick_action",
              name: "Summary",
              description: "",
              prompt_template: "Summarize {text}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "sparkles",
              sort_order: 40,
              enabled: true,
              is_builtin: false,
            },
            {
              id: "custom.rewrite",
              kind: "quick_action",
              name: "Rewrite",
              description: "",
              prompt_template: "Rewrite {text}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "sparkles",
              sort_order: 50,
              enabled: true,
              is_builtin: false,
            },
          ],
        });
      }

      if (command === "stream_chat_completion") {
        return Promise.resolve("ok");
      }

      return Promise.resolve(null);
    });

    renderAssistant();

    expect(await screen.findByRole("button", { name: "Rewrite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Translate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grammar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summary" })).toBeInTheDocument();
  });

  it("uses the configured translate prompt template when the builtin translate action is customized", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_active_model_config") {
        return Promise.resolve({
          id: "model-1",
          name: "Test Model",
          model: "gpt-4o-mini",
          api_provider: "openai",
        });
      }

      if (command === "get_config") {
        return Promise.resolve({
          target_language: "zh-CN",
          interface_language: "en",
          model_configs: [],
          prompt_features: [
            {
              id: "chat.default",
              kind: "chat_default",
              name: "Chat",
              description: "",
              prompt_template: "You are a tutor for {article_title}",
              requires_selection: false,
              show_in_quick_actions: false,
              icon: "sparkles",
              sort_order: 0,
              enabled: true,
              is_builtin: true,
            },
            {
              id: "selection.translate",
              kind: "quick_action",
              name: "Translate",
              description: "",
              prompt_template: "Explain the nuance of {text} in {target_language}",
              requires_selection: true,
              show_in_quick_actions: true,
              icon: "translate",
              sort_order: 10,
              enabled: true,
              is_builtin: true,
            },
          ],
        });
      }

      if (command === "stream_chat_completion") {
        return Promise.resolve("ok");
      }

      if (command === "translate_text") {
        return Promise.resolve({ translated_text: "translated" });
      }

      return Promise.resolve(null);
    });

    renderAssistant();

    await userEvent.click(await screen.findByRole("button", { name: "Translate" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "stream_chat_completion",
        expect.objectContaining({
          request: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                content: "Explain the nuance of Selected text in zh-CN",
              }),
            ]),
          }),
        }),
      );
    });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "translate_text",
      expect.anything(),
    );
  });

  it("renders the localized welcome message instead of a hardcoded English string", async () => {
    render(
      <ArticleChatAssistant
        articleId="article-1"
        articleTitle="Demo Article"
        targetLanguage="zh-CN"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText(/你好！我是你的阅读助手/).length).toBeGreaterThan(0);
    });
  });
});
