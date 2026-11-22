// lint 检查：所有源文件 UTF-8 无 BOM、LF 行尾、无尾随空白、文件末尾单个换行
// 违规输出清单并以退出码 1 结束（CI 阻断依据）
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SKIP_DIRS = new Set(["node_modules", ".git", ".recon", ".impeccable", ".superpowers", "原型", ".zcode-plugin"]);
const EXTS = new Set([".mjs", ".js", ".json", ".md", ".html", ".css", ".ps1"]);

const problems = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full);
    } else if ([...EXTS].some((e) => name.endsWith(e))) {
      yield full;
    }
  }
}

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const buf = readFileSync(file);
  // BOM 检查：文件头不得为 EF BB BF
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push(`${rel}: 含 UTF-8 BOM`);
  }
  const text = buf.toString("utf8");
  // CRLF 检查：行尾必须是 LF
  if (text.includes("\r\n")) {
    problems.push(`${rel}: 含 CRLF 行尾`);
  }
  // 尾随空白检查（排除行尾换行符本身）
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(`${rel}:${i + 1}: 尾随空白`);
  });
  // 文件末尾必须恰好一个换行
  if (text.length > 0 && !text.endsWith("\n")) {
    problems.push(`${rel}: 文件末尾缺少换行符`);
  }
}

if (problems.length > 0) {
  console.error("lint 未通过：");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("lint 通过：编码/行尾/空白检查全部合规");
