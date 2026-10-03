// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShowField } from "./ShowField";

const readMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/show/actions", () => ({
  readCurrentShow: readMock,
  resolveShareShow: vi.fn(),
}));

afterEach(() => {
  cleanup();
  readMock.mockReset();
});

describe("ShowField", () => {
  it("读取后展示标题、票价、场馆和当前站，编号仍在", async () => {
    readMock.mockResolvedValueOnce({
      data: {
        itemId: "1082041144079",
        message: "已从手机当前页面识别演出。",
        detail: {
          title: "广州·恒星之城限定场演唱会",
          category: "演唱会",
          time: "2026.10.17-10.18",
          price: "¥488–1688",
          venue: "广东省奥林匹克体育中心体育场",
          address: "广东省广州市天河区",
          cities: [
            { name: "上海站", state: "预约", time: "11.20-11.22", selected: false },
            { name: "广州站", state: "热卖", time: "10.17-10.18", selected: true },
          ],
          notices: ["条件退", "实名制购票和入场"],
        },
      },
    });
    const onItemIdChange = vi.fn();
    const view = render(<ShowField deviceId="phone" itemId="" onItemIdChange={onItemIdChange} />);
    fireEvent.click(screen.getByRole("button", { name: "读取手机当前演出" }));
    expect(await screen.findByText("已从手机当前页面识别演出。")).toBeTruthy();
    view.rerender(
      <ShowField deviceId="phone" itemId="1082041144079" onItemIdChange={onItemIdChange} />,
    );
    expect(screen.getByText("广州·恒星之城限定场演唱会")).toBeTruthy();
    expect(screen.getByText("¥488–1688")).toBeTruthy();
    expect(screen.getByText("广东省奥林匹克体育中心体育场")).toBeTruthy();
    expect(screen.getByText("广州站 热卖 10.17-10.18")).toBeTruthy();
    expect(screen.getByText("1082041144079")).toBeTruthy();
    expect(onItemIdChange).toHaveBeenCalledWith("1082041144079");
  });
});
