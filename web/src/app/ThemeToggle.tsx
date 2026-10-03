"use client";

import { useEffect, useState } from "react";
import { Glyph } from "@/components/ui";

type ThemeMode = "light" | "dark" | "system";

/**
 * 主题切换控制器：
 * 支持白天模式 (light)、夜间深色 (dark) 与系统偏好跟随 (system)。
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("damai_theme") as ThemeMode | null;
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
    return <div className="h-6 w-20 shrink-0" />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="主题切换"
      className="flex items-center rounded border border-line bg-surface p-0.5 shrink-0"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === "light"}
        onClick={() => selectMode("light")}
        title="白天浅色主题"
        className={`flex h-5 w-6.5 items-center justify-center rounded transition-colors ${
          mode === "light"
            ? "bg-surface-raised text-ink font-semibold shadow-xs"
            : "text-muted hover:text-ink"
        }`}
      >
        <Glyph name="sun" className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        role="radio"
        aria-checked={mode === "dark"}
        onClick={() => selectMode("dark")}
        title="夜间深色主题"
        className={`flex h-5 w-6.5 items-center justify-center rounded transition-colors ${
          mode === "dark"
            ? "bg-surface-raised text-ink font-semibold shadow-xs"
            : "text-muted hover:text-ink"
        }`}
      >
        <Glyph name="moon" className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        role="radio"
        aria-checked={mode === "system"}
        onClick={() => selectMode("system")}
        title="跟随系统外观"
        className={`flex h-5 w-6.5 items-center justify-center rounded transition-colors ${
          mode === "system"
            ? "bg-surface-raised text-ink font-semibold shadow-xs"
            : "text-muted hover:text-ink"
        }`}
      >
        <Glyph name="monitor" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
