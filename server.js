// version: 1.3.0 — 2025-11-12T16:00+07:001
// server.js — Nonnon (น้อนน้อน) LINE Bot with Firebase + Gemini Planner (No-Keyword)
// Node >= 18, package.json should include: "type":"module"
// ENV required:
// - PORT (default 8080)
// - TZ=Asia/Bangkok
// - LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
// - GEMINI_API_KEY  (from Google AI Studio)
// - FIREBASE_SERVICE_ACCOUNT (JSON string for service account; keep newlines or escaped \n)
// Optional:
// - LOG_LEVEL (info|debug)

import express from 'express';
import crypto from 'crypto';
import { middleware as lineMw, Client as LineClient } from '@line/bot-sdk';
import admin from 'firebase-admin';

// --- Config ---
const cfg = {
  port: Number(process.env.PORT || 8080),
  tz: process.env.TZ || 'Asia/Bangkok',
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    defaultModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash', // fast & capable; switch to pro when needed
  },
  log: process.env.LOG_LEVEL || 'info',
};

function log(...args){ if (cfg.log !== 'silent') console.log(...args); }
function logErr(...args){ console.error(...args); }

// --- Firebase Admin init ---
let firebaseInit = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing');
  const json = JSON.parse(
    raw
      .replace(/^\uFEFF/, '') // strip BOM
      .replace(/\n/g, '\n')   // keep escaped newlines
  );
  admin.initializeApp({
    credential: admin.credential.cert(json),
    storageBucket: json.project_id ? `${json.project_id}.appspot.com` : undefined,
  });
  firebaseInit = true;
  log('Firebase initialized');
} catch (e) {
  logErr('[FIREBASE_INIT_ERROR]', e.message);
}

const db = firebaseInit ? admin.firestore() : null;

// --- LINE client ---
const lineClient = new LineClient({
  channelAccessToken: cfg.line.channelAccessToken,
  channelSecret: cfg.line.channelSecret,
});

// --- Express ---
const app = express();
app.set('trust proxy', true);

// Minimal health
app.get('/', (_req, res) => res.send('Nonnon Pet Bot OK'));
app.get('/debug/version', (_req, res) => res.json({ ok:true, version: '1.3.0', model: cfg.gemini.defaultModel, tz: cfg.tz }));

// Debug Firestore
app.get('/debug/firestore', async (_req, res) => {
  try {
    if (!db) return res.status(500).json({ ok:false, error:'NO_DB' });
    const doc = await db.collection('debug').add({ at: admin.firestore.Timestamp.now() });
    return res.json({ ok:true, id: doc.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// --- LINE Webhook (recommended) ---
// Use official middleware to validate signature + parse JSON
app.post('/webhook', lineMw(cfg.line), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// --- Optional: Raw webhook for manual signature testing ---
app.use('/webhook-raw', express.raw({ type: '*/*' }));
app.post('/webhook-raw', async (req, res) => {
  try {
    const signature = req.get('x-line-signature');
    const hmac = crypto.createHmac('sha256', cfg.line.channelSecret);
    hmac.update(req.body);
    const digest = hmac.digest('base64');
    if (digest !== signature) throw new Error('Signature mismatch');

    const body = JSON.parse(req.body.toString('utf8'));
    const events = body.events || [];
    await Promise.all(events.map(handleEvent));
    return res.status(200).end();
  } catch (e) {
    logErr('[SIGCHECK_ERROR]', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// --- Utilities ---
function todayYMD(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function addDays(dateStr, days){
  const dt = new Date(`${dateStr}T00:00:00+07:00`);
  dt.setDate(dt.getDate() + Number(days || 0));
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const d = String(dt.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function normalizeDate(s){
  if (!s) return null;
  // allow DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)){
    const [d,m,y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  // allow YYYY.MM.DD or YYYY/MM/DD
  return s.replace(/\./g,'-').replace(/\//g,'-');
}

async function ensureOwner(userId, displayName){
  const ref = db.collection('owners');
  const snap = await ref.where('line_user_id','==', userId).limit(1).get();
  if (snap.empty){
    await ref.add({
      line_user_id: userId,
      display_name: displayName || null,
      consent_pdpa_at: admin.firestore.Timestamp.now(),
      created_at: admin.firestore.Timestamp.now(),
    });
  }
}

async function getLastPetName(userId){
  const q = await db.collection('pets')
    .where('owner_user_id','==', userId)
    .orderBy('updated_at','desc')
    .limit(1).get();
  if (q.empty) return null;
  return q.docs[0].data().name;
}

async function setSession(userId, obj){
  await db.collection('sessions').doc(userId).set({ ...obj, updated_at: admin.firestore.Timestamp.now() }, { merge: true });
}
async function getSession(userId){
  const d = await db.collection('sessions').doc(userId).get();
  return d.exists ? d.data() : null;
}

// --- Firestore helpers (schema expanded) ---
async function upsertPetProfile(userId, p){
  if (!p?.pet_name && !p?.name) throw new Error('missing_pet_name');
  const name = p.pet_name || p.name;
  const ref = db.collection('pets');
  const q = await ref.where('owner_user_id','==', userId).where('name','==', name).limit(1).get();
  const doc = {
    owner_user_id: userId,
    name,
    species: p.species || null,
    breed: p.breed || null,
    sex: p.sex || 'unknown',
    birthdate: p.birthdate || null,
    neutered: typeof p.neutered === 'boolean' ? p.neutered : null,
    color_markings: p.color_markings || null,
    microchip_id: p.microchip_id || null,
    license_tag: p.license_tag || null,
    adoption_date: p.adoption_date || null,
    profile_photo_url: p.photo_url || p.profile_photo_url || null,
    updated_at: admin.firestore.Timestamp.now()
  };
  if (q.empty){
    await ref.add({ ...doc, created_at: admin.firestore.Timestamp.now() });
  } else {
    await q.docs[0].ref.set(doc, { merge: true });
  }
}

async function addVaccine(userId, petName, vaccineName, lastDate, cycleDays){
  const next = addDays(lastDate, Number(cycleDays || 365));
  await db.collection('vaccines').add({
    owner_user_id: userId,
    pet_name: petName,
    vaccine_name: vaccineName,
    last_shot_date: lastDate,
    next_due_date: next,
    created_at: admin.firestore.Timestamp.now(),
  });
  // create reminders D-7, D-1, D0 (09:00)
  const toIsoAt = (ymd, hhmm='09:00') => new Date(`${ymd}T${hhmm}:00+07:00`).toISOString();
  const d0 = toIsoAt(next);
  const d1 = new Date(new Date(d0).getTime() - 24*60*60*1000).toISOString();
  const d7 = new Date(new Date(d0).getTime() - 7*24*60*60*1000).toISOString();
  const addReminder = (type, at) => db.collection('reminders').add({
    owner_user_id: userId,
    pet_name: petName,
    type, remind_at: at, sent: false,
    created_at: admin.firestore.Timestamp.now(),
  });
  await Promise.all([
    addReminder('D-7', d7),
    addReminder('D-1', d1),
    addReminder('D0', d0),
  ]);
  return next;
}

async function addParasite(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.type || !p.product_name || !p.given_date) throw new Error('missing_parasite_fields');
  const next = p.next_due_date || (p.cycle_days ? addDays(p.given_date, Number(p.cycle_days)) : null);
  await db.collection('parasite_prevention').add({
    owner_user_id: userId,
    pet_name: pet,
    type: p.type,
    product_name: p.product_name,
    given_date: p.given_date,
    next_due_date: next,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
  return next;
}

async function addAllergy(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.type || !p.name) throw new Error('missing_allergy_fields');
  await db.collection('allergies').add({
    owner_user_id: userId,
    pet_name: pet,
    type: p.type,
    name: p.name,
    severity: p.severity || null,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addVet(userId, p){
  if (!p.clinic_name && !p.doctor_name) throw new Error('missing_vet_fields');
  await db.collection('vets').add({
    owner_user_id: userId,
    clinic_name: p.clinic_name || null,
    doctor_name: p.doctor_name || null,
    phone: p.phone || null,
    address: p.address || null,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addMedicalHistory(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.title || !p.date) throw new Error('missing_medhist_fields');
  await db.collection('medical_history').add({
    owner_user_id: userId,
    pet_name: pet,
    title: p.title,
    date: p.date,
    hospital: p.hospital || null,
    details: p.details || null,
    attachments: p.attachments || [],
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addMedication(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.drug_name) throw new Error('missing_medication_fields');
  await db.collection('medications').add({
    owner_user_id: userId,
    pet_name: pet,
    drug_name: p.drug_name,
    dosage: p.dosage || null,
    frequency: p.frequency || null,
    start_date: p.start_date || null,
    end_date: p.end_date || null,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addWeight(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.date || typeof p.weight_kg !== 'number') throw new Error('missing_weight_fields');
  await db.collection('weights').add({
    owner_user_id: userId,
    pet_name: pet,
    date: p.date,
    weight_kg: p.weight_kg,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function setFeeding(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet) throw new Error('missing_pet_name');
  await db.collection('feeding_schedules').add({
    owner_user_id: userId,
    pet_name: pet,
    brand: p.brand || null,
    type: p.type || null,
    amount: p.amount || null,
    times: p.times || [],
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addExercise(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.date) throw new Error('missing_exercise_fields');
  await db.collection('exercise_logs').add({
    owner_user_id: userId,
    pet_name: pet,
    date: p.date,
    duration_min: Number(p.duration_min || 0),
    distance_km: p.distance_km != null ? Number(p.distance_km) : null,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function setGrooming(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.type) throw new Error('missing_grooming_fields');
  await db.collection('grooming_schedules').add({
    owner_user_id: userId,
    pet_name: pet,
    type: p.type,
    last_date: p.last_date || null,
    next_due_date: p.next_due_date || null,
    vendor: p.vendor || null,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addDiary(userId, p){
  const pet = p.pet_name || await getLastPetName(userId);
  if (!pet || !p.date || !p.note) throw new Error('missing_diary_fields');
  await db.collection('behavior_diary').add({
    owner_user_id: userId,
    pet_name: pet,
    date: p.date,
    note: p.note,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addDocument(userId, p){
  if (!p.doc_type || !p.file_url) throw new Error('missing_document_fields');
  await db.collection('documents').add({
    owner_user_id: userId,
    pet_name: p.pet_name || null,
    doc_type: p.doc_type,
    title: p.title || null,
    file_url: p.file_url,
    created_at: admin.firestore.Timestamp.now(),
  });
}

async function addContact(userId, p){
  if (!p.type || !p.name || !p.phone) throw new Error('missing_contact_fields');
  await db.collection('owner_contacts').add({
    owner_user_id: userId,
    type: p.type,
    name: p.name,
    phone: p.phone,
    relation: p.relation || null,
    address: p.address || null,
    note: p.note || null,
    created_at: admin.firestore.Timestamp.now(),
  });
}

// --- Gemini Calls ---
async function geminiCall(model, messages, genConfig={}){
  // messages: [{role:'user'|'model'|'system', parts:[{text:string}]}]
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.gemini.apiKey}`;
  const body = {
    contents: messages.map(m => ({ role: m.role === 'system' ? 'user' : m.role, parts: m.parts })),
    safetySettings: [],
    generationConfig: {
      temperature: genConfig.temperature ?? 0.2,
      topP: genConfig.topP ?? 0.95,
      topK: genConfig.topK ?? 64,
      maxOutputTokens: genConfig.maxOutputTokens ?? 1024,
    }
  };
  const res = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok){
    const txt = await res.text().catch(()=> '');
    throw new Error(`Gemini HTTP ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return text.trim();
}

async function geminiChat(systemText, userText, model = cfg.gemini.defaultModel){
  try{
    const out = await geminiCall(model, [
      { role: 'user', parts: [{ text: `SYSTEM:\n${systemText}` }]},
      { role: 'user', parts: [{ text: userText }]} 
    ]);
    return out;
  }catch(e){ logErr('Gemini parse error:', e.message); return null; }
}

async function geminiPlanner(userText, context={}){
  const sys = `คุณคือ \"น้อนน้อน Planner\" วางแผนการทำงานสำหรับบอทสัตว์เลี้ยง\n- ตอบเป็น JSON เดียวเท่านั้น (ไม่มี code block/คำบรรยาย)\n- ถ้าข้อมูลไม่พอให้ถามต่อใน \"followup_question\"\n- ถ้ามั่นใจ < 0.6 ให้ถามยืนยันก่อนลงมือ\n- ใช้ actions จากชุดนี้เท่านั้น: add_pet, upsert_pet, add_vaccine, list_vaccine, add_parasite_prevention, list_parasite_prevention, add_allergy, list_allergies, add_vet, list_vets, add_medical_history, list_medical_history, add_medication, list_medications, add_weight, list_weights, set_feeding, list_feeding, add_exercise, list_exercise, set_grooming, list_grooming, add_diary, list_diary, add_document, list_documents, add_contact, list_contacts, ask_health, reply\nสคีมาตัวอย่าง: {\"confidence\":0.85,\"reply_hint\":\"...\", \"followup_question\":null, \"actions\":[{\"type\":\"upsert_pet\",\"params\":{\"pet_name\":\"โมจิ\",\"species\":\"dog\"}}]}\nบริบท (JSON): ${JSON.stringify(context).slice(0,1800)}`;

  const out = await geminiChat(sys, userText);
  if (!out) return null;
  const cleaned = out.replace(/```json|```/g,'').trim();
  try{ return JSON.parse(cleaned); }catch{ return null; }
}

// --- LINE Event Handler ---
async function handleEvent(event){
  const userId = event.source?.userId;
  if (!userId) return;

  // follow: welcome
  if (event.type === 'follow'){
    try{
      const profile = await lineClient.getProfile(userId).catch(()=>({ displayName: 'คุณ' }));
      await ensureOwner(userId, profile.displayName);
      const welcome = `สวัสดี ${profile.displayName}! ผมชื่อ \"น้อนน้อน\" 🐾\nผู้ช่วยจดข้อมูลสัตว์เลี้ยงของคุณ\nคุณสามารถพิมพ์ได้เลย เช่น\n- เพิ่มโปรไฟล์หมาชื่อโมจิ เพศผู้ พันธุ์ปอม เกิด 2023-04-01\n- ฉีดวัคซีน Rabies ให้โมจิ วันนี้ นัดอีก 365 วัน\n- ตั้งตารางให้อาหาร 08:00 และ 18:00\n- บันทึกน้ำหนัก 3.4 กก. วันนี้`;
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: welcome }]);
    }catch(e){ logErr('follow error', e.message); }
  }

  // message: text — Gemini-first planner
  if (event.type === 'message' && event.message?.type === 'text'){
    const text = (event.message.text || '').trim();

    // simple menu
    if (/^เมนู$/i.test(text)){
      const menu = 'เมนู 🐾\n- เพิ่มสัตว์เลี้ยง\n- บันทึกวัคซีน\n- ดูวัคซีน\n- บันทึก/ดูสุขภาพอื่นๆ (เห็บหมัด หนอนหัวใจ แพ้ ผ่าตัด ยาประจำ น้ำหนัก)\n- ตั้งอาหาร/ออกกำลัง/ทำความสะอาด/ไดอารี่\n- เอกสาร/คอนแทค';
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: menu }]);
    }

    // Planner context
    const lastPet = await getLastPetName(userId);
    const context = { last_pet: lastPet };

    let plan = null;
    try { plan = await geminiPlanner(text, context); } catch(e){ logErr('planner error', e.message); }

    // If planner fails → safe fallback
    if (!plan){
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: 'ระบบกำลังเริ่มต้น โปรดลองใหม่อีกครั้งนะครับ/ค่ะ' }]);
    }

    // followup question if low confidence
    if (plan.followup_question && (plan.confidence ?? 0) < 0.6){
      await setSession(userId, { expect: 'followup', last_plan: plan });
      return lineClient.replyMessage(event.replyToken, [{ type:'text', text: plan.followup_question }]);
    }

    // Execute actions
    let replyText = plan.reply_hint || null;

    const runListFormat = (arr, emptyMsg) => (arr.length ? arr.join('\n') : emptyMsg);

    for (const a of (plan.actions || [])){
      const p = a.params || {};

      if (a.type === 'add_pet' || a.type === 'upsert_pet'){
        await upsertPetProfile(userId, p);
        replyText ||= `อัปเดตโปรไฟล์ \"${p.pet_name || p.name}\" เรียบร้อย ✅`;
      }

      if (a.type === 'add_vaccine'){
        const pet = p.pet_name || lastPet || await getLastPetName(userId);
        if (!pet || !p.vaccine_name || !p.last_shot_date){
          await setSession(userId, { expect:'fill_add_vaccine' });
          return lineClient.replyMessage(event.replyToken, [{ type:'text', text:'กรอก: วัคซีนอะไร/ให้ใคร/วันที่ (เช่น “Rabies ให้โมจิ 2025-11-03 รอบ 365”)' }]);
        }
        const next = await addVaccine(userId, pet, p.vaccine_name, normalizeDate(p.last_shot_date), Number(p.cycle_days || 365));
        replyText ||= `บันทึกวัคซีน ${p.vaccine_name} ให้ ${pet} แล้ว นัดถัดไป ${next} ✅`;
      }

      if (a.type === 'list_vaccine'){
        const pet = p.pet_name || lastPet || await getLastPetName(userId);
        if (!pet){
          replyText ||= 'ยังไม่พบน้องในระบบ บอกชื่อน้องก่อนน้า';
        } else {
          const snap = await db.collection('vaccines').where('owner_user_id','==', userId).where('pet_name','==', pet).orderBy('next_due_date','asc').get();
          if (snap.empty) replyText ||= `ยังไม่มีวัคซีนของ ${pet}`;
          else {
            const lines = snap.docs.map(d=>{ const r=d.data(); return `• ${r.vaccine_name} ล่าสุด: ${r.last_shot_date||'-'} นัด: ${r.next_due_date||'-'}`; });
            replyText ||= runListFormat(lines, `ยังไม่มีวัคซีนของ ${pet}`);
          }
        }
      }

      if (a.type === 'add_parasite_prevention'){
        const next = await addParasite(userId, p);
        replyText ||= `บันทึกการป้องกันปรสิตแล้ว ✅${next ? ` นัดถัดไป ${next}` : ''}`;
      }

      if (a.type === 'add_allergy'){
        await addAllergy(userId, p);
        replyText ||= 'บันทึกประวัติแพ้สำเร็จ ✅';
      }

      if (a.type === 'add_vet'){
        await addVet(userId, p);
        replyText ||= 'เพิ่มข้อมูลคลินิก/โรงพยาบาลสำเร็จ ✅';
      }

      if (a.type === 'add_medical_history'){
        await addMedicalHistory(userId, p);
        replyText ||= 'บันทึกประวัติการรักษา/ผ่าตัดสำเร็จ ✅';
      }

      if (a.type === 'add_medication'){
        await addMedication(userId, p);
        replyText ||= 'บันทึกยาที่ใช้อยู่สำเร็จ ✅';
      }

      if (a.type === 'add_weight'){
        await addWeight(userId, p);
        replyText ||= 'บันทึกน้ำหนักเรียบร้อย ✅';
      }

      if (a.type === 'set_feeding'){
        await setFeeding(userId, p);
        replyText ||= 'ตั้งตารางให้อาหารเรียบร้อย ✅';
      }

      if (a.type === 'add_exercise'){
        await addExercise(userId, p);
        replyText ||= 'บันทึกการออกกำลังกายเรียบร้อย ✅';
      }

      if (a.type === 'set_grooming'){
        await setGrooming(userId, p);
        replyText ||= 'บันทึก/ตั้งตาราง Grooming เรียบร้อย ✅';
      }

      if (a.type === 'add_diary'){
        await addDiary(userId, p);
        replyText ||= 'จดไดอารี่พฤติกรรมแล้ว ✅';
      }

      if (a.type === 'add_document'){
        await addDocument(userId, p);
        replyText ||= 'อัปโหลดเอกสารแล้ว ✅';
      }

      if (a.type === 'add_contact'){
        await addContact(userId, p);
        replyText ||= 'เพิ่มข้อมูลติดต่อเรียบร้อย ✅';
      }

      if (a.type === 'ask_health'){
        const ans = await geminiChat(
          'คุณคือน้อนน้อน ให้คำแนะนำสุขภาพสัตว์ทั่วไป (ไม่วินิจฉัย/ไม่สั่งยา) เป็น bullet สั้นๆ + เตือนพบสัตวแพทย์เมื่อมีสัญญาณอันตราย',
          `คำถาม: ${p.question || text}\nสัตว์: ${p.species || 'unknown'} ชื่อ: ${p.pet_name || (lastPet||'-')}`
        );
        replyText ||= ans || 'ขอโทษนะคะ/ครับ ตอนนี้น้อนน้อนยังตอบเรื่องนี้ไม่ได้';
      }

      if (a.type === 'reply'){
        replyText ||= p.text || null;
      }
    }

    const finalReply = replyText || 'สำเร็จ';
    return lineClient.replyMessage(event.replyToken, [{ type:'text', text: finalReply }]);
  }

  // Postbacks, images, etc. can be added here if needed
}

// --- Start server ---
app.listen(cfg.port, () => log('Server running on', cfg.port));
