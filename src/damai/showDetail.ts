/**
 * 从大麦详情页的无障碍节点里抽出给人看的字段。
 * 编号不在这些节点里，标题、时间、票价、场馆和巡演站在固定 resource-id 上。
 */

export interface ShowCity {
  name: string;
  state: string | null;
  time: string | null;
  /** 当前详情页选中的那一站。 */
  selected: boolean;
}

export interface ShowDetail {
  title: string | null;
  /** 海报角标，例如「演唱会」。 */
  category: string | null;
  time: string | null;
  /** 已带人民币符号，例如「¥488–1688」。 */
  price: string | null;
  venue: string | null;
  address: string | null;
  cities: ShowCity[];
  notices: string[];
}

export interface DetailNode {
  package?: string;
  text?: string;
  resourceId?: string;
}

export function detailFromNodes(nodes: readonly DetailNode[]): ShowDetail | null {
  const textOf = new Map<string, string>();
  const notices: string[] = [];
  const cities: ShowCity[] = [];
  let city: ShowCity | null = null;

  const flushCity = (): void => {
    if (city !== null && city.name !== "") {
      cities.push(city);
    }
    city = null;
  };

  for (const node of nodes) {
    const id = resourceName(node.resourceId ?? "");
    const text = normalizeText(node.text ?? "");
    if (id === "tour_city_select_bg" || id === "tour_city_normal_bg") {
      flushCity();
      city = { name: "", state: null, time: null, selected: id === "tour_city_select_bg" };
      continue;
    }
    if (city !== null && id === "tour_city_name" && text !== "") {
      city = { ...city, name: text };
      continue;
    }
    if (city !== null && id === "tour_city_name_state_desc" && text !== "") {
      city = { ...city, state: text };
      continue;
    }
    if (city !== null && id === "tour_city_name_show_time" && text !== "") {
      city = { ...city, time: text };
      continue;
    }
    if (id === "project_support_content_tv" && text !== "" && !notices.includes(text)) {
      notices.push(text);
      continue;
    }
    if (text !== "" && !textOf.has(id)) {
      textOf.set(id, text);
    }
  }
  flushCity();

  const title = joinTitle(textOf.get("info_v2_title_tv1"), textOf.get("info_v2_title_tv2"));
  const detail: ShowDetail = {
    title,
    category: textOf.get("info_v2_poster_tag_pioneer") ?? null,
    time: textOf.get("info_v2_time_and_duration_tv") ?? null,
    price: formatPrice(textOf.get("info_v2_price_left"), textOf.get("info_v2_price_right")),
    venue: textOf.get("venue_name_0") ?? null,
    address: textOf.get("venue_address_0") ?? null,
    cities,
    notices,
  };
  if (
    detail.title === null &&
    detail.time === null &&
    detail.price === null &&
    detail.venue === null &&
    detail.cities.length === 0
  ) {
    return null;
  }
  return detail;
}

function resourceName(resourceId: string): string {
  const slash = resourceId.lastIndexOf("/");
  return slash === -1 ? resourceId : resourceId.slice(slash + 1);
}

function normalizeText(text: string): string {
  return text.replaceAll("\u00a0", " ").replace(/\s+/g, " ").trim();
}

function joinTitle(first: string | undefined, second: string | undefined): string | null {
  const head = first ?? "";
  const tail = second ?? "";
  if (head === "" && tail === "") {
    return null;
  }
  if (tail === "" || head.endsWith(tail)) {
    return head || tail;
  }
  return head + tail;
}

function formatPrice(left: string | undefined, right: string | undefined): string | null {
  if (!left && !right) {
    return null;
  }
  if (left && right && left !== right) {
    return `¥${left}–${right}`;
  }
  return `¥${left ?? right}`;
}
