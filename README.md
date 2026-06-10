# Personal Assistant

A personal LLM assistant built on Cloudflare Workers with Durable Objects and SQLite storage.

## Features

- **Conversation Storage**: Stores conversations by category and topic
- **Context-Aware**: Maintains summary context for each topic
- **Daily Summaries**: Automatically updates topic summaries daily via cron
- **Export/Import**: Full data export and import for backup and migration
- **API Key Auth**: Secure access with Bearer token authentication
- **Web Interface**: Simple HTML UI at root path

## Web Interface

Visit `https://your-worker.workers.dev/` to use the built-in chat UI. 

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

### POST /export

Export all categories, topics, and conversations as JSON. Complete message history is included.

```bash
curl -X POST https://your-worker.workers.dev/export \
  -H "Authorization: Bearer YOUR_API_KEY" > backup.json
```

### POST /import

Import data from a previous export. New categories/topics are added; existing ones are skipped. Accepts `{ "data": <export JSON> }`.

```bash
curl -X POST https://your-worker.workers.dev/import \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d @backup.json
```

Response includes imported counts and any conflicts:

```json
{
  "imported": { "categories": 5, "topics": 12, "conversations": 48 },
  "conflicts": { "categories": ["Work"], "topics": ["Work/Project X"] }
}
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