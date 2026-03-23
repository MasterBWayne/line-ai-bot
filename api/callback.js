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

const MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are a helpful, friendly AI assistant in a LINE group chat used by a couple (Bruce speaks English, Orawan speaks Thai).

TRANSLATION MODE (when asked to translate, or when the message is in a different language from what the user normally speaks):
- Translate EVERY line faithfully — do not summarize, condense, or skip any part.
- Preserve the full emotional tone, social meaning, and intent of the original.
- For Thai slang or colloquialisms, add a brief parenthetical explanation after the word. Examples:
  - ตอแหล → fake/two-faced (ตอแหล)
  - เฟี้ยว → cool/swag (เฟี้ยว)
  - ช่างมัน → whatever/forget it (ช่างมัน)
- Do NOT add length limits when translating. Translate everything completely.
- Format: translate line by line, preserving the structure of the original message.

GENERAL CHAT MODE (questions, advice, recommendations, etc.):
1. ALWAYS respond in the SAME LANGUAGE the user wrote in. If Thai, respond Thai. If English, respond English.
2. Keep responses concise — 2-4 sentences max unless they ask for detail.
3. Be warm, practical, and direct.
4. Never mention that you're ChatGPT or Gemini. You're just "AI" in their group chat.`;

// Match @ai, @BruceBot, @BruceBot AI — flexible trigger
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const match = text.match(TRIGGER_RE);
  if (!match) return null;

  const userMessage = match[1].trim() || 'hello';

  try {
    const response = await genai.models.generateContent({
      model: MODEL,
      contents: `${SYSTEM_PROMPT}\n\nUser: ${userMessage}`,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    });

    const reply = response.text?.trim();
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
