/**
 * Built-in themes and custom theme loading for codex-replay.
 */

import { readFileSync } from "node:fs";

const THEME_VARS = [
  "bg",
  "bg-surface",
  "bg-elevated",
  "bg-hover",
  "text",
  "text-dim",
  "text-bright",
  "accent",
  "accent-2",
  "green",
  "blue",
  "orange",
  "red",
  "cyan",
  "border",
  "tool-bg",
  "reasoning-bg",
  "history-bg",
  "user-bg",
  "system-bg",
];

const BUILTIN_THEMES = {
  "cinder-amber": {
    "bg": "#15120f",
    "bg-surface": "#1d1916",
    "bg-elevated": "#26211c",
    "bg-hover": "#312a23",
    "text": "#efe5d8",
    "text-dim": "#aa9886",
    "text-bright": "#fffaf2",
    "accent": "#ff9b54",
    "accent-2": "#ffe066",
    "green": "#8bd18f",
    "blue": "#72c8ff",
    "orange": "#ffbc6b",
    "red": "#ff7b72",
    "cyan": "#8ce7d5",
    "border": "#40362d",
    "tool-bg": "#1b1612",
    "reasoning-bg": "#211a16",
    "history-bg": "#181411",
    "user-bg": "#231a14",
    "system-bg": "#261d17",
  },
  "oxide-blue": {
    "bg": "#111827",
    "bg-surface": "#182135",
    "bg-elevated": "#1f2a44",
    "bg-hover": "#2b3959",
    "text": "#dce7f5",
    "text-dim": "#8fa5c2",
    "text-bright": "#f7fbff",
    "accent": "#6aa6ff",
    "accent-2": "#80f0ff",
    "green": "#69d2a4",
    "blue": "#74b4ff",
    "orange": "#ffb86b",
    "red": "#ff7a8a",
    "cyan": "#89e8ff",
    "border": "#33425f",
    "tool-bg": "#121b2a",
    "reasoning-bg": "#162235",
    "history-bg": "#131a27",
    "user-bg": "#152033",
    "system-bg": "#1a2438",
  },
  "paper-stack": {
    "bg": "#f6f1e8",
    "bg-surface": "#fffaf2",
    "bg-elevated": "#ffffff",
    "bg-hover": "#efe4d3",
    "text": "#312a24",
    "text-dim": "#7a6c5f",
    "text-bright": "#17120d",
    "accent": "#b85c38",
    "accent-2": "#2f7d65",
    "green": "#2f7d65",
    "blue": "#356cc8",
    "orange": "#d17f36",
    "red": "#bb4a4a",
    "cyan": "#297f8b",
    "border": "#d8cbb9",
    "tool-bg": "#f3eadf",
    "reasoning-bg": "#f9f2e8",
    "history-bg": "#f4ecdf",
    "user-bg": "#efe0d0",
    "system-bg": "#efe6da",
  },
  "terminal-moss": {
    "bg": "#0d120f",
    "bg-surface": "#121a15",
    "bg-elevated": "#18211b",
    "bg-hover": "#213027",
    "text": "#d6ead8",
    "text-dim": "#7c9b82",
    "text-bright": "#f3fff4",
    "accent": "#88d37d",
    "accent-2": "#d8ff84",
    "green": "#88d37d",
    "blue": "#5ab3a5",
    "orange": "#d8b86f",
    "red": "#ff7b78",
    "cyan": "#8ee1cf",
    "border": "#314639",
    "tool-bg": "#111814",
    "reasoning-bg": "#151d17",
    "history-bg": "#101612",
    "user-bg": "#172019",
    "system-bg": "#1a241d",
  },
};

export function getTheme(name) {
  if (!(name in BUILTIN_THEMES)) {
    const available = Object.keys(BUILTIN_THEMES).sort().join(", ");
    throw new Error(`Unknown theme '${name}'. Available: ${available}`);
  }
  return BUILTIN_THEMES[name];
}

export function loadThemeFile(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const custom = JSON.parse(raw);
  if (typeof custom !== "object" || custom === null || Array.isArray(custom)) {
    throw new Error("Theme file must be a JSON object");
  }
  return { ...BUILTIN_THEMES["cinder-amber"], ...custom };
}

export function themeToCss(theme) {
  const lines = [];
  for (const variable of THEME_VARS) {
    if (variable in theme) lines.push(`  --${variable}: ${theme[variable]};`);
  }
  let css = ":root {\n" + lines.join("\n") + "\n}";
  if (theme.extraCss) css += "\n" + theme.extraCss;
  return css;
}

export function listThemes() {
  return Object.keys(BUILTIN_THEMES).sort();
}
