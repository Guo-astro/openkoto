import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebImportForm } from "./WebImportForm";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const RAW_CONTENT = ["首页 登录 注册", "这是正文第一段，讲述了故事的开端。", "相关推荐：点击查看更多", "这是正文第二段。"].join(
  "\n"
);
const CLEANED_CONTENT = ["这是正文第一段，讲述了故事的开端。", "这是正文第二段。"].join("\n");

const configWithModel = {
  model_configs: [{ id: "model-1" }],
  active_model_id: "model-1",
};

function mockInvoke(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation((command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    switch (command) {
      case "get_config":
        return Promise.resolve(configWithModel);
      case "fetch_url_content":
        return Promise.resolve({ title: "原始标题 - 某站点", content: RAW_CONTENT });
      default:
        return Promise.resolve(null);
    }
  });
}

async function fetchPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("webImport.urlPlaceholder"), "https://example.com/a");
  await user.click(screen.getByRole("button", { name: /webImport.fetchPreview/ }));
}

describe("WebImportForm smart cleaning mode", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    mockInvoke();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the raw extraction in classic mode", async () => {
    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await fetchPreview(user);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT)
    );
    expect(invokeMock).not.toHaveBeenCalledWith("clean_web_content_cmd", expect.anything());
  });

  it("cleans the fetched content and reports what was removed in smart mode", async () => {
    mockInvoke({
      clean_web_content_cmd: {
        title: "原始标题",
        content: CLEANED_CONTENT,
        removed_lines: 2,
        removed_chars: 18,
        kept_lines: 2,
        partial: false,
      },
    });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /webImport.modes.smart/ }));
    await fetchPreview(user);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(
        CLEANED_CONTENT
      )
    );
    expect(screen.getByDisplayValue("原始标题")).toBeInTheDocument();
    expect(screen.getByText("webImport.clean.summary")).toBeInTheDocument();
  });

  it("can toggle back to the raw extraction after cleaning", async () => {
    mockInvoke({
      clean_web_content_cmd: {
        title: "原始标题",
        content: CLEANED_CONTENT,
        removed_lines: 2,
        removed_chars: 18,
        kept_lines: 2,
        partial: false,
      },
    });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /webImport.modes.smart/ }));
    await fetchPreview(user);
    await waitFor(() => screen.getByText("webImport.clean.showRaw"));

    await user.click(screen.getByText("webImport.clean.showRaw"));
    expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT);

    await user.click(screen.getByText("webImport.clean.showCleaned"));
    expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(
      CLEANED_CONTENT
    );
  });

  it("falls back to the raw extraction when cleaning fails", async () => {
    mockInvoke({ clean_web_content_cmd: new Error("WEB_CLEAN_TOO_SHORT") });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /webImport.modes.smart/ }));
    await fetchPreview(user);

    await waitFor(() => expect(screen.getByText("webImport.errors.cleanTooShort")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT);
  });

  it("restores the raw extraction when switching back to classic mode", async () => {
    mockInvoke({
      clean_web_content_cmd: {
        title: "原始标题",
        content: CLEANED_CONTENT,
        removed_lines: 2,
        removed_chars: 18,
        kept_lines: 2,
        partial: false,
      },
    });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /webImport.modes.smart/ }));
    await fetchPreview(user);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(
        CLEANED_CONTENT
      )
    );

    await user.click(screen.getByRole("button", { name: /webImport.modes.classic/ }));
    expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT);
    expect(screen.queryByText("webImport.clean.summary")).not.toBeInTheDocument();
  });

  it("cleans on demand in classic mode without switching modes", async () => {
    mockInvoke({
      clean_web_content_cmd: {
        title: "原始标题",
        content: CLEANED_CONTENT,
        removed_lines: 2,
        removed_chars: 18,
        kept_lines: 2,
        partial: false,
      },
    });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await fetchPreview(user);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT)
    );

    await user.click(screen.getByRole("button", { name: /webImport.clean.action/ }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(
        CLEANED_CONTENT
      )
    );
    // 没切模式，经典模式仍然选中
    expect(screen.getByRole("button", { name: /webImport.modes.classic/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  /// 手动清洗按编辑区当前的内容走，而不是抓取回来的那一版——用户可能已经手改过。
  it("cleans the edited content, not the fetched snapshot", async () => {
    mockInvoke({
      clean_web_content_cmd: {
        title: "",
        content: "留下来的正文。",
        removed_lines: 1,
        removed_chars: 5,
        kept_lines: 1,
        partial: false,
      },
    });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await fetchPreview(user);
    const textarea = await screen.findByPlaceholderText("webImport.contentPlaceholder");
    await waitFor(() => expect(textarea).toHaveValue(RAW_CONTENT));

    await user.clear(textarea);
    await user.type(textarea, "我自己贴进来的一段正文。");
    await user.click(screen.getByRole("button", { name: /webImport.clean.action/ }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "clean_web_content_cmd",
        expect.objectContaining({ content: "我自己贴进来的一段正文。" })
      )
    );
  });

  it("disables the clean button when no AI model is configured", async () => {
    mockInvoke({ get_config: { model_configs: [], active_model_id: undefined } });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await fetchPreview(user);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT)
    );

    expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeDisabled();
  });

  it("warns when no AI model is configured", async () => {
    mockInvoke({ get_config: { model_configs: [], active_model_id: undefined } });

    const user = userEvent.setup();
    render(<WebImportForm onCancel={() => {}} />);

    await user.click(screen.getByRole("button", { name: /webImport.modes.smart/ }));

    expect(screen.getByText("webImport.modes.smartUnavailable")).toBeInTheDocument();

    await fetchPreview(user);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("webImport.contentPlaceholder")).toHaveValue(RAW_CONTENT)
    );
    expect(invokeMock).not.toHaveBeenCalledWith("clean_web_content_cmd", expect.anything());
  });
});
