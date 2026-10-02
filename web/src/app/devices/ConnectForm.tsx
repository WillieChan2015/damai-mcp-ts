"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { deviceConnectSchema } from "@core/schemas/grab";

import { connectDevice } from "./actions";

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

  return (
    <form onSubmit={onSubmit} className="flex items-start gap-2">
      <div className="flex-1">
        <input
          {...form.register("hostPort")}
          placeholder="ADB 地址，如 127.0.0.1:5555 或设备序列号"
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        {form.formState.errors.hostPort ? (
          <p className="mt-1 text-xs text-red-600">{form.formState.errors.hostPort.message}</p>
        ) : null}
        {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
      </div>
      <button
        type="submit"
        disabled={isPending || form.formState.isSubmitting}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {form.formState.isSubmitting ? "连接中…" : "连接"}
      </button>
    </form>
  );
}
