// server.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { Client, middleware as lineMw } from '@line/bot-sdk';

/**
 * LINE Pet Vaccine Bot — Firebase Firestore + Gemini + Railway
 * - Health:   GET / , GET /healthz
 * - Webhook:  POST /webhook   (LINE -> POST เท่านั้น)
 * - DebugSig: POST /webhook-raw (ชั่วคราวไว้ตรวจ Signature)
 * - Cron:     แจ้งเตือนทุกชั่วโมง (TZ=Asia/Bangkok)
 *
 * ใส่ ENV ใน Railway:
 *  - LINE_CHANNEL_SECRET
 *  - LINE_CHANNEL_ACCESS_TOKEN
 *  - GEMINI_API_KEY
 *  - FIREBASE_SERVICE_ACCOUNT (ทั้งก้อน JSON)  หรือแยก 3 ตัวแปร PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY
 *  - TZ=Asia/Bangkok
 */

// -------------------- Express & Body (เก็บ rawBody ให้ LINE) --------------------
const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// access log & timeout (ช่วยไล่ปัญหา)
app.set('trust proxy', true);
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t}ms)`);
  });
  next();
});
app.use((req, res, next) => {
  res.setTimeout(10000, () => {
    console.error('Request timeout >10s:', req.method, req.originalUrl);
    if (!res.headersSent) res.status(504).send('Gateway Timeout');
  });
  next();
});

// Health
app.get('/', (_, res) => res.status(200).send('Pet Vaccine Bot (Firebase + Gemini) — OK'));
app.get('/healthz', (_, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// -------------------- Firebase Admin init (ปลอดภัย/ไม่ล้มแอป) --------------------
let db;
(function initFirebaseSafe(){
  try {
    let cred;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (svc.private_key && svc.private_key.includes('\\n')) {
        svc.private_key = svc.private_key.replace(/\\n/g, '\n');
      }
      cred = admin.credential.cert(svc);
    } else if (process.env.FIREBASE_PROJECT_ID) {
      cred = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      });
    } else {
      throw new Error('Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY');
    }
    admin.initializeApp({ credential: cred });
    db = admin.firestore();
    console.log('Firebase initialized');
  } catch (e) {
    console.error('[FIREBASE_INIT_ERROR]', e.message);
  }
})();

// -------------------- LINE SDK --------------------
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new Client(lineConfig);

// -------------------- Gemini NLU --------------------
async function geminiParse(userText) {
  try {
    const sys = 'คุณเป็นระบบ NLU สำหรับบอทวัคซีนสัตว์เลี้ยง ให้ตอบ JSON เท่านั้น: {"intent":"add_pet|add_vaccine|list_vaccine|help","parameters":{...}}';
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: sys }] },
        { role: 'user', parts: [{ text: `ข้อความผู้ใช้: ${userText}\nตอบ JSON ล้วน` }] },
      ],
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const { data } = await axios.post(url, payload, { timeout: 15000 });
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try { return JSON.parse(text.replace(/```json|```/g, '')); } catch { return null; }
  } catch (e) {
    console.error('geminiParse error', e?.response?.data || e.message);
    return null;
  }
}

// -------------------- Firestore Helpers --------------------
async function ensureOwner(line_user_id, display_name = '') {
  if (!db) throw new Error('Firestore not initialized');
  const ref = db.collection('owners').doc(line_user_id);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ display_name, consent_pdpa_at: admin.firestore.Timestamp.now() });
  }
}
async function lastPetName(line_user_id) {
  if (!db) throw new Error('Firestore not initialized');
  const q = await db.collection('pets')
    .where('owner_user_id', '==', line_user_id)
    .orderBy('name')
    .get();
  const docs = q.docs;
  return docs.length ? docs[docs.length - 1].data().name : '';
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00+07:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
function toTimestampAt(dateStr, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dateStr + 'T00:00:00+07:00');
  d.setHours(h, m, 0, 0);
  return admin.firestore.Timestamp.fromDate(d);
}
function guessName(t) { const m = t.match(/ชื่อ\s*(น้อง)?([^\s]+)/); return m ? m[2].trim() : 'น้องไม่ระบุชื่อ'; }
function guessVaccine(t){ const m=t.match(/(Rabies|DHPPiL|FVRCP|FeLV)/i); return m?m[1]:'Rabies'; }
function guessDate(t){ const m=t.match(/(20\d{2}-\d{2}-\d{2})/); return m?m[1]:''; }
function guessCycleDays(t){ const m=t.match(/(\d{2,4})\s*(วัน|days?)/i); return m?Number(m[1]):365; }

async function addPet({ line_user_id, name, species='dog', breed='', sex='unknown', birthdate='', note='' }) {
  await ensureOwner(line_user_id);
  if (!name) name = 'น้องไม่ระบุชื่อ';
  await db.collection('pets').add({ owner_user_id: line_user_id, name, species, breed, sex, birthdate, note });
  return { ok:true };
}

async function addVaccine({ line_user_id, pet_name, vaccine_name, last_shot_date, cycle_days=365, clinic='', lot_no='', note='' }) {
  await ensureOwner(line_user_id);
  if (!line_user_id) return { ok:false, msg:'missing user' };
  if (!pet_name) return { ok:false, msg:'ยังไม่มีสัตว์เลี้ยง โปรดเพิ่มก่อนครับ/ค่ะ' };
  if (!vaccine_name) return { ok:false, msg:'กรุณาระบุชื่อวัคซีน เช่น Rabies, DHPPiL' };
  if (!last_shot_date) return { ok:false, msg:'กรุณาระบุวันที่ฉีดล่าสุด (YYYY-MM-DD)' };

  // หา/สร้าง pet
  let petId;
  const pets = await db.collection('pets')
    .where('owner_user_id','==', line_user_id)
    .where('name','==', pet_name)
    .limit(1).get();
  if (pets.empty) {
    const p = await db.collection('pets').add({ owner_user_id: line_user_id, name: pet_name, species:'dog', sex:'unknown' });
    petId = p.id;
  } else {
    petId = pets.docs[0].id;
  }

  const nextDue = addDays(last_shot_date, Number(cycle_days || 365));
  const vRef = await db.collection('vaccines').add({
    owner_user_id: line_user_id, pet_id: petId, pet_name,
    vaccine_name, last_shot_date, next_due_date: nextDue,
    clinic, lot_no, note
  });

  // สร้าง Reminders เวลา 09:00 (D0, D-1, D-7)
  const d0 = toTimestampAt(nextDue,'09:00');
  const d1 = admin.firestore.Timestamp.fromMillis(d0.toMillis() - 24*60*60*1000);
  const d7 = admin.firestore.Timestamp.fromMillis(d0.toMillis() - 7*24*60*60*1000);
  const rCol = db.collection('reminders');
  await Promise.all([
    rCol.add({ owner_user_id: line_user_id, pet_id: petId, vaccine_id: vRef.id, remind_at: d0, sent:false, type:'D0' }),
    rCol.add({ owner_user_id: line_user_id, pet_id: petId, vaccine_id: vRef.id, remind_at: d1, sent:false, type:'D-1' }),
    rCol.add({ owner_user_id: line_user_id, pet_id: petId, vaccine_id: vRef.id, remind_at: d7, sent:false, type:'D-7' }),
  ]);

  return { ok:true, nextDue };
}

async function listVaccinesMsg(line_user_id, pet_name){
  await ensureOwner(line_user_id);
  let petId = null;
  if (pet_name){
    const pets = await db.collection('pets')
      .where('owner_user_id','==', line_user_id)
      .where('name','==', pet_name)
      .limit(1).get();
    if (!pets.empty) petId = pets.docs[0].id;
  }
  let q = db.collection('vaccines').where('owner_user_id','==', line_user_id);
  if (petId) q = q.where('pet_id','==', petId);
  const snap = await q.get();
  const items = snap.docs.map(d=>d.data());
  if (!items.length) return pet_name ? `ยังไม่มีข้อมูลวัคซีนของ ${pet_name}` : 'ยังไม่มีข้อมูลวัคซีน';
  return items.map(r => `• ${r.pet_name}: ${r.vaccine_name}  ล่าสุด: ${r.last_shot_date||'-'}  นัด: ${r.next_due_date||'-'}`).join('\n');
}

// -------------------- LINE Event Handler --------------------
async function handleEvent(event){
  const userId = event?.source?.userId;
  if (!userId) return;

  if (event.type === 'follow'){
    try{
      const profile = await lineClient.getProfile(userId);
      await ensureOwner(userId, profile?.displayName);
      return lineClient.replyMessage(event.replyToken, [
        { type:'text', text:`สวัสดี ${profile.displayName}! 🐾 ยินดีต้อนรับสู่ Pet Vaccine Buddy\nพิมพ์ "เมนู" เพื่อเริ่มใช้งาน` }
      ]);
    }catch(e){ console.error(e); }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text'){
    const text = (event.message.text||'').trim();
    try { await ensureOwner(userId); } catch(e) {
      console.error('ensureOwner failed', e.message);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ระบบกำลังเริ่มต้น โปรดลองใหม่อีกครั้งนะครับ/ค่ะ' }]);
    }

    if (/^เมนู$/i.test(text)){
      return lineClient.replyMessage(event.replyToken, [{
        type:'text',
        text: 'เมนูหลัก 🐾\n- เพิ่มสัตว์เลี้ยง: "เพิ่มหมาชื่อ โมจิ"\n- บันทึกวัคซีน: "ฉีด Rabies ให้โมจิ 2025-11-03 รอบ 365 วัน"\n- ดูกำหนดวัคซีน: "ดูวัคซีนของโมจิ"'
      }]);
    }

    const parsed = await geminiParse(text);
    if (!parsed || !parsed.intent){
      // fallback เบื้องต้น
      if (/เพิ่ม(หมา|แมว|สัตว์)/i.test(text)){
        const name = guessName(text);
        await addPet({ line_user_id: userId, name });
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`เพิ่มสัตว์เลี้ยง "${name}" สำเร็จ ✅` }]);
      }
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ยังไม่เข้าใจครับ/ค่ะ ลองพิมพ์ "เมนู" เพื่อดูตัวเลือก' }]);
    }

    const intent = parsed.intent; const p = parsed.parameters || {};

    if (intent === 'add_pet'){
      const name = p.name || guessName(text);
      const species = (p.species || 'dog').toLowerCase();
      await addPet({ line_user_id: userId, name, species, breed:p.breed, sex:p.sex, birthdate:p.birthdate, note:p.note });
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`เพิ่มสัตว์เลี้ยง "${name}" สำเร็จ ✅` }]);
    }

    if (intent === 'add_vaccine'){
      const pet_name = p.pet_name || await lastPetName(userId);
      const vaccine_name = p.vaccine_name || p.vaccine || guessVaccine(text);
      const last_shot_date = p.last_shot_date || guessDate(text);
      const cycle_days = p.cycle_days || guessCycleDays(text) || 365;
      const res = await addVaccine({ line_user_id: userId, pet_name, vaccine_name, last_shot_date, cycle_days, clinic:p.clinic, lot_no:p.lot_no, note:p.note });
      return lineClient.replyMessage(event.replyToken, [{
        type:'text',
        text: res.ok ? `บันทึกวัคซีน ${vaccine_name} ให้ ${pet_name} แล้ว ✅\nนัดถัดไป: ${res.nextDue}` : res.msg
      }]);
    }

    if (intent === 'list_vaccine'){
      const pet_name = p.pet_name || await lastPetName(userId);
      const msg = await listVaccinesMsg(userId, pet_name);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: msg }]);
    }

    return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ยังไม่รองรับคำสั่งนี้ครับ/ค่ะ' }]);
  }
}

// -------------------- Routes --------------------
// LINE official webhook (อย่าทดลองด้วย GET)
app.post('/webhook', lineMw(lineConfig), async (req, res) => {
  if (!db) {
    console.error('Webhook received but Firestore not initialized yet');
    return res.status(503).send('Service initializing, please retry');
  }
  const events = req.body?.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// DEBUG ONLY: ตรวจลายเซ็น ถ้าใช้เสร็จแนะนำลบ/ปิด route นี้
app.post('/webhook-raw', (req, res) => {
  try {
    const headerSig = req.headers['x-line-signature'];
    const computed = crypto
      .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(req.rawBody) // Buffer จาก express.json({ verify })
      .digest('base64');
    console.log('[SIGCHECK] header=', headerSig, ' computed=', computed, ' match=', headerSig === computed);
    res.status(200).send('ok');
  } catch (e) {
    console.error('[SIGCHECK_ERROR]', e);
    res.status(500).send('error');
  }
});

// global error handler (กัน error หลุด)
app.use((err, req, res, next) => {
  console.error('UNCAUGHT ERROR:', err);
  if (!res.headersSent) res.status(500).send('Internal Server Error');
});

// -------------------- Cron: แจ้งเตือนทุกชั่วโมง --------------------
cron.schedule('0 * * * *', async () => {
  if (!db) return;
  const now = admin.firestore.Timestamp.now();
  const dueSnap = await db.collection('reminders')
    .where('sent','==', false)
    .where('remind_at','<=', now)
    .get();
  for (const doc of dueSnap.docs){
    const r = doc.data();
    const vDoc = await db.collection('vaccines').doc(r.vaccine_id).get();
    const pDoc = await db.collection('pets').doc(r.pet_id).get();
    const v = vDoc.data(); const p = pDoc.data();
    const owner_user_id = r.owner_user_id;
    if (owner_user_id && p && v){
      try{
        await lineClient.pushMessage(owner_user_id, {
          type:'text',
          text:`แจ้งเตือน${r.type} 🐾\n${p.name} ถึงกำหนดวัคซีน ${v.vaccine_name}\nวันที่นัด: ${v.next_due_date}`
        });
        await doc.ref.update({ sent: true });
      }catch(e){ console.error('push error', e?.response?.data || e.message); }
    }
  }
}, { timezone: process.env.TZ || 'Asia/Bangkok' });


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


// -------------------- Start server --------------------
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Server running on', port));
