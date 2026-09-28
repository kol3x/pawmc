# Pawmc: Private Assistant with Managed Context

A personal LLM assistant that runs on Cloudflare Workers and maintains a user-guided compounding knowledge base across conversations. 

When starting a new conversation, choose which historical context you want it to have by choosing a category and topic. Additional context from new chats is compounded daily or on request.

It's simple and lightweight, and you own your data, pick your model, and control the prompts.

## Key advantages

### Compounding context that works

Pawmc asks for a little effort from a user, but the result is predictability of compounding context. Every time you start a chat, you must select a "category" and "topic" (existing or new) and that's exactly where the context will compound. 

Over time, when you gather context about your fields of interest, you will have multiple context options to use as a background for your new chats. (e.g. "personal", "project-x", "hobby-y", "philosophy")

### Simplicity

It's a great relief to use an LLM that doesn't have search-access and [a system prompt of 200–1500 (!) lines](https://github.com/elder-plinius/CL4R1T4S). Pawmc's system prompt is one short sentence, focused on getting the point across.

### Control over data

You deploy the software, you control the database. The database includes all your conversations and summaries. You can redact your summaries, you can redact your prompts, you can change the model.

In an ideal world, you would also control the LLM deployment, but as of mid-2026 most of us can't host a cutting-edge LLM on a private machine. It's the main tradeoff - prompts are still sent to the companies that host LLMs.

### Cost

Deploying and hosting Pawmc on Cloudflare is way under their free tier limits, and you even get some free daily tokens with Workers AI. 

## Features

- **Conversation Storage**: Stores conversations by category and topic
- **Context-Aware**: Maintains AI-generated summaries for each category and topic
- **Daily Summaries**: Automatically updates summaries via cron daily
- **API Key Auth**: Secure access with Bearer token authentication
- **Web Interface**: Chat UI at the root URL

## Setup

### 1. Create your own copy

Click **"Use this template"** on the [GitHub repo](https://github.com/kol3x/Pawmc) to create your own repository.

### 2. Create a Cloudflare account

Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and create a free account. No credit card required.

### 3. Create an API token

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Click **Use template** next to "Edit Cloudflare Workers"
4. Under **Account Resources**, select your account
5. Click **Continue to summary**, then **Create Token**
6. Copy the token — you'll need it in the next step

### 4. Add secrets to GitHub

In your new GitHub repository:

1. Go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Add these two secrets:

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | The API token you created in step 3 |
| `API_KEY` | A secret password of your choice (you'll enter this in the web app to log in) |

### 5. Deploy

1. In your GitHub repository click the **Actions** tab
1. Select the **Deploy** workflow from the left sidebar
1. Under three dots button on the right choose **Run workflow** option

Once deployed, you can put together a link to your worker, based on the email you used to register on Cloudflare, like in the example below.  

```
replaceme@gmail.com => 
https://pawmc.replaceme.workers.dev
```

Open that URL, enter your `API_KEY` and start chatting.

## Advanced: Use OpenRouter instead of Workers AI

By default, Pawmc uses Cloudflare Workers AI (free, no extra setup). However, Workers AI can be unreliable and is only ok for testing out the project. If you are planning to use it extensively, I recommend switching to [OpenRouter](https://openrouter.ai), which is also supported.

Note that OpenRouter is pay-per-token — you'll need to add credit to your OpenRouter account (supports crypto as well). However, it's usually a symbolical spending due to project's simplicity and the budget-friendly model default.

To switch:

1. Create an account at [openrouter.ai](https://openrouter.ai) and generate an API key.
2. In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add a new secret named `OPENROUTER_API_KEY` with your key.
3. In `wrangler.jsonc`, set `AI_PROVIDER` to `"openrouter"` and, if you want a different model, update `AI_MODEL_OPENROUTER` to any [OpenRouter model slug](https://openrouter.ai/models).
4. Commit and push the change (or run the **Deploy** action) to redeploy.

To switch back, set `AI_PROVIDER` back to `"workers-ai"`.

## Getting updates

When the template repo is updated, go to your GitHub repo, click **Sync fork** → **Update branch**, and the action will redeploy automatically.

## Development

The project ships a test suite that runs the worker with its Durable Object and SQLite storage locally (no Cloudflare account or network access needed — AI calls are mocked).

```sh
npm install
npm run typecheck   # typechecks src and test
npm test            # runs the suite in test/index.test.ts
```

Pushes to `main` and pull requests run both commands via the `CI` workflow before the `Deploy` workflow can ship anything.

The web interface is a Vite + Svelte 5 app in `web/`, built to `web/dist` and served by the worker's static assets. `npm run dev` builds the UI and starts the worker; to iterate on the UI, run a second terminal with the dev server and live reload:

```sh
npm run dev        # terminal 1: builds web/dist, starts wrangler dev on :8787
npm run dev -w web # terminal 2: vite dev server on :5173, proxies API calls to :8787
```

```sh
npm run check -w web   # svelte-check over the UI
npm run build -w web   # production build to web/dist
```

## Free Tier Cloudflare Workers Limits

| Resource | Limit |
|----------|-------|
| Workers Requests | 100,000/day |
| Workers AI | 10,000 neurons/day |
| SQLite Row Reads | 5 million/day |
| SQLite Row Writes | 100,000/day |
| Cron Triggers | 5/account |
