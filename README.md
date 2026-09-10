# Homeland Helpdesk

Role-based IT helpdesk for Homeland Group — Super Admin, Managers, Users, and a public complaint form.

## What's in this repo

| File | Purpose |
|---|---|
| `index.html` | The whole app (HTML + CSS + JS, single file) |
| `schema.sql` | Run this once in Supabase SQL Editor to set up the database |
| `README.md` | This file |

## How the pieces fit together

```
   Browser (any device)
         │
         ▼
   GitHub Pages  ← serves index.html  (free static hosting)
         │
         ▼
   Supabase  ← stores shared data + real-time sync  (free tier)
```

- **GitHub** holds the source code **and** serves the site via GitHub Pages.
- **GitHub Pages** re-publishes `index.html` every time you push to `main`.
- **Supabase** is the database — one shared source of truth for every device.

You'll do the setup **once**. After that, every change is just: edit → commit → push → live in about a minute (GitHub Pages can take a few minutes extra to clear its CDN cache).

---

## Step 1 — Push the code to GitHub

You said the repo is already created (**Homeland Helpdesk**). On the machine where you have this folder:

```bash
cd path/to/this/folder
git init
git add index.html schema.sql README.md
git commit -m "Initial helpdesk app"
git branch -M main
git remote add origin https://github.com/<your-username>/Homeland-Helpdesk.git
git push -u origin main
```

Replace `<your-username>` with your actual GitHub username. If GitHub asks for a password, use a **Personal Access Token** (Settings → Developer settings → Personal access tokens → Fine-grained → "repo" scope).

Confirm on GitHub that the three files are visible in the repo.

---

## Step 2 — Set up Supabase (once, ~2 minutes)

1. Sign in at [supabase.com](https://supabase.com) → open your **Homeland Helpdesk** project.
2. Left sidebar → **SQL Editor** → click **+ New query**.
3. Open `schema.sql` from this repo, copy its whole contents, paste into the SQL Editor.
4. Press **Run** (or Ctrl/Cmd + Enter). You should see *"Success. No rows returned."*
5. Left sidebar → **Table Editor** → confirm the table **`hg_state`** exists with one row (`id = 1`, `data = {}`).

That's it — the database is ready.

### Grab your credentials

- Left sidebar → **Project Settings** (gear icon) → **API**
- Copy two values:
  - **Project URL** — looks like `https://xxxxxxxx.supabase.co`
  - **anon public** key — starts with `eyJ...` (long string). This is safe to expose in browser code.

Keep both handy for Step 4.

---

## Step 3 — Deploy on GitHub Pages (once, ~1 minute)

1. On GitHub, open your repository → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set **Branch** to `main` and the folder to **/ (root)**, then click **Save**.
4. Wait ~1 minute. GitHub Pages publishes your site at
   `https://<your-username>.github.io/<repo-name>/`
   (for this project it's <https://dme77.github.io/homeland-helpdesk/>).

Open that URL. The login screen loads. You can already sign in with `Vivek` / `Homeland@77` — but data is still local per-browser. Step 4 turns on the shared database.

---

## Step 4 — Connect the app to Supabase

1. Open `index.html` in a text editor (VS Code, Notepad++, or GitHub's web editor is fine).
2. Find these two lines near the top of the `<script>` block (around line 830):
   ```js
   var HG_SUPABASE_URL = '';   // e.g. 'https://xxxxxxxx.supabase.co'
   var HG_SUPABASE_KEY = '';   // your anon public key (safe to expose)
   ```
3. Paste your Supabase Project URL and anon key inside the quotes:
   ```js
   var HG_SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   var HG_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
   ```
4. Commit and push:
   ```bash
   git add index.html
   git commit -m "Connect Supabase backend"
   git push
   ```
5. GitHub Pages re-publishes in about a minute. Refresh your GitHub Pages URL (a hard refresh clears any cached copy).

The sync bar at the top of the app should now show a green **"Connected to Supabase — data syncs across all devices"**. Log in on your phone, on a colleague's laptop, from anywhere — everyone sees the same live data.

---

## Step 5 — First login and creating users

1. Open the deployed site.
2. Click **Admin Login**.
3. Sign in with:
   - **Username:** `Vivek` (or `SA261`)
   - **Password:** `Homeland@77`
4. Go to **User Management → Create user / admin** to add your managers and users.
5. Managers become "Heads of Department" for whichever department you assign them to.
6. Users are assigned under a manager. Only Users can receive queries; managers oversee their team.

---

## Ongoing use

Every time you change something (fix a bug, adjust a label, add a feature):

```bash
git add index.html
git commit -m "what you changed"
git push
```

GitHub Pages republishes automatically. No further Supabase changes needed unless you're evolving the database schema.

---

## Troubleshooting

**Sync bar shows amber "Local mode" instead of green "Connected"**
→ Check that `HG_SUPABASE_URL` and `HG_SUPABASE_KEY` are filled in inside the quotes in `index.html`. Also open the browser DevTools Console (F12) to see any Supabase connection errors.

**Login fails after switching to Supabase**
→ The Supabase row starts empty (`{}`). On first successful load, the app writes the seeded Vivek admin into it. Just try logging in with `Vivek` / `Homeland@77` again — if the write succeeded, it works.

**Someone else's changes aren't showing up on my screen**
→ Realtime should push them within a second. If not, check in the Supabase dashboard: **Database → Replication → supabase_realtime** — the `hg_state` table should be listed. If missing, re-run the last line of `schema.sql`.

**I want to reset everything**
→ In Supabase SQL Editor:
```sql
UPDATE hg_state SET data = '{}' WHERE id = 1;
```
Then refresh the app — it will re-seed the Vivek admin.

---

## Security note

The `anon public` key is safe to expose in browser code (Supabase is designed for this). RLS is currently disabled for simplicity. For a production deployment with untrusted users, add:

1. Row Level Security policies on `hg_state` (only authenticated users read/write).
2. Supabase Auth for real password hashing (currently passwords are stored in plaintext inside the JSON blob — fine for a small internal team, not for public).

Ask me when you're ready to harden it.
