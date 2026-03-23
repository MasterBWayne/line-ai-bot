# LINE AI Companion Bot 🤖

A LINE group chat AI assistant powered by **GPT-4o-mini**. Responds to `@ai` messages in group chats with automatic language detection (English ↔ Thai).

## Features

- **`@ai` trigger** — Only responds when messages start with `@ai` in group chats
- **Auto language detection** — Responds in Thai if you write in Thai, English if English
- **Group chat optimized** — Works in LINE groups without being noisy
- **1:1 chat support** — Responds to all messages in direct chats (no trigger needed)
- **Conversation memory** — Remembers last ~20 messages for context
- **Railway deploy** — One-click deploy to Railway free tier

## Quick Start

### 1. Get LINE Credentials

1. Go to [LINE Developer Console](https://developers.line.biz/console/)
2. Log in with your LINE account
3. Click **Create a new provider** (or use existing)
4. Click **Create a Messaging API channel**
5. Fill in the required fields:
   - Channel name: `AI Companion` (or whatever you like)
   - Channel description: anything
   - Category & subcategory: pick any
6. After creation, go to the **Basic settings** tab:
   - Copy **Channel secret** → this is `LINE_CHANNEL_SECRET`
7. Go to the **Messaging API** tab:
   - Scroll to **Channel access token** → click **Issue** → copy it → this is `LINE_CHANNEL_ACCESS_TOKEN`
   - Under **Auto-reply messages** → click **Edit** → turn OFF auto-reply and greeting
   - Under **Webhook settings** → you'll set the URL after deploying (Step 3)

### 2. Get OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/api-keys)
2. Create a new API key → this is `OPENAI_API_KEY`
3. Make sure you have credits / a payment method on file (GPT-4o-mini is very cheap: ~$0.15/1M input tokens)

### 3. Deploy to Railway

1. Go to [Railway](https://railway.com/) and sign up (free tier: $5/month credit, no CC required for trial)
2. Click **New Project** → **Deploy from GitHub repo**
3. Connect your GitHub and select the `line-ai-bot` repo
4. Go to **Variables** tab and add:

   | Variable | Value |
   |----------|-------|
   | `LINE_CHANNEL_SECRET` | From Step 1.6 |
   | `LINE_CHANNEL_ACCESS_TOKEN` | From Step 1.7 |
   | `OPENAI_API_KEY` | From Step 2 |
   | `PORT` | `3000` |

5. Railway will auto-deploy. Once live, copy your Railway URL (e.g., `https://line-ai-bot-production-xxxx.up.railway.app`)

### 4. Register Webhook URL in LINE

1. Go back to [LINE Developer Console](https://developers.line.biz/console/) → your channel
2. Go to **Messaging API** tab
3. Under **Webhook settings**:
   - **Webhook URL**: `https://YOUR-RAILWAY-URL.up.railway.app/webhook`
   - Click **Verify** — should show "Success"
   - Toggle **Use webhook** → ON

### 5. Add Bot to a Group Chat

1. On the **Messaging API** tab in LINE Developer Console:
   - Find the **Bot basic ID** or **QR code**
   - Make sure **Allow bot to join groups** is enabled (under "LINE Official Account features" → Bot settings)
2. Scan the QR code from LINE app → add as friend
3. Open any LINE group → tap **Invite** → select the bot
4. Send a message: `@ai hello!`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINE_CHANNEL_SECRET` | ✅ | — | LINE channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | — | LINE channel access token |
| `OPENAI_API_KEY` | ✅ | — | OpenAI API key |
| `OPENAI_MODEL` | ❌ | `gpt-4o-mini` | OpenAI model to use |
| `OPENAI_TEMPERATURE` | ❌ | `0.7` | Response creativity (0-1) |
| `OPENAI_MAX_TOKENS` | ❌ | `1000` | Max response length |
| `MSG_LIST_LIMIT` | ❌ | `20` | Conversation memory size |
| `PORT` | ❌ | `3000` | Server port |

## Usage

### In Group Chats
```
@ai what's the weather like in Bangkok?
@ai แนะนำร้านอาหารไทยหน่อย
@ai translate "I love you" to Thai
```

### In 1:1 Direct Chats
Just send any message — no trigger needed.

## Local Development

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/line-ai-bot.git
cd line-ai-bot

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Install
pip install -r requirements.txt

# Run
python -m api.index

# Or with gunicorn
gunicorn --bind 0.0.0.0:3000 api.index:app
```

Use [ngrok](https://ngrok.com/) for local webhook testing:
```bash
ngrok http 3000
# Then set the ngrok URL as your webhook in LINE Developer Console
```

## Architecture

```
line-ai-bot/
├── api/
│   ├── index.py      # Flask app, webhook handler, event routing
│   ├── chatgpt.py    # OpenAI client wrapper
│   └── prompt.py     # System prompt & conversation memory
├── Dockerfile         # Container config
├── railway.json       # Railway deployment config
├── Procfile           # Process definition
├── requirements.txt   # Python dependencies
└── .env.example       # Environment variable template
```

## Cost Estimate

GPT-4o-mini pricing (as of 2024):
- Input: ~$0.15 / 1M tokens
- Output: ~$0.60 / 1M tokens
- **Typical group chat usage: < $1/month**

Railway free tier: $5/month credit — more than enough for a LINE bot.

## Credits

Based on [howarder3/ChatGPT-Linebot-using-python-flask-on-vercel](https://github.com/howarder3/ChatGPT-Linebot-using-python-flask-on-vercel), heavily modified for group chat support, language auto-detection, and Railway deployment.
