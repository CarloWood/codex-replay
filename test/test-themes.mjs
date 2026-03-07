import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getTheme, listThemes, loadThemeFile, themeToCss } from "../src/themes.mjs";

describe("getTheme", () => {
  it("returns a built-in theme", () => {
    const theme = getTheme("cinder-amber");
    assert.equal(theme.bg, "#15120f");
    assert.equal(theme.accent, "#ff9b54");
  });

  it("throws on unknown themes", () => {
    assert.throws(() => getTheme("unknown"), /Unknown theme/);
  });
});

describe("listThemes", () => {
  it("returns sorted theme names", () => {
    assert.deepEqual(listThemes(), ["cinder-amber", "oxide-blue", "paper-stack", "terminal-moss"]);
  });
});

describe("themeToCss", () => {
  it("serializes css variables", () => {
    const css = themeToCss(getTheme("terminal-moss"));
    assert.match(css, /^:root \{/);
    assert.match(css, /--bg: #0d120f/);
    assert.match(css, /--accent: #88d37d/);
  });
});

describe("loadThemeFile", () => {
  it("merges a custom theme with defaults", () => {
    const filePath = join(tmpdir(), "codex-replay-theme.json");
    writeFileSync(filePath, JSON.stringify({ bg: "#000000" }));
    try {
      const theme = loadThemeFile(filePath);
      assert.equal(theme.bg, "#000000");
      assert.equal(theme.accent, "#ff9b54");
    } finally {
      unlinkSync(filePath);
    }
  });

  it("rejects non-object json", () => {
    const filePath = join(tmpdir(), "codex-replay-theme-invalid.json");
    writeFileSync(filePath, '"invalid"');
    try {
      assert.throws(() => loadThemeFile(filePath), /JSON object/);
    } finally {
      unlinkSync(filePath);
    }
  });
});
