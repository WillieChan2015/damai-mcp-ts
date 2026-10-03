// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const saveViewerPresets = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({
  saveViewerPresets,
  startGrabTask: vi.fn(),
}));

import { TaskForm } from "./TaskForm";

describe("TaskForm 观演人快捷项", () => {
  afterEach(() => {
    cleanup();
    saveViewerPresets.mockReset();
  });

  it("没有已保存名单时不渲染示例姓名", () => {
    render(<TaskForm devices={[]} viewerPresets={[]} onStarted={() => undefined} />);
    expect(screen.queryByRole("button", { name: "+杨安琪" })).toBeNull();
    expect(screen.getByLabelText("添加快捷姓名")).toBeTruthy();
    expect(screen.getByPlaceholderText("姓名之间用逗号分隔")).toBeTruthy();
  });

  it("添加后出现按钮，点击按钮写入观演人输入框", async () => {
    saveViewerPresets.mockResolvedValue({ data: { names: ["王五"] } });
    render(<TaskForm devices={[]} viewerPresets={[]} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("添加快捷姓名"), { target: { value: " 王五 " } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findByRole("button", { name: "+王五" })).toBeTruthy();
    expect(saveViewerPresets).toHaveBeenCalledWith({ names: ["王五"] });

    fireEvent.click(screen.getByRole("button", { name: "+王五" }));
    expect(screen.getByPlaceholderText("姓名之间用逗号分隔")).toHaveProperty("value", "王五");
  });

  it("保存失败时名单不变", async () => {
    saveViewerPresets.mockResolvedValue({ serverError: "保存观演人快捷项失败: 磁盘只读" });
    render(<TaskForm devices={[]} viewerPresets={["王五"]} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("添加快捷姓名"), { target: { value: "赵六" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findByText("保存观演人快捷项失败: 磁盘只读")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+王五" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+赵六" })).toBeNull();
  });

  it("含逗号的姓名不提交，已有名单保留", () => {
    render(<TaskForm devices={[]} viewerPresets={["王五"]} onStarted={() => undefined} />);
    fireEvent.change(screen.getByLabelText("添加快捷姓名"), { target: { value: "杨安琪,张三" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByText("姓名不能包含逗号")).toBeTruthy();
    expect(saveViewerPresets).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "+王五" })).toBeTruthy();
  });

  it("移除后按剩余名单保存", async () => {
    saveViewerPresets.mockResolvedValue({ data: { names: [] } });
    render(<TaskForm devices={[]} viewerPresets={["王五"]} onStarted={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "移除快捷姓名 王五" }));
    expect(await screen.findByLabelText("添加快捷姓名")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+王五" })).toBeNull();
    expect(saveViewerPresets).toHaveBeenCalledWith({ names: [] });
  });
});
