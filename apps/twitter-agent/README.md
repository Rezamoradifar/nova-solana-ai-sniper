# Terminal_X — Autonomous AI X (Twitter) Agent

An AI-run X account that posts original, high-quality content, monitors AI/crypto/tech
news, detects trends, replies to mentions (always disclosed as an AI), and continuously
tunes its own posting schedule and style based on real engagement data.

This agent does **not** impersonate humans, does not "snipe" replies on other accounts'
threads, and never solicits funds through a fake persona — see `llm/claude_client.py`'s
system prompt for the hard rules baked into every generation call.

## Architecture

```
/agent        orchestration: pipeline.py (generate -> score -> dedup -> publish),
              scheduler.py (APScheduler jobs), main.py (entrypoint)
/core         config.py (env loading), models.py (shared dataclasses)
/twitter      client.py — Tweepy v2 wrapper with retry/backoff
/llm          claude_client.py (generation + scoring + persona),
              openai_images.py, embeddings.py
/news         fetcher.py (RSS monitoring), rewriter.py
/memory       db.py (SQLite), vector_store.py (local embedding-based dedup)
/analytics    metrics.py, scheduler_optimizer.py, reporter.py
/dashboard    FastAPI read-only dashboard (followers, engagement, trends, recommendations)
/docker       Dockerfile, start.sh, docker-compose.yml
```

## Requirements before you run this

1. **X (Twitter) API v2 access with a paid tier.** The free tier cannot read mentions,
   search recent tweets, or fetch tweet metrics — all of which this agent needs. You need
   at least the **Basic** tier (~$200/month) from https://developer.twitter.com. Posting-only
   would work on a lower tier, but mention replies, trend detection, and analytics require
   read access that free doesn't include.
2. An **Anthropic API key** (console.anthropic.com) with billing enabled.
3. An **OpenAI API key** (platform.openai.com) with billing enabled — used for image
   generation and embeddings (the local vector database).

## Local setup

```bash
cd apps/twitter-agent
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in your real keys
python -m agent.main            # runs the scheduler loop
# in a second terminal:
uvicorn dashboard.app:app --reload --port 8080   # dashboard at http://localhost:8080
```

## How it decides what to post

- **Scoring gate** (`agent/pipeline.py`): every candidate post is scored by Claude itself
  across six axes (virality, curiosity, emotion, humor, novelty, readability). Only posts
  averaging **92+/100** get published; otherwise the agent regenerates (up to
  `MAX_GENERATION_ATTEMPTS`) and gives up gracefully if nothing clears the bar.
- **Dedup** (`memory/vector_store.py`): every post is embedded and checked against all
  past posts by cosine similarity — a paraphrase of an old idea is rejected even if the
  wording differs.
- **Scheduling** (`agent/scheduler.py` + `analytics/scheduler_optimizer.py`): once enough
  engagement history exists, the agent posts at the hours that have historically performed
  best for this account, not a fixed schedule.
- **Style adaptation** (`analytics/reporter.py`, runs every 24h): the best-performing recent
  posts are summarized by Claude into a short style note, which is then woven into future
  original-thought generations.

## Deployment (Render or Railway) — step by step

Both platforms support "deploy from a Dockerfile" directly from a GitHub repo. Steps are
nearly identical; Railway is used below, Render differences are noted inline.

1. **Push this directory to a GitHub repo** (or a subdirectory of one, as it is here).
2. **Create a persistent volume** — `memory.sqlite3` must survive restarts/redeploys.
   - Railway: Project → your service → **Volumes** → add a volume mounted at `/data`.
   - Render: **Disks** → add a disk mounted at `/data` (Render disks require a paid plan).
3. **Create the service**:
   - Railway: "New Project" → "Deploy from GitHub repo" → select this repo → set the
     **root directory** to `apps/twitter-agent` → Railway auto-detects the `docker/Dockerfile`
     (set the Dockerfile path explicitly to `docker/Dockerfile` in service settings if it
     doesn't auto-detect).
   - Render: "New" → "Web Service" → connect the repo → set **root directory** to
     `apps/twitter-agent`, **Dockerfile path** to `docker/Dockerfile`.
4. **Set environment variables** in the platform's dashboard — copy every key from
   `.env.example` and fill in real values. Set `DB_PATH=/data/memory.sqlite3` (matching
   your mounted volume) and `DASHBOARD_PORT` to whatever port the platform expects
   (Railway/Render both inject `PORT` — if your platform requires binding to `$PORT`
   instead of a fixed value, set `DASHBOARD_PORT=$PORT` or update `docker/start.sh`
   accordingly).
5. **Deploy.** Both platforms build the Dockerfile and start the container automatically;
   `docker/start.sh` runs the scheduler loop and the dashboard together in one process
   group.
6. **Verify**: open `https://<your-service-domain>/healthz` (should return `{"status":
"ok"}`) and `https://<your-service-domain>/` for the dashboard. Check the platform's
   log viewer for `"Scheduler started. Jobs: [...]"` confirming the posting loop is live.
7. **(Recommended) Split into two services** once you've confirmed it works: one running
   `python -m agent.main` (the scheduler) and one running
   `uvicorn dashboard.app:app --host 0.0.0.0 --port $PORT` (the dashboard), both pointed at
   the same mounted volume/`DB_PATH`. This means a dashboard crash/restart never interrupts
   the posting loop and vice versa — override each service's **start command** to the
   relevant one instead of using `docker/start.sh`.

## Notes on the "CTR" dashboard metric

X's public API v2 (even paid tiers below Enterprise/Ads access) does not expose real
link-click counts. The dashboard shows an **engagement rate** (likes+retweets+replies+quotes
÷ impressions) clearly labeled as a proxy — wire in X Ads API access if you need true
link CTR.
