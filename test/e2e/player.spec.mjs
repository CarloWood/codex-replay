import { expect, test } from "@playwright/test";
import {
  getAutoFollowRolloutFileUrl,
  getDuplicateAssistantFileUrl,
  getGroupedRolloutFileUrl,
  getHistoryFileUrl,
  getRolloutFileUrl,
  waitForReady,
} from "./setup.mjs";

const visibleBlockCount = (page, turn) =>
  page.locator(`.turn-shell[data-index="${turn}"] .block-wrapper:not(.hidden-step):not(.hidden-by-filter)`).count();
const scrollWindow = (page, y) => page.evaluate((nextY) => window.scrollTo(0, nextY), y);
const topbarHeight = (page) =>
  page.locator(".topbar").evaluate((node) => node.getBoundingClientRect().height);
const elementHeight = (page, selector) =>
  page.locator(selector).evaluate((node) => node.getBoundingClientRect().height);
const latestVisibleBlockMetrics = (page, turn) =>
  page.locator(`.turn-shell[data-index="${turn}"]`).evaluate((shell) => {
    const visible = Array.from(shell.querySelectorAll(".block-wrapper")).filter(
      (node) => !node.classList.contains("hidden-step") && !node.classList.contains("hidden-by-filter")
    );
    const lastVisible = visible[visible.length - 1] ?? null;
    const rect = lastVisible ? lastVisible.getBoundingClientRect() : null;
    const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    return {
      visibleCount: visible.length,
      scrollY: Math.round(window.scrollY),
      safeTop: Math.round(topbarBottom + 16),
      safeBottom: Math.round(window.innerHeight - 24),
      lastVisibleTop: rect ? Math.round(rect.top) : null,
      lastVisibleBottom: rect ? Math.round(rect.bottom) : null,
    };
  });

test("rollout mode loads with the first turn active", async ({ page }) => {
  await page.goto(getRolloutFileUrl());
  await waitForReady(page);

  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#status-banner")).toContainText("Rollout mode");
  await expect(page.locator('.turn-shell[data-index="1"].active')).toBeVisible();
  await expect(page.locator('.turn-shell[data-index="1"] .turn-metrics')).toContainText("replies");
  await expect(page.locator('.turn-shell[data-index="1"] .turn-metrics')).toContainText("reasoning");
  await expect(page.locator('.turn-shell[data-index="1"] .turn-metrics')).toContainText("tool");
  expect(await visibleBlockCount(page, 1)).toBe(0);
});

test("deep links jump directly to the requested turn", async ({ page }) => {
  await page.goto(getRolloutFileUrl("turn=2"));
  await waitForReady(page);

  await expect(page.locator('.turn-shell[data-index="2"].active')).toBeVisible();
  await expect(page.locator("#progress-label")).toContainText("Turn 2 / 2");
  await expect.poll(async () => visibleBlockCount(page, 2)).toBeGreaterThan(0);
});

test("playback and step navigation reveal blocks incrementally", async ({ page }) => {
  await page.goto(getRolloutFileUrl());
  await waitForReady(page);

  await page.locator("#btn-play").click();
  await expect.poll(async () => visibleBlockCount(page, 1), { timeout: 3000 }).toBeGreaterThan(0);
  await page.locator("#btn-play").click();

  const afterPlay = await visibleBlockCount(page, 1);
  await page.keyboard.press("ArrowRight");
  expect(await visibleBlockCount(page, 1)).toBeGreaterThanOrEqual(afterPlay);

  await page.keyboard.press("ArrowLeft");
  expect(await visibleBlockCount(page, 1)).toBeLessThanOrEqual(afterPlay + 1);
});

test("duplicate assistant content is rendered once with compact metadata", async ({ page }) => {
  await page.goto(getDuplicateAssistantFileUrl("turn=1"));
  await waitForReady(page);

  const assistantCards = page.locator('.turn-shell[data-index="1"] .block-card.assistant-message');
  await expect(assistantCards).toHaveCount(1);
  await expect(assistantCards.first()).toContainText("Merged assistant answer for duplicate coverage.");
  await expect(assistantCards.first().locator(".assistant-meta")).toBeVisible();
  await expect(assistantCards.first().locator(".assistant-meta .phase-badge")).toContainText("final_answer");
});

test("autoplay keeps the newest visible response block inside the safe viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto(getAutoFollowRolloutFileUrl());
  await waitForReady(page);

  await page.locator("#btn-play").click();
  await expect.poll(async () => visibleBlockCount(page, 1), { timeout: 5000 }).toBeGreaterThanOrEqual(5);
  await expect.poll(async () => {
    const metrics = await latestVisibleBlockMetrics(page, 1);
    return Boolean(
      metrics.scrollY > 0 &&
      metrics.lastVisibleTop != null &&
      metrics.lastVisibleBottom != null &&
      metrics.lastVisibleTop >= metrics.safeTop - 1 &&
      metrics.lastVisibleBottom <= metrics.safeBottom + 1
    );
  }, { timeout: 3000 }).toBe(true);

  await expect.poll(async () => visibleBlockCount(page, 1), { timeout: 5000 }).toBeGreaterThanOrEqual(7);
  const metrics = await latestVisibleBlockMetrics(page, 1);
  expect(metrics.scrollY).toBeGreaterThan(0);
  expect(metrics.lastVisibleTop).toBeGreaterThanOrEqual(metrics.safeTop - 1);
  expect(metrics.lastVisibleBottom).toBeLessThanOrEqual(metrics.safeBottom + 1);
});

test("rollout topbar auto-compacts on scroll and restores on scroll up", async ({ page }) => {
  await page.goto(getRolloutFileUrl("turn=1"));
  await waitForReady(page);

  const expandedHeight = await topbarHeight(page);
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "expanded");
  await scrollWindow(page, 400);
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "compact");
  await expect.poll(async () => topbarHeight(page), { timeout: 1000 }).toBeLessThan(expandedHeight - 120);
  await expect.poll(async () => elementHeight(page, ".header-row"), { timeout: 1000 }).toBe(0);
  await expect.poll(async () => elementHeight(page, ".playback-controls .toggle-row"), { timeout: 1000 }).toBe(0);
  await expect.poll(async () => elementHeight(page, "#status-banner"), { timeout: 1000 }).toBe(0);
  await expect(page.locator("#btn-play")).toBeVisible();
  await expect(page.locator("#progress-range")).toBeVisible();

  await page.waitForTimeout(350);
  await page.evaluate(() => window.scrollBy(0, -12));
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "expanded");
  await page.waitForTimeout(350);
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "expanded");
  await expect.poll(async () => topbarHeight(page), { timeout: 1000 }).toBeGreaterThan(expandedHeight - 24);
  await expect(page.locator(".header-row")).toBeVisible();
  await expect(page.locator(".playback-controls .toggle-row")).toBeVisible();
});

test("reasoning, tool, and system filters hide their matching blocks", async ({ page }) => {
  await page.goto(getRolloutFileUrl("turn=1"));
  await waitForReady(page);

  await page.locator("#toggle-reasoning").uncheck();
  await expect(page.locator('.turn-shell[data-index="1"] .block-wrapper.hidden-by-filter[data-kind="reasoning"]')).toHaveCount(2);

  await page.locator("#toggle-tools").uncheck();
  await expect(page.locator('.turn-shell[data-index="1"] .block-wrapper.hidden-by-filter[data-kind="request_user_input"]')).toHaveCount(1);
  await expect(page.locator('.turn-shell[data-index="1"] .block-wrapper.hidden-by-filter[data-kind="tool_call"]')).toHaveCount(1);

  await page.locator("#toggle-system").uncheck();
  await expect(page.locator('.turn-shell[data-index="1"] .block-wrapper.hidden-by-filter[data-kind="system_notice"]')).toHaveCount(1);
});

test("tool and reasoning panels expand and collapse without changing playback state", async ({ page }) => {
  await page.goto(getRolloutFileUrl("turn=1"));
  await waitForReady(page);

  const toolDetails = page.locator('details.block-card[data-kind="tool_call"]').first();
  await expect(toolDetails.locator(".summary-chevron")).toBeVisible();
  await expect(toolDetails.locator(".summary-preview")).toContainText("AGENTS.md");
  await toolDetails.locator("summary").click();
  await expect(toolDetails).toHaveAttribute("open", "");
  await toolDetails.locator("summary").click();
  await expect(toolDetails).not.toHaveAttribute("open", "");

  const reasoningDetails = page.locator('details.block-card[data-kind="reasoning"]').nth(1);
  await expect(reasoningDetails.locator(".summary-preview")).toContainText(
    "Inspecting the repo instructions and tool outputs before replying."
  );
  await reasoningDetails.locator("summary").click();
  await expect(reasoningDetails).toHaveAttribute("open", "");
  await expect(reasoningDetails.locator(".status-chip.locked")).toContainText("locked");
  await expect(reasoningDetails.locator(".locked-note")).toContainText(
    "Full reasoning was encrypted in the source Codex log"
  );

  const requestInputDetails = page.locator('details.block-card[data-kind="request_user_input"]').first();
  await expect(requestInputDetails.locator(".summary-preview")).toContainText("Scope");
});

test("long assistant content can expand and collapse inside the message body", async ({ page }) => {
  await page.goto(getAutoFollowRolloutFileUrl("turn=1"));
  await waitForReady(page);

  const assistantCollapse = page.locator('.turn-shell[data-index="1"] .assistant-message .content-collapse').first();
  const toggle = assistantCollapse.locator(".collapse-toggle");
  await expect(assistantCollapse).toHaveClass(/is-collapsed/);
  await expect(toggle).toContainText("Show more");

  await toggle.click();
  await expect(assistantCollapse).not.toHaveClass(/is-collapsed/);
  await expect(toggle).toContainText("Show less");

  await toggle.click();
  await expect(assistantCollapse).toHaveClass(/is-collapsed/);
});

test("history mode disables playback controls and filters sessions", async ({ page }) => {
  await page.goto(getHistoryFileUrl());
  await waitForReady(page);

  await expect(page.locator("body")).toHaveClass(/history-mode/);
  await expect(page.locator("#playback-controls")).toBeHidden();
  await expect(page.locator("#status-banner")).toContainText("History mode is text-only");
  await expect(page.locator(".history-session")).toHaveCount(2);
  await expect(page.locator(".history-entry").first()).toContainText("Older alpha prompt.");

  await page.locator("#session-filter").selectOption("session-beta");
  await expect(page.locator(".history-session")).toHaveCount(1);
  await expect(page.locator(".history-entry")).toHaveCount(2);
});

test("history topbar auto-compacts while keeping the session filter visible", async ({ page }) => {
  await page.goto(getHistoryFileUrl());
  await waitForReady(page);

  const expandedHeight = await topbarHeight(page);
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "expanded");
  await scrollWindow(page, 400);
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "compact");
  await expect.poll(async () => topbarHeight(page), { timeout: 1000 }).toBeLessThan(expandedHeight - 80);
  await expect.poll(async () => elementHeight(page, ".header-row"), { timeout: 1000 }).toBe(0);
  await expect.poll(async () => elementHeight(page, "#status-banner"), { timeout: 1000 }).toBe(0);
  await expect(page.locator("#history-controls")).toBeVisible();
  await expect(page.locator("#session-filter")).toBeVisible();

  await scrollWindow(page, 0);
  await expect(page.locator("body")).toHaveAttribute("data-topbar-state", "expanded");
});

test("grouped rollout mode shows merged session metadata and source badges", async ({ page }) => {
  await page.goto(getGroupedRolloutFileUrl("turn=2"));
  await waitForReady(page);

  await expect(page.locator("#status-banner")).toContainText("Grouped rollout mode");
  await expect(page.locator("#meta-strip")).toContainText("sessions");
  await expect(page.locator("#meta-strip")).toContainText("Aquinas");
  await expect(page.locator('.turn-shell[data-index="2"].active')).toBeVisible();
  await expect(page.locator('.turn-shell[data-index="1"] .turn-source-root')).toContainText("main");
  await expect(page.locator('.turn-shell[data-index="2"] .turn-source')).toContainText("Aquinas");
  await expect(page.locator('.turn-shell[data-index="2"] .turn-source-role')).toContainText("awaiter");
  await expect(page.locator("#progress-label")).toContainText("Turn 2 / 2");
});
