import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openEphemeralPreview } from "../src/preview-server.mjs";

async function waitForServerShutdown(url, timeoutMs = 4_000) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(timeoutMs, 1_200)));
  try {
    await fetch(url);
  } catch {
    return;
  }
  throw new Error("Preview server stayed alive longer than expected.");
}

describe("openEphemeralPreview", () => {
  it("serves replay HTML over an ephemeral localhost URL and cleans itself up", async () => {
    const preview = await openEphemeralPreview(
      "<!DOCTYPE html><html><body>preview-smoke</body></html>",
      {
        idleMs: 500,
        handshakeTimeoutMs: 5_000,
      }
    );

    assert.match(preview.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/);

    const response = await fetch(preview.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /preview-smoke/);

    await waitForServerShutdown(preview.url);
  });
});
