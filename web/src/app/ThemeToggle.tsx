"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type ThemeMode = "light" | "dark" | "system";

/**
 * 主题切换：浅色、深色、跟随系统。
 * system 清掉 data-theme 与 localStorage，交给 prefers-color-scheme。
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("damai_theme");
    if (saved === "light" || saved === "dark" || saved === "system") {
      setMode(saved);
      applyTheme(saved);
    } else {
      setMode("system");
    }
  }, []);

  const applyTheme = (next: ThemeMode) => {
    if (next === "system") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem("damai_theme");
    } else {
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("damai_theme", next);
    }
  };

  const selectMode = (next: ThemeMode) => {
    setMode(next);
    applyTheme(next);
  };

  if (!mounted) {
    return <div className="h-7 w-24 shrink-0" />;
  }

  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(next) => {
        if (next === "light" || next === "dark" || next === "system") selectMode(next);
      }}
      size="sm"
      spacing={0}
      aria-label="主题切换"
      className="shrink-0 rounded-md border border-border bg-card p-0.5"
    >
      <ToggleGroupItem value="light" aria-label="白天浅色主题" title="白天浅色主题" className="px-1.5">
        <Sun />
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="夜间深色主题" title="夜间深色主题" className="px-1.5">
        <Moon />
      </ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="跟随系统外观" title="跟随系统外观" className="px-1.5">
        <Monitor />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
