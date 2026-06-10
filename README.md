# Personal Assistant

A personal LLM assistant built on Cloudflare Workers with Durable Objects and SQLite storage.

## Features

- **Conversation Storage**: Stores conversations by category and topic
- **Context-Aware**: Maintains AI-generated summaries for each topic
- **Daily Summaries**: Automatically updates topic summaries via cron
- **Export/Import**: Full data export and import for backup and migration
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

Push any change to the `main` branch — the GitHub Action will automatically deploy. Your assistant will be live at:

```
https://personal-assistant.YOUR-ACCOUNT.workers.dev
```

Open that URL, enter your `API_KEY` at the top of the page, and start chatting.

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
