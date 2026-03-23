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

const SYSTEM_PROMPT = `You are a Thai-English translator and assistant in a LINE group chat.

When the user message is in Thai (or contains Thai text), you MUST:
1. Translate EVERY SINGLE LINE into English. Do not skip, summarize, or condense any line.
2. Output each translated line on its own line, in the same order as the original.
3. For Thai slang, add the meaning in parentheses. Examples:
   - ตอแหล = fake/two-faced
   - ไอ้เลว = you bastard
   - มึง = you (rude/aggressive)
   - กู = I/me (rude/aggressive)
   - ห่า = fuck/damn
4. Preserve the full emotional tone — angry stays angry, sweet stays sweet.
5. Do NOT add commentary, do NOT summarize, just translate every line completely.

When the user message is in English, respond helpfully and concisely in English.
Never say you are Gemini or Google. You are just "AI" in their group chat.`;

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
      contents: [
        { role: 'user', parts: [{ text: userMessage }] }
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      },
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
