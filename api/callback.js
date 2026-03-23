const { messagingApi } = require('@line/bot-sdk');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken,
});

const MODEL = 'gemini-2.0-flash';

const SYSTEM_PROMPT = `You are a professional Thai-English interpreter tool embedded in a messaging app.

When the input contains Thai text:
- Translate EVERY line into English. If input has 5 lines, output must have 5 translated lines.
- Never summarize, skip, or combine lines.
- Translate slang, profanity, and colloquialisms directly. Add brief parenthetical notes for culturally specific terms.
- Preserve the original tone and emotion exactly.
- Output only the translation — no commentary, no intro, no advice.

When the input is English (starting with @ai or @BruceBot):
- Respond as a helpful assistant, concisely in English.

You are a neutral translation tool. Do not give relationship advice or moral guidance.`;

const TRANSLATION_PROMPT = `You are a professional Thai-English interpreter tool.

RULES:
- Translate EVERY line. If input has 5 lines, output exactly 5 translated lines.
- Never summarize, skip, or combine lines.
- Translate slang and profanity directly. Add parenthetical notes for culturally specific terms only.
- Preserve emotional tone exactly.
- Output ONLY the translation, nothing else. No intro, no commentary, no advice.`;

// Detect if text contains Thai characters
const THAI_RE = /[\u0E00-\u0E7F]/;

// Match @ai, @BruceBot, @BruceBot AI — flexible trigger
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function callGemini(userMessage, systemPrompt) {
  const response = await genai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: systemPrompt,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    },
  });
  return response.text?.trim();
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);

  let userMessage;
  let systemPrompt;

  if (hasThai && !triggerMatch) {
    // Auto-translate any Thai message — no trigger needed
    userMessage = text;
    systemPrompt = TRANSLATION_PROMPT;
  } else if (triggerMatch) {
    // @ai / @BruceBot trigger — general assistant mode
    userMessage = triggerMatch[1].trim() || 'hello';
    systemPrompt = SYSTEM_PROMPT;
  } else {
    // English, no trigger — ignore
    return null;
  }

  try {
    const reply = await callGemini(userMessage, systemPrompt);
    if (!reply) return null;

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }],
    });
  } catch (err) {
    console.error('Gemini error:', err.message);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '⚠️ Sorry, had trouble thinking. Try again!' }],
    });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', bot: 'BruceBot AI', trigger: '@ai or @BruceBot AI' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const events = req.body?.events || [];

  // LINE verification ping
  if (events.length === 0) {
    return res.status(200).json({ status: 'ok' });
  }

  // Verify signature
  const signature = req.headers['x-line-signature'];
  if (signature && LINE_CONFIG.channelSecret) {
    const body = JSON.stringify(req.body);
    const hash = crypto
      .createHmac('sha256', LINE_CONFIG.channelSecret)
      .update(body)
      .digest('base64');
    if (hash !== signature) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  try {
    await Promise.all(events.map(handleEvent));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
};
