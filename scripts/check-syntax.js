#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const JS_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "results",
  "benchmark_data",
  "coverage",
  "dist",
]);

function gitTrackedJavaScriptFiles() {
  const result = spawnSync("git", ["ls-files", "*.js", "*.cjs", "*.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(ROOT, item));
}

function walkJavaScriptFiles(dirPath) {
  const out = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...walkJavaScriptFiles(fullPath));
    else if (entry.isFile() && JS_EXTENSIONS.has(path.extname(entry.name))) out.push(fullPath);
  }
  return out;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

function checkFile(filePath) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    filePath,
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function main() {
  const files = (gitTrackedJavaScriptFiles() || walkJavaScriptFiles(ROOT))
    .filter((filePath) => JS_EXTENSIONS.has(path.extname(filePath)))
    .sort((left, right) => relative(left).localeCompare(relative(right)));
  const failures = [];
  for (const filePath of files) {
    const result = checkFile(filePath);
    if (!result.ok) failures.push(result);
  }
  for (const failure of failures) {
    console.error(`FAIL syntax ${relative(failure.filePath)}`);
    if (failure.stdout.trim()) console.error(failure.stdout.trim());
    if (failure.stderr.trim()) console.error(failure.stderr.trim());
  }
  if (failures.length) {
    console.error(`\n${failures.length}/${files.length} JavaScript files failed syntax checks.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS syntax checks for ${files.length} JavaScript files.`);
  }
}

if (require.main === module) main();

module.exports = {
  checkFile,
  gitTrackedJavaScriptFiles,
  walkJavaScriptFiles,
};
