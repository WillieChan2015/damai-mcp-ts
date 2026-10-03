"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

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
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={onDisconnect}
        disabled={isPending}
        className="h-auto px-0 text-xs text-destructive"
      >
        {isPending ? "断开中…" : "断开"}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
