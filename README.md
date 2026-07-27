# Pawmc: Private Assistant with Managed Context

A personal LLM assistant that runs on Cloudflare Workers and maintains a user-guided compounding knowledge base across conversations. 

When starting a new conversation, choose which historical context you want it to have by choosing a category and topic. Additional context from new chats is getting compounded in the selected topic and category daily or on request.

It's simple and lightweight, and you own your data, pick your model, and control the prompts.

## Why use this over mainstream chat-interface LLM

Pawmc has genuinly become one of the must-have tools in my day-to-day. I'll talk about core advantages. 

1. Compounding context that works

Mainstream providers have "memory" and other features with different names, that are supposed to use your historical chats to gain more context of you and give more educated answers. These companies are scared to make chatting with an LLM any harder for you, so your new chats get random unhelpful context, like when you ask how to cook a dinner, and it start with "as a software developer from city X, you need to *xyz*".

Pawmc is asking for a little effort from a user, but the result is predictability of compounding context. Everytime you start a chat, you must select a "category" and "topic" (existing or new) and that's exactly where the context will compound. 

Over time, when you gather context about your fields of interest, you will have multiple context options to use as a background for your new chats. (e.g. "personal", "project-x", "hobby-y", "phylosophy")

1. Simplicity

Mainstream LLM providers contaminate their models with useless context. They trained these great models on all of the data in the world, but when you ask a simple question if starts web-searching and the answers stir toward whatever bullshit it found online. 

When I first starting using PA, I thought that search capabilities is something I would eventually want to add, but over time I discovered that it's such a relief to use a pure LLM without the search-results contamination! The mainstream LLM chat has become the "google search" of internet, so it makes sense when you actually want to find some specific up-to-date info, but it doesn't when you are discussing well-researched concepts.

There is [system prompt contamination](https://github.com/elder-plinius/CL4R1T4S) as well: all mainstream providers include some things that THEY care about and it can range from hundreds to thousands of lines of text. At the end of the day, for you it just means that the model is going to give a dumber response, because its attention will be scattered across your actual request and whatever corporate bullshit is in the system prompt.

The only main system prompt in Pawmc is:
> User values succinct and direct outputs without extra formatting, warnings, and politeness.

(shout out to @evgenydmitriev for coming up with this one)

1. Control over data

You deploy the software, you control the database. The database includes all your conversations and summaries. You can redact your summaries, you can redact your prompts, you can change the model.

In ideal world, you would also control the LLM deployment, but as of mid-2026 most of us can't host a cutting-edge LLM on a private machine. It's the main tradeoff, that I want to be clear about it - prompts are still sent to the companies that host LLMs.

1. Cost

Deploying and hosting on Cloudflare Pawmc is way under their free tier limits, and you can even get some free daily tokens with Workers AI. However it hasn't been reliable lately, and I recommend switching to openrouter and actually paying for tokens, but even in that case your spending shouldn't go over $2-3 a month.

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
https://Pawmc.replaceme.workers.dev
```

Open that URL, enter your `API_KEY` and start chatting.

## Advanced: Use OpenRouter instead of Workers AI

By default, Pawmc uses Cloudflare Workers AI (free, no extra setup). However, Workers AI can be unreliable and is only ok for testing out the project. If you are planning to use it extensively, I recommend switching to [OpenRouter](https://openrouter.ai), which is also supported.

Note that OpenRouter is pay-per-token — you'll need to add credit to your OpenRouter account (supports crypto as well). However, it's usually a symbolical spending due to project's simplicity and the budget-friendly model default.

To switch:

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
