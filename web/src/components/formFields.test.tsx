// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateTimeField } from "./DateTimeField";
import { DeviceSelect } from "./DeviceSelect";

afterEach(() => {
  cleanup();
});

describe("DeviceSelect", () => {
  it("空值显示占位，已选设备显示机型文案", () => {
    const device = {
      deviceId: "beb5a721",
      model: "24129PN74C",
      marketName: "Xiaomi 15",
      deviceName: "Willie的Xiaomi 15",
    };
    const { rerender } = render(
      <DeviceSelect devices={[device]} value="" onValueChange={vi.fn()} />,
    );
    expect(screen.getByRole("combobox").textContent).toContain("请选择设备");
    rerender(<DeviceSelect devices={[device]} value="beb5a721" onValueChange={vi.fn()} />);
    expect(screen.getByRole("combobox").textContent).toContain("Xiaomi 15（Willie的Xiaomi 15）");
  });
});

describe("DateTimeField", () => {
  it("点选日期后写出开票时间，清除后回到空串", () => {
    const onChange = vi.fn();
    render(
      <DateTimeField
        value=""
        onChange={onChange}
        format="open-time"
        placeholder="留空则立即开抢"
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "留空则立即开抢" }));
    fireEvent.click(screen.getByRole("button", { name: "留空则立即开抢" }));

    const day = screen.getAllByRole("button").find((node) => node.textContent === "15");
    expect(day).toBeTruthy();
    fireEvent.click(day!);

    const written = onChange.mock.calls.at(-1)?.[0] as string;
    expect(written).toMatch(/^\d{4}-\d{2}-15 12:00:00$/);

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("监控时间写成 datetime-local", () => {
    const onChange = vi.fn();
    render(
      <DateTimeField
        value=""
        onChange={onChange}
        format="datetime-local"
        placeholder="留空则立即采样"
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "留空则立即采样" }));
    fireEvent.click(screen.getByRole("button", { name: "留空则立即采样" }));
    const day = screen.getAllByRole("button").find((node) => node.textContent === "3");
    expect(day).toBeTruthy();
    fireEvent.click(day!);
    expect(onChange.mock.calls.at(-1)?.[0]).toMatch(/^\d{4}-\d{2}-03T12:00$/);
  });
});
