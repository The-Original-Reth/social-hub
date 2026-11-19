# Social Hub

A self-hosted server for posting to **Facebook, Instagram and TikTok** from one place, with a web interface:

- **Planner:** a week, month or list calendar of drafts, scheduled posts and published posts, filtered by network and status. Posts waiting for approval and unscheduled drafts sit in the side panel.
- **Composer:** write once, customize the text per network, attach a photo or video, and preview how it will look on each network. Then save a draft, send it for approval, schedule it, or post it now.
- **Media library:** upload once and reuse files across posts.
- **Accounts:** see what's connected, and connect TikTok.

Posts move through **Draft → Needs approval → Scheduled → Published**. If one network fails, the others still post, and you can retry just the failed ones.

> **Dry run is on by default.** Until you set `DRY_RUN=false`, posts are simulated and nothing reaches the networks. That way you can try everything safely before your accounts are connected.

---

## Run it

### On Proxmox (CT 110, Docker)

From this folder on your PC (Git Bash):

```bash
sh deploy/deploy-to-proxmox.sh root@<proxmox-host-ip> 110
```

The script:
1. packs the app and copies it to the Proxmox host
2. turns on `nesting` and `keyctl` for CT 110 if they're off (Docker needs them inside LXC). This restarts the container once.
3. installs Docker inside CT 110 if it's missing
4. unpacks the app to `/opt/social-hub` and starts it with `docker compose`
5. on first install, creates `/opt/social-hub/.env` with a random admin password and prints it

Then open `http://<CT-110-ip>:3000` and log in as `admin` with the password it printed.

Running the script again updates the app and keeps your `.env` and `data/` (posts, media, TikTok login).

Inside the container, useful commands:

```bash
cd /opt/social-hub && docker compose logs -f
```

```bash
cd /opt/social-hub && nano .env && docker compose up -d
```

### Locally (for development)

Requires Node 22.13 or newer.

```bash
npm install && cp .env.example .env && npm run dev
```

Open http://localhost:3000.

---

## Make it reachable from the internet

Instagram downloads your photos and videos from this server, and TikTok sends you back to it after you log in, so it needs a **public https address**. Social Hub includes a Cloudflare Tunnel for this, so you don't open any ports on your router. You need a domain that uses Cloudflare for its DNS.

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and name it `social-hub`.
2. On the install page, copy the token. It's the long string at the end of the `cloudflared service install …` command. You don't need to install anything; Social Hub runs cloudflared itself.
3. Add a **public hostname**: subdomain `social`, your domain, service type **HTTP**, URL **`http://social-hub:3000`** (some versions of the form want the `http://` typed in).
4. On the Proxmox host, open the container and run the setup script:
   ```bash
   pct enter 110
   ```
   ```bash
   sh /opt/social-hub/deploy/enable-tunnel.sh
   ```
   It asks for the hostname and the token, saves them in `.env` (including `PUBLIC_BASE_URL`), and starts the tunnel.

**The website itself stays on your home network.** Requests that come in through the tunnel can only reach:

| Path | Why it's public |
|---|---|
| `/media/<file>` | Instagram downloads your photos and videos from here. Files get random names, so they can't be guessed. |
| `/auth/tiktok/callback`, `/auth/meta/callback` | TikTok and Facebook send you back here after you log in. Each only works once, with the code made when you clicked Connect, and then sends you back to the home-network address you started from. |
| `/healthz` | A health check that says "ok" and nothing else. |

Everything else, including the website and its API, answers **404 Not found** from the internet, even with the password. On your home network, use `http://<CT-110-ip>:3000` with the admin password.

---

## Connect Facebook and Instagram

You can post to **your own** Page and Instagram account without Meta's App Review. App Review is only needed to manage other people's accounts.

1. Your Instagram account must be a **Business or Creator** account, linked to your Facebook Page (Instagram app → Settings → Account type, then link the Page).
2. Go to https://developers.facebook.com/apps, create an app (type **Business**), and add **Facebook Login** (or **Facebook Login for Business**) and **Instagram Graph API**.
3. In Social Hub, open **Accounts**. Under **Facebook & Instagram**, enter the **App ID** and **App secret** (Meta app → App settings → Basic) and click **Save**.
4. Copy the redirect URI shown there into the Meta app's Facebook Login settings, under **Valid OAuth Redirect URIs**. If your app uses **Facebook Login for Business**, also create a login configuration with the permissions below and paste its **configuration ID** into Social Hub.
5. Click **Log in with Facebook**, allow access to your Page, then pick the Page on the Accounts page. Its Instagram account is found automatically.

**Instead of logging in,** you can open **Or paste a token from the Graph API Explorer**. In the Explorer, select your app, add these permissions, generate a **User token** and paste it in:
`pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management`

Either way, Social Hub keeps the Page's access token, which doesn't expire unless you change your Facebook password or remove the app. It's stored on the server and never shown in the browser. (`npm run meta:setup` still works if you prefer putting the values in `.env`.)

**Network rules:**
- **Facebook:** text, photo, or video.
- **Instagram:** needs a photo (JPEG) or a video, which posts as a Reel. Up to 2,200 characters and 30 hashtags.

## Connect TikTok

1. Create an app at https://developers.tiktok.com, add **Login Kit** and **Content Posting API** (turn on **Direct Post**), and request the scopes `user.info.basic` and `video.publish`.
2. In Social Hub, open **Accounts**. Under **TikTok**, enter the **Client key** and **Client secret** and click **Save**.
3. Copy the redirect URI shown there into the TikTok app's Login Kit settings.
4. Click **Connect TikTok** and log in. Social Hub refreshes the login automatically, which lasts up to a year.

**Important:** until TikTok **audits** your app, posts can only be **private** (set **Who can see posts** to **Only me**). After the audit, you can choose **Everyone**. TikTok posts need a video (MP4, MOV or WebM).

When everything is connected and a few test posts look right, click **Switch to live posting** at the top of the Accounts page.

---

## Settings (`.env`)

You normally don't need these. The network accounts, app keys and posting mode are set on the **Accounts** page, and a value saved there replaces the same setting from `.env`. The ones only `.env` can set are `PUBLIC_BASE_URL`, the admin login, `MAX_UPLOAD_MB` and `SCHEDULER_INTERVAL_MS`.

| Setting | What it does |
|---|---|
| `PUBLIC_BASE_URL` | Public https address of this server |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Login for the web interface |
| `DRY_RUN` | `true` simulates posting; `false` posts for real |
| `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` | Your Facebook Page |
| `INSTAGRAM_USER_ID` | Instagram business account linked to that Page |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok developer app |
| `TIKTOK_PRIVACY_LEVEL` | `SELF_ONLY` until audited |
| `MAX_UPLOAD_MB` | Largest upload allowed (default 1024) |
| `SCHEDULER_INTERVAL_MS` | How often to check for due posts (default 20000 = 20 s) |

## How it works

- `src/server.js`: web server and REST API
- `src/scheduler.js`: every 20 s, publishes posts whose time has come
- `src/publisher.js`: sends a post to each network in parallel and records each result
- `src/platforms/`: one file per network (Facebook, Instagram, TikTok)
- `data/`: SQLite database and uploaded media (a Docker volume, so back this up)

If the server restarts in the middle of publishing, that post is marked failed instead of being posted again, because it may already be live. Check the network before you press Retry.

---

## License, terms and privacy

Social Hub is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a changed version for other people, including as a website, you must offer them its source code.

- [Terms of Service](TERMS.md)
- [Privacy Policy](PRIVACY.md), including how to delete data

If you run your own Social Hub server with your own TikTok and Meta developer apps, you're its operator. These documents explain what the software does, but you're responsible for your server and for your own apps' terms and policies.
