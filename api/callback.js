const { messagingApi } = require('@line/bot-sdk');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const crypto = require('crypto');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken,
});

const MODEL = 'gemini-1.5-flash';

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const TRANSLATION_PROMPT = `You are an expert Thai-English translator who understands Thai culture, slang, and subtext.

When given Thai text, output TWO sections:

**Translation:**
Translate every line faithfully into natural English. Do not skip or combine lines. Translate slang and profanity directly. Preserve the emotional tone exactly.

**Context:**
In 1-3 sentences, explain what this person is really communicating — the emotional subtext, cultural nuance, or implied meaning that may not be obvious from the literal words alone.

Do not give advice. Just translate and explain the meaning.`;

const ASSISTANT_PROMPT = `You are a helpful assistant in a LINE group chat. Reply concisely. If Thai, reply in Thai. If English, reply in English.`;

// Detect Thai characters
const THAI_RE = /[\u0E00-\u0E7F]/;
// Match @ai or @BruceBot trigger
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function callGemini(systemPrompt, userMessage) {
  const model = genai.getGenerativeModel({
    model: MODEL,
    systemInstruction: systemPrompt,
    safetySettings: SAFETY_SETTINGS,
  });
  const result = await model.generateContent(userMessage);
  return result.response.text()?.trim();
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);

  let userMessage;
  let systemPrompt;

  if (hasThai && !triggerMatch) {
    // Auto-translate any Thai message
    userMessage = text;
    systemPrompt = TRANSLATION_PROMPT;
  } else if (triggerMatch) {
    // @ai / @BruceBot — assistant mode
    userMessage = triggerMatch[1].trim() || 'hello';
    systemPrompt = ASSISTANT_PROMPT;
  } else {
    return null;
  }

  try {
    const reply = await callGemini(systemPrompt, userMessage);
    if (!reply) return null;

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }],
    });
  } catch (err) {
    console.error('Gemini error:', err.message);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '⚠️ Translation error. Try again!' }],
    });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', bot: 'BruceBot AI', model: MODEL });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const events = req.body?.events || [];
  if (events.length === 0) return res.status(200).json({ status: 'ok' });

  const signature = req.headers['x-line-signature'];
  if (signature && LINE_CONFIG.channelSecret) {
    const body = JSON.stringify(req.body);
    const hash = crypto
      .createHmac('sha256', LINE_CONFIG.channelSecret)
      .update(body)
      .digest('base64');
    if (hash !== signature) return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    await Promise.all(events.map(handleEvent));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
};
