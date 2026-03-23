const { messagingApi } = require('@line/bot-sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const client = new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CONFIG.channelAccessToken });

// ─── Feature 1: Multi-message split (4500 char chunks) ──────────────────────

async function pushMessage(chatId, text) {
  const fullText = (text || '').trim();
  if (!fullText) return false;

  const MAX_CHUNK = 4500;

  if (fullText.length <= MAX_CHUNK) {
    return await pushSingleMessage(chatId, fullText);
  }

  // Split into chunks at paragraph/line boundaries
  const chunks = [];
  let remaining = fullText;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK) {
      chunks.push(remaining);
      break;
    }
    // Find last newline within limit
    let splitAt = remaining.lastIndexOf('\n', MAX_CHUNK);
    if (splitAt < MAX_CHUNK * 0.3) {
      // No good newline break — split at last space
      splitAt = remaining.lastIndexOf(' ', MAX_CHUNK);
    }
    if (splitAt < MAX_CHUNK * 0.3) {
      // No good break at all — hard split
      splitAt = MAX_CHUNK;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    const ok = await pushSingleMessage(chatId, chunks[i]);
    if (!ok) allOk = false;
    if (i < chunks.length - 1) await sleep(500);
  }
  return allOk;
}

async function pushSingleMessage(chatId, text) {
  const safeText = text.slice(0, 4999);
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': `Bearer ${LINE_CONFIG.channelAccessToken}`,
    },
    body: JSON.stringify({ to: chatId, messages: [{ type: 'text', text: safeText }] }),
  });

  let body = {};
  try { body = await res.json(); } catch (e) { /* ignore */ }

  if (!res.ok) {
    console.error(`Push failed [${res.status}] to ${chatId}:`, JSON.stringify(body));
  } else {
    console.log(`Push sent to ${chatId}:`, body?.sentMessages?.[0]?.id);
  }
  return res.ok;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ─── Bot identity — hardcoded, never loses context ───────────────────────────
const BOT_IDENTITY = `You are BruceBot AI — a personal relationship assistant living inside Bruce and K's LINE group chat.

The people:
- Bruce (Jimmy Kong): English speaker, Bangkok-based MBA student, AI builder, NYC real estate owner, INFJ-T, systems thinker, deeply self-aware, values depth and authenticity.
- K (Orawan): Thai speaker, Bruce's girlfriend, expressive, observant, communicates naturally in Thai.

Your personality: warm, bilingual, wise like a close friend who knows them both. Playful when they're playing, thoughtful when they're deep. Never preachy.

Core rules you never break:
1. Always reply in BOTH English and Thai when assisting (@ai mode)
2. Translate every line faithfully — never summarize or skip
3. Translate slang and profanity directly — never soften
4. Always read their history and profile before responding
5. Learn something from every message and update the profile`;

// In-memory dedup for LINE event IDs (survives within same Render instance)
const processedEvents = new Set();

const THAI_RE = /[\u0E00-\u0E7F]/;
const ENGLISH_RE = /^[a-zA-Z][a-zA-Z0-9\s.,!?'"()\-:;]{2,}$/;
const TRIGGER_RE = /^@(?:ai|brucebot(?:\s+ai)?)\s*(.*)/is;

// ─── Feature 3: Help command ─────────────────────────────────────────────────

const HELP_TEXT = `🤖 BruceBot AI — ทำอะไรได้บ้าง

📝 แปลภาษา (Auto)
• พิมพ์ไทย → แปลเป็นอังกฤษ
• พิมพ์อังกฤษ → แปลเป็นไทย

💬 คุยกับ AI (@ai หรือ @BruceBot)
• @ai [คำถาม/คำขอ]
• @ai help — เมนูนี้

🧠 ตัวอย่าง
• @ai แนะนำที่เที่ยวในกรุงเทพ
• @ai เล่นเกม Would You Rather กัน
• @ai อธิบายหนังสือ Atomic Habits
• @ai remember K loves Japanese food

💾 จดจำอัตโนมัติ
บอทเรียนรู้จากทุกข้อความและสร้างโปรไฟล์ความสัมพันธ์

📸 ส่งรูปหรือเสียง — บอทจะตอบกลับอัตโนมัติ

---
🤖 BruceBot AI — What I can do

📝 Auto Translation
• Type Thai → translates to English
• Type English → translates to Thai

💬 Chat with AI (@ai or @BruceBot)
• @ai [question/request]
• @ai help — this menu

🧠 Examples
• @ai recommend places to visit in Bangkok
• @ai let's play Would You Rather
• @ai explain Atomic Habits
• @ai remember K loves Japanese food

💾 Learns automatically
Bot learns from every message and builds a relationship profile

📸 Send photos or voice — bot responds automatically`;

// ─── Feature 4: Sticker emotion map ─────────────────────────────────────────

const STICKER_EMOTIONS = {
  // LINE default stickers — common heart/love stickers
  '52002734': 'love', '52002735': 'love', '52002736': 'love',
  '5114': 'love', '5115': 'love', '5116': 'love',
  '13': 'love', '325': 'love', '522': 'love',
  // Crying/sad
  '52002739': 'sad', '52002743': 'sad',
  '7': 'sad', '17': 'sad', '404': 'sad', '427': 'sad',
  // Laughing/happy
  '52002738': 'happy', '52002741': 'happy',
  '1': 'happy', '2': 'happy', '4': 'happy', '11': 'happy', '13': 'happy',
  '106': 'happy', '138': 'happy', '407': 'happy',
  // Angry
  '52002740': 'angry', '8': 'angry', '12': 'angry', '405': 'angry',
  // Flirty/wink
  '52002737': 'flirty', '5': 'flirty', '115': 'flirty', '138': 'flirty',
  // Thumbs up/OK
  '52002742': 'approval', '3': 'approval', '14': 'approval',
};

const STICKER_PACKAGE_EMOTIONS = {
  // Heart/love sticker packages
  '11537': 'love', '11538': 'love', '11539': 'love',
};

function getStickerEmotion(stickerId, packageId) {
  if (STICKER_EMOTIONS[stickerId]) return STICKER_EMOTIONS[stickerId];
  if (STICKER_PACKAGE_EMOTIONS[packageId]) return STICKER_PACKAGE_EMOTIONS[packageId];
  return null;
}

const EMOTION_RESPONSES = {
  love: [
    "sent a ❤️ — feeling affectionate!\nส่งหัวใจ ❤️ — กำลังรู้สึกหวานๆ!",
    "is sending love! ❤️\nส่งความรักมาให้! ❤️",
    "❤️ Love in the chat!\n❤️ ความรักเต็มแชท!",
  ],
  sad: [
    "seems a bit down 🥺\nดูเศร้านิดหน่อย 🥺",
    "is feeling emotional 😢\nกำลังรู้สึกอ่อนไหว 😢",
  ],
  happy: [
    "is cracking up! 😂\nขำมาก! 😂",
    "is in a great mood! 😄\nอารมณ์ดีมาก! 😄",
  ],
  angry: [
    "seems fired up! 😤\nดูโกรธๆ นะ! 😤",
  ],
  flirty: [
    "is being flirty! 😏\nกำลังจีบอยู่นะ! 😏",
  ],
  approval: [
    "👍 Got it!\n👍 รับทราบ!",
  ],
};

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

async function getRecentMessages(chatId, limit = 100) {
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

// ─── Gemini helpers ──────────────────────────────────────────────────────────

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

// Feature 7 & 8: Gemini with inline data (image/audio)
async function callGeminiWithMedia(systemPrompt, textPrompt, mediaBase64, mimeType) {
  const contents = [{
    role: 'user',
    parts: [
      { inline_data: { mime_type: mimeType, data: mediaBase64 } },
      { text: textPrompt },
    ],
  }];
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
  if (!res.ok) { console.error('Gemini media error:', res.status, (await res.text()).slice(0, 300)); return null; }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── LINE Content download ───────────────────────────────────────────────────

async function downloadLineContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${LINE_CONFIG.channelAccessToken}` },
  });
  if (!res.ok) {
    console.error('LINE content download failed:', res.status);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

// ─── Profile updater — runs silently on every message ────────────────────────

async function learnFromMessage(chatId, displayName, text, lang, currentProfile) {
  const prompt = `You are a relationship intelligence system silently observing a couple's chat.

Current profile:
${JSON.stringify(currentProfile, null, 2)}

New message from ${displayName}: "${text}"

Extract ONLY genuinely meaningful insights — things that reveal personality, preferences, feelings, milestones, or relationship patterns. Skip small talk, filler, and bot commands.

Things worth saving:
- Emotional moments ("I miss you", "that made me happy", "I was surprised")
- Preferences and dislikes ("I love Japanese food", "I hate when...")
- Milestones ("our first date", "we went to Silom today")
- Personality reveals (self-awareness, humor, sensitivity, directness)
- Relationship dynamics (who initiates, how they express love, tension patterns)
- Shared interests, inside jokes, recurring topics
- Specific memories worth remembering

Profile structure:
{
  "bruce": { "personality": [], "interests": [], "communication_style": "", "love_language": "", "notes": [] },
  "k": { "personality": [], "interests": [], "communication_style": "", "love_language": "", "notes": [] },
  "relationship": { "milestones": [], "patterns": [], "shared_interests": [], "recurring_topics": [], "dynamics": "", "started": "", "inside_jokes": [] },
  "memories": [{ "date": "", "description": "", "manual": false }]
}

Output ONLY valid JSON to merge, or exactly null if nothing meaningful. No explanation, no markdown.`;

  try {
    const result = await callGemini(prompt, [{ role: 'user', text: `Message: "${text}"` }]);
    if (!result || result === 'null') return;
    const updates = JSON.parse(result.replace(/```json\n?|\n?```/g, '').trim());
    if (updates && typeof updates === 'object') {
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
  if (event.type !== 'message') return null;

  const msgType = event.message.type;

  // Dedup by LINE message ID
  const eventKey = event.message.id;
  if (processedEvents.has(eventKey)) {
    console.log('Dedup: already processed message', eventKey);
    return null;
  }
  processedEvents.add(eventKey);
  if (processedEvents.size > 200) {
    const first = processedEvents.values().next().value;
    processedEvents.delete(first);
  }

  const userId = event.source.userId;
  const chatType = event.source.type;
  const chatId = event.source.groupId || event.source.roomId || event.source.userId;

  // ─── Feature 4: Sticker handling ─────────────────────────────────────────
  if (msgType === 'sticker') {
    const stickerId = event.message.stickerId;
    const packageId = event.message.packageId;
    const emotion = getStickerEmotion(String(stickerId), String(packageId));

    if (!emotion) return null; // Unknown sticker — skip

    const displayName = await getDisplayName(userId, chatId, chatType);
    const responses = EMOTION_RESPONSES[emotion] || EMOTION_RESPONSES.approval;
    const response = responses[Math.floor(Math.random() * responses.length)];
    const reply = `${displayName} ${response}`;

    await pushMessage(chatId, reply);
    saveMessage(chatId, 'brucebot', 'BruceBot AI', reply, 'bot');
    return;
  }

  // ─── Feature 7: Voice message transcription ─────────────────────────────
  if (msgType === 'audio') {
    const displayName = await getDisplayName(userId, chatId, chatType);

    try {
      const audioBuffer = await downloadLineContent(event.message.id);
      if (!audioBuffer) {
        await pushMessage(chatId, '🎙️ Couldn\'t download voice message. Try again.');
        return;
      }

      const base64Audio = audioBuffer.toString('base64');
      // LINE audio is m4a
      const mimeType = 'audio/mp4';

      const transcription = await callGeminiWithMedia(
        'You are a transcription assistant. Transcribe the audio accurately. If it is in Thai, write the Thai text first, then provide an English translation below. If it is in English, just write the English. Keep it faithful — no summarizing.',
        `Transcribe this voice message from ${displayName}. Output the transcript and translation.`,
        base64Audio,
        mimeType
      );

      if (!transcription) {
        await pushMessage(chatId, '🎙️ Voice messages — couldn\'t transcribe. Try again.');
        return;
      }

      const reply = `🎙️ ${displayName} said:\n${transcription}`;
      await pushMessage(chatId, reply);
      saveMessage(chatId, userId, displayName, `[Voice] ${transcription}`, 'th');
      saveMessage(chatId, 'brucebot', 'BruceBot AI', reply, 'bot');
    } catch (err) {
      console.error('Audio error:', err.message);
      await pushMessage(chatId, '🎙️ Voice message error — try again.');
    }
    return;
  }

  // ─── Feature 8: Photo context ───────────────────────────────────────────
  if (msgType === 'image') {
    const displayName = await getDisplayName(userId, chatId, chatType);

    try {
      const imageBuffer = await downloadLineContent(event.message.id);
      if (!imageBuffer) {
        return; // Silently skip if download fails
      }

      const base64Image = imageBuffer.toString('base64');
      const mimeType = 'image/jpeg';

      const description = await callGeminiWithMedia(
        `You are BruceBot AI in Bruce and K's LINE chat. Describe what's in the photo briefly (1-2 sentences) and add a warm, natural comment. Reply in both English and Thai. Keep it short and fun.`,
        `${displayName} shared a photo. Describe it and react warmly.`,
        base64Image,
        mimeType
      );

      if (!description) return; // Silently skip

      const reply = `📸 ${description}`;
      await pushMessage(chatId, reply);
      saveMessage(chatId, userId, displayName, '[Photo shared]', 'en');
      saveMessage(chatId, 'brucebot', 'BruceBot AI', reply, 'bot');
    } catch (err) {
      console.error('Image error:', err.message);
    }
    return;
  }

  // ─── Text messages ──────────────────────────────────────────────────────
  if (msgType !== 'text') return null;

  const text = event.message.text.trim();
  const hasThai = THAI_RE.test(text);
  const triggerMatch = text.match(TRIGGER_RE);
  const textWithoutMentions = text.replace(/@\S+\s*/g, '').trim();
  const isEnglishOnly = ENGLISH_RE.test(textWithoutMentions) && !hasThai;

  let lang;
  if (triggerMatch) lang = 'cmd';
  else if (hasThai) lang = 'th';
  else if (isEnglishOnly) lang = 'en';
  else return null;

  const [displayName, history, profile] = await Promise.all([
    getDisplayName(userId, chatId, chatType),
    getRecentMessages(chatId, 30),
    getProfile(chatId),
  ]);

  // Save message + silently learn (fire and forget)
  saveMessage(chatId, userId, displayName, text, lang);
  learnFromMessage(chatId, displayName, text, lang, profile);

  // ─── Feature 3: Help command ────────────────────────────────────────────
  if (triggerMatch) {
    const cmdBody = (triggerMatch[1] || '').trim().toLowerCase();
    if (cmdBody === 'help') {
      await pushMessage(chatId, HELP_TEXT);
      saveMessage(chatId, 'brucebot', 'BruceBot AI', HELP_TEXT, 'bot');
      return;
    }

    // ─── Feature 6: @ai remember [X] ───────────────────────────────────────
    const rememberMatch = (triggerMatch[1] || '').trim().match(/^remember\s+(.+)/is);
    if (rememberMatch) {
      const memory = rememberMatch[1].trim();
      const today = new Date().toISOString().split('T')[0];

      // Add to profile memories array
      const currentProfile = profile || {};
      if (!currentProfile.memories) currentProfile.memories = [];
      currentProfile.memories.push({ date: today, description: memory, manual: true });
      await saveProfile(chatId, currentProfile);

      const reply = `Got it! Saved: ${memory} 💾\n\nจำแล้ว! บันทึก: ${memory} 💾`;
      await pushMessage(chatId, reply);
      saveMessage(chatId, 'brucebot', 'BruceBot AI', reply, 'bot');
      return;
    }
  }

  // Build history for @ai
  const chatHistory = [];
  if (lang === 'cmd') {
    const recentHistory = history.slice(-20);
    for (const msg of recentHistory) {
      if (msg.lang === 'bot') {
        const cleaned = msg.text
          .replace(/\[English reply\]\n?/gi, '')
          .replace(/\[Exact same reply in Thai\]\n?/gi, '')
          .trim();
        if (cleaned) chatHistory.push({ role: 'model', text: cleaned });
      } else if (msg.lang === 'cmd' || msg.lang === 'th' || msg.lang === 'en') {
        chatHistory.push({ role: 'user', text: `${msg.display_name}: ${msg.text}` });
      }
    }
  }

  const recentLines = history.slice(-20).map(m => `${m.display_name}: ${m.text}`).join('\n');

  let systemPrompt, inputMessages;

  if (lang === 'th') {
    systemPrompt = `You are a Thai cultural interpreter, not just a translator. When given Thai text:

1. Translate every line into natural English — what a native speaker would actually say, not word-for-word.
2. Handle Thai cultural nuance carefully:
   - บาปกรรม in casual speech = past mistakes/flaws, NOT religious "sins"
   - เซอร์ไพรส์ = surprised/caught off guard
   - ตอแหล = two-faced/fake/hypocritical (strong insult)
   - มึง/กู = very rude/aggressive pronouns
   - ช่วงเวลาสั้นๆ = in such a short time
   - ยิ้มแย้ม = smiling sweetly/warmly
3. Preserve the full emotional weight exactly as the Thai speaker intended
4. After the translation, add:
💭 What they're feeling: [1-2 sentences on the emotion and intent, as a Thai person would understand it]`;
    inputMessages = [{ role: 'user', text }];

  } else if (lang === 'en') {
    // ─── Feature 2: Smarter EN→Thai ─────────────────────────────────────────
    systemPrompt = `Translate English to natural Thai texting style. Rules:
- Use casual, warm Thai — like texting a close friend or partner (คนรัก)
- Use particles naturally: นะ, ค่ะ/ครับ, จ้า, น้า as appropriate
- Match the tone: playful → playful Thai, serious → thoughtful Thai
- Keep it natural — not formal, not textbook Thai
- If slang or cultural concepts don't translate directly, use the closest Thai equivalent

Output the Thai translation first. Then on a new line add:
💡 [Brief cultural context note in English — tone, formality level, or anything that helps Bruce understand the nuance]`;
    inputMessages = [{ role: 'user', text }];

  } else {
    // @ai command
    const profileSummary = Object.keys(profile).length > 0
      ? `\n\nWhat you know about them:\n${JSON.stringify(profile, null, 2)}`
      : '';

    systemPrompt = `${BOT_IDENTITY}
${profileSummary}

CRITICAL RULE: Before responding, carefully read the full conversation history below. Track exactly:
- What game or activity is being played (if any)
- What each person has said and answered
- What has happened so far in the current thread
- What the last @ai message was and what you replied

Never hallucinate game state or assume something wasn't said — check the history. If Bruce answered a question, acknowledge it. If a game is in progress, continue it correctly.

Help them communicate, play, grow, and understand each other. Be fun, warm, and accurate.

Write your full response in English first. Then write the exact same response in Thai below it, preceded by 🇹🇭. Never write placeholder text like "[English reply]" — write the actual content directly.`;

    chatHistory.push({ role: 'user', text: `${displayName}: ${triggerMatch[1].trim() || 'hello'}` });
    inputMessages = chatHistory;
  }

  try {
    if (lang === 'cmd') {
      try {
        const rawReply = await callGemini(systemPrompt, inputMessages);
        const cleanReply = (rawReply || '')
          .replace(/^\s*\[English reply\]\s*/gi, '')
          .replace(/\n\s*\[Exact same reply in Thai\]\s*/gi, '\n🇹🇭 ')
          .replace(/\n\s*\[Same reply in Thai\]\s*/gi, '\n🇹🇭 ')
          .replace(/\n\s*\[Thai reply\]\s*/gi, '\n🇹🇭 ')
          .replace(/^\s*\[Exact same reply in Thai\]\s*/gi, '🇹🇭 ')
          .replace(/^\s*\[Same reply in Thai\]\s*/gi, '🇹🇭 ')
          .trim();
        if (!cleanReply) {
          await pushMessage(chatId, '⚠️ Got an empty response. Try again.');
          return;
        }
        // Dedup
        const lastBotMsgs = history.filter(m => m.user_id === 'brucebot').slice(-1);
        if (lastBotMsgs.length > 0 && lastBotMsgs[0].text.slice(0, 50) === cleanReply.slice(0, 50)) {
          console.log('Dedup: skipping duplicate push');
          return;
        }
        saveMessage(chatId, 'brucebot', 'BruceBot AI', cleanReply, 'bot');
        await pushMessage(chatId, cleanReply);
      } catch (err) {
        console.error('@ai error:', err.message);
        await pushMessage(chatId, `⚠️ ${err.message}`);
      }
      return;
    }

    // Translations
    const replyText = await Promise.race([
      callGemini(systemPrompt, inputMessages),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 22000)),
    ]);

    if (!replyText) return null;

    const flag = lang === 'th' ? '🇹🇭' : '🇺🇸';
    const finalReply = `${flag} ${displayName}:\n${replyText}`;

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: finalReply.slice(0, 4999) }],
    });
  } catch (err) {
    console.error('Error:', err.message);
    try {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `⚠️ Error: ${err.message}` }],
      });
    } catch (e2) {
      await pushMessage(chatId, `⚠️ Error: ${err.message}`);
    }
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
    return res.status(200).json({ status: 'ok', bot: 'BruceBot AI', model: MODEL, features: 'translate, @ai chat, stickers, voice, photos, remember, help' });
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
