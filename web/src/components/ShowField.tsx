"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { useEffect, useRef, useState } from "react";

import { extractDamaiItemId } from "@core/damai/itemId";
import type { ShowDetail } from "@core/damai/showDetail";

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
  const [detail, setDetail] = useState<ShowDetail | null>(null);
  const [reading, setReading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [manual, setManual] = useState(false);
  const onChangeRef = useRef(onItemIdChange);
  onChangeRef.current = onItemIdChange;

  const selectShow = (nextItemId: string, nextDetail: ShowDetail | null): void => {
    onChangeRef.current(nextItemId);
    setDetail(nextDetail);
  };

  useEffect(() => {
    const trimmed = shareText.trim();
    if (trimmed === "") {
      setResolving(false);
      return;
    }
    const direct = extractDamaiItemId(trimmed);
    if (direct !== null) {
      selectShow(direct, null);
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
        } else         if (result.data) {
          if (result.data.itemId !== null) {
            selectShow(result.data.itemId, null);
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
      selectShow(result.data.itemId, result.data.detail);
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

      <Button
        type="button"
        onClick={() => void readFromPhone()}
        disabled={reading}
        variant="outline" size="sm"
      >
        {reading ? "正在读取手机…" : "读取手机当前演出"}
      </Button>

      <div>
        <label htmlFor="show-share" className="block text-xs font-medium text-muted">
          分享内容
        </label>
        <Textarea
          id="show-share"
          value={shareText}
          onChange={(event) => setShareText(event.target.value)}
          rows={3}
          placeholder="粘贴大麦分享的文字或链接"
          className="mt-1 text-xs"
        />
        {resolving ? <p className="mt-1 text-[11px] text-muted">正在从链接识别…</p> : null}
      </div>

      {itemId !== "" ? (
        <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              {detail?.category ? <p className="text-[11px] text-muted">{detail.category}</p> : null}
              <p className="text-xs font-medium text-ink">{detail?.title ?? "已选定演出"}</p>
              {detail?.time ? <p className="mt-0.5 text-[11px] text-muted">{detail.time}</p> : null}
              {detail?.price ? <p className="mt-0.5 text-xs text-ink">{detail.price}</p> : null}
              {detail?.venue ? <p className="mt-0.5 text-[11px] text-ink">{detail.venue}</p> : null}
              {detail?.address ? <p className="text-[11px] text-muted">{detail.address}</p> : null}
            </div>
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => selectShow("", null)}
              className="h-auto shrink-0 px-0 text-[11px] text-muted"
            >
              清除
            </Button>
          </div>
          {detail && detail.cities.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {detail.cities.map((city) => (
                <li
                  key={city.name}
                  className={
                    city.selected
                      ? "rounded border border-ink/30 bg-surface px-2 py-1 text-[11px] text-ink"
                      : "rounded border border-transparent px-2 py-1 text-[11px] text-muted"
                  }
                >
                  {city.name}
                  {city.state ? ` ${city.state}` : ""}
                  {city.time ? ` ${city.time}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {detail && detail.notices.length > 0 ? (
            <p className="mt-2 text-[11px] text-muted">{detail.notices.join(" · ")}</p>
          ) : null}
          <p className="mt-1 font-mono text-[11px] text-muted">{itemId}</p>
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
          <Input
            id="show-item-id"
            value={itemId}
            onChange={(event) => selectShow(event.target.value.trim(), null)}
            placeholder="读取或粘贴失败时，在这里填写"
            className="mt-1 font-mono text-xs"
          />
        </div>
      ) : (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={() => setManual(true)}
          className="h-auto px-0 text-[11px] text-muted"
        >
          直接填写编号
        </Button>
      )}
    </div>
  );
}
