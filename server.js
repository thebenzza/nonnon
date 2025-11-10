import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { Client, middleware as lineMw } from '@line/bot-sdk';

/**
 * LINE Pet Vaccine Bot — Firebase Firestore + Gemini + Railway
 * ต้องตั้งค่า ENV:
 * - LINE_CHANNEL_SECRET
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - GEMINI_API_KEY   (AI Studio / Generative Language API)
 * - FIREBASE_SERVICE_ACCOUNT  (JSON ทั้งก้อน; private_key มี \\n ได้)
 * - TZ=Asia/Bangkok
 */

// ---------- EXPRESS ----------
const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // เก็บ raw body ไว้ตรวจ LINE signature
}));

// Access log
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
app.get('/version', (_, res) => res.json({ version: 'g-first-1.0.0', time: new Date().toISOString() }));

// ---------- FIREBASE ----------
let db;
(function initFirebaseSafe() {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (svc.private_key && svc.private_key.includes('\\n') === false && svc.private_key.includes('\\\\n')) {
      svc.private_key = svc.private_key.replace(/\\\\n/g, '\n');
    }
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
async function geminiCall(model, contents, genCfg = {}) {
  if (!process.env.GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = { contents, generationConfig: { temperature: 0.2, ...genCfg } };
  try {
    const { data } = await axios.post(url, body, { timeout: 15000 });
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text;
  } catch (e) {
    if (e.response) console.error('Gemini error:', e.response.status, e.response.data);
    else console.error('Gemini error:', e.message);
    return null;
  }
}

// 1) NLU: บังคับตอบ JSON เท่านั้น
async function geminiNLU(userText) {
  const sys = `คุณคือ NLU สำหรับ "บอทวัคซีนสัตว์เลี้ยง" ให้ตอบเป็น JSON เท่านั้น
รูปแบบ:
{"intent":"add_pet|add_vaccine|list_vaccine|help|smalltalk","parameters":{...}}
กติกา:
- add_pet: {"name":"<ชื่อสัตว์>"}
- add_vaccine: {"pet_name":"<ชื่อ>","vaccine_name":"<ชื่อวัคซีน>","last_shot_date":"YYYY-MM-DD","cycle_days":<วัน>}
- list_vaccine: {"pet_name":"<อาจว่างได้>"}
- help / smalltalk: {} 
ห้ามใส่ข้อความอื่นนอกจาก JSON, ห้ามใช้ code block`;
  const text = await geminiCall(
    'gemini-2.5-flash',
    [
      { role: 'user', parts: [{ text: sys }] },
      { role: 'user', parts: [{ text: userText }] }
    ],
    { temperature: 0.1 }
  );
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

// 2) Chat: ให้ช่วยร่างคำตอบไทยสั้นๆ/สุภาพ
async function geminiChat(systemHint, userHint) {
  const text = await geminiCall(
    'gemini-2.5-flash',
    [
      { role: 'user', parts: [{ text: systemHint }] },
      { role: 'user', parts: [{ text: userHint }] }
    ],
    { temperature: 0.4 }
  );
  return text || null;
}

// ---------- RULE-BASED PARSERS (ไทย) ----------
function normalizeDate(input) {
  if (!input) return '';
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;            // YYYY-MM-DD
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // DD/MM/YYYY
  if (m) {
    const d = String(m[1]).padStart(2,'0');
    const mm = String(m[2]).padStart(2,'0');
    const y = m[3];
    return `${y}-${mm}-${d}`;
  }
  return '';
}

function parseAddPet(text) {
  const byKeyword = text.match(/^เพิ่ม(หมา|แมว|สัตว์เลี้ยง)?ชื่อ\s+(.+)$/i);
  if (byKeyword) return { intent: 'add_pet', name: byKeyword[2].trim() };
  const colon = text.match(/^ชื่อ\s*:\s*(.+)$/i);
  if (colon) return { intent: 'add_pet', name: colon[1].trim() };
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

// ---------- Firestore helpers ----------
async function ensureOwner(line_user_id, name='') {
  try {
    if (!db) { db = admin.firestore(); }
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

async function addPet(userId, name) {
  await ensureOwner(userId);
  await db.collection('pets').add({ owner_user_id: userId, name });
}

async function addVaccine(userId, pet_name, vaccine_name, last_shot_date, cycle_days=365) {
  const nextDue = addDays(last_shot_date, cycle_days);
  const vRef = await db.collection('vaccines').add({
    owner_user_id: userId, pet_name, vaccine_name, last_shot_date, next_due_date: nextDue
  });
  // สร้าง reminders D-7 / D-1 / D0 เวลา 09:00 (+7)
  const reminders = db.collection('reminders');
  const d0 = new Date(nextDue + 'T09:00:00+07:00');
  const d1 = new Date(d0.getTime() - 24*60*60*1000);
  const d7 = new Date(d0.getTime() - 7*24*60*60*1000);
  for (const [t, dt] of [['D0', d0], ['D-1', d1], ['D-7', d7]]) {
    await reminders.add({
      owner_user_id: userId,
      vaccine_id: vRef.id,
      pet_name,
      type: t,
      remind_at: admin.firestore.Timestamp.fromDate(dt),
      sent: false
    });
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
      return lineClient.replyMessage(event.replyToken, [{
        type: 'text',
        text: `สวัสดี ${profile.displayName} 🐾 พิมพ์ "เมนู" เพื่อเริ่มใช้งาน`
      }]);
    } catch (e) {
      console.error('follow error', e.message);
      return;
    }
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    console.log('[MSG_IN]', { userId, text });

    // เมนูด่วน
    if (/^เมนู$/i.test(text)) {
      return lineClient.replyMessage(event.replyToken, [{
        type:'text',
        text:'เมนู 🐾\n- เพิ่มสัตว์เลี้ยง: "เพิ่มหมาชื่อ โมจิ"\n- บันทึกวัคซีน: "วัคซีน: Rabies 2025-11-03 365" หรือ "ฉีด Rabies ให้โมจิ 2025-11-03 รอบ 365"\n- ดูวัคซีน: "ดูกำหนดวัคซีน" หรือ "ดูวัคซีนของโมจิ"'
      }]);
    }

    // ลบข้อมูลทั้งหมด (PDPA)
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
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ระบบเชื่อมฐานข้อมูลยังไม่พร้อม กรุณาลองใหม่อีกครั้งครับ/ค่ะ' }]);
    }

    // === 1) ให้ Gemini NLU นำ ===
    let nlu = await geminiNLU(text);

    // === 2) ถ้า NLU ล้ม/ไม่ชัด → rule-based fallback ===
    if (!nlu) {
      const p1 = parseAddPet(text);
      if (p1) nlu = { intent: 'add_pet', parameters: { name: p1.name } };

      const p2 = !nlu && parseAddVaccine(text);
      if (p2) nlu = { intent: 'add_vaccine', parameters: { pet_name: p2.pet, vaccine_name: p2.vaccine, last_shot_date: p2.date, cycle_days: p2.cycle } };

      const p3 = !nlu && parseListVaccine(text);
      if (p3) nlu = { intent: 'list_vaccine', parameters: { pet_name: p3.pet } };
    }

    // === 3) Action ตาม intent แล้วให้ Gemini Chat ช่วยร่างคำตอบ ===
    if (nlu && nlu.intent) {
      try {
        if (nlu.intent === 'add_pet') {
          const name = nlu.parameters?.name;
          if (!name) throw new Error('missing_pet_name');
          await addPet(userId, name);

          const reply = await geminiChat(
            'คุณคือผู้ช่วยเขียนคำตอบสั้นๆ ภาษาไทย สุภาพ กระชับ',
            `ผู้ใช้เพิ่มสัตว์เลี้ยงชื่อ "${name}" สำเร็จ ให้ตอบยืนยันแบบบวก พร้อมแนะนำคำสั่งถัดไปสั้นๆ`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `เพิ่มสัตว์เลี้ยง "${name}" เรียบร้อย ✅` }]);
        }

        if (nlu.intent === 'add_vaccine') {
          const pet = nlu.parameters?.pet_name;
          const vaccine = nlu.parameters?.vaccine_name;
          const date = nlu.parameters?.last_shot_date;
          const cycle = Number(nlu.parameters?.cycle_days || 365);
          if (!vaccine || !date) throw new Error('missing_vaccine_fields');

          let petName = pet;
          if (!petName) {
            const qs = await db.collection('pets').where('owner_user_id','==', userId).orderBy('name').get();
            if (!qs.empty) petName = qs.docs[qs.docs.length-1].data().name;
          }
          if (!petName) throw new Error('no_pet');

          const next = await addVaccine(userId, petName, vaccine, date, cycle);
          const reply = await geminiChat(
            'คุณคือผู้ช่วยเขียนคำตอบสั้นๆ ภาษาไทย สุภาพ กระชับ',
            `ผู้ใช้บันทึกวัคซีนสำเร็จ: สัตว์ "${petName}", วัคซีน "${vaccine}", วันที่ฉีดล่าสุด "${date}", นัดถัดไป "${next}" เขียนยืนยัน + แจ้งว่ามีเตือน D-7/D-1/D0`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `บันทึกวัคซีน ${vaccine} ให้ ${petName} แล้ว ✅ นัดถัดไป: ${next}` }]);
        }

        if (nlu.intent === 'list_vaccine') {
          let petName = nlu.parameters?.pet_name;
          if (!petName) {
            const qs = await db.collection('pets').where('owner_user_id','==', userId).orderBy('name').get();
            if (!qs.empty) petName = qs.docs[qs.docs.length-1].data().name;
          }
          if (!petName) throw new Error('no_pet');

          const vSnap = await db.collection('vaccines')
            .where('owner_user_id','==', userId)
            .where('pet_name','==', petName)
            .get();
          if (vSnap.empty) {
            const none = await geminiChat(
              'คุณคือผู้ช่วยเขียนคำตอบสุภาพ',
              `ยังไม่มีข้อมูลวัคซีนของ "${petName}" แนะนำผู้ใช้วิธีเพิ่มวัคซีนแบบตัวอย่าง 1 บรรทัด`
            );
            return lineClient.replyMessage(event.replyToken, [{ type:'text', text: none || `ยังไม่มีข้อมูลวัคซีนของ ${petName}` }]);
          }
          const lines = vSnap.docs.map(d => {
            const r = d.data();
            return `• ${r.vaccine_name}  ล่าสุด: ${r.last_shot_date||'-'}  นัด: ${r.next_due_date||'-'}`;
          }).join('\n');

          const reply = await geminiChat(
            'คุณคือผู้ช่วยสรุปรายการเป็นภาษาไทย อ่านง่าย',
            `สรุปรายการวัคซีนของ "${petName}" จากข้อมูลต่อไปนี้:\n${lines}\nแปลงเป็นสรุปสั้นๆ ภาษามนุษย์อ่านง่าย`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `กำหนดวัคซีนของ ${petName}\n${lines}` }]);
        }

        if (nlu.intent === 'help' || nlu.intent === 'smalltalk') {
          const reply = await geminiChat(
            'คุณคือผู้ช่วยของบอทวัคซีนสัตว์เลี้ยง ให้คำแนะนำการใช้งาน',
            `เขียนคำตอบสั้นๆ แนะนำคำสั่ง:
- "เพิ่มหมาชื่อ โมจิ"
- "วัคซีน: Rabies 2025-11-03 365"
- "ดูวัคซีนของโมจิ"`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || 'พิมพ์: เมนู เพื่อดูคำสั่งได้เลยครับ/ค่ะ' }]);
        }

      } catch (err) {
        console.error('[NLU-ACTION ERROR]', err.message);
        // ถ้าพังค่อยไป fallback ท้ายสุด
      }
    }

    // === 4) Fallback คู่มือสั้นๆ ===
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

// ตรวจ Signature แบบ raw (debug เท่านั้น)
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

// Debug Firestore (ควรลบทิ้งเมื่อโปรดักชัน)
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

// ---------- CRON: แจ้งเตือน D-7/D-1/D0 ----------
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
        text: `แจ้งเตือน${r.type} 🐾 ถึงกำหนดวัคซีนของ ${r.pet_name}`
      });
      await doc.ref.update({ sent: true });
    } catch (e) { console.error('push error', e.message); }
  }
}, { timezone: process.env.TZ || 'Asia/Bangkok' });

// ---------- START ----------
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Server running on', port));
