import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { Client, middleware as lineMw } from '@line/bot-sdk';
import stream from 'stream';

/**
 * LINE Pet Vaccine Bot — "น้อนน้อน" (Firebase Firestore + Gemini + Railway)
 * ENV ที่ต้องมี:
 * - LINE_CHANNEL_SECRET
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - GEMINI_API_KEY  (AI Studio / Generative Language API)
 * - FIREBASE_SERVICE_ACCOUNT  (JSON ทั้งก้อน; private_key มี \\n ได้)
 * - TZ=Asia/Bangkok
 * (ออปชันเก็บรูป) FIREBASE_STORAGE_BUCKET = <project-id>.appspot.com
 */

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // เก็บ raw body สำหรับตรวจลายเซ็น
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

app.get('/', (_, res) => res.send('น้อนน้อนพร้อมช่วยบันทึกวัคซีน/การรักษาน้อง ๆ แล้วครับ/ค่ะ 🐾'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/version', (_, res) => res.json({ version: 'noonnon-2.0.0', time: new Date().toISOString() }));

// ---------- FIREBASE ----------
let db, bucket = null;
(function initFirebaseSafe() {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (svc.private_key && svc.private_key.includes('\\n') === false && svc.private_key.includes('\\\\n')) {
      svc.private_key = svc.private_key.replace(/\\\\n/g, '\n');
    }
    const opts = { credential: admin.credential.cert(svc) };
    if (process.env.FIREBASE_STORAGE_BUCKET) {
      opts.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
    }
    admin.initializeApp(opts);
    db = admin.firestore();
    if (process.env.FIREBASE_STORAGE_BUCKET) bucket = admin.storage().bucket();
    console.log('Firebase initialized', bucket ? '(+Storage)' : '');
  } catch (e) {
    console.error('[FIREBASE_INIT_ERROR]', e.message);
  }
})();

// ---------- LINE ----------
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new Client(lineConfig);

// ---------- GEMINI ----------
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

// NLU: ขยาย intents สำหรับสัตว์/วัคซีน/การรักษา/รูป
async function geminiNLU(userText) {
  const sys = `คุณคือ NLU สำหรับ "น้อนน้อน" ผู้ช่วยจดข้อมูลสัตว์เลี้ยง ให้ตอบเป็น JSON "เท่านั้น"
รูปแบบ:
{"intent":"add_pet|add_pet_details|add_vaccine|list_vaccine|add_treatment|list_treatments|help|smalltalk","parameters":{...}}
กติกา:
- add_pet: {"name":"<ชื่อ>"}  (ถ้าเจอประเภท/เพศ/พันธุ์/วันเกิด ก็ใส่ใน fields เดียวกับ add_pet_details ได้)
- add_pet_details: {"name":"<ชื่อ>","species":"dog|cat|other","breed":"<พันธุ์>","sex":"male|female|unknown","birthdate":"YYYY-MM-DD","photo_url":"<url|optional>"}
- add_vaccine: {"pet_name":"<ชื่อ>","vaccine_name":"<ชื่อวัคซีน>","last_shot_date":"YYYY-MM-DD","cycle_days":<วัน>}
- list_vaccine: {"pet_name":"<อาจว่างได้>"}
- add_treatment: {"pet_name":"<ชื่อ>","diagnosis":"<โรค>","hospital":"<โรงพยาบาล>","date":"YYYY-MM-DD","note":"<ข้อความ|optional>"}
- list_treatments: {"pet_name":"<อาจว่างได้>"}
- help/smalltalk: {}
ห้ามตอบอย่างอื่น นอกจาก JSON เดียว ไม่มีโค้ดบล็อก ไม่มีคำอธิบาย`;
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

// Chat: ให้ช่วยเขียนคำตอบไทยสั้นๆ
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

// ---------- Utils & Parsers ----------
function normalizeDate(input) {
  if (!input) return '';
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = String(m[1]).padStart(2,'0');
    const mm = String(m[2]).padStart(2,'0');
    const y = m[3];
    return `${y}-${mm}-${d}`;
  }
  return '';
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00+07:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0,10);
}

// ---------- Firestore helpers ----------
async function ensureOwner(line_user_id, name='') {
  try {
    const ref = db.collection('owners').doc(line_user_id);
    const snap = await ref.get();
    if (!snap.exists) await ref.set({ display_name: name, consent_pdpa_at: admin.firestore.Timestamp.now() });
    return true;
  } catch (err) {
    console.error('[ensureOwner ERROR]', err.message);
    return false;
  }
}

async function addOrUpdatePet(userId, payload) {
  // payload: { name, species, breed, sex, birthdate, photo_url }
  if (!payload?.name) throw new Error('missing_pet_name');
  const q = await db.collection('pets')
    .where('owner_user_id','==', userId)
    .where('name','==', payload.name)
    .limit(1).get();
  const base = {
    owner_user_id: userId,
    name: payload.name,
    species: payload.species || null,
    breed: payload.breed || null,
    sex: payload.sex || 'unknown',
    birthdate: payload.birthdate || null,
    photo_url: payload.photo_url || null,
    updated_at: admin.firestore.Timestamp.now()
  };
  if (q.empty) {
    await db.collection('pets').add({ ...base, created_at: admin.firestore.Timestamp.now() });
  } else {
    await q.docs[0].ref.set(base, { merge: true });
  }
}

async function addVaccine(userId, pet_name, vaccine_name, last_shot_date, cycle_days=365) {
  const nextDue = addDays(last_shot_date, cycle_days);
  const vRef = await db.collection('vaccines').add({
    owner_user_id: userId, pet_name, vaccine_name, last_shot_date, next_due_date: nextDue,
    created_at: admin.firestore.Timestamp.now()
  });
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

async function addTreatment(userId, payload) {
  // { pet_name, diagnosis, hospital, date, note }
  if (!payload?.pet_name) throw new Error('missing_pet_name');
  const date = payload.date ? normalizeDate(payload.date) : null;
  await db.collection('treatments').add({
    owner_user_id: userId,
    pet_name: payload.pet_name,
    diagnosis: payload.diagnosis || null,
    hospital: payload.hospital || null,
    date,
    note: payload.note || null,
    created_at: admin.firestore.Timestamp.now()
  });
}

// เลือกสัตว์ตัวล่าสุด (ถ้าไม่ได้ระบุ)
async function getLastPetName(userId) {
  const qs = await db.collection('pets').where('owner_user_id','==', userId).orderBy('name').get();
  if (qs.empty) return null;
  return qs.docs[qs.docs.length - 1].data().name || null;
}

// ---------- Sessions (สำหรับรอรูป/ถามต่อ) ----------
async function setSession(userId, data) {
  await db.collection('sessions').doc(userId).set({ ...data, updated_at: admin.firestore.Timestamp.now() }, { merge: true });
}
async function getSession(userId) {
  const snap = await db.collection('sessions').doc(userId).get();
  return snap.exists ? snap.data() : null;
}
async function clearSession(userId) {
  await db.collection('sessions').doc(userId).delete().catch(()=>{});
}

// ---------- LINE Handlers ----------
async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  // ต้อนรับแบบ "น้อนน้อน"
  if (event.type === 'follow') {
    try {
      const profile = await lineClient.getProfile(userId);
      await ensureOwner(userId, profile.displayName);
      const msg = `สวัสดีคุณ${profile.displayName} 🐾\nหนูชื่อ “น้อนน้อน” ผู้ช่วยจดข้อมูลสัตว์เลี้ยงค่ะ/ครับ\nพร้อมช่วยบันทึกประวัติ, วัคซีน, และการรักษาให้น้อง ๆ เสมอ!\n\nเริ่มได้เลย เช่น:\n• เพิ่มหมาชื่อ โมจิ เพศผู้ เกิด 2023-04-01 พันธุ์ปอม\n• วัคซีน: Rabies 2025-11-03 365\n• บันทึกการรักษา โมจิ โรคผิวหนัง รพ.สัตว์บางรัก 2025-11-01`;
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: msg }]);
    } catch (e) {
      console.error('follow error', e.message);
      return;
    }
  }

  // รูปภาพ: ใช้กับ workflow อัปโหลดรูปสัตว์
  if (event.type === 'message' && event.message.type === 'image') {
    const sess = await getSession(userId);
    if (!sess || sess.expect !== 'pet_photo') {
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'รับรูปแล้วครับ/ค่ะ หากต้องการตั้งเป็นรูปประจำตัวน้อง ให้พิมพ์: เพิ่มรูปให้{ชื่อน้อง} แล้วส่งรูปอีกครั้ง' }]);
    }
    try {
      const contentStream = await lineClient.getMessageContent(event.message.id);
      const chunks = [];
      await new Promise((resolve, reject) => {
        contentStream.on('data', (c) => chunks.push(c));
        contentStream.on('end', resolve);
        contentStream.on('error', reject);
      });
      const buf = Buffer.concat(chunks);

      let photoURL = null;
      if (bucket) {
        const filename = `pets/${userId}/${sess.pet_name}_${Date.now()}.jpg`;
        const file = bucket.file(filename);
        await file.save(buf, { contentType: 'image/jpeg', resumable: false, public: true });
        await file.makePublic().catch(()=>{});
        photoURL = `https://storage.googleapis.com/${bucket.name}/${filename}`;
      }

      // อัปเดตรูปให้สัตว์ตัวนั้น
      await addOrUpdatePet(userId, { name: sess.pet_name, photo_url: photoURL || '(stored-local)' });
      await clearSession(userId);

      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: `บันทึกรูปของ "${sess.pet_name}" เรียบร้อยแล้ว ✅` }]);
    } catch (e) {
      console.error('image save error', e.message);
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ขอโทษด้วย บันทึกรูปไม่สำเร็จ ลองใหม่อีกครั้งได้ครับ/ค่ะ' }]);
    }
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    await ensureOwner(userId);

    // เมนู/ช่วยเหลือด่วน
    if (/^เมนู$|^ช่วยเหลือ$/i.test(text)) {
      const t = `เมนูของน้อนน้อน 🐾\n• เพิ่มสัตว์เลี้ยง: "เพิ่มแมวชื่อ ชูครีม เพศเมีย พันธุ์สก็อตติช เกิด 2024-02-10"\n• เพิ่มรูปสัตว์: "เพิ่มรูปให้ชูครีม" แล้วส่งรูป\n• บันทึกวัคซีน: "วัคซีน: Rabies 2025-11-03 365"\n• ดูวัคซีน: "ดูวัคซีนของชูครีม"\n• บันทึกการรักษา: "บันทึกการรักษา ชูครีม โรคผิวหนัง รพ.สัตว์A 2025-10-01 หมายเหตุ: ให้ยาทา"\n• ดูประวัติรักษา: "ดูการรักษาของชูครีม"\n• ลบข้อมูล ทั้งหมด: "ลบข้อมูล"`;
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: t }]);
    }

    // ลบข้อมูลทั้งหมด (PDPA)
    if (/^ลบข้อมูล$/i.test(text)) {
      try {
        const ownerId = userId;
        const delCol = async (col) => {
          const snap = await db.collection(col).where('owner_user_id','==', ownerId).get();
          const batch = db.batch();
          snap.forEach(d => batch.delete(d.ref));
          await batch.commit();
        };
        await Promise.all([delCol('reminders'), delCol('vaccines'), delCol('pets'), delCol('treatments')]);
        await db.collection('owners').doc(ownerId).delete().catch(()=>{});
        await clearSession(userId);
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ลบข้อมูลทั้งหมดของคุณเรียบร้อยแล้ว ✅' }]);
      } catch (e) {
        console.error('delete all error', e.message);
        return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'ลบข้อมูลไม่สำเร็จ กรุณาลองใหม่ครับ/ค่ะ' }]);
      }
    }

    // คำสั่งเพิ่มรูป: "เพิ่มรูปให้โมจิ"
    const addPhotoCmd = text.match(/^เพิ่มรูปให้(.+)$/i);
    if (addPhotoCmd) {
      const petName = addPhotoCmd[1].trim();
      await setSession(userId, { expect: 'pet_photo', pet_name: petName });
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`โอเค ส่งรูปของ "${petName}" มาได้เลยครับ/ค่ะ` }]);
    }

    // === NLU นำ ===
    let nlu = await geminiNLU(text);

    // ถ้า NLU ไม่ชัด ลอง rule-based เบื้องต้น
    if (!nlu) {
      // ตัวอย่างง่าย: วัคซีน: Rabies 2025-11-03 365
      const vx = text.match(/^วัคซีน\s*:\s*([^\s]+)\s+([^\s]+)\s+(\d{2,4})$/i);
      if (vx) {
        nlu = { intent: 'add_vaccine', parameters: {
          pet_name: null, vaccine_name: vx[1], last_shot_date: normalizeDate(vx[2]), cycle_days: parseInt(vx[3],10)||365
        }};
      }
      // “ดูวัคซีนของโมจิ”
      if (!nlu && /^ดู(กำหนด)?วัคซีน(?:ของ(.+))?$/i.test(text)) {
        const m = text.match(/^ดู(?:กำหนด)?วัคซีน(?:ของ(.+))?$/i);
        nlu = { intent: 'list_vaccine', parameters: { pet_name: (m && m[1]) ? m[1].trim() : null } };
      }
      // “บันทึกการรักษา ชื่อ โรค โรงพยาบาล วันที่ … หมายเหตุ: …”
      if (!nlu && /^บันทึกการรักษา\s+(.+)$/i.test(text)) {
        // โครงสร้างแบบหลวม ๆ: บันทึกการรักษา {ชื่อ} {โรค} {รพ.} {YYYY-MM-DD} [หมายเหตุ: ...]
        const raw = text.replace(/^บันทึกการรักษา\s+/i,'').trim();
        const noteMatch = raw.match(/หมายเหตุ\s*:\s*(.+)$/i);
        const note = noteMatch ? noteMatch[1].trim() : null;
        const main = raw.replace(/หมายเหตุ\s*:.+$/i,'').trim().split(/\s+/);
        if (main.length >= 4) {
          nlu = { intent: 'add_treatment', parameters: {
            pet_name: main[0], diagnosis: main[1], hospital: main[2], date: normalizeDate(main[3]), note
          }};
        }
      }
    }

    // จัดการตาม intent
    if (nlu && nlu.intent) {
      try {
        // เพิ่มสัตว์แบบเบื้องต้น (แนะถามต่อให้ครบ)
        if (nlu.intent === 'add_pet') {
          const name = nlu.parameters?.name;
          if (!name) throw new Error('missing_pet_name');
          await addOrUpdatePet(userId, { name, sex: 'unknown' });

          const reply = await geminiChat(
            'คุณคือน้อนน้อน พูดสุภาพ เป็นกันเอง',
            `ผู้ใช้เพิ่มสัตว์เลี้ยงชื่อ "${name}" แล้ว แต่ยังไม่ครบ ให้คุณชวนถามต่อว่าเป็นสัตว์อะไร (สุนัข/แมว/อื่นๆ), เพศอะไร, พันธุ์อะไร, วันเกิดเมื่อไหร่ และแนะนำ "ส่งรูป" ได้ด้วย`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `เพิ่ม "${name}" แล้วครับ/ค่ะ — บอกน้อนน้อนเพิ่มได้ว่าพันธุ์/เพศ/วันเกิด และสามารถ "เพิ่มรูปให้${name}" ได้ด้วยนะ` }]);
        }

        // เพิ่ม/อัปเดตรายละเอียดสัตว์ (ครบหรือบางส่วน)
        if (nlu.intent === 'add_pet_details') {
          const p = nlu.parameters || {};
          if (!p.name) throw new Error('missing_pet_name');
          // ปกติถ้าให้มาไม่ครบ เราก็บันทึกเท่าที่ได้
          await addOrUpdatePet(userId, {
            name: p.name,
            species: p.species || null,
            breed: p.breed || null,
            sex: p.sex || 'unknown',
            birthdate: p.birthdate ? normalizeDate(p.birthdate) : null,
            photo_url: p.photo_url || null
          });
          const missing = [];
          if (!p.species) missing.push('ประเภทสัตว์');
          if (!p.sex) missing.push('เพศ');
          if (!p.breed) missing.push('พันธุ์');
          if (!p.birthdate) missing.push('วันเกิด');
          const hint = missing.length ? `ยังขาด: ${missing.join(', ')} (ใส่เพิ่มได้ทีหลัง)` : 'ครบถ้วนแล้ว';
          const reply = await geminiChat(
            'คุณคือน้อนน้อน พูดสุภาพ สั้น กระชับ',
            `บันทึกข้อมูลสัตว์สำเร็จ: ชื่อ "${p.name}". แจ้งสถานะ "${hint}". ถ้ายังไม่มีรูป แนะนำ "เพิ่มรูปให้${p.name}" แล้วให้ส่งรูปเข้ามา`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `อัปเดตข้อมูล "${p.name}" เรียบร้อย ✅ ${hint}` }]);
        }

        // วัคซีน
        if (nlu.intent === 'add_vaccine') {
          const pet = nlu.parameters?.pet_name || await getLastPetName(userId);
          const vaccine = nlu.parameters?.vaccine_name;
          const date = normalizeDate(nlu.parameters?.last_shot_date || '');
          const cycle = Number(nlu.parameters?.cycle_days || 365);
          if (!pet) throw new Error('no_pet');
          if (!vaccine || !date) throw new Error('missing_vaccine_fields');

          const next = await addVaccine(userId, pet, vaccine, date, cycle);
          const reply = await geminiChat(
            'คุณคือน้อนน้อน ผู้ช่วยจดวัคซีน',
            `บันทึกวัคซีนให้ "${pet}": ${vaccine}, ล่าสุด ${date}, นัดถัดไป ${next}. แจ้งผู้ใช้ว่าจะเตือน D-7/D-1/วันนัด`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `บันทึกวัคซีน ${vaccine} ให้ ${pet} แล้ว ✅ นัดถัดไป: ${next} (น้อนน้อนจะเตือนล่วงหน้าให้นะ)` }]);
        }

        if (nlu.intent === 'list_vaccine') {
          let pet = nlu.parameters?.pet_name || await getLastPetName(userId);
          if (!pet) throw new Error('no_pet');
          const vSnap = await db.collection('vaccines').where('owner_user_id','==', userId).where('pet_name','==', pet).get();
          if (vSnap.empty) return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`ยังไม่มีข้อมูลวัคซีนของ ${pet}` }]);
          const lines = vSnap.docs.map(d => {
            const r = d.data();
            return `• ${r.vaccine_name}  ล่าสุด: ${r.last_shot_date||'-'}  นัด: ${r.next_due_date||'-'}`;
          }).join('\n');
          const reply = await geminiChat('คุณคือน้อนน้อน ช่วยสรุปไทยอ่านง่าย', `สรุปวัคซีนของ "${pet}":\n${lines}`);
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `วัคซีนของ ${pet}\n${lines}` }]);
        }

        // การรักษา
        if (nlu.intent === 'add_treatment') {
          const p = nlu.parameters || {};
          const pet = p.pet_name || await getLastPetName(userId);
          if (!pet) throw new Error('no_pet');
          await addTreatment(userId, {
            pet_name: pet,
            diagnosis: p.diagnosis || null,
            hospital: p.hospital || null,
            date: p.date ? normalizeDate(p.date) : null,
            note: p.note || null
          });
          const reply = await geminiChat(
            'คุณคือน้อนน้อน ผู้ช่วยจดประวัติรักษา',
            `บันทึกการรักษาของ "${pet}" แล้ว รายละเอียด: โรค=${p.diagnosis||'-'}, โรงพยาบาล=${p.hospital||'-'}, วันที่=${p.date||'-'}. ให้พูดสุภาพและชวนให้กรอกข้อมูลเพิ่มเติมได้ภายหลัง`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `บันทึกการรักษาของ ${pet} แล้ว ✅` }]);
        }

        if (nlu.intent === 'list_treatments') {
          let pet = nlu.parameters?.pet_name || await getLastPetName(userId);
          if (!pet) throw new Error('no_pet');
          const tSnap = await db.collection('treatments').where('owner_user_id','==', userId).where('pet_name','==', pet).orderBy('created_at','desc').limit(10).get();
          if (tSnap.empty) return lineClient.replyMessage(event.replyToken, [{ type:'text', text:`ยังไม่มีประวัติการรักษาของ ${pet}` }]);
          const lines = tSnap.docs.map(d => {
            const r = d.data();
            return `• ${r.date||'-'}: ${r.diagnosis||'-'} @${r.hospital||'-'} ${r.note?'- '+r.note:''}`;
          }).join('\n');
          const reply = await geminiChat('คุณคือน้อนน้อน ช่วยสรุปไทยอ่านง่าย', `สรุปการรักษาของ "${pet}":\n${lines}`);
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || `ประวัติรักษาของ ${pet}\n${lines}` }]);
        }

        if (nlu.intent === 'help' || nlu.intent === 'smalltalk') {
          const reply = await geminiChat(
            'คุณคือน้อนน้อน แนะนำการใช้งานสั้นๆ',
            `สอนผู้ใช้ด้วยตัวอย่าง: 
- เพิ่มแมวชื่อ ชูครีม เพศเมีย พันธุ์สก็อตติช เกิด 2024-02-10
- เพิ่มรูปให้ชูครีม (แล้วส่งรูป)
- วัคซีน: Rabies 2025-11-03 365
- บันทึกการรักษา ชูครีม โรคผิวหนัง รพ.สัตว์A 2025-10-01 หมายเหตุ: ให้ยาทา`
          );
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text: reply || 'พิมพ์ "เมนู" เพื่อดูคำสั่งตัวอย่างได้เลยครับ/ค่ะ' }]);
        }

      } catch (err) {
        console.error('[INTENT ERROR]', err.message);
        // ไป fallback ด้านล่าง
      }
    }

    // Fallback
    const fb = `น้อนน้อนแนะนำตัวอย่างนะคะ/ครับ 🐾
• เพิ่มแมวชื่อ ชูครีม เพศเมีย พันธุ์สก็อตติช เกิด 2024-02-10
• เพิ่มรูปให้ชูครีม  (แล้วส่งรูปมา)
• วัคซีน: Rabies 2025-11-03 365
• ดูวัคซีนของชูครีม
• บันทึกการรักษา ชูครีม โรคผิวหนัง รพ.สัตว์A 2025-10-01 หมายเหตุ: ให้ยาทา`;
    return lineClient.replyMessage(event.replyToken, [{ type:'text', text: fb }]);
  }
}

// ---------- Routes ----------
app.post('/webhook', lineMw(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// ตรวจลายเซ็น (debug)
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

// Debug Firestore
app.get('/debug/firestore', async (req, res) => {
  try {
    const doc = await db.collection('ping').add({ ts: Date.now() });
    res.status(200).json({ ok: true, id: doc.id });
  } catch (e) {
    console.error('[DEBUG_FIRESTORE]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- CRON: แจ้งเตือนวัคซีน ----------
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
