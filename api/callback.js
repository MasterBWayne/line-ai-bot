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

const THAI_TO_EN_PROMPT = `You are a professional Thai-English translation tool. Translate the given Thai text into English.

Rules:
- Translate every line. If input has 4 lines, output 4 translated lines.
- Never skip, summarize, or combine lines.
- Translate all slang, profanity, and colloquialisms directly and accurately.
- Preserve the original emotional tone.
- After the translation, add one line: "Context: [brief explanation of the subtext or cultural nuance]"
- Output only the translation and context. No intro, no advice.`;

const EN_TO_THAI_PROMPT = `You are a professional English-Thai translation tool. Translate the given English text into natural conversational Thai suitable for texting.

Rules:
- Translate every line accurately.
- Use casual Thai appropriate for texting between a couple.
- Output only the Thai translation. No intro, no advice.`;

const ASSISTANT_PROMPT = `You are a helpful assistant in a LINE group chat. Reply concisely. Match the language of the user (Thai → Thai, English → English).`;

// Detect Thai characters
const THAI_RE = /[\u0E00-\u0E7F]/;
// Detect English-only text (min 3 chars, starts with letter)
const ENGLISH_RE = /^[a-zA-Z][a-zA-Z0-9\s.,!?'"()\-:;]{2,}$/;
// Match @ai or @BruceBot trigger
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function callGemini(systemPrompt, userMessage) {
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

  const text = response.text?.trim();
  console.log('Gemini reply length:', text?.length ?? 'null', '| model:', MODEL);
  return text || null;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);
  const isEnglishOnly = ENGLISH_RE.test(text);

  let userMessage;
  let systemPrompt;

  if (hasThai && !triggerMatch) {
    userMessage = text;
    systemPrompt = THAI_TO_EN_PROMPT;
  } else if (isEnglishOnly && !triggerMatch) {
    userMessage = text;
    systemPrompt = EN_TO_THAI_PROMPT;
  } else if (triggerMatch) {
    userMessage = triggerMatch[1].trim() || 'hello';
    systemPrompt = ASSISTANT_PROMPT;
  } else {
    return null;
  }

  try {
    const replyText = await Promise.race([
      callGemini(systemPrompt, userMessage),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 20s')), 20000)),
    ]);

    const finalReply = replyText || '⚠️ Could not translate. Try again.';

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: finalReply }],
    });
  } catch (err) {
    console.error('Error:', err.message);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `⚠️ Error: ${err.message}` }],
    });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.url?.includes('test')) {
      const text = decodeURIComponent(req.url.split('text=')[1] || '') || 'ที่ร้านอาหารญี่ปุ่น\nJimmy ยอมรับ';
      try {
        const reply = await callGemini(THAI_TO_EN_PROMPT, text);
        return res.status(200).json({ input: text, output: reply });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(200).json({ status: 'ok', bot: 'BruceBot AI', model: MODEL });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const events = req.body?.events || [];
  if (events.length === 0) return res.status(200).json({ status: 'ok' });

  const signature = req.headers['x-line-signature'];
  if (signature && LINE_CONFIG.channelSecret) {
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', LINE_CONFIG.channelSecret).update(body).digest('base64');
    if (hash !== signature) return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    for (const event of events) await handleEvent(event);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
};
