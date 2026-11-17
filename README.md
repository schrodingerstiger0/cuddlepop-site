# Cuddle Pop — website (cuddlepop.com)

Static site, no build step. Files:

- `index.html` — the marketing page.
- `side/` — the guest page (docs/18 §3, §4, §6): the second partner says their side, or plays the invite's 2-minute game, with no app and no account. `side/index.html` + `side/assets/side.css` + `side/assets/side.js`, vanilla JS, no build step, site tokens only (Epilogue / Plus Jakarta Sans, cream canvas, ink outlines, pop shadows). Flow: Oliver's three promises (verbatim) → their side (saves as they type) → the yes (Yes / Not yet, "Delete the whole thing" confirmed in the page) → after-yes screen with the only install pitch and the code. Game invites go straight into the game; answers are sealed and the reveal shows once both have answered. The guest token lives in `sessionStorage` for that tab only and goes out as `Authorization: Bearer` on `/v1/guest/*`.
  - API base: `<meta name="api-base">`, empty in the repo, which means the page's own origin + `/v1` (the API serves this page at `/side/{code}` in dev, e.g. `http://<lan-ip>:8000/side/ABC123`). `deploy-pages.sh` writes the production value from `SIDE_API_BASE`. The API's `cors_origins` must include `https://cuddlepop.com` in prod.
  - Store links: `<meta name="app-store-ios">` / `app-store-android`, filled by `deploy-pages.sh` from `IOS_STORE_URL` / `ANDROID_STORE_URL`; buttons stay hidden while empty.
  - "Open in the app" shows only when the app is known to be on the phone (Android `getInstalledRelatedApps`, or a past successful open). "I already have the app" tries `cuddlepop://join/<code>` in a hidden iframe and, if the page is still visible after 1.6 s, says the app isn't installed instead of leaving a dead button.
  - Check the state machine without a browser: `node apps/web/tools/side-check.js`.
- `join.html` — `/join/<code>` is the universal link in every invite. On hosts with rewrites (Vercel, Hostinger) it forwards to `/side/<code>`; it never redirects into the app on its own. On GitHub Pages `/join/<code>` is served by `404.html`, which `deploy-pages.sh` copies from `side/index.html`, so the promises render directly.
- `.well-known/apple-app-site-association` — claims no invite paths on purpose: `/join/*` and `/side/*` are `NOT` entries, so an invite opens this web page first on every device, app installed or not (docs/18 §3). The page's "Open in the app" uses `cuddlepop://join/<code>`. Android likewise has no verified `/join` intent filter (apps/mobile/app.config.ts). Replace `TEAMID` with the Apple Team ID of the app (EAS credentials show it). Must be served as `application/json` with no redirect.
- `.well-known/assetlinks.json` — Android app links. Replace the SHA-256 with the release signing certificate fingerprint.
- `vercel.json` — clean URLs, the `/join/:code` rewrite and the JSON headers, for Vercel hosting (needs a `/side/:code` → `/side/index.html` rewrite too if Vercel is ever used).

## Run locally

```sh
make web-serve        # http://localhost:4321
```

## Connecting cuddlepop.com (domain is at Hostinger)

Pick one host; the DNS records go into Hostinger → Domains → cuddlepop.com → DNS / Name servers.

**A. Hostinger web hosting (if the plan includes hosting).** In hPanel → Websites → cuddlepop.com → File manager, upload the contents of this folder into `public_html` (keep the `.well-known` folder and `join.html`). Add to `.htaccess` in `public_html`:

```
RewriteEngine On
RewriteRule ^join/([A-Za-z0-9]+)/?$ /join.html [L]
RewriteRule ^side/([A-Za-z0-9]+)/?$ /side/index.html [L]
<Files "apple-app-site-association">
  ForceType application/json
</Files>
```

No DNS change is needed when the domain and hosting are on the same Hostinger account.

**B. Vercel.** `vercel login`, then from this folder `vercel --prod` and `vercel domains add cuddlepop.com`. Vercel prints the records: an `A` record for `@` → `76.76.21.21` and a `CNAME` for `www` → `cname.vercel-dns.com`. Add both at Hostinger; certificates are automatic.

**C. GitHub Pages (chosen, live).** The site is published from the public repo `schrodingerstiger0/cuddlepop-site` by its GitHub Actions workflow (`.github/workflows/pages.yml` there) on every push to `main`. From this project: `SIDE_API_BASE=https://<api host>/v1 make web-deploy` pushes apps/web to that repo by hand, and `.github/workflows/web-deploy.yml` does the same automatically on push to `main` once this project is on GitHub and the `SITE_DEPLOY_KEY` secret (private half of a write deploy key on cuddlepop-site) is set. Setup was: push this folder to a repo, enable Pages on the branch, set the custom domain to `cuddlepop.com` (this creates a `CNAME` file). At Hostinger add four `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` and a `CNAME` for `www` → `<github-user>.github.io`, then tick "Enforce HTTPS" once the certificate is issued. Pages does not run `vercel.json`: `deploy-pages.sh` writes `404.html` as a copy of `side/index.html` so `/join/<code>` and `/side/<code>` both resolve (the page reads the code from the path and loads its assets from absolute `/side/assets/` paths). The CI workflow must do the same copy.

## Before launch

- Wire the early-access form (`#waitlist` handler at the bottom of `index.html`) to a form service or an API endpoint. Today it only shows a confirmation on the page.
- Set the Plus price in the pricing section once it is decided.
- Add `<meta name="description">`, Open Graph tags and a favicon.
- Fill in `TEAMID`, the Android fingerprint and the store links above.
- Decide whether the app should keep claiming `/join/*` as a universal link: once `TEAMID` / the fingerprint are real, installed users open the app straight from the invite and skip the web page (docs/18 §3 says page first).
- Set `SIDE_API_BASE` for deploys and add `https://cuddlepop.com` to the API's `cors_origins`.

## Source of the current design

index.html is a short single-scroll landing page (2026-11-17) generated in Stitch from the "Retro Romance & Digital
Intimacy" design system in the project "Retro Gen Z CuddlePop" (projects/18230474138243898393, screen 14cda6d2…),
then wired to the site's scripts (sign-up form, share step, get-the-app modal, GA tracking) and the compiled Tailwind
in assets/site.css (`npm run build:css` after any class change). Under 200 visible words: hero with Oliver between two
phones (looping bubbles, ear wiggle, blink, pointer tilt), tappable fight chips with a typed reply, a chatbot-vs-Oliver
toggle that flips itself once, three step cards that light up in order, the Let's Fight button with meter and toast,
Oliver holding a lock, two plan cards, five FAQs (mirrored in the FAQPage JSON-LD), sign-up, footer. All
illustrations are inline SVG so they animate; `prefers-reduced-motion` turns the motion off. Copy rules: lowercase
except Oliver, Cuddle Pop, Let's Fight; no pronouns for Oliver; no testimonials, ratings, counts or prices.
Old hashes (#home, #how-it-works, #lets-fight, #privacy, #pricing, #cta) still land on the right section.
Earlier versions: docs/web-archive/index-v1.html (hand-built), Stitch screens 5273d678… (long cozy edition),
edcadf25… (tabbed mobile edition), 82470a3f… (icon sprite used by the 2026-11-14 page).
