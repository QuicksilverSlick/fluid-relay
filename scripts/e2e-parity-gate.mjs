#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

const REQUIRED_SCRIPTS = [
  "test:e2e:smoke",
  "test:e2e:smoke:process",
  "test:e2e:smoke:claude",
];

const REQUIRED_TEST_FILES = [
  // Session integration tests (formerly mock e2e, now run under pnpm test)
  "src/core/coordinator/session-lifecycle.integration.test.ts",
  "src/core/coordinator/session-status.integration.test.ts",
  "src/core/coordinator/streaming-conversation.integration.test.ts",
  "src/core/coordinator/permission-flow.integration.test.ts",
  "src/core/consumer/presence-rbac.integration.test.ts",
  "src/core/session/message-queue.integration.test.ts",
  "src/server/ws-server-flow.integration.test.ts",
  // Adapter integration tests (formerly adapter e2e, now run under pnpm test)
  "src/adapters/codex/codex-adapter.integration.test.ts",
  "src/adapters/gemini/gemini-adapter.integration.test.ts",
  "src/adapters/acp/acp-adapter.integration.test.ts",
  "src/adapters/opencode/opencode-adapter.integration.test.ts",
  // E2E tests (real backends)
  "src/e2e/smoke.e2e.test.ts",
  "src/e2e/handshake.e2e.test.ts",
];

const REQUIRED_DOCS = [];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function fileExists(path) {
  try {
    readFileSync(resolve(root, path), "utf8");
    return true;
  } catch {
    return false;
  }
}

function verifyRequiredScripts(pkg) {
  const missing = REQUIRED_SCRIPTS.filter((name) => !pkg.scripts?.[name]);
  return { ok: missing.length === 0, missing };
}

function verifyRequiredFiles(paths) {
  const missing = paths.filter((path) => !fileExists(path));
  return { ok: missing.length === 0, missing };
}

function printResult(label, result) {
  if (result.ok) {
    console.log(`[parity-gate] ${label}: OK`);
    return;
  }
  console.error(`[parity-gate] ${label}: missing`);
  for (const item of result.missing) {
    console.error(`  - ${item}`);
  }
}

function main() {
  const pkg = readJson("package.json");

  const scriptResult = verifyRequiredScripts(pkg);
  const testFileResult = verifyRequiredFiles(REQUIRED_TEST_FILES);
  const docsResult = verifyRequiredFiles(REQUIRED_DOCS);

  printResult("scripts", scriptResult);
  printResult("test files", testFileResult);
  printResult("docs", docsResult);

  const ok = scriptResult.ok && testFileResult.ok && docsResult.ok;
  if (!ok) {
    process.exitCode = 1;
    return;
  }

  console.log("[parity-gate] E2E parity matrix prerequisites are configured.");
}

main();
