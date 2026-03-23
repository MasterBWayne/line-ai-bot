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

const MODEL = 'gemini-2.0-flash';

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const THAI_TO_EN_PROMPT = `You are an expert Thai-English translator who understands Thai culture, slang, and subtext.

When given Thai text, output TWO sections:

**Translation:**
Translate every line faithfully into natural English. Do not skip or combine lines. Translate slang and profanity directly. Preserve the emotional tone exactly.

**Context:**
In 1-3 sentences, explain what this person is really communicating — the emotional subtext, cultural nuance, or implied meaning that may not be obvious from the literal words alone.

Do not give advice. Just translate and explain the meaning.`;

const EN_TO_THAI_PROMPT = `You are an expert English-Thai translator.

Translate the given English text into natural, conversational Thai. Output TWO sections:

**การแปล (Translation):**
Translate every line into natural Thai. Use casual Thai appropriate for texting between a couple or friends.

**Context:**
In 1 sentence in English, note anything important about tone or phrasing the sender should know.

Do not give advice. Just translate.`;

const ASSISTANT_PROMPT = `You are a helpful assistant in a LINE group chat. Reply concisely. If Thai, reply in Thai. If English, reply in English.`;

// Detect Thai characters (Unicode block U+0E00–U+0E7F)
const THAI_RE = /[\u0E00-\u0E7F]/;
// Detect mostly-English text (letters, basic punctuation, no Thai) — min 3 chars
const ENGLISH_RE = /^[a-zA-Z][a-zA-Z0-9\s.,!?'"()\-:;]{2,}$/;
// Match @ai or @BruceBot trigger
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function callGemini(systemPrompt, userMessage) {
  const model = genai.getGenerativeModel({
    model: MODEL,
    systemInstruction: systemPrompt,
    safetySettings: SAFETY_SETTINGS,
  });
  const result = await model.generateContent(userMessage);
  const response = result.response;

  // Check if blocked
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    console.error('Gemini blocked:', blockReason);
    return `[Blocked: ${blockReason}]`;
  }

  // Check finish reason
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.error('Gemini finish reason:', finishReason);
    return `[Finish: ${finishReason}]`;
  }

  const text = response.text()?.trim();
  console.log('Gemini response length:', text?.length, '| finish:', finishReason);
  return text;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);
  const isEnglish = ENGLISH_RE.test(text) && text.length > 2;

  let userMessage;
  let systemPrompt;

  if (hasThai && !triggerMatch) {
    // Auto-translate Thai → English
    userMessage = text;
    systemPrompt = THAI_TO_EN_PROMPT;
  } else if (isEnglish && !triggerMatch) {
    // Auto-translate English → Thai
    userMessage = text;
    systemPrompt = EN_TO_THAI_PROMPT;
  } else if (triggerMatch) {
    // @ai / @BruceBot — assistant mode
    userMessage = triggerMatch[1].trim() || 'hello';
    systemPrompt = ASSISTANT_PROMPT;
  } else {
    return null;
  }

  try {
    // Race against LINE's 30s reply token expiry
    const reply = await Promise.race([
      callGemini(systemPrompt, userMessage),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
    ]);

    if (!reply) {
      console.error('Empty reply from Gemini for input:', userMessage.slice(0, 100));
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '⚠️ Got empty response. Try again!' }],
      });
    }

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }],
    });
  } catch (err) {
    console.error('Error:', err.message, '| input:', userMessage.slice(0, 100));
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `⚠️ Error: ${err.message}. Try again!` }],
    });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    // Test endpoint: /test?text=ที่ร้าน
    if (req.url?.includes('/test')) {
      const text = req.query?.text || 'ที่ร้านอาหารญี่ปุ่น\nJimmy ยอมรับ';
      try {
        const reply = await callGemini(THAI_TO_EN_PROMPT, text);
        return res.status(200).json({ input: text, output: reply });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
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
    // Process events sequentially — parallel risks reply token conflicts
    for (const event of events) {
      await handleEvent(event);
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
};
