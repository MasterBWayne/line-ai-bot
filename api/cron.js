/**
 * BruceBot AI — Proactive Engagement Cron
 * Runs every hour via Vercel cron
 * Handles: silence breaker (12h), conversation catalyst, weekly memory surfacing
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sb(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (res.status === 204 || res.status === 201) return true;
  return await res.json();
}

async function getProfile(chatId) {
  const rows = await sb(`brucebot_profile?id=eq.${encodeURIComponent(chatId)}`);
  return Array.isArray(rows) && rows.length > 0 ? rows[0].data : {};
}

async function saveProfile(chatId, data) {
  return sb('brucebot_profile', 'POST', {
    id: chatId,
    data,
    updated_at: new Date().toISOString(),
  });
}

async function getRecentMessages(chatId, limit = 20) {
  const rows = await sb(`brucebot_messages?chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows.reverse() : [];
}

async function getAllChatIds() {
  // Get distinct chat IDs that have had activity
  const rows = await sb('brucebot_messages?select=chat_id&order=created_at.desc&limit=1000');
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.map(r => r.chat_id).filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function pushMessage(chatId, text) {
  // LINE push message API — works for groups and 1:1
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: chatId,
      messages: [{ type: 'text', text }],
    }),
  });
  const result = await res.json();
  console.log('Push result:', res.status, JSON.stringify(result).slice(0, 200));
  return res.ok;
}

async function callGemini(systemPrompt, userText) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  const res = await fetch(GEMINI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── Feature 1: Silence Breaker (12h) ────────────────────────────────────────

async function checkSilenceBreaker(chatId, messages, profile) {
  if (messages.length === 0) return;

  const lastMsg = messages[messages.length - 1];
  const lastTime = new Date(lastMsg.created_at);
  const hoursSince = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);

  // Only trigger between 12-13 hours of silence (so we don't spam every hour)
  if (hoursSince < 12 || hoursSince > 13) return;

  // Don't trigger if last message was from the bot
  if (lastMsg.user_id === 'brucebot') return;

  // Check if we already sent a silence breaker in the last 12h
  const lastBotMsg = messages.filter(m => m.user_id === 'brucebot').pop();
  if (lastBotMsg) {
    const botHoursAgo = (Date.now() - new Date(lastBotMsg.created_at).getTime()) / (1000 * 60 * 60);
    if (botHoursAgo < 12) return;
  }

  const profileSummary = JSON.stringify(profile, null, 2);
  const recentContext = messages.slice(-5).map(m => `${m.display_name}: ${m.text}`).join('\n');

  const prompt = `You are BruceBot AI — a warm, bilingual relationship assistant for Bruce (English) and K (Thai).

They haven't chatted in about 12 hours. Based on what you know about them, send a gentle, natural nudge to restart the conversation. 

What you know about them:
${profileSummary}

Their last few messages:
${recentContext}

Write ONE message in BOTH English and Thai. Make it feel natural — like a thoughtful friend, not a chatbot. Could be:
- A question about something they were discussing
- A fun prompt or game idea
- A sweet check-in
- A conversation starter based on their interests

Keep it short and warm. Format:
[English message]

🇹🇭 [Same in Thai]

Do NOT say "I notice you haven't talked" or anything that sounds robotic.`;

  const reply = await callGemini(prompt, 'Generate silence breaker message');
  if (!reply) return;

  console.log(`Silence breaker for ${chatId}: ${hoursSince.toFixed(1)}h since last message`);
  await pushMessage(chatId, reply);

  // Save bot message to history
  await sb('brucebot_messages', 'POST', {
    chat_id: chatId,
    user_id: 'brucebot',
    display_name: 'BruceBot AI',
    text: reply,
    lang: 'bot',
  });
}

// ─── Feature 2: Conversation Catalyst ────────────────────────────────────────

async function checkConversationCatalyst(chatId, messages, profile) {
  if (messages.length < 6) return;

  // Look at last 6 non-bot messages
  const recent = messages.filter(m => m.user_id !== 'brucebot').slice(-6);
  if (recent.length < 6) return;

  // Check if last bot message was recent (don't double-suggest)
  const lastBotMsg = messages.filter(m => m.user_id === 'brucebot').pop();
  if (lastBotMsg) {
    const botMinAgo = (Date.now() - new Date(lastBotMsg.created_at).getTime()) / (1000 * 60);
    if (botMinAgo < 60) return; // Don't suggest within 1h of last bot message
  }

  // Detect low engagement: all recent messages are very short (≤3 words)
  const shortMessages = recent.filter(m => m.text.split(/\s+/).length <= 3 && !m.text.startsWith('@'));
  if (shortMessages.length < 5) return; // Not enough short messages

  // Check last message is recent (within 30 min) — conversation is active but flat
  const lastTime = new Date(recent[recent.length - 1].created_at);
  const minSince = (Date.now() - lastTime.getTime()) / (1000 * 60);
  if (minSince > 30) return;

  const profileSummary = JSON.stringify(profile, null, 2);
  const recentContext = recent.map(m => `${m.display_name}: ${m.text}`).join('\n');

  const prompt = `You are BruceBot AI — a warm, bilingual relationship assistant for Bruce (English) and K (Thai).

Their conversation has gone quiet with short replies. Inject some energy with a fun prompt, game, or interesting question tailored to what you know about them.

What you know about them:
${profileSummary}

Recent messages (flat energy):
${recentContext}

Write ONE engaging prompt in BOTH English and Thai. Make it feel spontaneous and fun — something they'd actually want to engage with. Could be:
- A quick game (20 questions, "would you rather", "describe X in 3 emojis")
- A thoughtful question about each other
- Something tied to their shared interests
- A playful challenge

Format:
[English prompt]

🇹🇭 [Same in Thai]`;

  const reply = await callGemini(prompt, 'Generate conversation catalyst');
  if (!reply) return;

  console.log(`Conversation catalyst for ${chatId}: ${shortMessages.length}/6 short messages`);
  await pushMessage(chatId, reply);

  await sb('brucebot_messages', 'POST', {
    chat_id: chatId,
    user_id: 'brucebot',
    display_name: 'BruceBot AI',
    text: reply,
    lang: 'bot',
  });
}

// ─── Feature 3: Weekly Memory Surfacing (Sundays) ────────────────────────────

async function checkWeeklyMemory(chatId, messages, profile) {
  const now = new Date();
  const isSunday = now.getUTCDay() === 0;
  const isNoonHour = now.getUTCHours() === 5; // 5 UTC = noon Bangkok time

  if (!isSunday || !isNoonHour) return;

  // Check if we already sent a weekly memory this Sunday
  const lastBotMsg = messages.filter(m => m.user_id === 'brucebot').pop();
  if (lastBotMsg) {
    const botHoursAgo = (Date.now() - new Date(lastBotMsg.created_at).getTime()) / (1000 * 60 * 60);
    if (botHoursAgo < 20) return; // Already sent today
  }

  if (!profile || Object.keys(profile).length === 0) return;

  const profileSummary = JSON.stringify(profile, null, 2);

  const prompt = `You are BruceBot AI — a warm, bilingual relationship assistant for Bruce (English) and K (Thai).

It's Sunday — time to surface a meaningful memory, milestone, or reflection from what you've learned about them.

What you know:
${profileSummary}

Write ONE warm Sunday message in BOTH English and Thai. Could be:
- A milestone or memory worth celebrating
- A pattern you've noticed and want to reflect back warmly
- A meaningful question for them to explore together this week
- An appreciation of something specific about their relationship

Keep it heartfelt and genuine — not generic. Make them feel seen.

Format:
☀️ [English message]

🇹🇭 [Same in Thai]`;

  const reply = await callGemini(prompt, 'Generate weekly memory surface');
  if (!reply) return;

  console.log(`Weekly memory for ${chatId}`);
  await pushMessage(chatId, reply);

  await sb('brucebot_messages', 'POST', {
    chat_id: chatId,
    user_id: 'brucebot',
    display_name: 'BruceBot AI',
    text: reply,
    lang: 'bot',
  });
}

// ─── Main cron handler ────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Verify cron secret to prevent abuse
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET || 'brucebot-cron'}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Cron running:', new Date().toISOString());

  try {
    const chatIds = await getAllChatIds();
    console.log(`Processing ${chatIds.length} chat(s)`);

    for (const chatId of chatIds) {
      try {
        const [messages, profile] = await Promise.all([
          getRecentMessages(chatId, 20),
          getProfile(chatId),
        ]);

        await checkSilenceBreaker(chatId, messages, profile);
        await checkConversationCatalyst(chatId, messages, profile);
        await checkWeeklyMemory(chatId, messages, profile);
      } catch (e) {
        console.error(`Error processing ${chatId}:`, e.message);
      }
    }

    res.status(200).json({ status: 'ok', processed: chatIds.length, time: new Date().toISOString() });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ error: err.message });
  }
};
