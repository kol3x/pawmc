# Personal Assistant

A personal LLM assistant built on Cloudflare Workers with Durable Objects and SQLite storage.

## Features

- **Conversation Storage**: Stores conversations by category and topic
- **Context-Aware**: Maintains summary context for each topic
- **Daily Summaries**: Automatically updates topic summaries daily via cron
- **API Key Auth**: Secure access with Bearer token authentication

## API Endpoints

### POST /chat

Send a message and receive an AI response.

```bash
curl -X POST https://your-worker.workers.dev/chat \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"category": "work", "topic": "project-x", "message": "Hello"}'
```

### GET /categories

Get all categories, topics, and their summaries.

```bash
curl https://your-worker.workers.dev/categories \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### POST /update-summaries

Manually trigger summary updates.

```bash
curl -X POST https://your-worker.workers.dev/update-summaries \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set API key secret

```bash
npx wrangler secret put API_KEY
```

Enter your desired API key when prompted.

### 3. Deploy

```bash
npm run deploy
```

## Free Tier Limits

| Resource | Limit |
|----------|-------|
| Workers Requests | 100,000/day |
| Workers AI | 10,000 neurons/day |
| SQLite Row Reads | 5 million/day |
| SQLite Row Writes | 100,000/day |
| Cron Triggers | 5/account |