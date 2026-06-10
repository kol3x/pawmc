# Personal Assistant Product Wiki

## Overview
Personal Assistant is a personal LLM assistant built on Cloudflare Workers with Durable Objects and SQLite storage. It stores conversations by category/topic, maintains AI-generated summaries, and integrates with external services like KanbanFlow for task management.

**Created by:** Nikolai Shcherbinin (`kol3x`)  
**Repository:** https://github.com/kol3x/personal-assistant  
**Live Deployment:** Available on Cloudflare Workers

## Core Concept
The assistant organizes user interactions into:
- **Categories** (e.g., "work", "personal", "kanban") 
- **Topics** (e.g., "project-x", "travel-planning") within categories
- **Conversations** (message arrays) stored per topic

AI-generated summaries are maintained for both topics and categories, updated incrementally via cron jobs or on-demand requests. Summaries prioritize user messages — they represent confirmed information and intent, while assistant messages are speculative unless explicitly confirmed.

## Features

### Existing Features
1. **Conversation Storage**: By category/topic with auto-creation
2. **Context-Aware Responses**: Maintains summary context for each topic
3. **Daily Summaries**: Automatically updated via cron
4. **KanbanFlow Integration**: Task creation, board views, AI rundowns
5. **AI Features**: Chat, topic/category querying, contextual responses
6. **Web UI**: Single HTML file with Chat/Query/Explore/Kanban tabs
7. **Context Injection System**: Pluggable providers for real-time data (kanban tasks, etc.)
8. **Context Notes**: Save messages to conversation history without a full AI response ("Save as note" toggle)
9. **Data Portability**: Full export/import with conflict detection

## Product Decisions

### Summarization Opt-Out (Not Implemented — June 2026)

**Considered:** Adding an explicit flag/mechanism to opt individual messages or whole conversations out of AI summarization.

**Decision:** Not needed. The user can simply say "don't summarize this" in the conversation and the AI naturally respects that instruction. The summarization prompt already prioritizes user messages, so user intent about what should or shouldn't be summarized is preserved without a separate mechanism. Building an override system would add complexity with no real benefit — the conversation itself is the best interface for expressing summarization intent.
