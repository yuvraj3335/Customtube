# Deploying Custom Tube

Custom Tube is one Node process that keeps its data in memory: it needs a host that runs a
long-lived container (or VM) with about **512 MB of RAM**. The `Dockerfile` builds a
self-contained image (app + data export + search model), so any container host works.

What it doesn't fit: Vercel, Netlify and Cloudflare Pages (static or short-lived serverless
functions), and Hugging Face Spaces (Docker Spaces now need a paid PRO plan).

## Free options, best first

| Host | Cost | Good for | Catch |
|---|---|---|---|
| **Render** (free web service) | Free, no card needed | Trying it out and sharing a link | Sleeps after ~15 min idle; the next visit waits ~30–60 s while it wakes. 512 MB RAM. Free bandwidth is small, so not for lots of users. |
| **Google Cloud Run** | Free within the monthly free tier (2M requests, 360K GB-seconds); needs a billing account | Real users at low to moderate traffic | Card required. Scales to zero, so a cold start of a few seconds after idle. |
| **Oracle Cloud Always Free** (Arm VM) | Free, card for sign-up | Always on, fastest | Sign-up can be refused, idle VMs can be reclaimed, and you run the server yourself. |

## Render (easiest: about 10 minutes)

1. Sign up at https://render.com with your GitHub account and allow it to read the
   `yuvraj3335/Customtube` repo.
2. **New → Blueprint**, pick the repo. Render reads `render.yaml` and creates a free Docker web
   service called `customtube`.
3. The first build takes ~10 minutes (it downloads the data and the search model). When it's
   live you get `https://customtube-xxxx.onrender.com`.
4. In the service's **Environment**, set `PUBLIC_URL` to that address (for share previews) and
   save; it redeploys.

Every push to `main` redeploys. If the free service runs out of memory (it would restart), set
`CUSTOMTUBE_EMBEDDER=off` to save ~100 MB; search then matches by keywords only.

## Google Cloud Run

With the gcloud CLI installed and a project with billing enabled:

```bash
gcloud run deploy customtube --source . --region us-central1 --allow-unauthenticated \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 2 --set-env-vars TRUST_PROXY=1
```

It builds the Dockerfile in Cloud Build and prints the `https://customtube-…run.app` URL. Set
`--set-env-vars PUBLIC_URL=https://…` on a second deploy. `--max-instances 2` keeps costs
bounded; stay inside the free tier by keeping `--min-instances 0`.

## Any VM (Oracle Always Free, a $5 VPS, a home server)

```bash
git clone https://github.com/yuvraj3335/Customtube.git && cd Customtube
docker build -t customtube .
docker run -d --name customtube --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e TRUST_PROXY=1 -e PUBLIC_URL=https://tube.example.com customtube
```

Put Caddy in front for HTTPS (it gets certificates automatically). `/etc/caddy/Caddyfile`:

```
tube.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## After it's live

- Open the URL on your phone and use **Add to Home Screen** / **Install**: it runs like an app.
- `/healthz` is the health check (`degraded: true` means search is keyword-only for now).
- Everyone's likes, lists and settings live in their own browser, so there is no database to back
  up and nothing personal on the server.
- The data is licensed ODC-By 1.0, which requires the credit line on the About page. Keep it when
  you publish.
