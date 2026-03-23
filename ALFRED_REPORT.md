# ALFRED REPORT — LINE AI Companion Bot

## Status: ✅ COMPLETE

## Repo Location
`~/Documents/GitHub/line-ai-bot`

## What Was Built
Scaffolded a LINE Messaging API bot powered by GPT-4o-mini with:
- **`@ai` trigger** — only fires on `@ai <message>` in group chats
- **Language auto-detection** — system prompt instructs the model to detect and match the user's language (Thai ↔ English)
- **Group chat support** — uses LINE SDK's `SourceGroup`/`SourceRoom` detection; only responds to `@ai` trigger in groups, responds to everything in 1:1
- **Conversation memory** — rolling 20-message window with system prompt preserved
- **Railway deployment** — `railway.json`, `Dockerfile`, and `Procfile` included

## Environment Variables Bruce Needs

| Variable | Where to Get It |
|----------|----------------|
| `LINE_CHANNEL_SECRET` | LINE Developer Console → Channel → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developer Console → Channel → Messaging API → Issue token |
| `OPENAI_API_KEY` | OpenAI Platform → API Keys |

## LINE Developer Console Steps (Exact)

1. **https://developers.line.biz/console/** → Log in
2. **Create Provider** (or use existing)
3. **Create a Messaging API Channel**
   - Name: `AI Companion` (or anything)
   - Fill category/description
4. **Basic settings tab** → copy **Channel secret**
5. **Messaging API tab**:
   - Click **Issue** under Channel access token → copy it
   - **Auto-reply messages** → Edit → turn OFF auto-reply and greeting messages
   - **Allow bot to join groups** → ON (under LINE Official Account Manager → Settings)
6. **Deploy to Railway** first (see README), get your Railway URL
7. **Messaging API tab** → Webhook settings:
   - URL: `https://YOUR-RAILWAY-URL.up.railway.app/webhook`
   - Click **Verify** → should show Success
   - Toggle **Use webhook** → ON
8. **Add bot to group**: Scan QR code → Add as friend → Invite to group

## File Structure
```
line-ai-bot/
├── api/
│   ├── index.py          # Flask app + webhook handler
│   ├── chatgpt.py        # OpenAI GPT-4o-mini client
│   └── prompt.py         # System prompt + conversation memory
├── Dockerfile            # Docker build for Railway
├── railway.json          # Railway deploy config
├── Procfile              # Gunicorn process definition
├── requirements.txt      # Python deps
├── .env.example          # Env var template
├── .gitignore
├── README.md             # Full setup guide
└── ALFRED_REPORT.md      # This file
```

## Git
- Initialized and committed as: `feat: LINE AI companion bot — @ai trigger, language auto-detect, Railway deploy`
- Remote: pushed to `https://github.com/MasterBWayne/line-ai-bot.git`

## Notes
- Based on howarder3's Python Flask LINE bot, heavily rewritten
- GPT-4o-mini costs ~$0.15/1M input tokens — negligible for chat use
- Railway free tier ($5/mo credit) is sufficient
- The bot uses gunicorn in production (2 workers, 120s timeout)
- System prompt explicitly instructs language matching — no external language detection library needed
