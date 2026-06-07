# Personal Assistant Product Wiki

## Overview
Personal Assistant is a personal LLM (Large Language Model) assistant built on Cloudflare Workers with Durable Objects and SQLite storage. It allows users to store conversations by category/topic, maintain AI-generated summaries, and integrate with external services like KanbanFlow for task management.

**Created by:** Nikolai Shcherbinin (`kol3x`)  
**Repository:** https://github.com/kol3x/personal-assistant  
**Live Deployment:** Available on Cloudflare Workers

## Core Concept
The assistant organizes user interactions into:
- **Categories** (e.g., "work", "personal", "kanban") 
- **Topics** (e.g., "project-x", "travel-planning") within categories
- **Conversations** (message arrays) stored per topic

AI-generated summaries are maintained for both topics and categories, updated incrementally via cron jobs or on-demand requests.

## Technical Architecture

### Stack
- **Runtime:** Cloudflare Workers (ES modules)
- **Language:** JavaScript (vanilla, no framework)
- **AI/LLM:** Cloudflare Workers AI (`@cf/moonshotai/kimi-k2.6`)
- **Database:** SQLite via Durable Objects
- **State Management:** Durable Object singleton pattern
- **Frontend:** Vanilla HTML/CSS/JS (single-page app)
- **Task Integration:** KanbanFlow API
- **Deployment:** Cloudflare Workers via `wrangler` v4.76.0

### Database Schema
Three tables in SQLite:
- `categories`: id, name (UNIQUE), summary, updated_at_timestamp
- `topics`: id, category_id (FK), name, summary, updated_at_timestamp, UNIQUE(category_id, name)
- `conversations`: id, topic_id (FK), messages, last_message, created_at_timestamp

## Features

### Existing Features
1. **Conversation Storage**: By category/topic with auto-creation
2. **Context-Aware Responses**: Maintains summary context for each topic
3. **Daily Summaries**: Automatically updated via cron (0 0 * * *)
4. **KanbanFlow Integration**: Task creation, board views, AI rundowns (0 11 * * *)
5. **AI Features**: Chat, topic/query summarization, contextual responses
6. **Web UI**: Single HTML file with Chat/Query/Explore/Kanban tabs
7. **Context Injection System**: Pluggable providers for real-time data

## Setup & Deployment

### Prerequisites
- Node.js
- Cloudflare account
- wrangler v4.76.0

### Installation
```bash
git clone https://github.com/kol3x/personal-assistant.git
cd personal-assistant
npm install
```

### Configuration
```bash
npx wrangler secret put API_KEY
# Optional for KanbanFlow:
npx wrangler secret put KANBANFLOW_API_KEY
```

### Deployment
```bash
npm run dev          # Local preview
npm run deploy       # Deploy to Cloudflare
# or
npx wrangler deploy
```

## API Reference

### Authentication
All endpoints: `Authorization: Bearer <API_KEY>`

### Key Endpoints
**Conversations**: `GET /conversations`, `POST /chat`, `GET /categories`  
**Kanban**: `POST /kanban-board`, `POST /kanban-create-task`, `POST /kanban-rundown`

## Development

### Code Organization
```
/src
  index.js          - Worker + Durable Object (1162 lines)
  context.js        - Context injection system (providers)
/html
  index.html              - Web UI (Chat/Query/Explore/Kanban tabs)
  favicon.ico             - Main browser favicon (robot emoji, Twitter Twemoji CC-BY 4.0)
  favicon-16x16.png       - 16px PNG favicon
  favicon-32x32.png       - 32px PNG favicon
  apple-touch-icon.png    - iOS home screen icon (180x180)
wrangler.jsonc      - Wrangler configuration
package.json        - Dependencies (wrangler only)
```

### Extending Functionality
Add context providers in `src/context.js`:
```js
define("provider-name", async (env, doInstance) => {
  return `## Provider Name\n${data}`;
});
```

