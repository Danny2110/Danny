#!/usr/bin/env node
// Internal link checker for the built site.
// Usage: node scripts/check-links.mjs [root]
// Default root: dist/ (relative to the current working directory).
// Walks the root for .html files, extracts href="..." / src="...",
// and reports internal targets that resolve to no file on disk.
// Ignores fragments (#...), mailto:, tel:, data:, javascript:, and http(s): links.
// Exits 1 if any internal link is broken, 0 otherwise.
// No dependencies.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? "dist");
const IGNORED_PREFIX = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|#)/;

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

function extractLinks(html) {
  const links = [];
  const attr = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = attr.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw) links.push(raw);
  }
  return links;
}

function isExternal(link) {
  return IGNORED_PREFIX.test(link);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolvesToFile(targetPath) {
  if (targetPath.endsWith("/")) {
    return exists(path.join(targetPath, "index.html"));
  }
  if (await exists(targetPath)) {
    const info = await stat(targetPath);
    if (info.isDirectory()) return exists(path.join(targetPath, "index.html"));
    return true;
  }
  // Pretty URLs: /about -> /about.html or /about/index.html
  if (await exists(`${targetPath}.html`)) return true;
  if (await exists(path.join(targetPath, "index.html"))) return true;
  return false;
}

async function main() {
  if (!(await exists(root))) {
    console.error(`check-links: root not found: ${root}`);
    console.error("Run the site build first (node build.mjs) so dist/ exists.");
    process.exit(1);
  }

  const files = await walk(root);
  if (files.length === 0) {
    console.error(`check-links: no .html files under ${root}`);
    process.exit(1);
  }

  let checked = 0;
  const broken = [];

  for (const file of files) {
    const html = await readFile(file, "utf8");
    const pageRel = path.relative(root, file);

    for (const link of extractLinks(html)) {
      if (!link || isExternal(link)) continue;

      // Strip query string and fragment.
      const clean = link.split("#")[0].split("?")[0];
      if (clean === "") continue; // pure fragment link such as "#top"

      let decoded = clean;
      try {
        decoded = decodeURIComponent(clean);
      } catch {
        // keep the raw value if it is not valid percent-encoding
      }

      const targetPath = decoded.startsWith("/")
        ? path.join(root, decoded)
        : path.resolve(path.dirname(file), decoded);

      checked += 1;

      const relative = path.relative(root, targetPath);
      const escapesRoot = relative.startsWith("..") || path.isAbsolute(relative);
      if (escapesRoot || !(await resolvesToFile(targetPath))) {
        broken.push({ page: pageRel, link, resolved: relative || "." });
      }
    }
  }

  if (broken.length === 0) {
    console.log(`check-links: OK — ${checked} internal link(s) checked across ${files.length} page(s), 0 broken.`);
    return;
  }

  console.log(
    `check-links: ${broken.length} broken internal link(s) of ${checked} checked across ${files.length} page(s):`,
  );
  for (const item of broken) {
    console.log(`  ${item.page} -> ${item.link}   (resolved: ${item.resolved})`);
  }
  process.exit(1);
}

await main();
