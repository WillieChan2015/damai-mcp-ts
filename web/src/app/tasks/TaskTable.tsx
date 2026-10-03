"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import type { TaskSnapshot } from "@/task/manager";

const helper = createColumnHelper<TaskSnapshot>();

const STATUS_CLS: Record<string, string> = {
  running: "border-info/30 bg-info/10 text-info",
  cancelling: "border-warn/30 bg-warn/10 text-warn",
  cancelled: "border-line bg-secondary text-muted",
  succeeded: "border-ok/30 bg-ok/10 text-ok",
  failed: "border-danger/30 bg-danger/10 text-danger",
};

const STATUS_TEXT: Record<string, string> = {
  running: "运行中",
  cancelling: "取消中",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
};

const columns = [
  helper.accessor("id", {
    header: "任务",
    cell: (info) => (
      <span className="font-mono text-xs">{info.getValue().slice(0, 8)}</span>
    ),
  }),
  helper.accessor("kind", {
    header: "类型",
    cell: (info) => (info.getValue() === "grab" ? "抢票" : info.getValue()),
  }),
  helper.accessor("deviceId", {
    header: "设备",
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor("label", { header: "描述" }),
  helper.accessor("status", {
    header: "状态",
    cell: (info) => (
      <Badge variant="outline" className={STATUS_CLS[info.getValue()] ?? ""}>
        {STATUS_TEXT[info.getValue()] ?? info.getValue()}
        {info.row.original.unresponsive ? "（未响应）" : ""}
      </Badge>
    ),
  }),
];

/** 任务列表（TanStack Table 基础行模型；纯展示，便于单测）。 */
export function TaskTable({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: TaskSnapshot[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const table = useReactTable({ data: tasks, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <table className="w-full text-sm">
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id} className="border-b border-line text-left text-muted">
            {hg.headers.map((header) => (
              <th key={header.id} className="py-2 pr-4 font-medium">
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr
            key={row.id}
            onClick={() => onSelect(row.original.id)}
            className={`cursor-pointer border-b border-line transition-colors hover:bg-surface-raised ${
              row.original.id === selectedId ? "bg-surface-raised font-medium" : ""
            }`}
          >
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} className="py-2 pr-4">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
