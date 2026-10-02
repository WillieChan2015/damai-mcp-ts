"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useState } from "react";

import { disconnectDevice } from "./actions";

/** 断开单个设备（行内按钮）。 */
export function DisconnectButton({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onDisconnect = (): void => {
    setError(null);
    startTransition(async () => {
      const result = await disconnectDevice({ deviceId });
      if (result.serverError) {
        setError(result.serverError);
        return;
      }
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={onDisconnect}
        disabled={isPending}
        className="text-xs text-red-600 hover:underline disabled:opacity-50"
      >
        {isPending ? "断开中…" : "断开"}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
