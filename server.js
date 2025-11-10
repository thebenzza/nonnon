import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { Client, middleware as lineMw } from '@line/bot-sdk';

/**
 * LINE Pet Vaccine Bot — Firebase Firestore + Gemini + Railway
 * ENV ต้องมี:
 * LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN,
 * GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT, TZ=Asia/Bangkok
 */

// ---------- EXPRESS ----------
const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // เก็บ raw body ไว้ตรวจ signature
}));

// Log ทุก request
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t}ms)`);
  });
  next();
});

app.get('/', (_, res) => res.send('Pet Vaccine Bot (Firebase + Gemini) — OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- FIREBASE ----------
let db;
(function initFirebaseSafe() {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (svc.private_key.includes('\\n')) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    db = admin.firestore();
    console.log('Firebase initialized');
  } catch (e) {
    console.error('[FIREBASE_INIT_ERROR]', e.message);
  }
})();

// ---------- LINE SDK ----------
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new Client(lineConfig);

// ---------- GEMINI ----------
async function geminiParse(text) {
  try {
    const systemPrompt = 'คุณเป็น NLU สำหรับบอทวัคซีนสัตว์เลี้ยง ให้ตอบ JSON {"intent":"add_pet|add_vaccine|list_vaccine","parameters":{...}}';
    const body = {
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'user', parts: [{ text }] }
      ]
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const { data } = await axios.post(url, body);
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(raw.replace(/```json|```/g, ''));
  } catch (e) {
    console.error('Gemini parse error:', e.message);
    return null;
  }
}

// ---------- Firestore helper ----------
async function ensureOwner(line_user_id, name='') {
  const ref = db.collection('owners').doc(line_user_id);
  const snap = await ref.get();
  if (!snap.exists) await ref.set({ display_name: name, consent_pdpa_at: Date.now() });
  return true;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00+07:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0,10);
}

async function addPet(line_user_id, name) {
  await ensureOwner(line_user_id);
  await db.collection('pets').add({ owner_user_id: line_user_id, name });
}

async function addVaccine(line_user_id, pet_name, vaccine_name, last_shot_date, cycle_days=365) {
  const nextDue = addDays(last_shot_date, cycle_days);
  const vRef = await db.collection('vaccines').add({
    owner_user_id: line_user_id, pet_name, vaccine_name, last_shot_date, next_due_date: nextDue
  });
  const reminders = db.collection('reminders');
  const d0 = new Date(nextDue + 'T09:00:00+07:00');
  const d1 = new Date(d0.getTime() - 24*60*60*1000);
  const d7 = new Date(d0.getTime() - 7*24*60*60*1000);
  for (const [t, dt] of [['D0',d0],['D-1',d1],['D-7',d7]]) {
    await reminders.add({ owner_user_id: line_user_id, vaccine_id: vRef.id, pet_name, type:t, remind_at: admin.firestore.Timestamp.fromDate(dt), sent:false });
  }
  return nextDue;
}

// ---------- LINE handler ----------
async function handleEvent(event) {
  const userId = event.source.userId;
  if (!userId) return;

  if (event.type === 'follow') {
    const profile = await lineClient.getProfile(userId);
    await ensureOwner(userId, profile.displayName);
    return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`สวัสดี ${profile.displayName} 🐾 พิมพ์ "เมนู" เพื่อเริ่มใช้งาน` }]);
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (/^เมนู$/i.test(text)) {
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'เมนู 🐾\n- เพิ่มสัตว์เลี้ยง\n- บันทึกวัคซีน\n- ดูวัคซีน' }]);
    }

    const parsed = await geminiParse(text);
    if (!parsed) return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ระบบกำลังเริ่มต้น โปรดลองใหม่อีกครั้งนะครับ/ค่ะ' }]);

    if (parsed.intent === 'add_pet') {
      const name = parsed.parameters?.name || text.replace('เพิ่มหมาชื่อ','').trim();
      await addPet(userId, name);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`เพิ่มสัตว์เลี้ยง "${name}" เรียบร้อย ✅` }]);
    }

    if (parsed.intent === 'add_vaccine') {
      const pet = parsed.parameters?.pet_name || 'โมจิ';
      const vaccine = parsed.parameters?.vaccine_name || 'Rabies';
      const date = parsed.parameters?.last_shot_date || '2025-11-03';
      const cycle = parsed.parameters?.cycle_days || 365;
      const next = await addVaccine(userId, pet, vaccine, date, cycle);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`บันทึกวัคซีน ${vaccine} ให้ ${pet} แล้ว ✅ นัดถัดไป: ${next}` }]);
    }

    return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ยังไม่เข้าใจครับ/ค่ะ ลองพิมพ์ "เมนู" เพื่อดูตัวเลือก' }]);
  }
}

// ---------- ROUTES ----------
app.post('/webhook', lineMw(lineConfig), async (req, res) => {
  await Promise.all((req.body.events || []).map(handleEvent));
  res.status(200).end();
});

// ตรวจ Signature ด้วย POST เท่านั้น
app.post('/webhook-raw', (req, res) => {
  try {
    const sig = req.headers['x-line-signature'];
    const computed = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(req.rawBody)
      .digest('base64');
    console.log('[SIGCHECK]', sig === computed ? '✅ match' : '❌ mismatch', sig, computed);
    res.status(200).send('ok');
  } catch (e) {
    console.error('[SIGCHECK_ERROR]', e.message);
    res.status(500).send('error');
  }
});

// ✅ Debug Firestore route
app.get('/debug/firestore', async (req, res) => {
  try {
    if (!db) throw new Error('db_not_ready');
    const doc = await db.collection('ping').add({ ts: Date.now() });
    res.status(200).json({ ok: true, id: doc.id });
  } catch (e) {
    console.error('[DEBUG_FIRESTORE]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- CRON ----------
cron.schedule('0 * * * *', async () => {
  if (!db) return;
  const now = admin.firestore.Timestamp.now();
  const due = await db.collection('reminders')
    .where('sent', '==', false)
    .where('remind_at', '<=', now)
    .get();
  for (const doc of due.docs) {
    const r = doc.data();
    try {
      await lineClient.pushMessage(r.owner_user_id, { type: 'text', text: `แจ้งเตือน${r.type} 🐾 ถึงกำหนดวัคซีนของ ${r.pet_name}` });
      await doc.ref.update({ sent: true });
    } catch (e) { console.error('push error', e.message); }
  }
}, { timezone: process.env.TZ || 'Asia/Bangkok' });

// ---------- START ----------
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Server running on', port));
