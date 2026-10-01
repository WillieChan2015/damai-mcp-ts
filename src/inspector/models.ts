/**
 * UI 元素模型 + Android UIAutomator XML 的类 XPath 选择器
 * （Python `inspector/models.py` 的 TS 对应物）。
 *
 * 使用最小化的 XML 解析器（@xmldom/xmldom）而不是引入 `uiautomator2`，
 * 因为 (a) MCP 只需要对 XML 的只读访问，(b) uiautomator2 还会在设备内部
 * 运行一个 HTTP server，比必要的更重。
 */

/** UI 边界矩形 [x1, y1, x2, y2]（左上角与右下角）。 */
export type Bounds = readonly [number, number, number, number];

/** 元素中心点坐标 [cx, cy]。 */
export type Center = readonly [number, number];

/** {@link UIElement} 的构造参数；除 `tag` 外均带与 Python dataclass 一致的默认值。 */
export interface UIElementInit {
  /** XML 节点名（UIAutomator dump 中恒为 "node"）。 */
  tag: string;
  text?: string;
  resourceId?: string;
  className?: string;
  contentDesc?: string;
  bounds?: Bounds;
  clickable?: boolean;
  enabled?: boolean;
  selected?: boolean;
  checked?: boolean;
  password?: boolean;
  focused?: boolean;
  package?: string;
  /** 未提升为一等字段的原生 XML 属性。 */
  attrs?: Record<string, string> | null;
}

/** UIAutomator dump 中的一个节点。 */
export class UIElement {
  readonly tag: string;
  readonly text: string;
  readonly resourceId: string;
  readonly className: string;
  readonly contentDesc: string;
  readonly bounds: Bounds;
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly checked: boolean;
  readonly password: boolean;
  readonly focused: boolean;
  readonly package: string;
  readonly attrs: Record<string, string> | null;

  constructor(init: UIElementInit) {
    this.tag = init.tag;
    this.text = init.text ?? "";
    this.resourceId = init.resourceId ?? "";
    this.className = init.className ?? "";
    this.contentDesc = init.contentDesc ?? "";
    this.bounds = init.bounds ?? [0, 0, 0, 0];
    this.clickable = init.clickable ?? false;
    this.enabled = init.enabled ?? true;
    this.selected = init.selected ?? false;
    this.checked = init.checked ?? false;
    this.password = init.password ?? false;
    this.focused = init.focused ?? false;
    this.package = init.package ?? "";
    this.attrs = init.attrs ?? null;
  }

  /** 中心点坐标 ((x1+x2)//2, (y1+y2)//2)。 */
  get center(): Center {
    const [x1, y1, x2, y2] = this.bounds;
    return [Math.floor((x1 + x2) / 2), Math.floor((y1 + y2) / 2)];
  }

  get width(): number {
    return this.bounds[2] - this.bounds[0];
  }

  get height(): number {
    return this.bounds[3] - this.bounds[1];
  }

  get visible(): boolean {
    const [x1, y1, x2, y2] = this.bounds;
    return this.enabled && x2 > x1 && y2 > y1;
  }

  /**
   * 序列化为普通对象。
   *
   * 输出的键名保持 Python 版 `to_dict()` 的 snake_case 原样
   * （这是 MCP 工具响应的对外表面，改动会破坏行为保真）。
   */
  toDict(): {
    tag: string;
    text: string;
    resource_id: string;
    class_name: string;
    content_desc: string;
    bounds: number[];
    center: number[];
    clickable: boolean;
    enabled: boolean;
    selected: boolean;
    checked: boolean;
    package: string;
  } {
    return {
      tag: this.tag,
      text: this.text,
      resource_id: this.resourceId,
      class_name: this.className,
      content_desc: this.contentDesc,
      bounds: [...this.bounds],
      center: [...this.center],
      clickable: this.clickable,
      enabled: this.enabled,
      selected: this.selected,
      checked: this.checked,
      package: this.package,
    };
  }

  /** 对应 Python 版 `__repr__`：`<UIElement {tag} {label!r} @ {center}>`。 */
  toString(): string {
    const label = this.text || this.contentDesc || this.resourceId || this.className;
    const [cx, cy] = this.center;
    return `<UIElement ${this.tag} '${label}' @ (${cx}, ${cy})>`;
  }
}

/** bounds 字符串 `[x1,y1][x2,y2]` 的解析正则（与 Python re.match 相同：仅锚定开头）。 */
const BOUNDS_RE = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

/** 解析 bounds 字符串 `'[x1,y1][x2,y2]'`；不匹配时返回 `[0, 0, 0, 0]`。 */
export function parseBounds(boundsAttr: string): Bounds {
  const m = BOUNDS_RE.exec(boundsAttr);
  if (!m) {
    return [0, 0, 0, 0];
  }
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
