# Personal Assistant

A personal LLM assistant built on Cloudflare Workers with Durable Objects and SQLite storage.

## Features

- **Conversation Storage**: Stores conversations by category and topic
- **Context-Aware**: Maintains AI-generated summaries for each topic
- **Daily Summaries**: Automatically updates topic summaries via cron daily
- **API Key Auth**: Secure access with Bearer token authentication
- **Web Interface**: Chat UI at the root URL

## Setup

### 1. Create your own copy

Click **"Use this template"** on the [GitHub repo](https://github.com/kol3x/personal-assistant) to create your own repository.

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

Once deployed, you will find the link in the action outputs.
You can put it together manually, like in the example below, based on the email you used to register on Cloudflare.  

```
replaceme@gmail.com => 
https://personal-assistant.replaceme.workers.dev
```

Open that URL, enter your `API_KEY` and start chatting.

## Optional: Use OpenRouter instead of Workers AI

By default, PA uses Cloudflare Workers AI (free, no extra setup). If Workers AI is unavailable or unreliable for your account, you can switch to [OpenRouter](https://openrouter.ai) instead. Note that OpenRouter is pay-per-token — you'll need to add credit to your OpenRouter account.

1. Create an account at [openrouter.ai](https://openrouter.ai) and generate an API key.
2. In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add a new secret named `OPENROUTER_API_KEY` with your key.
3. In `wrangler.jsonc`, set `AI_PROVIDER` to `"openrouter"` and, if you want a different model, update `AI_MODEL_OPENROUTER` to any [OpenRouter model slug](https://openrouter.ai/models).
4. Commit and push the change (or re-run the **Deploy** action) to redeploy.

To switch back, set `AI_PROVIDER` back to `"workers-ai"`.

## Getting updates

When the template repo is updated, go to your GitHub repo, click **Sync fork** → **Update branch**, and the action will redeploy automatically.

## Free Tier Limits

| Resource | Limit |
|----------|-------|
| Workers Requests | 100,000/day |
| Workers AI | 10,000 neurons/day |
| SQLite Row Reads | 5 million/day |
| SQLite Row Writes | 100,000/day |
| Cron Triggers | 5/account |
