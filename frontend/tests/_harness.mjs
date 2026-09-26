/** UI 断言公共库：playwright 解析（临时目录兜底）+ 浏览器启动 + 断言收集。 */

import { createRequire } from "node:module";
import fs from "node:fs";

export const BASE = process.env.WO_BASE || "http://127.0.0.1:8787";

const CANDIDATES = [
  process.env.WO_PLAYWRIGHT,
  "playwright",
  "C:/Users/X1882/AppData/Local/Temp/opencode/node_modules/playwright",
].filter(Boolean);

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const c of CANDIDATES) {
    try {
      return req(c);
    } catch {
      /* try next */
    }
  }
  console.error("找不到 playwright。请执行：npm i -D playwright && npx playwright install chromium（或设 WO_PLAYWRIGHT=<模块路径>）");
  process.exit(2);
}

const CHROME_EXE =
  process.env.WO_CHROME ||
  "C:/Users/X1882/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe";

export async function launchBrowser(pw) {
  return pw.chromium.launch(fs.existsSync(CHROME_EXE) ? { executablePath: CHROME_EXE } : undefined);
}

export function makeChecks() {
  const checks = [];
  const skips = [];
  return {
    checks,
    /** 环境相关而无法执行的断言：显式记录并在结尾汇总，不静默通过 */
    skip(name, reason) {
      skips.push(`SKIP ${name} — ${reason}`);
    },
    check(name, cond) {
      checks.push(`${cond ? "PASS" : "FAIL"} ${name}`);
    },
    finish(pageErrors = []) {
      console.log(checks.join("\n"));
      if (skips.length) {
        console.log(skips.join("\n"));
        console.log(`skipped: ${skips.length} 项（依赖示例数据，当前库为空）`);
      }
      console.log("page errors:", pageErrors.length ? pageErrors.join("\n") : "none");
      const failed = checks.filter((c) => c.startsWith("FAIL"));
      process.exit(failed.length || pageErrors.length ? 1 : 0);
    },
  };
}
