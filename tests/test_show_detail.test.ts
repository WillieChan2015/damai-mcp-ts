import { describe, expect, it } from "vitest";

import { detailFromNodes, type DetailNode } from "../src/damai/showDetail";

function node(resourceId: string, text = ""): DetailNode {
  return { package: "cn.damai", resourceId: `cn.damai:id/${resourceId}`, text };
}

describe("detailFromNodes", () => {
  it("拼上被拆开的标题，并标出当前选中的巡演站", () => {
    const detail = detailFromNodes([
      node("info_v2_poster_tag_pioneer", "演唱会"),
      node("info_v2_title_tv1", " 广州·恒星之城（广州）限定"),
      node("info_v2_title_tv2", "场演唱会"),
      node("info_v2_time_and_duration_tv", "2026.10.17-10.18 约120分钟（以现场为准）"),
      node("info_v2_price_symbol", "¥"),
      node("info_v2_price_left", "488"),
      node("info_v2_price_right", "1688"),
      node("tour_city_normal_bg"),
      node("tour_city_name", "上海站"),
      node("tour_city_name_state_desc", "预约"),
      node("tour_city_name_show_time", "11.20-11.22"),
      node("tour_city_select_bg"),
      node("tour_city_name", "广州站"),
      node("tour_city_name_state_desc", "热卖"),
      node("tour_city_name_show_time", "10.17-10.18"),
      node("venue_name_0", "广州市\u00a0·\u00a0广东省奥林匹克体育中心体育场"),
      node("venue_address_0", "广东省广州市天河区黄村街道广东奥林匹克体育中心"),
      node("project_support_content_tv", "条件退"),
      node("project_support_content_tv", "实名制购票和入场"),
      node("project_support_content_tv", "条件退"),
    ]);
    expect(detail).toEqual({
      title: "广州·恒星之城（广州）限定场演唱会",
      category: "演唱会",
      time: "2026.10.17-10.18 约120分钟（以现场为准）",
      price: "¥488–1688",
      venue: "广州市 · 广东省奥林匹克体育中心体育场",
      address: "广东省广州市天河区黄村街道广东奥林匹克体育中心",
      cities: [
        { name: "上海站", state: "预约", time: "11.20-11.22", selected: false },
        { name: "广州站", state: "热卖", time: "10.17-10.18", selected: true },
      ],
      notices: ["条件退", "实名制购票和入场"],
    });
  });

  it("没有详情字段时返回空", () => {
    expect(detailFromNodes([node("project_detail_title_bar_back_btn", "返回")])).toBeNull();
  });
});
