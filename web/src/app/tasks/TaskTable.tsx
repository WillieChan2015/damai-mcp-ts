"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import type { TaskSnapshot } from "@/task/manager";

const helper = createColumnHelper<TaskSnapshot>();

const STATUS_CLS: Record<string, string> = {
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  cancelling: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  cancelled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  succeeded: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
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
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
          STATUS_CLS[info.getValue()] ?? ""
        }`}
      >
        {STATUS_TEXT[info.getValue()] ?? info.getValue()}
        {info.row.original.unresponsive ? "（未响应）" : ""}
      </span>
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
          <tr key={hg.id} className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
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
            className={`cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900 ${
              row.original.id === selectedId ? "bg-zinc-50 dark:bg-zinc-900" : ""
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
