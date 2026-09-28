import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewArticleForm } from "./NewArticleForm";

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

const PASTED = ["首页 登录 注册", "这是正文第一段，讲述了故事的开端。", "版权所有 © 某站点", "这是正文第二段。"].join(
  "\n"
);
const CLEANED = ["这是正文第一段，讲述了故事的开端。", "这是正文第二段。"].join("\n");

const configWithModel = { model_configs: [{ id: "model-1" }], active_model_id: "model-1" };

function mockInvoke(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation((command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    if (command === "get_config") return Promise.resolve(configWithModel);
    return Promise.resolve(null);
  });
}

const CLEAN_OK = {
  title: "干净标题",
  content: CLEANED,
  removed_lines: 2,
  removed_chars: 20,
  kept_lines: 2,
  partial: false,
};

async function typeContent(user: ReturnType<typeof userEvent.setup>, text: string) {
  const textarea = screen.getByPlaceholderText("newArticle.contentPlaceholder");
  await user.click(textarea);
  await user.paste(text);
  return textarea;
}

describe("NewArticleForm AI cleaning", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    mockInvoke();
  });

  afterEach(() => {
    cleanup();
  });

  it("cleans the pasted text and reports what was removed", async () => {
    mockInvoke({ clean_web_content_cmd: CLEAN_OK });

    const user = userEvent.setup();
    render(<NewArticleForm onCancel={() => {}} />);

    const textarea = await typeContent(user, PASTED);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: /webImport.clean.action/ }));

    await waitFor(() => expect(textarea).toHaveValue(CLEANED));
    expect(screen.getByText("webImport.clean.summary")).toBeInTheDocument();
    expect(screen.getByDisplayValue("干净标题")).toBeInTheDocument();
  });

  it("can toggle back to the text as it was before cleaning", async () => {
    mockInvoke({ clean_web_content_cmd: CLEAN_OK });

    const user = userEvent.setup();
    render(<NewArticleForm onCancel={() => {}} />);

    const textarea = await typeContent(user, PASTED);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: /webImport.clean.action/ }));
    await waitFor(() => screen.getByText("webImport.clean.showRaw"));

    await user.click(screen.getByText("webImport.clean.showRaw"));
    expect(textarea).toHaveValue(PASTED);

    await user.click(screen.getByText("webImport.clean.showCleaned"));
    expect(textarea).toHaveValue(CLEANED);
  });

  /// 清洗失败最要紧的是别把用户贴进来的正文弄丢。
  it("keeps the original text when cleaning fails", async () => {
    mockInvoke({ clean_web_content_cmd: new Error("WEB_CLEAN_TOO_SHORT") });

    const user = userEvent.setup();
    render(<NewArticleForm onCancel={() => {}} />);

    const textarea = await typeContent(user, PASTED);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: /webImport.clean.action/ }));

    await waitFor(() =>
      expect(screen.getByText("webImport.errors.cleanTooShort")).toBeInTheDocument()
    );
    expect(textarea).toHaveValue(PASTED);
  });

  it("disables cleaning until there is enough text", async () => {
    const user = userEvent.setup();
    render(<NewArticleForm onCancel={() => {}} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_config"));
    expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeDisabled();

    await typeContent(user, "太短");
    expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeDisabled();
  });

  it("disables cleaning when no AI model is configured", async () => {
    mockInvoke({ get_config: { model_configs: [], active_model_id: undefined } });

    const user = userEvent.setup();
    render(<NewArticleForm onCancel={() => {}} />);

    await typeContent(user, PASTED);
    expect(screen.getByRole("button", { name: /webImport.clean.action/ })).toBeDisabled();
  });
});
