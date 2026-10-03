// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageResponse } from "./message";

/**
 * MessageResponse 是 AI 助手文本的 markdown 渲染出口（AI Elements，内嵌 streamdown）：
 * 校验标题/加粗/列表转成真实 DOM，而不是像旧版那样原样输出 markdown 符号。
 * 注意：streamdown 用 <span data-streamdown="strong"> 而非 <strong> 承载加粗。
 */

describe("MessageResponse", () => {
  afterEach(cleanup);

  it("渲染标题、加粗与列表为 DOM 元素而非原始符号", () => {
    render(
      <MessageResponse>{"### 演出信息\n\n- **标题**：恒星之城"}</MessageResponse>,
    );

    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.textContent).toBe("演出信息");
    expect(screen.getByText("标题").getAttribute("data-streamdown")).toBe(
      "strong",
    );
    expect(screen.getByRole("listitem").textContent).toContain("恒星之城");
    expect(document.body.textContent).not.toContain("###");
    expect(document.body.textContent).not.toContain("**");
  });

  it("流式半截加粗（未闭合 **）按加粗渲染，不露出原始星号", () => {
    render(<MessageResponse>{"当前手机界面是**大麦 App"}</MessageResponse>);

    expect(screen.getByText("大麦 App").getAttribute("data-streamdown")).toBe(
      "strong",
    );
    expect(document.body.textContent).not.toContain("**");
  });
});
