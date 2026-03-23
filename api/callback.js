const { messagingApi } = require('@line/bot-sdk');
const crypto = require('crypto');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const client = new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CONFIG.channelAccessToken });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const THAI_RE = /[\u0E00-\u0E7F]/;
const ENGLISH_RE = /^[a-zA-Z][a-zA-Z0-9\s.,!?'"()\-:;]{2,}$/;
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function sb(path, method = 'GET', body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : undefined,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
    if (res.status === 204 || res.status === 201) return true;
    return await res.json();
  } catch (e) {
    console.error('Supabase error:', e.message);
    return null;
  }
}

async function saveMessage(chatId, userId, displayName, text, lang) {
  return sb('brucebot_messages', 'POST', { chat_id: chatId, user_id: userId, display_name: displayName, text, lang });
}

async function getRecentMessages(chatId, limit = 30) {
  const rows = await sb(`brucebot_messages?chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows.reverse() : [];
}

async function getProfile(chatId) {
  const rows = await sb(`brucebot_profile?id=eq.${encodeURIComponent(chatId)}`);
  return Array.isArray(rows) && rows.length > 0 ? rows[0].data : {};
}

async function saveProfile(chatId, data) {
  return sb('brucebot_profile', 'POST', { id: chatId, data, updated_at: new Date().toISOString() });
}

// ─── Gemini helper ───────────────────────────────────────────────────────────

async function callGemini(systemPrompt, messages) {
  // messages = [{role: 'user'|'model', text: string}]
  const contents = messages.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
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
  const res = await fetch(GEMINI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { console.error('Gemini error:', res.status, (await res.text()).slice(0, 200)); return null; }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── Profile updater — runs silently on every message ────────────────────────

async function learnFromMessage(chatId, displayName, text, lang, currentProfile) {
  const prompt = `You are silently observing a couple's LINE chat to build a relationship intelligence profile.
A message was just sent. Extract any meaningful insights about the people or relationship.

Current profile:
${JSON.stringify(currentProfile, null, 2)}

New message from ${displayName} (lang: ${lang}): "${text}"

If this message reveals something worth remembering (personality trait, preference, feeling, milestone, pattern, topic they care about), output a JSON object with the new/updated fields to merge into the profile.

Profile structure to use:
{
  "bruce": { "personality": [], "interests": [], "communication_style": "", "languages": ["English"], "notes": [] },
  "k": { "personality": [], "interests": [], "communication_style": "", "languages": ["Thai"], "notes": [] },
  "relationship": { "milestones": [], "patterns": [], "shared_interests": [], "recurring_topics": [], "dynamics": "", "started": "" },
  "memories": []
}

Output ONLY valid JSON to merge, or output null if nothing meaningful to add. No explanation.`;

  try {
    const result = await callGemini(prompt, [{ role: 'user', text: `Message: "${text}"` }]);
    if (!result || result === 'null') return;
    const updates = JSON.parse(result.replace(/```json\n?|\n?```/g, '').trim());
    if (updates && typeof updates === 'object') {
      // Deep merge
      const merged = deepMerge(currentProfile, updates);
      await saveProfile(chatId, merged);
    }
  } catch (e) {
    console.error('Learn error:', e.message);
  }
}

function deepMerge(base, updates) {
  const result = { ...base };
  for (const key of Object.keys(updates)) {
    if (Array.isArray(updates[key]) && Array.isArray(base[key])) {
      // Merge arrays, deduplicate strings
      const combined = [...base[key], ...updates[key]];
      result[key] = [...new Set(combined.map(x => typeof x === 'string' ? x : JSON.stringify(x)))].map(x => { try { return JSON.parse(x); } catch { return x; } });
    } else if (typeof updates[key] === 'object' && updates[key] !== null && typeof base[key] === 'object' && base[key] !== null) {
      result[key] = deepMerge(base[key], updates[key]);
    } else if (updates[key] !== null && updates[key] !== undefined && updates[key] !== '') {
      result[key] = updates[key];
    }
  }
  return result;
}

// ─── LINE display name ───────────────────────────────────────────────────────

async function getDisplayName(userId, chatId, chatType) {
  try {
    if (chatType === 'group') return (await client.getGroupMemberProfile(chatId, userId)).displayName || 'Member';
    if (chatType === 'room') return (await client.getRoomMemberProfile(chatId, userId)).displayName || 'Member';
    return (await client.getProfile(userId)).displayName || 'User';
  } catch (e) { return 'User'; }
}

// ─── Event handler ───────────────────────────────────────────────────────────

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);
  const isEnglishOnly = ENGLISH_RE.test(text);
  const userId = event.source.userId;
  const chatType = event.source.type;
  const chatId = event.source.groupId || event.source.roomId || event.source.userId;

  let lang;
  if (hasThai && !triggerMatch) lang = 'th';
  else if (isEnglishOnly && !triggerMatch) lang = 'en';
  else if (triggerMatch) lang = 'cmd';
  else return null;

  const [displayName, history, profile] = await Promise.all([
    getDisplayName(userId, chatId, chatType),
    getRecentMessages(chatId, 30),
    getProfile(chatId),
  ]);

  // Save message + silently learn from it (fire and forget)
  saveMessage(chatId, userId, displayName, text, lang);
  learnFromMessage(chatId, displayName, text, lang, profile); // non-blocking

  // Build history turns for @ai
  const chatHistory = [];
  if (lang === 'cmd') {
    for (const msg of history) {
      if (msg.lang === 'cmd') chatHistory.push({ role: 'user', text: `${msg.display_name}: ${msg.text}` });
      else if (msg.lang === 'bot') chatHistory.push({ role: 'model', text: msg.text });
    }
  }

  // Recent convo context for translations
  const recentLines = history.slice(-10).map(m => `${m.display_name}: ${m.text}`).join('\n');

  let systemPrompt, inputMessages;

  if (lang === 'th') {
    systemPrompt = `You are a Thai-English translator. Translate every line faithfully. No skipping. Preserve tone and slang. Add "Context: [emotional subtext in 1-2 sentences]".`;
    inputMessages = [{ role: 'user', text }];
  } else if (lang === 'en') {
    systemPrompt = `Translate English to natural conversational Thai for texting. Output only the Thai translation.`;
    inputMessages = [{ role: 'user', text }];
  } else {
    // Build rich profile summary
    const profileSummary = Object.keys(profile).length > 0
      ? `\n\nWhat you know about them:\n${JSON.stringify(profile, null, 2)}`
      : '';

    systemPrompt = `You are a personal relationship assistant living inside Bruce and K's LINE group chat.

Bruce speaks English. K speaks Thai. You've been watching their conversations and learning about them over time.
${profileSummary}

Your role:
- Help them communicate, play, grow, understand each other
- Give advice when asked, suggest date ideas, games, conversation starters, anything they need
- Notice patterns in their relationship and gently reflect them back when relevant
- Be warm, insightful, and fun — like a wise friend who knows them both well

Always reply in BOTH languages so both can read:
[English reply]

🇹🇭 [Exact same reply in Thai]`;

    // Add history as proper turns
    chatHistory.push({ role: 'user', text: `${displayName}: ${triggerMatch[1].trim() || 'hello'}` });
    inputMessages = chatHistory;
  }

  try {
    const replyText = await Promise.race([
      callGemini(systemPrompt, inputMessages),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 22000)),
    ]);

    if (!replyText) return null;

    let finalReply = replyText;
    if (lang === 'th' || lang === 'en') {
      const flag = lang === 'th' ? '🇹🇭' : '🇺🇸';
      finalReply = `${flag} ${displayName}:\n${replyText}`;
    }

    if (lang === 'cmd') {
      saveMessage(chatId, 'brucebot', 'BruceBot AI', replyText, 'bot');
    }

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: finalReply }],
    });
  } catch (err) {
    console.error('Error:', err.message);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `⚠️ ${err.message}` }],
    });
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.url?.includes('test')) {
      const text = decodeURIComponent(req.url.split('text=')[1] || '') || 'ที่ร้านอาหารญี่ปุ่น\nJimmy ยอมรับ';
      try {
        const reply = await callGemini('Translate Thai to English. Every line. Preserve tone. Add Context line.', [{ role: 'user', text }]);
        return res.status(200).json({ input: text, output: reply });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }
    if (req.url?.includes('profile')) {
      const chatId = decodeURIComponent(req.url.split('chatId=')[1] || '');
      const profile = await getProfile(chatId);
      return res.status(200).json({ chatId, profile });
    }
    return res.status(200).json({ status: 'ok', bot: 'BruceBot AI', model: MODEL, memory: '30 messages + relationship profile' });
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
