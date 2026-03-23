const { messagingApi } = require('@line/bot-sdk');
const crypto = require('crypto');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CONFIG.channelAccessToken,
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const THAI_TO_EN_PROMPT = `Translate Thai to English. Rules: translate every line (no skipping), preserve tone, translate slang accurately. Then add "Context: [1-2 sentences on emotional subtext]". Output only translation + context.`;

const EN_TO_THAI_PROMPT = `You are a professional English-Thai translation tool. Translate the given English text into natural conversational Thai suitable for texting between a couple. Output only the Thai translation. No intro, no advice.`;

const ASSISTANT_PROMPT = `You are a helpful assistant in a LINE group chat. Reply concisely. Match the user's language (Thai → Thai, English → English).`;

const THAI_RE = /[\u0E00-\u0E7F]/;
const ENGLISH_RE = /^[a-zA-Z][a-zA-Z0-9\s.,!?'"()\-:;]{2,}$/;
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

async function callGemini(systemPrompt, userMessage) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Gemini API error:', res.status, err.slice(0, 300));
    return null;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  console.log('Gemini reply length:', text?.length ?? 'null', '| finish:', data.candidates?.[0]?.finishReason);
  return text || null;
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);
  const isEnglishOnly = ENGLISH_RE.test(text);

  let userMessage, systemPrompt;

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
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
    ]);

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText || '⚠️ Could not translate. Try again.' }],
    });
  } catch (err) {
    console.error('handleEvent error:', err.message);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `⚠️ Error: ${err.message}` }],
    });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.url?.includes('test')) {
      const raw = req.url.split('text=')[1] || '';
      const text = decodeURIComponent(raw) || 'ที่ร้านอาหารญี่ปุ่น\nJimmy ยอมรับ';
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

  // Log every webhook call — shows us what LINE is actually sending
  console.log(`Webhook: ${events.length} event(s)`);
  events.forEach((e, i) => {
    const text = e.message?.text || '';
    const hasThai = THAI_RE.test(text);
    console.log(`Event[${i}]: type=${e.type} msgType=${e.message?.type} hasThai=${hasThai} text="${text.slice(0, 80)}"`);
  });

  if (events.length === 0) return res.status(200).json({ status: 'ok' });

  const signature = req.headers['x-line-signature'];
  if (signature && LINE_CONFIG.channelSecret) {
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', LINE_CONFIG.channelSecret).update(body).digest('base64');
    if (hash !== signature) {
      console.error('Signature mismatch — rejecting');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  try {
    for (const event of events) await handleEvent(event);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
};
