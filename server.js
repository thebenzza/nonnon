import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { Client, middleware as lineMw } from '@line/bot-sdk';

/**
 * LINE Pet Vaccine Bot — Firebase Firestore + Gemini + Railway
 * 
 * ENV ที่ต้องมี:
 * - LINE_CHANNEL_SECRET
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - GEMINI_API_KEY
 * - FIREBASE_SERVICE_ACCOUNT (JSON ทั้งก้อน)
 * - TZ=Asia/Bangkok
 */

// ---------- EXPRESS (setup + rawBody) ----------
const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Log ทุก request
app.set('trust proxy', true);
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t}ms)`);
  });
  next();
});

// ---------- Health ----------
app.get('/', (_, res) => res.send('Pet Vaccine Bot (Firebase + Gemini) — OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- FIREBASE ----------
let db;
(function initFirebaseSafe() {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (svc.private_key && svc.private_key.includes('\\n'))
      svc.private_key = svc.private_key.replace(/\\n/g, '\n');
    const cred = admin.credential.cert(svc);
    admin.initializeApp({ credential: cred });
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
async function geminiParse(userText) {
  try {
    const systemPrompt = 'คุณเป็น NLU สำหรับบอทวัคซีนสัตว์เลี้ยง ให้ตอบ JSON เช่น {"intent":"add_pet|add_vaccine|list_vaccine","parameters":{...}}';
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'user', parts: [{ text: `ข้อความผู้ใช้: ${userText}` }] },
      ],
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const { data } = await axios.post(url, payload);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(text.replace(/```json|```/g, ''));
  } catch (e) {
    console.error('Gemini parse error:', e.message);
    return null;
  }
}

// ---------- Firestore helpers ----------
async function ensureOwner(line_user_id, display_name = '') {
  try {
    if (!db) {
      const app = admin.app();
      db = admin.firestore();
    }
    const ref = db.collection('owners').doc(line_user_id);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ display_name, consent_pdpa_at: admin.firestore.Timestamp.now() });
      console.log('[ensureOwner] created owner', line_user_id);
    }
    return true;
  } catch (err) {
    console.error('[ensureOwner ERROR]', err.message);
    return false;
  }
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00+07:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

async function addPet(line_user_id, name = 'น้องไม่ระบุชื่อ') {
  await ensureOwner(line_user_id);
  await db.collection('pets').add({ owner_user_id: line_user_id, name });
}

async function addVaccine(line_user_id, pet_name, vaccine_name, last_shot_date, cycle_days = 365) {
  const nextDue = addDays(last_shot_date, cycle_days);
  const vRef = await db.collection('vaccines').add({
    owner_user_id: line_user_id, pet_name, vaccine_name, last_shot_date, next_due_date: nextDue,
  });
  const remind = db.collection('reminders');
  const toTS = d => admin.firestore.Timestamp.fromDate(new Date(d + 'T09:00:00+07:00'));
  const d0 = toTS(nextDue);
  const d1 = admin.firestore.Timestamp.fromMillis(d0.toMillis() - 24*60*60*1000);
  const d7 = admin.firestore.Timestamp.fromMillis(d0.toMillis() - 7*24*60*60*1000);
  await Promise.all([
    remind.add({ owner_user_id: line_user_id, vaccine_id: vRef.id, pet_name, type:'D0', remind_at: d0, sent:false }),
    remind.add({ owner_user_id: line_user_id, vaccine_id: vRef.id, pet_name, type:'D-1', remind_at: d1, sent:false }),
    remind.add({ owner_user_id: line_user_id, vaccine_id: vRef.id, pet_name, type:'D-7', remind_at: d7, sent:false }),
  ]);
  return nextDue;
}

// ---------- Handle LINE Events ----------
async function handleEvent(event) {
  const userId = event.source.userId;
  if (!userId) return;

  // เมื่อเพิ่มเพื่อน
  if (event.type === 'follow') {
    const profile = await lineClient.getProfile(userId);
    await ensureOwner(userId, profile.displayName);
    return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`สวัสดี ${profile.displayName}! 🐾 พิมพ์ "เมนู" เพื่อเริ่มใช้งาน` }]);
  }

  // ข้อความทั่วไป
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    if (/^เมนู$/i.test(text)) {
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'เมนูหลัก 🐾\n- เพิ่มสัตว์เลี้ยง: "เพิ่มหมาชื่อ โมจิ"\n- บันทึกวัคซีน: "ฉีด Rabies ให้โมจิ 2025-11-03 รอบ 365 วัน"\n- ดูวัคซีน: "ดูวัคซีนของโมจิ"' }]);
    }

    const ok = await ensureOwner(userId);
    if (!ok)
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ระบบเชื่อมฐานข้อมูลยังไม่พร้อม กรุณาลองใหม่อีกครั้งครับ/ค่ะ' }]);

    const parsed = await geminiParse(text);
    if (parsed?.intent === 'add_pet') {
      const name = parsed.parameters?.name || text.replace('เพิ่มหมาชื่อ','').trim();
      await addPet(userId, name);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`เพิ่มสัตว์เลี้ยง "${name}" เรียบร้อย ✅` }]);
    }
    if (parsed?.intent === 'add_vaccine') {
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

// ---------- Routes ----------
app.post('/webhook', lineMw(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// ✅ Debug signature (POST เท่านั้น)
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

// ---------- Cron แจ้งเตือน ----------
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
      await lineClient.pushMessage(r.owner_user_id, {
        type: 'text',
        text: `แจ้งเตือน${r.type} 🐾 ถึงกำหนดวัคซีน ${r.pet_name}`,
      });
      await doc.ref.update({ sent: true });
    } catch (e) {
      console.error('push error', e.message);
    }
  }
}, { timezone: process.env.TZ || 'Asia/Bangkok' });

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Server running on', port));
