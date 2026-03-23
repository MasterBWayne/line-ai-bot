"""
LINE AI Companion Bot
- Triggers on messages starting with @ai in group chats
- Auto-responds to all messages in 1:1 chats
- Auto-detects language (Thai/English) and responds in kind
- Powered by GPT-4o-mini via OpenAI API
"""

import os
import re
from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import (
    MessageEvent,
    TextMessage,
    TextSendMessage,
    SourceGroup,
    SourceRoom,
    SourceUser,
)
from api.chatgpt import ChatGPT

# ─── Config ──────────────────────────────────────
line_bot_api = LineBotApi(os.getenv("LINE_CHANNEL_ACCESS_TOKEN"))
line_handler = WebhookHandler(os.getenv("LINE_CHANNEL_SECRET"))

TRIGGER = "@ai / @BruceBot AI"
# Match: @ai, @brucebot, @BruceBot AI, or any message mentioning the bot
TRIGGER_PATTERN = re.compile(
    r"^(?:@ai|@brucebot(?:\s+ai)?)\s+(.+)|^(?:@ai|@brucebot(?:\s+ai)?)\s*$",
    re.IGNORECASE | re.DOTALL
)

app = Flask(__name__)
chatgpt = ChatGPT()

# ─── Routes ──────────────────────────────────────


@app.route("/")
def home():
    return {
        "status": "ok",
        "bot": "line-ai-bot",
        "trigger": TRIGGER,
        "model": chatgpt.model,
    }


@app.route("/health")
def health():
    return {"status": "ok"}


@app.route("/webhook", methods=["POST"])
def callback():
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    app.logger.info("Request body: " + body)
    try:
        line_handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)
    return "OK"


# ─── Event Handler ───────────────────────────────


@line_handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    if event.message.type != "text":
        return

    text = event.message.text.strip()
    source = event.source

    # Determine if this is a group/room chat or 1:1
    is_group = isinstance(source, (SourceGroup, SourceRoom))

    if is_group:
        # In group chats: respond to @ai OR @BruceBot OR @BruceBot AI
        match = TRIGGER_PATTERN.match(text)
        if not match:
            return
        user_message = (match.group(1) or "hello").strip()
    else:
        # In 1:1 chats: respond to everything
        user_message = text

    if not user_message:
        return

    try:
        reply = chatgpt.get_response(user_message)
        line_bot_api.reply_message(
            event.reply_token, TextSendMessage(text=reply)
        )
    except Exception as e:
        app.logger.error(f"Error generating response: {e}")
        line_bot_api.reply_message(
            event.reply_token,
            TextSendMessage(
                text="⚠️ Sorry, I had trouble thinking. Try again in a moment."
            ),
        )


# ─── Entrypoint ──────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    print(f"LINE AI Bot running on port {port}")
    print(f"Model: {chatgpt.model}")
    print(f"Trigger: {TRIGGER} (group chats only)")

    if not os.getenv("LINE_CHANNEL_ACCESS_TOKEN"):
        print("⚠️  Missing LINE_CHANNEL_ACCESS_TOKEN")
    if not os.getenv("LINE_CHANNEL_SECRET"):
        print("⚠️  Missing LINE_CHANNEL_SECRET")
    if not os.getenv("OPENAI_API_KEY"):
        print("⚠️  Missing OPENAI_API_KEY")

    app.run(host="0.0.0.0", port=port)
