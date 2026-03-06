# Kontrast — Quem está no Espaço

Live display of members currently in the Pinheiros space, embedded at **kontrast.com.br/pages/pinheiros**.

---

## Architecture

```
Control iD / iDSecure  ──→  Vercel Serverless API  ──→  Shopify Page (iframe)
(access logs + photos)       (api/live.js)            (page.pinheiros.liquid)
```

The Vercel function securely holds your API credentials and polls iDSecure every time the page requests data (every 30 seconds).

---

## Step 1 — Deploy the backend to Vercel

### Prerequisites
- A free [Vercel](https://vercel.com) account
- [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`

### Deploy
```bash
cd kontrast-presence
vercel deploy --prod
```

Vercel will give you a URL like `https://kontrast-presence-abc123.vercel.app`

### Set environment variables in Vercel dashboard
Go to your project → Settings → Environment Variables and add:

| Name                  | Value                                      |
|-----------------------|--------------------------------------------|
| `IDSECURE_BASE_URL`   | `https://main.idsecure.com.br:5000`        |
| `IDSECURE_EMAIL`      | Your email from iDSecure                   |
| `IDSECURE_PASSWORD`   | Your password from iDSecure                |
| `ALLOWED_ORIGIN`      | `https://kontrast.com.br`                  |

> ⚠️ **Never commit your token to git.** Use `.env.local` locally (it's gitignored).

---

## Step 2 — Update the frontend URL

In `public/index.html`, replace:
```js
const API_URL = "https://YOUR-PROJECT.vercel.app/api/members";
```
with your actual Vercel URL.

In `shopify/page.pinheiros.liquid`, replace:
```html
src="https://YOUR-PROJECT.vercel.app"
```
with your actual Vercel URL.

Redeploy after editing:
```bash
vercel deploy --prod
```

---

## Step 3 — Add the page to Shopify

1. In Shopify Admin: **Online Store → Themes → Edit Code**
2. Under **Templates**, click "Add a new template"
3. Choose type **page**, name it **pinheiros** → creates `page.pinheiros.liquid`
4. Replace its contents with the code in `shopify/page.pinheiros.liquid`
5. Save
6. Go to **Pages → Add page**
   - Title: `Pinheiros` (or anything you like)
   - Template: `page.pinheiros`
7. Save → your page is live at `kontrast.com.br/pages/pinheiros`

---

## How it works

### Access log query
The API calls iDSecure's `/load_objects` endpoint with:
- Object: `access_logs`
- Filter: event type = 7 (door granted) + timestamp >= now − 3h
- Sorted by most recent first

### Deduplication
If a member entered multiple times in 3 hours, only their **latest** entry is shown (so each person appears once).

### Photos
Photos are fetched via `/get_user_image?id=<personId>`. If unavailable, the card shows the member's initials as a fallback.

---

## Local development

```bash
cp .env.example .env.local
# Fill in your credentials

npm install -g vercel
vercel dev
# → API available at http://localhost:3000/api/members
# → Frontend at http://localhost:3000
```

---

## Customisation

| What                         | Where                                      |
|------------------------------|--------------------------------------------|
| Refresh interval             | `REFRESH_INTERVAL_MS` in `public/index.html` |
| Window to show (3h)          | `3 * 60 * 60 * 1000` in `api/live.js`  |
| Accent colours               | CSS variables in `public/index.html`       |
| Space name / city            | Header text in `public/index.html`         |
| iDSecure API path variations | `fetchIDSecure()` in `api/live.js`      |

---

## iDSecure API notes

The `/load_objects` and `/get_user_image` endpoints follow the standard Control iD REST API
pattern documented at https://www.controlid.com.br/docs/access-api-pt/

If your iDSecure instance uses different field names (e.g. `portal_name` vs `door_name`),
adjust the mapping in `api/live.js` → `getMembersInHouse()`.

You can inspect the exact fields your device returns by opening:
```
https://main.idsecure.com.br:5000/swagger/index.html
```
and calling `/load_objects` with `{ "object": "access_logs", "limit": 1 }` to see a sample record.
