/* =========================================================
 * server.js — Nonnon (Pet Planner) v2.0-hybrid
 * Features:
 *  - Hybrid AI Router: Planner (structured) + Health/Chat (free text)
 *  - Session Memory on Firestore (expect/pending_action/partial)
 *  - Add Pet / Add Vaccine (auto reminders D-7/D-1/D0)
 *  - LINE Image → Firebase Storage → attach to pet profile
 *  - Debug endpoints: /debug/version, /debug/session/:uid
 * ---------------------------------------------------------
 * ENV (required):
 *  LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
 *  GEMINI_API_KEY, GEMINI_MODEL=gemini-2.5-flash-lite
 *  FIREBASE_SERVICE_ACCOUNT (stringified JSON, \n escaped)
 *  FIREBASE_PROJECT_ID
 *  TZ=Asia/Bangkok
 * Optional for future:
 *  LLM_PROVIDER=gemini|openai, OPENAI_API_KEY, OPENAI_MODEL=gpt-4o-mini
 * ========================================================= */

import express from 'express';
import 'dotenv/config';
import admin from 'firebase-admin';
import { Client, middleware as lineMw } from '@line/bot-sdk';
import { v4 as uuidv4 } from 'uuid';

// ---------- Init Firebase ----------
function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('[ENV] FIREBASE_SERVICE_ACCOUNT is missing');
  try {
    // รองรับทั้ง JSON ตรง ๆ หรือ string ที่มี \n
    const json = JSON.parse(raw.replace(/\\n/g, '\n'));
    return json;
  } catch (e) {
    throw new Error('[FIREBASE_INIT_ERROR] Cannot parse FIREBASE_SERVICE_ACCOUNT: ' + e.message);
  }
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(parseServiceAccount()),
    projectId: process.env.FIREBASE_PROJECT_ID,
    // ตั้ง default storage bucket (แก้เป็นของโปรเจกต์คุณ)
    storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com`,
  });
  console.log('Firebase initialized');
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// ---------- Init LINE ----------
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new Client(lineConfig);

// ---------- Express ----------
const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.send('Nonnon v2.0-hybrid OK'));

// ---------- Session Helpers ----------
const SESSIONS = db.collection('sessions');

async function loadSession(userId) {
  const snap = await SESSIONS.doc(userId).get();
  if (!snap.exists) return { expect: null, pending_action: null, partial: {}, updated_at: null };
  return snap.data();
}
async function saveSession(userId, patch) {
  const now = admin.firestore.Timestamp.now();
  await SESSIONS.doc(userId).set({ updated_at: now, ...(patch || {}) }, { merge: true });
  return { updated_at: now, ...(patch || {}) };
}
async function clearSession(userId) {
  await SESSIONS.doc(userId).delete().catch(() => {});
  return { expect: null, pending_action: null, partial: {}, updated_at: null };
}
function patchPartial(session, kv) {
  const partial = { ...(session.partial || {}), ...(kv || {}) };
  return { ...session, partial };
}

// ---------- Prompts ----------
const GLOBAL_PERSONA = `
คุณคือน้อนน้อน ผู้ช่วยดูแลสัตว์เลี้ยง พูดสุภาพ อบอุ่น และเป็นมิตร ใช้ภาษาไทยเข้าใจง่าย มีอีโมจิเล็กน้อย 🐾
หลักการ:
- คำตอบกระชับ เป็นประโยคสั้น ๆ อ่านง่าย
- ถ้าข้อมูลยังไม่พอ: ถามต่อเพียง “หนึ่งคำถาม” ที่สำคัญที่สุดในเที่ยวถัดไป
- ห้ามวินิจฉัยโรคหรือสั่งยา ให้คำแนะนำเบื้องต้นเท่านั้น และบอกสัญญาณอันตรายที่ควรไปพบสัตวแพทย์
- ถ้าผู้ใช้พิมพ์สั้นมาก เช่น “ใช่”, “ไม่”, “วันนี้”, “เมื่อวาน”, ให้พยายามเชื่อมกับบริบทก่อนหน้า
`;

const PLANNER_PROMPT = `
[type=planner_instructions]
ให้คุณแปลงข้อความผู้ใช้เป็นแผน (actions) สำหรับเก็บข้อมูลสัตว์เลี้ยง โดยตอบเป็น JSON เดียวเท่านั้น
สคีมา JSON:
{
  "confidence": number (0..1),
  "reply_hint": string,
  "followup_question": string,
  "actions": [
    { "action": "add_pet" | "add_vaccine" | "add_medical" | "list_vaccine" | "confirm" | "noop", "params": { ... } }
  ]
}
กติกา:
- "add_pet": params = { name, species?, breed?, sex?, birthdate?, neutered?, color_markings?, profile_photo_url? }
- "add_vaccine": params = { pet_name, vaccine_name, date(YYYY-MM-DD|today), cycle_days? (default 365) }
- ถ้าขาดข้อมูล ให้แนะนำคำถามใน "followup_question" และ/หรือใช้ "noop" ชั่วคราว
- ตอบเป็น JSON เท่านั้น ห้ามใส่คำอธิบายนอก JSON
ตัวอย่าง:
IN: "โบมฉีดพิษสุนัขบ้าวันนี้"
OUT: {"confidence":0.9,"reply_hint":"จะบันทึกวัคซีน Rabies ให้โบม วันนี้นะคะ","followup_question":"รอบถัดไป 365 วันดีไหมคะ?","actions":[{"action":"add_vaccine","params":{"pet_name":"โบม","vaccine_name":"Rabies","date":"today","cycle_days":365}}]}
`;

const HEALTH_SYSTEM = `
คุณจะให้คำแนะนำสุขภาพสัตว์เลี้ยงแบบทั่วไปเท่านั้น:
- สาเหตุที่พบได้บ่อย (ไม่วินิจฉัย)
- สิ่งที่ควรสังเกตเพิ่มเติม
- การดูแลเบื้องต้นที่ปลอดภัย
- เมื่อไรควรพาไปพบสัตวแพทย์ทันที
ตอบเป็น bullet สั้น ๆ และปิดท้ายด้วยคำถามคัดกรอง 1 ข้อ
`;

// ---------- LLM Adapters ----------
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'gemini'; // 'gemini' | 'openai'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function extractJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const mFence = /```json\s*([\s\S]*?)```/i.exec(trimmed);
  if (mFence) { try { return JSON.parse(mFence[1]); } catch {} }
  try { return JSON.parse(trimmed); } catch {}
  const a = trimmed.indexOf('{'), b = trimmed.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(trimmed.slice(a, b + 1)); } catch {} }
  return null;
}

async function geminiCall({ system, user, json = false, maxTokens = 1200, temperature = 0.3 }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const contents = [];
  if (system) contents.push({ role: 'user', parts: [{ text: `[SYSTEM]\n${system}` }] });
  contents.push({ role: 'user', parts: [{ text: user }] });
  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: json ? 'application/json' : 'text/plain'
    }
  };
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return json ? extractJSON(text) : (text || '').trim();
}
async function geminiPlanner(userText, context = {}) {
  const sys = `${GLOBAL_PERSONA}\n\n${PLANNER_PROMPT}\n\n[BCTX]\n${JSON.stringify(context).slice(0, 2000)}`;
  return geminiCall({ system: sys, user: userText, json: true, maxTokens: 1200, temperature: 0.2 });
}
async function geminiChat(userText, context = {}, mode = 'health') {
  const sys = `${GLOBAL_PERSONA}\n${mode === 'health' ? HEALTH_SYSTEM : ''}\n\n[BCTX]\n${JSON.stringify(context).slice(0, 1200)}`;
  return geminiCall({ system: sys, user: userText, json: false, maxTokens: 1000, temperature: 0.4 });
}

// (OpenAI adapter — เผื่อสลับในอนาคต)
async function openaiCall({ system, user, json = false, model = OPENAI_MODEL, maxTokens = 1200, temperature = 0.3 }) {
  const url = 'https://api.openai.com/v1/responses';
  const messages = [];
  if (system) messages.push({ role: 'system', content: [{ type: 'text', text: system }] });
  messages.push({ role: 'user', content: [{ type: 'text', text: user }] });
  const body = {
    model,
    input: messages,
    temperature,
    max_output_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {})
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.output_text ?? '';
  return json ? extractJSON(text) : (text || '').trim();
}

async function llmPlanner(userText, context = {}) {
  if (LLM_PROVIDER === 'openai') {
    const sys = `${GLOBAL_PERSONA}\n\n${PLANNER_PROMPT}\n\n[BCTX]\n${JSON.stringify(context).slice(0, 2000)}`;
    return openaiCall({ system: sys, user: userText, json: true, maxTokens: 1200, temperature: 0.2 });
  }
  return geminiPlanner(userText, context);
}
async function llmChat(userText, context = {}, mode = 'health') {
  if (LLM_PROVIDER === 'openai') {
    const sys = `${GLOBAL_PERSONA}\n${mode === 'health' ? HEALTH_SYSTEM : ''}\n\n[BCTX]\n${JSON.stringify(context).slice(0, 1200)}`;
    return openaiCall({ system: sys, user: userText, json: false, maxTokens: 1000, temperature: 0.4 });
  }
  return geminiChat(userText, context, mode);
}

// ---------- Intent Router ----------
function quickIntent(text, session) {
  const t = (text || '').trim().toLowerCase();
  const has = (k) => t.includes(k);
  if (session?.expect) return { intent: 'continue', reason: 'session.expect active' };

  const plannerVerbs = ['เพิ่ม','บันทึก','แก้ไข','ดู','นัด','เตือน','ตั้งเตือน'];
  if (plannerVerbs.some(v => has(v))) return { intent: 'planner', reason: 'matched planner verbs' };

  const symptoms = ['ท้องเสีย','อาเจียน','ซึม','คัน','ผื่น','ไอ','เลือด','ไม่กิน','กินน้อย','น้ำหนักลด'];
  if (symptoms.some(v => has(v))) return { intent: 'health', reason: 'matched symptoms' };

  if (['ใช่','ไม่','วันนี้','เมื่อวาน','ผู้','เมีย','ทับสุนัข','ทับแมว'].includes(t)) {
    return { intent: 'continue', reason: 'short answer likely follow-up' };
  }
  return { intent: 'unknown', reason: 'no match' };
}

async function routeIntent(text, session) {
  const q = quickIntent(text, session);
  if (q.intent !== 'unknown') return q;
  // ใช้ planner เป็น router แบบเบา ๆ
  try {
    const probe = await llmPlanner(text, { mode: 'router_only' });
    if (probe?.actions?.length) return { intent: 'planner', reason: 'router → planner' };
    return { intent: 'chat', reason: 'router → chat' };
  } catch {
    return { intent: 'chat', reason: 'router fallback' };
  }
}

// ---------- Planner Core ----------
async function runPlanner(userId, text, session) {
  const ctx = { session_partial: session.partial || {} };
  let plan;
  try {
    plan = await llmPlanner(text, ctx);
  } catch (e) {
    return { reply: 'ระบบกำลังเริ่มต้นอยู่ค่ะ โปรดลองอีกครั้งนะคะ 🐾' };
  }

  if (!plan || !Array.isArray(plan.actions)) {
    return { reply: 'น้อนน้อนไม่แน่ใจค่ะ ต้องการ “บันทึกข้อมูล” หรือ “ปรึกษาอาการ” ดีคะ? 🐾', keep: session };
  }

  if (plan.followup_question && (!plan.actions.length || plan.actions[0].action === 'noop')) {
    const nextSession = await saveSession(userId, { expect: 'followup', pending_action: 'collect', partial: session.partial || {} });
    return { reply: plan.reply_hint || plan.followup_question, keep: nextSession };
  }

  let replyLines = [];
  let newSession = session;

  for (const a of plan.actions) {
    const action = (a.action || '').trim();
    const p = a.params || {};
    if (p.date === 'today') p.date = new Date().toISOString().slice(0,10);

    if (action === 'add_pet') {
      await db.collection('pets').add({
        owner_user_id: userId,
        name: p.name,
        species: p.species || 'dog',
        breed: p.breed || null,
        sex: p.sex || 'unknown',
        birthdate: p.birthdate || null,
        neutered: p.neutered ?? null,
        color_markings: p.color_markings || null,
        profile_photo_url: p.profile_photo_url || null,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
      replyLines.push(`สร้างโปรไฟล์ **${p.name}** ให้เรียบร้อยค่ะ 🐾`);
      newSession = await clearSession(userId);
    }

    if (action === 'add_vaccine') {
      const petName = p.pet_name;
      const vaccine = p.vaccine_name;
      const lastDate = p.date;
      const cycleDays = Number(p.cycle_days || 365);

      if (!petName || !vaccine || !lastDate) {
        const hold = patchPartial(session, { pet_name: petName, vaccine_name: vaccine, date: lastDate, cycle_days: cycleDays });
        await saveSession(userId, { expect: !vaccine ? 'vaccine_name' : !petName ? 'pet_name' : 'date', pending_action: 'add_vaccine', partial: hold.partial });
        return { reply: plan.followup_question || 'ขอทราบชื่อวัคซีน/ชื่อสัตว์/วันที่ค่ะ', keep: hold };
      }

      // หา/สร้าง pet
      const petSnap = await db.collection('pets').where('owner_user_id','==', userId).get();
      let petId = null;
      petSnap.forEach(doc => { if ((doc.data().name||'').trim() === petName.trim()) petId = doc.id; });
      if (!petId) {
        const created = await db.collection('pets').add({
          owner_user_id: userId, name: petName, species: p.species || 'dog',
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        petId = created.id;
      }

      // บันทึกวัคซีน
      const nextDue = new Date(new Date(`${lastDate}T00:00:00+07:00`).getTime() + cycleDays*86400000);
      const nextDueStr = `${nextDue.getFullYear()}-${String(nextDue.getMonth()+1).padStart(2,'0')}-${String(nextDue.getDate()).padStart(2,'0')}`;
      await db.collection('vaccines').add({
        owner_user_id: userId,
        pet_name: petName,
        vaccine_name: vaccine,
        last_shot_date: lastDate,
        next_due_date: nextDueStr,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });

      // สร้างเตือน D-7 / D-1 / D0
      const d0 = new Date(`${nextDueStr}T09:00:00+07:00`);
      const d1 = new Date(d0.getTime() - 86400000);
      const d7 = new Date(d0.getTime() - 7*86400000);
      const REMS = db.collection('reminders');
      for (const [type, at] of [['D-7', d7], ['D-1', d1], ['D0', d0]]) {
        await REMS.add({
          owner_user_id: userId,
          pet_name: petName,
          type,
          remind_at: admin.firestore.Timestamp.fromDate(at),
          sent: false,
          created_at: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      replyLines.push(`บันทึกวัคซีน **${vaccine}** ให้ **${petName}** แล้วค่ะ นัดถัดไป **${nextDueStr}** ✅`);
      newSession = await clearSession(userId);
    }

    if (action === 'confirm') {
      replyLines.push(p.message || 'รับทราบค่ะ ✅');
      newSession = await clearSession(userId);
    }
  }

  const reply = plan.reply_hint || (replyLines.length ? replyLines.join('\n') : 'เรียบร้อยค่ะ 🐾');
  return { reply, keep: newSession };
}

// ---------- Health Chat ----------
async function runHealthChat(userId, text) {
  const reply = await llmChat(text, { userId }, 'health');
  return { reply };
}

// ---------- LINE Image → Firebase Storage ----------
async function handleImageMessage(event) {
  const userId = event.source.userId;
  const messageId = event.message.id;

  const stream = await client.getMessageContent(messageId);
  const fname = `line/${userId}/${Date.now()}-${uuidv4()}.jpg`;
  const file = bucket.file(fname);

  await new Promise((resolve, reject) => {
    const writeStream = file.createWriteStream({ contentType: 'image/jpeg', resumable: false, metadata: { cacheControl: 'public, max-age=31536000' } });
    stream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    stream.pipe(writeStream);
  });

  await file.makePublic().catch(()=>{});
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fname}`;

  const session = await loadSession(userId);
  if (session.expect === 'profile_photo' && session.partial?.pet_name) {
    const snap = await db.collection('pets').where('owner_user_id','==', userId).get();
    let updated = false;
    for (const doc of snap.docs) {
      if ((doc.data().name||'').trim() === (session.partial.pet_name||'').trim()) {
        await doc.ref.set({ profile_photo_url: publicUrl, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        updated = true;
        break;
      }
    }
    await clearSession(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: updated ? 'อัปเดตรูปโปรไฟล์เรียบร้อยค่า 🧡' : 'รับรูปแล้วค่า แต่ยังหาโปรไฟล์ไม่เจอ ลองบอกชื่อสัตว์อีกครั้งได้ไหมคะ?' });
  }

  await saveSession(userId, { expect: 'profile_photo_pet_name', pending_action: 'attach_photo', partial: { temp_photo_url: publicUrl } });
  return client.replyMessage(event.replyToken, { type: 'text', text: 'รับรูปเรียบร้อยค่า 🧡 จะบันทึกเป็นรูปโปรไฟล์ของน้องตัวไหนคะ? (พิมพ์ชื่อได้เลย)' });
}

// ---------- LINE Text Handler ----------
async function onTextMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text || '';
  let session = await loadSession(userId);

  const route = await routeIntent(text, session);

  let result;
  if (route.intent === 'continue' || route.intent === 'planner') {
    result = await runPlanner(userId, text, session);
  } else if (route.intent === 'health' || route.intent === 'chat') {
    result = await runHealthChat(userId, text);
  } else {
    result = { reply: 'อยากให้น้อนน้อนช่วย “บันทึกข้อมูล” หรือ “ปรึกษาอาการ” ดีคะ? 🐾' };
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: result.reply || '...' });
}

// ---------- LINE Webhook ----------
app.post('/webhook', lineMw(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(async (event) => {
    try {
      if (event.type === 'follow') {
        // ทักทาย + แนะนำตัว
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `สวัสดีค่ะ นี่คือน้อนน้อน ผู้ช่วยจดข้อมูลสัตว์เลี้ยง 🐾\nพิมพ์ “เพิ่มสัตว์” เพื่อเริ่มสร้างโปรไฟล์ หรือถามอาการสุขภาพทั่วไปก็ได้ค่ะ`
        });
      }
      if (event.type === 'message') {
        if (event.message.type === 'text') return onTextMessage(event);
        if (event.message.type === 'image') return handleImageMessage(event);
        // อื่น ๆ
        return client.replyMessage(event.replyToken, { type: 'text', text: 'ขออภัย น้อนน้อนรองรับเฉพาะข้อความและรูปภาพค่ะ 🐾' });
      }
    } catch (e) {
      console.error('Event error:', e);
      try {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'ขออภัย น้อนน้อนติดขัดนิดหน่อย ลองอีกครั้งได้ไหมคะ 🐾' });
      } catch {}
    }
  }));
  res.status(200).end();
});

// ---------- Debug ----------
app.get('/debug/version', (_req, res) => {
  res.json({
    ok: true,
    version: 'v2.0-hybrid',
    provider: LLM_PROVIDER,
    model: LLM_PROVIDER === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL,
    tz: process.env.TZ || 'Asia/Bangkok'
  });
});

app.get('/debug/session/:uid', async (req, res) => {
  try {
    const s = await loadSession(req.params.uid);
    res.json({ ok: true, session: s });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('Server running on', port));
