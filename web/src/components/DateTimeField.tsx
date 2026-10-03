"use client";

import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import { zhCN as zhCNDayPicker } from "react-day-picker/locale";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";

import {
  formatDateTimeValue,
  parseDateTimeValue,
  type DateTimeValueFormat,
} from "./dateTimeValue";

/**
 * 日期 + 时间。日历是 shadcn Calendar，时间用 time 输入。
 * `open-time` 写出 `YYYY-MM-DD HH:MM:SS`；`datetime-local` 写出 `YYYY-MM-DDTHH:mm`。
 * 清除后写空串。
 */
export function DateTimeField({
  value,
  onChange,
  format: valueFormat,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  format: DateTimeValueFormat;
  placeholder: string;
  className?: string;
}) {
  const parts = parseDateTimeValue(value, valueFormat);
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const time = timeDraft ?? parts.time;
  const withSeconds = valueFormat === "open-time";

  function commit(date: Date | undefined, nextTime: string) {
    if (!date || nextTime === "") {
      onChange("");
      return;
    }
    onChange(formatDateTimeValue(date, nextTime, valueFormat));
    setTimeDraft(null);
  }

  const label = parts.date
    ? `${format(parts.date, "yyyy-MM-dd", { locale: zhCN })} ${parts.time}`
    : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          data-empty={!parts.date}
          className={cn(
            "w-full justify-start px-2.5 text-left font-mono text-xs font-normal data-[empty=true]:text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon />
          {label ?? placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={zhCNDayPicker}
          selected={parts.date}
          onSelect={(date) => commit(date, time)}
        />
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">时间</span>
          <Input
            type="time"
            step={withSeconds ? 1 : 60}
            value={withSeconds ? time : time.slice(0, 5)}
            onChange={(event) => {
              const raw = event.target.value;
              const next = withSeconds && raw.length === 5 ? `${raw}:00` : raw;
              setTimeDraft(next);
              if (parts.date) commit(parts.date, next);
            }}
            className="h-7 w-auto font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setTimeDraft(null);
              onChange("");
            }}
          >
            清除
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
