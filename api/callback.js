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

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const THAI_RE = /[\u0E00-\u0E7F]/;
const ENGLISH_RE = /^[a-zA-Z][a-zA-Z0-9\s.,!?'"()\-:;]{2,}$/;
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

// ─── Supabase: conversation memory ───────────────────────────────────────────

async function saveMessage(chatId, userId, displayName, text, lang) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/brucebot_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ chat_id: chatId, user_id: userId, display_name: displayName, text, lang }),
    });
  } catch (e) {
    console.error('Supabase save error:', e.message);
  }
}

async function getRecentMessages(chatId, limit = 10) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/brucebot_messages?chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=${limit}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return Array.isArray(rows) ? rows.reverse() : [];
  } catch (e) {
    console.error('Supabase fetch error:', e.message);
    return [];
  }
}

async function saveBotReply(chatId, text) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/brucebot_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ chat_id: chatId, user_id: 'brucebot', display_name: 'BruceBot AI', text, lang: 'bot' }),
    });
  } catch (e) {
    console.error('Supabase bot save error:', e.message);
  }
}

// ─── LINE: get sender display name ───────────────────────────────────────────

async function getDisplayName(userId, chatId, chatType) {
  try {
    if (chatType === 'group') {
      const member = await client.getGroupMemberProfile(chatId, userId);
      return member.displayName || 'Member';
    } else if (chatType === 'room') {
      const member = await client.getRoomMemberProfile(chatId, userId);
      return member.displayName || 'Member';
    } else {
      const profile = await client.getProfile(userId);
      return profile.displayName || 'User';
    }
  } catch (e) {
    console.error('getDisplayName error:', e.message);
    return 'User';
  }
}

// ─── Gemini call ─────────────────────────────────────────────────────────────

async function callGemini(systemPrompt, userMessage, chatHistory = []) {
  // Build contents array: history turns + current message
  const contents = [];
  for (const msg of chatHistory) {
    contents.push({ role: msg.role, parts: [{ text: msg.text }] });
  }
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
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
    console.error('Gemini error:', res.status, err.slice(0, 200));
    return null;
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── Event handler ───────────────────────────────────────────────────────────

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);
  const isEnglishOnly = ENGLISH_RE.test(text);
  const userId = event.source.userId;

  // Determine chat context
  const chatType = event.source.type; // 'user', 'group', 'room'
  const chatId = event.source.groupId || event.source.roomId || event.source.userId;

  let userMessage, systemPrompt, lang;

  if (hasThai && !triggerMatch) {
    userMessage = text;
    lang = 'th';
  } else if (isEnglishOnly && !triggerMatch) {
    userMessage = text;
    lang = 'en';
  } else if (triggerMatch) {
    userMessage = triggerMatch[1].trim() || 'hello';
    lang = 'cmd';
  } else {
    return null;
  }

  // Get sender name + recent history in parallel
  const [displayName, history] = await Promise.all([
    getDisplayName(userId, chatId, chatType),
    getRecentMessages(chatId, 10),
  ]);

  // Save this message
  saveMessage(chatId, userId, displayName, text, lang);

  // Build context string from history
  let contextBlock = '';
  if (history.length > 0) {
    const historyLines = history
      .map(m => `${m.display_name}: ${m.text}`)
      .join('\n');
    contextBlock = `\n\nRecent conversation history (for context only, do not translate these):\n${historyLines}`;
  }

  // Build chat history for @ai assistant mode (proper turn-by-turn)
  let chatHistory = [];
  if (lang === 'cmd' && history.length > 0) {
    for (const msg of history) {
      if (msg.lang === 'cmd') chatHistory.push({ role: 'user', text: msg.text });
      else if (msg.lang === 'bot') chatHistory.push({ role: 'model', text: msg.text });
    }
  }

  if (lang === 'th') {
    systemPrompt = `Translate Thai to English. Translate every line, no skipping. Preserve tone. Translate slang accurately. Then add "Context: [1-2 sentences on emotional subtext]". Output only translation and context.${contextBlock}`;
  } else if (lang === 'en') {
    systemPrompt = `Translate English to natural conversational Thai for texting. Output only the Thai translation.${contextBlock}`;
  } else {
    systemPrompt = `You are a helpful, fun assistant in a LINE group chat between a couple (Bruce speaks English, K speaks Thai). 
Always reply in BOTH languages: first in English, then in Thai, separated by a line break.
Format:
[English reply]

🇹🇭 [Same reply in Thai]

Be concise, warm, and helpful.`;
  }

  try {
    const replyText = await Promise.race([
      callGemini(systemPrompt, userMessage, chatHistory),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 22000)),
    ]);

    if (!replyText) return null;

    // Add sender label for translations
    let finalReply = replyText;
    if (lang === 'th' || lang === 'en') {
      const flag = lang === 'th' ? '🇹🇭' : '🇺🇸';
      finalReply = `${flag} ${displayName}:\n${replyText}`;
    }

    // Save bot reply to memory (for @ai conversation continuity)
    if (lang === 'cmd') saveBotReply(chatId, replyText);

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: finalReply }],
    });
  } catch (err) {
    console.error('handleEvent error:', err.message);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `⚠️ Error: ${err.message}` }],
    });
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.url?.includes('test')) {
      const raw = req.url.split('text=')[1] || '';
      const text = decodeURIComponent(raw) || 'ที่ร้านอาหารญี่ปุ่น\nJimmy ยอมรับ';
      try {
        const reply = await callGemini(
          'Translate Thai to English. Translate every line, no skipping. Preserve tone. Add Context line.',
          text
        );
        return res.status(200).json({ input: text, output: reply });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(200).json({ status: 'ok', bot: 'BruceBot AI', model: MODEL, features: ['Thai↔EN auto-translate', 'sender label', 'conversation memory'] });
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
