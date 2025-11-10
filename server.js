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
app.set('trust proxy', true);
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t}ms)`);
  });
  next();
});

app.get('/', (_, res) => res.send('Pet Vaccine Bot (Firebase + Gemini) — OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/version', (_, res) => res.json({ version: 'rb-1.0.4', time: new Date().toISOString() }));

// ---------- FIREBASE ----------
let db;
(function initFirebaseSafe() {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (svc.private_key && svc.private_key.includes('\\n')) svc.private_key = svc.private_key.replace(/\\n/g, '\n');
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

// ---------- GEMINI (AI Studio) ----------
async function geminiParse(text) {
  if (!process.env.GEMINI_API_KEY) return null; // ไม่มีคีย์ให้ข้าม
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'ให้ตอบเป็น JSON {"intent":"add_pet|add_vaccine|list_vaccine","parameters":{...}} เท่านั้น' }] },
        { role: 'user', parts: [{ text }] }
      ]
    };
    const { data } = await axios.post(url, body, { timeout: 15000 });
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const jsonText = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(jsonText);
  } catch (e) {
    if (e.response) console.error('Gemini error:', e.response.status, e.response.data);
    else console.error('Gemini error:', e.message);
    return null; // ล้มก็ข้าม เพื่อไม่ให้บอทค้าง
  }
}

// ---------- RULE-BASED PARSERS (ไทย) ----------
function normalizeDate(input) {
  if (!input) return '';
  const s = input.trim();
  const iso = s.match(/^\d{4}-\d{2}-\d{2}$/);
  if (iso) return s;
  const dmy = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmy) {
    const d = String(dmy[1]).padStart(2,'0');
    const m = String(dmy[2]).padStart(2,'0');
    const y = dmy[3];
    return `${y}-${m}-${d}`;
  }
  return '';
}

function parseAddPet(text) {
  const byKeyword = text.match(/^เพิ่ม(หมา|แมว|สัตว์เลี้ยง)?ชื่อ\s+(.+)$/i);
  if (byKeyword) {
    const name = byKeyword[2].trim();
    return { intent: 'add_pet', name };
  }
  const colon = text.match(/^ชื่อ\s*:\s*(.+)$/i);
  if (colon) {
    return { intent: 'add_pet', name: colon[1].trim() };
  }
  return null;
}

function parseAddVaccine(text) {
  const quick = text.match(/^วัคซีน\s*:\s*([^\s]+)\s+([^\s]+)\s+(\d{2,4})$/i);
  if (quick) {
    const vaccine = quick[1];
    const date = normalizeDate(quick[2]);
    const cycle = parseInt(quick[3], 10) || 365;
    if (date) return { intent: 'add_vaccine', pet: null, vaccine, date, cycle };
  }
  const m = text.match(/^ฉีด\s+([^\s]+)\s+ให้([^\s]+)\s+([0-9\/\-]+)(?:\s+รอบ\s+(\d{2,4}))?/i);
  if (m) {
    const vaccine = m[1].trim();
    const pet = m[2].trim();
    const date = normalizeDate(m[3]);
    const cycle = parseInt(m[4] || '365', 10);
    if (date) return { intent: 'add_vaccine', pet, vaccine, date, cycle };
  }
  return null;
}

function parseListVaccine(text) {
  if (/^ดู(กำหนด)?วัคซีน(?:ของ(.+))?$/i.test(text)) {
    const m = text.match(/^ดู(?:กำหนด)?วัคซีน(?:ของ(.+))?$/i);
    const pet = (m && m[1]) ? m[1].trim() : null;
    return { intent: 'list_vaccine', pet };
  }
  return null;
}

// ---------- Firestore helper ----------
async function ensureOwner(line_user_id, name='') {
  try {
    if (!db) {
      const app = admin.app();
      db = admin.firestore();
    }
    const ref = db.collection('owners').doc(line_user_id);
    const snap = await ref.get();
    if (!snap.exists) await ref.set({ display_name: name, consent_pdpa_at: admin.firestore.Timestamp.now() });
    return true;
  } catch (err) {
    console.error('[ensureOwner ERROR]', err && (err.stack || err.message || err));
    return false;
  }
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
  const userId = event.source?.userId;
  if (!userId) return;

  if (event.type === 'follow') {
    try {
      const profile = await lineClient.getProfile(userId);
      await ensureOwner(userId, profile.displayName);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`สวัสดี ${profile.displayName} 🐾 พิมพ์ "เมนู" เพื่อเริ่มใช้งาน` }]);
    } catch (e) {
      console.error('follow error', e.message);
      return;
    }
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    console.log('[MSG_IN]', { userId, text });

    // เมนู
    if (/^เมนู$/i.test(text)) {
      return lineClient.replyMessage(event.replyToken, [{
        type:'text',
        text:'เมนู 🐾\n- เพิ่มสัตว์เลี้ยง: "เพิ่มหมาชื่อ โมจิ"\n- บันทึกวัคซีน: "วัคซีน: Rabies 2025-11-03 365" หรือ "ฉีด Rabies ให้โมจิ 2025-11-03 รอบ 365"\n- ดูวัคซีน: "ดูกำหนดวัคซีน" หรือ "ดูวัคซีนของโมจิ"'
      }]);
    }

    // ลบข้อมูล (PDPA)
    if (/^ลบข้อมูล$/i.test(text)) {
      try {
        const ownerId = userId;
        const delCol = async (col, field='owner_user_id') => {
          const snap = await db.collection(col).where(field,'==', ownerId).get();
          const batch = db.batch();
          snap.forEach(d => batch.delete(d.ref));
          await batch.commit();
        };
        await Promise.all([delCol('reminders'), delCol('vaccines'), delCol('pets')]);
        await db.collection('owners').doc(ownerId).delete().catch(()=>{});
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ลบข้อมูลทั้งหมดของคุณเรียบร้อยแล้ว ✅' }]);
      } catch (e) {
        console.error('delete all error', e.message);
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ลบข้อมูลไม่สำเร็จ กรุณาลองใหม่ครับ/ค่ะ' }]);
      }
    }

    // เชื่อมฐานข้อมูล
    const okOwner = await ensureOwner(userId);
    if (!okOwner) {
      return lineClient.replyMessage(event.replyToken, [{
        type:'text',
        text:'ระบบเชื่อมฐานข้อมูลยังไม่พร้อม กรุณาลองใหม่อีกครั้งครับ/ค่ะ'
      }]);
    }

    // พาร์สแบบกฎ (ไม่ง้อ Gemini)
    const p1 = parseAddPet(text);
    if (p1) {
      console.log('[PARSE_RULE] add_pet', p1);
      await addPet(userId, p1.name);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`เพิ่มสัตว์เลี้ยง "${p1.name}" เรียบร้อย ✅` }]);
    }

    const p2 = parseAddVaccine(text);
    if (p2) {
      console.log('[PARSE_RULE] add_vaccine', p2);
      let petName = p2.pet;
      if (!petName) {
        const qs = await db.collection('pets').where('owner_user_id','==', userId).orderBy('name').get();
        if (!qs.empty) petName = qs.docs[qs.docs.length-1].data().name;
      }
      if (!petName) return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ยังไม่มีสัตว์เลี้ยง กรุณาเพิ่มก่อนครับ/ค่ะ' }]);
      const next = await addVaccine(userId, petName, p2.vaccine, p2.date, p2.cycle);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`บันทึกวัคซีน ${p2.vaccine} ให้ ${petName} แล้ว ✅ นัดถัดไป: ${next}` }]);
    }

    const p3 = parseListVaccine(text);
    if (p3) {
      console.log('[PARSE_RULE] list_vaccine', p3);
      let petName = p3.pet;
      if (!petName) {
        const qs = await db.collection('pets').where('owner_user_id','==', userId).orderBy('name').get();
        if (!qs.empty) petName = qs.docs[qs.docs.length-1].data().name;
      }
      if (!petName) return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ยังไม่มีสัตว์เลี้ยง กรุณาเพิ่มก่อนครับ/ค่ะ' }]);
      const vSnap = await db.collection('vaccines').where('owner_user_id','==', userId).where('pet_name','==', petName).get();
      if (vSnap.empty) return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`ยังไม่มีข้อมูลวัคซีนของ ${petName}` }]);
      const lines = vSnap.docs.map(d => {
        const r = d.data();
        return `• ${r.vaccine_name}  ล่าสุด: ${r.last_shot_date||'-'}  นัด: ${r.next_due_date||'-'}`;
      }).join('\n');
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`กำหนดวัคซีนของ ${petName}\n${lines}` }]);
    }

    // (เสริม) ลอง Gemini ถ้ากฎไม่จับ — ถ้าล้มจะ return null แล้วมาทาง fallback ด้านล่าง
    const parsed = await geminiParse(text);
    if (parsed?.intent === 'add_pet') {
      const name = parsed.parameters?.name;
      if (name) {
        await addPet(userId, name);
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`เพิ่มสัตว์เลี้ยง "${name}" เรียบร้อย ✅` }]);
      }
    } else if (parsed?.intent === 'add_vaccine') {
      const pet = parsed.parameters?.pet_name;
      const vaccine = parsed.parameters?.vaccine_name || parsed.parameters?.vaccine;
      const date = normalizeDate(parsed.parameters?.last_shot_date || '');
      const cycle = parsed.parameters?.cycle_days || 365;
      if (pet && vaccine && date) {
        const next = await addVaccine(userId, pet, vaccine, date, cycle);
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`บันทึกวัคซีน ${vaccine} ให้ ${pet} แล้ว ✅ นัดถัดไป: ${next}` }]);
      }
    }

    // คู่มือ/ตัวอย่าง (fallback)
    return lineClient.replyMessage(event.replyToken, [{
      type:'text',
      text:'ลองพิมพ์ตามนี้นะครับ/ค่ะ 🐾\n- เพิ่มหมาชื่อ โมจิ\n- วัคซีน: Rabies 2025-11-03 365\n- ฉีด Rabies ให้โมจิ 2025-11-03 รอบ 365\n- ดูวัคซีนของโมจิ'
    }]);
  }
}

// ---------- ROUTES ----------
app.post('/webhook', lineMw(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// ตรวจ Signature ด้วย POST เท่านั้น (เอาออกเมื่อใช้งานจริง)
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

// ✅ Debug Firestore route (เอาออกเมื่อใช้งานจริง)
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
