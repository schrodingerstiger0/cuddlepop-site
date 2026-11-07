# Cuddle Pop — website (cuddlepop.com)

Static site, no build step. Files:

- `index.html` — the marketing page.
- `join.html` — invite landing page, served at `/join/<code>`; opens `cuddlepop://join/<code>` and shows the code with store buttons (fill in `IOS` / `ANDROID` links in the script once the listings exist).
- `.well-known/apple-app-site-association` — iOS universal links for `/join/*`. Replace `TEAMID` with the Apple Team ID of the app (EAS credentials show it). Must be served as `application/json` with no redirect.
- `.well-known/assetlinks.json` — Android app links. Replace the SHA-256 with the release signing certificate fingerprint.
- `vercel.json` — clean URLs, the `/join/:code` rewrite and the JSON headers, for Vercel hosting.

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
<Files "apple-app-site-association">
  ForceType application/json
</Files>
```

No DNS change is needed when the domain and hosting are on the same Hostinger account.

**B. Vercel.** `vercel login`, then from this folder `vercel --prod` and `vercel domains add cuddlepop.com`. Vercel prints the records: an `A` record for `@` → `76.76.21.21` and a `CNAME` for `www` → `cname.vercel-dns.com`. Add both at Hostinger; certificates are automatic.

**C. GitHub Pages.** Push this folder to a repo, enable Pages on the branch, set the custom domain to `cuddlepop.com` (this creates a `CNAME` file). At Hostinger add four `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` and a `CNAME` for `www` → `<github-user>.github.io`, then tick "Enforce HTTPS" once the certificate is issued. Pages does not run `vercel.json`: add a `404.html` copy of `join.html` so `/join/<code>` still resolves (the script reads the code from the path).

## Before launch

- Wire the early-access form (`#waitlist` handler at the bottom of `index.html`) to a form service or an API endpoint. Today it only shows a confirmation on the page.
- Set the Plus price in the pricing section once it is decided.
- Add `<meta name="description">`, Open Graph tags and a favicon.
- Fill in `TEAMID`, the Android fingerprint and the store links above.
