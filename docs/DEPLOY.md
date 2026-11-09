# Deploying danny2110.github.io

Static site built by `node build.mjs` into `dist/`, deployed to GitHub Pages by GitHub Actions.

Live URL: https://danny2110.github.io

## 1. Create the repository

The repo must be named exactly `Danny2110.github.io` (the GitHub *user site*), owned by the `Danny2110` account.

```bash
cd /Users/danny/Sites/danny2110.github.io
git init -b main
git add .
git commit -m "Initial site"
gh repo create Danny2110/Danny2110.github.io --public --source=. --remote=origin --push
```

No remote yet? Create it on github.com as a public repo, then:

```bash
git remote add origin https://github.com/Danny2110/Danny2110.github.io.git
git push -u origin main
```

## 2. Set Pages source to GitHub Actions

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Do not pick "Deploy from a branch": the workflow `.github/workflows/deploy.yml`
owns the deploy. No secrets are needed — `GITHUB_TOKEN` plus the workflow's
`pages: write` / `id-token: write` permissions are enough.

## 3. Push to main

```bash
git push origin main
```

The workflow runs on every push to `main` and can also be started by hand from
**Actions → Deploy to GitHub Pages → Run workflow** (`workflow_dispatch`).

Jobs:

- **build** — checkout, Node 24, `node build.mjs`, `actions/configure-pages`, upload `dist/` as the Pages artifact.
- **deploy** — `actions/deploy-pages`, environment `github-pages`.

A `pages` concurrency group means one deploy at a time; a queued run waits
instead of cancelling the live deploy.

## 4. First deploy

1. Push to `main`.
2. Watch **Actions → Deploy to GitHub Pages** until both jobs are green (usually 1–2 minutes).
3. Open https://danny2110.github.io and check the downloads under `/downloads/`.

If the deploy job fails with `Get Pages site failed`, the Pages source is still
set to a branch — fix step 2 and re-run the workflow.

## 5. Local check before pushing

```bash
node build.mjs          # writes dist/
node scripts/check-links.mjs   # exits 1 on broken internal links
```

`check-links.mjs` walks `dist/`, reads every `href`/`src`, and reports internal
targets that resolve to no file. It ignores `#fragment`, `mailto:`, `tel:`,
`data:`, `javascript:`, and `http(s):` links.

## Custom domain (optional, later)

1. **Settings → Pages → Custom domain**, enter e.g. `danny.example.com`, save.
   GitHub writes a `CNAME` file to the deployed site.
2. At the DNS provider add a `CNAME` record for the subdomain pointing to
   `danny2110.github.io` (an apex domain needs `A`/`AAAA` records to GitHub's
   Pages IPs instead).
3. Wait for the DNS check, then enable **Enforce HTTPS**.

With the Actions source, add a `CNAME` file to `public/` (or have `build.mjs`
emit one into `dist/`) so the domain survives every deploy; a domain set only
in the UI is dropped when the artifact has no `CNAME`.
