// build.mjs — zero-dependency static site builder.
// Usage: node build.mjs [--data src/data/apps] [--out dist]
// Reads src/data/site.json + <data>/*.json, writes hub, per-app pages,
// a downloads index, and 404 into <out>. Copies src/assets, src/styles,
// src/scripts, and public/ verbatim. No packages, no network. Node 24 stdlib.

import { readFile, writeFile, readdir, mkdir, cp, rm } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const DATA_DIR = path.resolve(ROOT, arg("--data", "src/data/apps"));
const ASSETS_SRC = path.resolve(ROOT, arg("--assets", "src/assets"));
const OUT_DIR = path.resolve(ROOT, arg("--out", "dist"));
const SITE_PATH = path.join(ROOT, "src/data/site.json");

// GitHub Pages serves project sites below /<repository>/ and user sites at
// the domain root. Local builds stay root-based.
const repositoryName = (process.env.GITHUB_REPOSITORY || "").split("/").pop() || "";
const BASE_PATH = repositoryName && !/^.+\.github\.io$/i.test(repositoryName)
  ? `/${repositoryName}` : "";
function sitePath(pathname) {
  return `${BASE_PATH}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

const errors = [];
function fail(msg) { errors.push(msg); }

// ---------------- schema ----------------
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validateApp(a, file) {
  if (!a || typeof a !== "object") { fail(`${file}: not an object`); return false; }
  let ok = true;
  const bad = (m) => { fail(`${file}: ${m}`); ok = false; };
  if (typeof a.slug !== "string" || !SLUG_RE.test(a.slug)) bad(`bad slug ${JSON.stringify(a.slug)}`);
  if (typeof a.name !== "string" || !a.name.trim()) bad("missing name");
  if (typeof a.tagline !== "string" || !a.tagline.trim()) bad("missing tagline");
  if (!a.theme || typeof a.theme.mode !== "string") bad("theme.mode missing");
  if (a.download && a.download.kind === "file" && typeof a.download.path !== "string") bad("download.path missing for kind=file");
  return ok;
}

// ---------------- helpers ----------------
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const u = ["B", "KB", "MB", "GB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
const FONT_STACKS = {
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
  serif: "ui-serif, 'New York', Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  rounded: "ui-rounded, -apple-system, 'SF Pro Rounded', system-ui, sans-serif",
};
function fontStack(name) { return FONT_STACKS[name] || FONT_STACKS.system; }

function downloadInfo(app) {
  const d = app.download || { kind: "none" };
  if (d.kind === "file") {
    const rel = String(d.path || "").replace(/^\//, "");
    const abs = path.join(ROOT, "public", rel);
    let size = null;
    try { size = statSync(abs).size; } catch { /* missing build */ }
    if (size == null) {
      return { kind: "missing", label: d.label || "Download for Mac", note: d.note || "No build uploaded yet — check back soon.", size: null, path: d.path };
    }
    return { kind: "file", label: d.label || "Download for Mac", note: d.note || "", size: humanBytes(size), path: d.path };
  }
  if (d.kind === "github" || d.kind === "link") {
    return { kind: "link", label: d.label || "Get it", note: d.note || "", url: d.url };
  }
  return { kind: "none", label: d.label || "Not available yet", note: d.note || "There is no downloadable build yet.", size: null };
}

function themeVars(app) {
  const t = app.theme || {};
  const mode = t.mode === "dark" ? "dark" : "light";
  const surface = t.surface || (mode === "dark" ? "#0c0e14" : "#ffffff");
  const ink = t.ink || (mode === "dark" ? "#eef1f7" : "#171a21");
  const muted = t.muted || (mode === "dark" ? "#9aa3b2" : "#5b6472");
  const accent = app.accent || "#4F5BD5";
  const radius = Number.isFinite(t.radius) ? t.radius : 16;
  return { mode, surface, ink, muted, accent, radius, font: t.font || "system", chrome: t.chrome || "glass", layout: t.layout || "split" };
}

function normAsset(rel) {
  if (typeof rel !== "string" || !rel) return rel;
  return rel.replace(/^\/+/, "").replace(/^assets\//, "");
}
function normApp(a) {
  a.icon = normAsset(a.icon);
  a.hero = normAsset(a.hero);
  if (Array.isArray(a.screenshots)) for (const s of a.screenshots) s.src = normAsset(s.src);
  return a;
}

// ---------------- shared chrome ----------------
function headHTML({ title, description, site, app, extraCSS = [] }) {
  const v = app ? themeVars(app) : null;
  const bodyVars = v
    ? `--surface:${esc(v.surface)};--ink:${esc(v.ink)};--muted:${esc(v.muted)};--accent:${esc(v.accent)};--radius:${v.radius}px;--font-body:${fontStack(v.font)}`
    : "";
  const css = (app
    ? [sitePath("/styles/base.css"), sitePath("/styles/app.css"), ...extraCSS]
    : [sitePath("/styles/hub.css"), ...extraCSS])
    .map((h) => `  <link rel="stylesheet" href="${h}">`).join("\n");
  return `<!DOCTYPE html>
<html lang="en"${v ? ` data-app="${esc(app.slug)}" data-mode="${v.mode}" data-chrome="${esc(v.chrome)}" data-layout="${esc(v.layout)}"` : ` data-mode="${esc(site.theme?.mode || "light")}"`}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="icon" href="${sitePath("/assets/site/favicon.svg")}" type="image/svg+xml">
  <link rel="alternate icon" href="${sitePath("/assets/site/favicon.png")}" type="image/png">
${css}
${v ? `  <style>body{${bodyVars}}</style>` : ""}
</head>`;
}

function navHTML(site, current) {
  return `<header class="site-nav"><div class="nav-inner">
    <a class="brand" href="${sitePath("/")}"><img src="${sitePath("/assets/site/favicon.svg")}" alt="" width="22" height="22"><span>${esc(site.name || site.title)}</span></a>
    <nav class="nav-links">
      <a href="${sitePath("/")}"${!current ? ' aria-current="page"' : ""}>Apps</a>
      <a href="${sitePath("/downloads/")}">Downloads</a>
    </nav>
  </div></header>`;
}

function footerHTML(site, apps) {
  const appLinks = (apps || []).map((a) => `<li><a href="${sitePath(`/${a.slug}/`)}">${esc(a.name)}</a></li>`).join("");
  return `<footer class="site-footer"><div class="footer-inner">
    <div class="footer-brand">
      <a class="brand" href="${sitePath("/")}"><img src="${sitePath("/assets/site/favicon.svg")}" alt="" width="24" height="24"><span>${esc(site.name || site.title)}</span></a>
      <p>${esc(site.tagline || "")}</p>
    </div>
    ${appLinks ? `<div class="footer-col"><h3>Apps</h3><ul>${appLinks}</ul></div>` : ""}
    <div class="footer-col"><h3>Site</h3><ul>
      <li><a href="${sitePath("/")}">All apps</a></li>
      <li><a href="${sitePath("/downloads/")}">Downloads</a></li>
      <li><a href="https://github.com/Danny2110">GitHub</a></li>
    </ul></div>
  </div>
  <div class="footer-base">${esc(site.footer?.note || "")}</div></footer>`;
}

function pillHTML(app) {
  const bits = [];
  if (app.version) bits.push(`<span class="pill">v${esc(app.version)}</span>`);
  if (app.status === "beta") bits.push(`<span class="pill pill-beta">beta</span>`);
  return bits.join("");
}

function downloadButtonHTML(app) {
  const d = downloadInfo(app);
  if (d.kind === "file") {
    return `<a class="btn btn-primary" href="${esc(sitePath(d.path))}" download>${esc(d.label)}${d.size ? ` · ${esc(d.size)}` : ""}</a>
      ${d.note ? `<p class="dl-note">${esc(d.note)}</p>` : `<p class="dl-note">Unsigned build: right-click → Open on first launch.</p>`}`;
  }
  if (d.kind === "link") {
    return `<a class="btn btn-primary" href="${esc(d.url)}">${esc(d.label)}</a>${d.note ? `<p class="dl-note">${esc(d.note)}</p>` : ""}`;
  }
  return `<span class="btn btn-disabled" aria-disabled="true">${esc(d.label)}</span>${d.note ? `<p class="dl-note">${esc(d.note)}</p>` : ""}`;
}

function imgTag(rel, alt, extra) {
  const u = assetURL(rel);
  if (!u) return "";
  return `<img src="${esc(u)}" alt="${esc(alt)}" ${extra || ""}>`;
}

// ---------------- hub ----------------
let LG_MAP_B64 = "";
try { LG_MAP_B64 = readFileSync(path.join(ROOT, "src/assets/site/lg-map.b64"), "utf8").trim(); } catch { /* glass filter degrades to blur */ }

function glassDefsHTML() {
  return `<svg class="glassdefs" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="lg-filter" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">
      <feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"
        href="data:image/png;base64,${LG_MAP_B64}" />
      <feDisplacementMap in="SourceGraphic" in2="map" result="dispRed" scale="-20" xChannelSelector="R" yChannelSelector="G" />
      <feColorMatrix in="dispRed" type="matrix" result="red" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
      <feDisplacementMap in="SourceGraphic" in2="map" result="dispGreen" scale="-24" xChannelSelector="R" yChannelSelector="G" />
      <feColorMatrix in="dispGreen" type="matrix" result="green" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" />
      <feDisplacementMap in="SourceGraphic" in2="map" result="dispBlue" scale="-28" xChannelSelector="R" yChannelSelector="G" />
      <feColorMatrix in="dispBlue" type="matrix" result="blue" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" />
      <feBlend in="red" in2="green" mode="screen" result="rg" />
      <feBlend in="rg" in2="blue" mode="screen" result="output" />
      <feGaussianBlur in="output" stdDeviation="3" />
    </filter>
  </defs>
</svg>`;
}

const GLASS_GATE = `<script>\n(function () {\n  var isSafari = /^((?!chrome|chromium|crios|android|fxios).)*safari/i.test(navigator.userAgent);\n  var ok = false;\n  try {\n    ok = !isSafari && window.CSS && CSS.supports && CSS.supports("backdrop-filter", "url(#lg-filter)");\n  } catch (e) { ok = false; }\n  document.documentElement.classList.toggle("svg-glass", ok);\n})();\n<\/script>`;

function assetURL(rel) {
  if (!rel) return null;
  if (/^https?:\/\//.test(rel)) return rel;
  return sitePath(`/assets/${rel}`);
}

// test-mode remap: when --assets points at tests/fixtures/files, app JSON
// paths like "night-owl-timer/icon.png" resolve under that root.
function checkAsset(rel) {
  return existsSync(path.join(ASSETS_SRC, rel));
}

function cardHTML(app, featured) {
  const icon = assetURL(app.icon);
  const iconHTML = icon
    ? `<img class="card-icon" src="${esc(icon)}" alt="" width="${featured ? 96 : 64}" height="${featured ? 96 : 64}" loading="lazy">`
    : `<span class="card-icon card-letter" aria-hidden="true">${esc(app.name.slice(0, 1))}</span>`;
  const dl = downloadInfo(app);
  const dlLabel = dl.kind === "file"
    ? `${esc(dl.label)}${dl.size ? ` · ${esc(dl.size)}` : ""}`
    : dl.kind === "link" ? esc(dl.label) : null;
  return `<a class="card${featured ? " card-featured" : ""}" style="--card-accent:${esc(app.accent || "#4F5BD5")}" data-name="${esc(app.name.toLowerCase())}" data-category="${esc(app.category || "")}" href="${sitePath(`/${app.slug}/`)}" aria-label="${esc(app.name)} — ${esc(app.tagline)}">
    <span class="card-glow" aria-hidden="true"></span>
    ${iconHTML}
    <span class="card-text">
      <span class="card-name">${esc(app.name)}</span>
      <span class="card-tag">${esc(app.tagline)}</span>
      <span class="card-meta">${pillHTML(app)}${app.category ? `<span class="card-cat">${esc(app.category)}</span>` : ""}</span>
      ${featured && app.description?.[0] ? `<span class="card-blurb">${esc(app.description[0])}</span>` : ""}
      ${featured && dlLabel ? `<span class="card-dl">${dlLabel} →</span>` : ""}
    </span>
    <span class="card-arrow" aria-hidden="true">→</span>
  </a>`;
}

function glassCardHTML(app, i) {
  const icon = assetURL(app.icon);
  const iconHTML = icon
    ? `<img class="card__icon" src="${esc(icon)}" alt="" loading="lazy" />`
    : `<div class="card__icon card__icon--tile">${esc(app.name.slice(0, 1))}</div>`;
  const href = app.slug === "notesy" ? "https://danny2110.github.io/Notesy/" : sitePath(`/${app.slug}/`);
  const inner = `
    ${iconHTML}
    <div class="card__body">
      <span class="card__badge">${esc(app.name)}</span>
      <p class="card__desc">${esc(app.tagline)}</p>
    </div>`;
  return `<a class="card${app.featured ? " card-featured" : ""}" style="animation-delay:${i * 45}ms" href="${esc(href)}">${inner}</a>`;
}

function hubHTML(site, apps) {
  const identityName = site.author || site.name || site.title;
  const avatar = existsSync(path.join(ROOT, "src/assets/site/avatar.png")) ? sitePath("/assets/site/avatar.png") : sitePath("/assets/site/favicon.png");
  return `${headHTML({ title: `${identityName} — Apps`, description: site.description || site.tagline || "", site })}
<body class="hub">
${glassDefsHTML()}
<main class="page">
  <header class="identity">
    <img class="identity__avatar" src="${avatar}" alt="" />
    <h1 class="identity__name">${esc(identityName)}</h1>
  </header>
  <section class="grid" id="grid">
    ${apps.map((a, i) => glassCardHTML(a, i)).join("\n    ")}
  </section>
</main>
<footer class="hub-foot">
  <a href="${sitePath("/downloads/")}">Downloads</a>
  <span aria-hidden="true">·</span>
  <a href="https://github.com/Danny2110">GitHub</a>
</footer>
${GLASS_GATE}
</body>
</html>
`;
}

// ---------------- app page ----------------
function appPageHTML(site, app) {
  const v = themeVars(app);
  const dl = downloadInfo(app);
  const icon = assetURL(app.icon);
  const hero = assetURL(app.hero);
  const shots = Array.isArray(app.screenshots) ? app.screenshots : [];
  const features = Array.isArray(app.features) ? app.features : [];
  const desc = Array.isArray(app.description) ? app.description : [];
  const reqs = Array.isArray(app.requirements) ? app.requirements : [];
  const links = Array.isArray(app.links) ? app.links : [];
  const perAppCSS = existsSync(path.join(ROOT, "src/styles/apps", `${app.slug}.css`))
    ? [sitePath(`/styles/apps/${app.slug}.css`)] : [];
  const gallery = shots.length
    ? `<section class="shots"><h2>Screens</h2><div class="shot-grid">${shots.map((s) => `<figure class="shot"><img src="${esc(assetURL(s.src))}" alt="${esc(s.alt || app.name)}" loading="lazy"></figure>`).join("")}</div></section>`
    : "";
  const featureHTML = features.length
    ? `<section class="features"><h2>What it does</h2><div class="feature-grid">${features.map((f) => `<div class="feature"><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p></div>`).join("")}</div></section>`
    : "";
  return `${headHTML({ title: `${app.name} — ${app.tagline}`, description: desc[0] || app.tagline, site, app, extraCSS: perAppCSS })}
<body class="app-page"${hero ? ` data-has-hero="1"` : ""}>
<div class="app-bg" aria-hidden="true"></div>
${navHTML(site, app.slug)}
<main class="app-main">
  <nav class="crumbs"><a href="${sitePath("/")}">← All apps</a></nav>
  <section class="app-hero">
    <div class="hero-icon">${icon ? `<img src="${esc(icon)}" alt="${esc(app.name)} icon" width="128" height="128">` : `<span class="hero-letter">${esc(app.name.slice(0, 1))}</span>`}</div>
    <div class="hero-text">
      <h1>${esc(app.name)}</h1>
      <p class="lede">${esc(app.tagline)}</p>
      <div class="hero-meta">${pillHTML(app)}${app.category ? `<span class="card-cat">${esc(app.category)}</span>` : ""}${app.host ? `<span class="card-cat">for ${esc(app.host)}</span>` : ""}</div>
      <div class="dl-block">${downloadButtonHTML(app)}</div>
    </div>
    ${hero ? `<div class="hero-shot"><img src="${esc(hero)}" alt="${esc(app.name)} screenshot" loading="eager"></div>` : ""}
  </section>
  ${desc.length ? `<section class="about">${desc.map((p) => `<p>${esc(p)}</p>`).join("")}</section>` : ""}
  ${featureHTML}
  ${gallery}
  <section class="details"><h2>Details</h2>
    <dl class="detail-list">
      <div><dt>Version</dt><dd>${esc(app.version || "—")}${app.status === "beta" ? " (beta)" : ""}</dd></div>
      ${reqs.length ? `<div><dt>Runs on</dt><dd>${reqs.map(esc).join("<br>")}</dd></div>` : ""}
      ${dl.kind === "file" ? `<div><dt>Download</dt><dd><a href="${esc(sitePath(dl.path))}">${esc(dl.path.split("/").pop())}</a>${dl.size ? ` · ${esc(dl.size)}` : ""}</dd></div>` : ""}
      ${links.length ? `<div><dt>Links</dt><dd>${links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(" · ")}</dd></div>` : ""}
    </dl>
  </section>
</main>
${footerHTML(site, [app])}
<script src="${sitePath("/scripts/hub.js")}" defer></script>
</body>
</html>
`;
}

// ---------------- downloads index ----------------
function downloadsHTML(site, apps) {
  const identityName = site.author || site.name || site.title;
  const avatar = existsSync(path.join(ROOT, "src/assets/site/avatar.png")) ? sitePath("/assets/site/avatar.png") : sitePath("/assets/site/favicon.png");
  const withFiles = apps.filter((a) => a.download?.kind === "file" && a.download?.path);
  const rows = withFiles.map((a) => {
    let size = null;
    try { size = humanBytes(statSync(path.join(ROOT, "public", a.download.path.replace(/^\//, ""))).size); } catch {}
    return `<tr><td><a href="${sitePath(`/${a.slug}/`)}">${esc(a.name)}</a></td><td>v${esc(a.version || "—")}</td><td><a href="${esc(sitePath(a.download.path))}" download>${esc(a.download.path.split("/").pop())}</a></td><td>${esc(size || "—")}</td></tr>`;
  }).join("\n      ");
  return `${headHTML({ title: `Downloads — ${site.title}`, description: `Every downloadable build for ${site.name}.`, site })}
<body class="hub dl-page">
<main class="page">
  <header class="identity">
    <a href="${sitePath("/")}"><img class="identity__avatar" src="${avatar}" alt="" /></a>
    <div>
      <h1 class="dl-title">Downloads</h1>
      <p class="dl-sub">Every build in one place. Unsigned developer builds: right-click → Open on first launch.</p>
    </div>
  </header>
  <div class="table-wrap"><table class="dl-table">
    <thead><tr><th>App</th><th>Version</th><th>File</th><th>Size</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</main>
<footer class="hub-foot">
  <a href="${sitePath("/")}">← All apps</a>
</footer>
</body>
</html>
`;
}

// ---------------- build ----------------
async function readJSON(p) { return JSON.parse(await readFile(p, "utf8")); }

async function main() {
  if (!existsSync(SITE_PATH)) { console.error(`site.json not found: ${SITE_PATH}`); process.exit(1); }
  const site = await readJSON(SITE_PATH);

  let files = [];
  try { files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".json")).sort(); }
  catch { fail(`data dir missing: ${DATA_DIR}`); }
  if (!files.length) console.warn(`warning: no app JSON files in ${DATA_DIR}`);

  const apps = [];
  for (const f of files) {
    try {
      const a = await readJSON(path.join(DATA_DIR, f));
      if (validateApp(a, f)) apps.push(normApp(a));
    } catch (e) { fail(`${f}: ${e.message}`); }
  }
  apps.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name));

  const seen = new Set();
  for (const a of apps) {
    if (seen.has(a.slug)) fail(`duplicate slug: ${a.slug}`);
    seen.add(a.slug);
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // copy static dirs (skip silently when absent)
  const copies = [
    [ASSETS_SRC, path.join(OUT_DIR, "assets")],
    [path.join(ROOT, "src/styles"), path.join(OUT_DIR, "styles")],
    [path.join(ROOT, "src/scripts"), path.join(OUT_DIR, "scripts")],
    [path.join(ROOT, "public"), OUT_DIR],
  ];
  for (const [from, to] of copies) {
    if (existsSync(from)) await cp(from, to, { recursive: true });
  }

  await writeFile(path.join(OUT_DIR, "index.html"), hubHTML(site, apps));
  for (const a of apps) {
    const dir = path.join(OUT_DIR, a.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), appPageHTML(site, a));
  }
  await mkdir(path.join(OUT_DIR, "downloads"), { recursive: true });
  await writeFile(path.join(OUT_DIR, "downloads", "index.html"), await downloadsHTML(site, apps));
  await writeFile(path.join(OUT_DIR, "404.html"),
    `${headHTML({ title: `Not found — ${site.title}`, description: "This page does not exist.", site })}
<body class="hub"><div class="notfound"><h1>Lost?</h1><p>That page is not here. <a href="${sitePath("/")}">Back to the apps →</a></p></div></body>
</html>`);

  // verify referenced assets exist
  for (const a of apps) {
    const heroImgs = [a.icon, a.hero, ...(a.screenshots || []).map((s) => s.src)]
      .filter(Boolean).filter((r) => !/^https?:\/\//.test(r));
    for (const rel of heroImgs) {
      if (!checkAsset(rel)) fail(`${a.slug}: missing asset ${path.relative(ROOT, ASSETS_SRC)}/${rel}`);
    }
    if (a.download?.kind === "file" && a.download?.path) {
      const abs = path.join(ROOT, "public", a.download.path.replace(/^\//, ""));
      if (!existsSync(abs)) console.warn(`warning: ${a.slug}: download missing ${a.download.path} (page will show "not uploaded yet")`);
    }
  }

  if (errors.length) {
    console.error(`build failed with ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`built ${apps.length} app page(s) + hub + downloads -> ${path.relative(ROOT, OUT_DIR) || OUT_DIR}`);
}

await main();
