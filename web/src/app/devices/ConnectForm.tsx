"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { deviceConnectSchema } from "@core/schemas/grab";
import { connectDevice } from "./actions";

const PRESET_PORTS = [
  { label: "标准模拟器 (5555)", host: "127.0.0.1:5555" },
  { label: "MuMu 模拟器 (16384)", host: "127.0.0.1:16384" },
  { label: "网易 MuMu 6 (7555)", host: "127.0.0.1:7555" },
  { label: "夜神 Nox (62001)", host: "127.0.0.1:62001" },
];

/** 连接设备表单：ADB 无线地址（host:port）或 USB 序列号。 */
export function ConnectForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(deviceConnectSchema),
    defaultValues: { hostPort: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const result = await connectDevice(values);
    if (result.serverError) {
      setError(result.serverError);
      return;
    }
    form.reset({ hostPort: "" });
    startTransition(() => router.refresh());
  });

  const setPreset = (host: string) => {
    form.setValue("hostPort", host);
    setError(null);
  };

  return (
    <Card className="p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">添加网络模拟器 / 无线设备</h2>
        <p className="mt-0.5 text-xs text-muted">
          真机请直接插 USB 并开启「开发者选项 → USB 调试」即可自动识别；网络模拟器请在此输入 ADB 地址。
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <Input
            {...form.register("hostPort")}
            placeholder="如 127.0.0.1:5555 或网络 host:port"
            className="font-mono text-xs"
          />
          {form.formState.errors.hostPort ? (
            <p className="mt-1 text-xs text-danger">{form.formState.errors.hostPort.message}</p>
          ) : null}
          {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
        </div>
        <Button
          type="submit"
          disabled={isPending || form.formState.isSubmitting}
          size="sm" className="shrink-0"
        >
          {form.formState.isSubmitting ? "正在建立 ADB 连接…" : "连接设备"}
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-line">
        <span className="text-[11px] text-muted">常见模拟器预设端口：</span>
        {PRESET_PORTS.map((p) => (
          <Button
            key={p.host}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setPreset(p.host)}
            className="font-mono"
          >
            {p.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}
