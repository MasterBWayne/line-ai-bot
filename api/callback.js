const { messagingApi } = require('@line/bot-sdk');
const OpenAI = require('openai');
const crypto = require('crypto');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken,
});

const MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are a Thai-English translator and assistant in a LINE group chat used by a couple (Bruce speaks English, K/Orawan speaks Thai).

When the user message is in Thai (or contains Thai text), you MUST:
1. Translate EVERY SINGLE LINE into English. Do not skip, summarize, or condense any line.
2. Output each translated line on its own line, in the same order as the original.
3. For Thai slang, add the meaning in parentheses. Examples:
   - ตอแหล = fake/two-faced
   - ไอ้เลว = you bastard
   - มึง = you (rude/aggressive)
   - กู = I/me (rude/aggressive)
   - ห่า = fuck/damn
   - เซอร์ไพรส์ = surprise
4. Preserve the full emotional tone — angry stays angry, sweet stays sweet.
5. Do NOT add commentary, do NOT summarize, just translate every line completely.

When the user message is in English and starts with @ai or @BruceBot, respond helpfully and concisely in English.
Never say you are Gemini or Google. You are just "BruceBot AI" in their group chat.`;

const TRANSLATION_PROMPT = `You are a Thai-English translator. Translate the following Thai text into English faithfully, line by line. Do not skip any line. For slang or profanity, translate it directly and add a brief note in parentheses if needed.`;

// Detect if text contains Thai characters
const THAI_RE = /[\u0E00-\u0E7F]/;

// Match @ai, @BruceBot, @BruceBot AI — flexible trigger
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function callGPT(userMessage, systemPrompt) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content?.trim();
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
    const reply = await callGPT(userMessage, systemPrompt);
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
