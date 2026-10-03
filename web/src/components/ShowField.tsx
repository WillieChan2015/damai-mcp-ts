"use client";

import { useEffect, useRef, useState } from "react";

import { extractDamaiItemId } from "@core/damai/itemId";

import { readCurrentShow, resolveShareShow } from "@/app/show/actions";

/**
 * 演出来源：读取手机前台详情，或粘贴大麦分享文字。
 * 编号写入父表单的 itemId，用户不必自己从链接里摘数字。
 */
export function ShowField({
  deviceId,
  itemId,
  onItemIdChange,
  itemError,
}: {
  deviceId: string;
  itemId: string;
  onItemIdChange: (itemId: string) => void;
  itemError?: string;
}) {
  const [shareText, setShareText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [manual, setManual] = useState(false);
  const onChangeRef = useRef(onItemIdChange);
  onChangeRef.current = onItemIdChange;

  useEffect(() => {
    const trimmed = shareText.trim();
    if (trimmed === "") {
      setResolving(false);
      return;
    }
    const direct = extractDamaiItemId(trimmed);
    if (direct !== null) {
      onChangeRef.current(direct);
      setMessage("已从分享内容识别演出。");
      setResolving(false);
      return;
    }
    if (!/https?:\/\//i.test(trimmed)) {
      setResolving(false);
      return;
    }
    setResolving(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await resolveShareShow({ text: trimmed });
        if (cancelled) {
          return;
        }
        if (result.serverError) {
          setMessage(result.serverError);
          setManual(true);
        } else if (result.data) {
          if (result.data.itemId !== null) {
            onChangeRef.current(result.data.itemId);
          } else {
            setManual(true);
          }
          setMessage(result.data.message);
        }
        setResolving(false);
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [shareText]);

  const readFromPhone = async (): Promise<void> => {
    if (deviceId.trim() === "") {
      setMessage("请先选择手机。");
      return;
    }
    setReading(true);
    setMessage(null);
    const result = await readCurrentShow({ deviceId });
    setReading(false);
    if (result.serverError) {
      setMessage(result.serverError);
      setManual(true);
      return;
    }
    if (result.data?.itemId) {
      onChangeRef.current(result.data.itemId);
      setMessage(result.data.message);
      return;
    }
    setManual(true);
    setMessage(result.data?.message ?? "没有读到演出。");
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-muted">演出</label>
        <p className="mt-0.5 text-[11px] text-muted">
          在手机大麦里打开要抢的那场，点读取。或在演出页点分享，把复制的文字粘贴到下面。
        </p>
      </div>

      <button
        type="button"
        onClick={() => void readFromPhone()}
        disabled={reading}
        className="btn btn-secondary px-3 py-1.5 text-xs"
      >
        {reading ? "正在读取手机…" : "读取手机当前演出"}
      </button>

      <div>
        <label htmlFor="show-share" className="block text-xs font-medium text-muted">
          分享内容
        </label>
        <textarea
          id="show-share"
          value={shareText}
          onChange={(event) => setShareText(event.target.value)}
          rows={3}
          placeholder="粘贴大麦分享的文字或链接"
          className="field mt-1 text-xs"
        />
        {resolving ? <p className="mt-1 text-[11px] text-muted">正在从链接识别…</p> : null}
      </div>

      {itemId !== "" ? (
        <div className="flex items-center justify-between gap-2 rounded border border-ok/30 bg-ok/10 px-3 py-2">
          <p className="text-xs text-ink">
            已选定演出 <span className="font-mono">{itemId}</span>
          </p>
          <button
            type="button"
            onClick={() => onItemIdChange("")}
            className="text-[11px] text-muted hover:text-ink"
          >
            清除
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-muted">还没选定演出。</p>
      )}

      {message ? <p className="text-xs text-ink">{message}</p> : null}
      {itemError ? <p className="text-xs text-danger">{itemError}</p> : null}

      {manual ? (
        <div>
          <label htmlFor="show-item-id" className="block text-xs font-medium text-muted">
            演出编号
          </label>
          <input
            id="show-item-id"
            value={itemId}
            onChange={(event) => onItemIdChange(event.target.value.trim())}
            placeholder="读取或粘贴失败时，在这里填写"
            className="field mt-1 font-mono text-xs"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setManual(true)}
          className="text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          直接填写编号
        </button>
      )}
    </div>
  );
}
