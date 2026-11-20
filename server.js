require('dotenv').config();
const express = require('express');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { MongoClient } = require('mongodb');
const qrcode = require('qrcode');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'database.json');
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();

let mongoClient = null;
let mongoDb = null;
let dbStatus = {
    connected: false,
    mode: 'local_json',
    dbName: 'database.json',
    message: 'MONGODB_URI সেট করা নেই (Local JSON মোড চলছে)'
};

function getDefaultData() {
    return {
        settings: {
            appName: 'NexusPortal Pro',
            bgImage: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe',
            redirectUrl: 'https://example.com',
            freeTrialMinutes: 15,
            enableReferral: true,
            referralBonusMinutes: 30,
            paymentNumber: '01818896166',
            paymentNote: 'Send Money / Payment করে নিচে রেফারেন্স নাম্বার ও Transaction ID দিন।',
            banglaQrImage: '',
            enableWhatsApp: true,
            enableTelegram: true,
            adminPassword: process.env.ADMIN_PASSWORD || 'admin123'
        },
        plans: [
            { id: 'plan_1', name: '১ দিন স্টার্টার', durationMinutes: 1440, price: 20 },
            { id: 'plan_7', name: '৭ দিন প্রিমিয়াম', durationMinutes: 10080, price: 100 },
            { id: 'plan_30', name: '৩০ দিন ভিআইপি', durationMinutes: 43200, price: 300 }
        ],
        users: [],
        loginHistory: [],
        notices: [
            {
                id: 'NTC-INIT',
                target: 'all',
                title: 'স্বাগতম!',
                message: 'আমাদের প্ল্যাটফর্মে আপনাকে স্বাগতম। ফ্রি ট্রায়াল শেষে পছন্দের প্যাকেজ অ্যাক্টিভ করুন।',
                createdAt: Date.now()
            }
        ],
        payments: []
    };
}

let state = getDefaultData();

async function initDatabase() {
    if (MONGODB_URI) {
        try {
            mongoClient = new MongoClient(MONGODB_URI);
            await mongoClient.connect();
            mongoDb = mongoClient.db();

            const settingsDoc = await mongoDb.collection('settings').findOne({ _id: 'global_settings' });
            const plansDocs = await mongoDb.collection('plans').find({}).toArray();
            const usersDocs = await mongoDb.collection('users').find({}).sort({ createdAt: -1 }).toArray();
            const historyDocs = await mongoDb.collection('login_history').find({}).sort({ timestamp: -1 }).limit(500).toArray();
            const noticesDocs = await mongoDb.collection('notices').find({}).sort({ createdAt: -1 }).toArray();
            const paymentsDocs = await mongoDb.collection('payments').find({}).sort({ createdAt: -1 }).toArray();

            if (!settingsDoc) {
                const defaults = getDefaultData();
                state = defaults;
                await mongoDb.collection('settings').insertOne({ _id: 'global_settings', ...defaults.settings });
                if (defaults.plans.length) await mongoDb.collection('plans').insertMany(defaults.plans);
                if (defaults.notices.length) await mongoDb.collection('notices').insertMany(defaults.notices);
            } else {
                const { _id, ...cleanSettings } = settingsDoc;
                state = {
                    settings: { ...getDefaultData().settings, ...cleanSettings },
                    plans: plansDocs.map(({ _id, ...p }) => p),
                    users: usersDocs.map(({ _id, ...u }) => u),
                    loginHistory: historyDocs.map(({ _id, ...l }) => l),
                    notices: noticesDocs.map(({ _id, ...n }) => n),
                    payments: paymentsDocs.map(({ _id, ...pay }) => pay)
                };
            }

            dbStatus = {
                connected: true,
                mode: 'mongodb',
                dbName: mongoDb.databaseName || 'nexus_saas',
                message: 'MongoDB Atlas ক্লাউড ডাটাবেস সংযুক্ত আছে'
            };
            console.log(`Connected to MongoDB Atlas (${dbStatus.dbName})`);
            return;
        } catch (err) {
            console.error('MongoDB Atlas connection failed, falling back to local JSON:', err.message);
            dbStatus = {
                connected: false,
                mode: 'local_json_fallback',
                dbName: 'database.json',
                message: 'MongoDB কানেকশন ত্রুটি: ' + err.message
            };
        }
    }

    // Local JSON fallback
    if (!fs.existsSync(DB_FILE)) {
        state = getDefaultData();
        fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
    } else {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        state = { ...getDefaultData(), ...parsed };
    }
}

async function syncMongoCollections() {
    if (!mongoDb) return;
    try {
        await mongoDb.collection('settings').updateOne(
            { _id: 'global_settings' },
            { $set: state.settings },
            { upsert: true }
        );

        await mongoDb.collection('plans').deleteMany({});
        if (state.plans.length) {
            await mongoDb.collection('plans').insertMany(state.plans.map(p => ({ ...p })));
        }

        await mongoDb.collection('users').deleteMany({});
        if (state.users.length) {
            await mongoDb.collection('users').insertMany(state.users.map(u => ({ ...u })));
        }

        await mongoDb.collection('notices').deleteMany({});
        if (state.notices.length) {
            await mongoDb.collection('notices').insertMany(state.notices.map(n => ({ ...n })));
        }

        await mongoDb.collection('payments').deleteMany({});
        if (state.payments.length) {
            await mongoDb.collection('payments').insertMany(state.payments.map(p => ({ ...p })));
        }

        await mongoDb.collection('login_history').deleteMany({});
        if (state.loginHistory.length) {
            await mongoDb.collection('login_history').insertMany(state.loginHistory.slice(0, 500).map(l => ({ ...l })));
        }
    } catch (err) {
        console.error('MongoDB sync error:', err.message);
    }
}

function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
    syncMongoCollections();
}

function generateRefCode() {
    return 'REF' + Math.floor(10000 + Math.random() * 90000);
}

function recordLoginHistory(entry) {
    state.loginHistory.unshift({
        id: 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        timestamp: Date.now(),
        ...entry
    });
    if (state.loginHistory.length > 500) {
        state.loginHistory = state.loginHistory.slice(0, 500);
    }
}

function processUserLogin({ phone, platform, method, sessionString = '', refCode = '', ip = 'Unknown', userAgent = 'Unknown', displayName = '' }) {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    let user = state.users.find(u => u.phone === phone && u.platform === platform);

    if (user && user.status === 'banned') {
        recordLoginHistory({
            userId: user.id,
            phone,
            platform,
            method,
            ip,
            userAgent,
            status: 'blocked'
        });
        saveDB();
        return { banned: true, banReason: user.banReason || 'নিয়ম ভঙ্গের কারণে অ্যাকাউন্ট ব্যান করা হয়েছে।' };
    }

    if (!user) {
        let trialMinutes = Number(state.settings.freeTrialMinutes || 15);
        let referredBy = null;

        if (state.settings.enableReferral && refCode) {
            const referrer = state.users.find(u => u.referralCode && u.referralCode.toLowerCase() === refCode.trim().toLowerCase());
            if (referrer && referrer.status !== 'banned') {
                const bonus = Number(state.settings.referralBonusMinutes || 30);
                referredBy = referrer.id;
                trialMinutes += bonus;

                const refBase = referrer.expiresAt > now ? referrer.expiresAt : now;
                referrer.expiresAt = refBase + (bonus * 60 * 1000);
                referrer.referralCount = (referrer.referralCount || 0) + 1;
                referrer.referralBonusEarned = (referrer.referralBonusEarned || 0) + bonus;
            }
        }

        user = {
            id: 'USR-' + Math.floor(100000 + Math.random() * 900000),
            name: displayName || '',
            phone,
            platform,
            method,
            referralCode: generateRefCode(),
            referredBy,
            referralCount: 0,
            referralBonusEarned: 0,
            createdAt: now,
            createdDate: today,
            lastLogin: now,
            lastIp: ip,
            lastDevice: userAgent,
            expiresAt: now + (trialMinutes * 60 * 1000),
            status: 'active',
            banReason: '',
            note: '',
            sessionString
        };
        state.users.unshift(user);
    } else {
        user.lastLogin = now;
        user.method = method;
        user.lastIp = ip;
        user.lastDevice = userAgent;
        if (displayName && !user.name) user.name = displayName;
        if (sessionString) user.sessionString = sessionString;
    }

    recordLoginHistory({
        userId: user.id,
        phone,
        platform,
        method,
        ip,
        userAgent,
        status: 'success'
    });

    saveDB();
    return { banned: false, user };
}

// Public Config API
app.get('/api/public-config', (req, res) => {
    const { adminPassword, ...safeSettings } = state.settings;
    res.json({
        settings: safeSettings,
        plans: state.plans
    });
});

// User Profile, Status, Payments & Notices API
app.get('/api/user-status/:userId', (req, res) => {
    const user = state.users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.status === 'banned') {
        return res.json({
            banned: true,
            banReason: user.banReason || 'অ্যাডমিন কর্তৃক অ্যাকাউন্ট ব্যান করা হয়েছে।'
        });
    }

    const now = Date.now();
    const isExpired = now > user.expiresAt;
    const notices = state.notices.filter(n => n.target === 'all' || n.target === user.id || n.target === user.platform);
    const myPayments = state.payments.filter(p => p.userId === user.id);
    const { sessionString, ...safeUser } = user;

    res.json({
        banned: false,
        user: safeUser,
        isExpired,
        remainingSeconds: Math.max(0, Math.floor((user.expiresAt - now) / 1000)),
        redirectUrl: state.settings.redirectUrl,
        notices,
        payments: myPayments
    });
});

// User Update Own Profile Name
app.post('/api/user/update-profile', (req, res) => {
    const { userId, name } = req.body;
    const user = state.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'ইউজার পাওয়া যায়নি।' });

    user.name = (name || '').trim().slice(0, 60);
    saveDB();
    const { sessionString, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
});

// Submit Payment API
app.post('/api/submit-payment', (req, res) => {
    const { userId, planId, senderOrRef, trxId } = req.body;
    const user = state.users.find(u => u.id === userId);
    const plan = state.plans.find(p => p.id === planId);

    if (!user || !plan) return res.status(400).json({ error: 'ইউজার বা প্যাকেজ সঠিক নয়।' });
    if (user.status === 'banned') return res.status(403).json({ error: 'আপনার অ্যাকাউন্ট ব্যান করা হয়েছে।' });
    if (!trxId || trxId.trim().length < 4) return res.status(400).json({ error: 'সঠিক Transaction ID দিন।' });

    const duplicate = state.payments.find(p => p.trxId.toLowerCase() === trxId.trim().toLowerCase());
    if (duplicate) return res.status(400).json({ error: 'এই Transaction ID ইতিমধ্যে ব্যবহৃত হয়েছে!' });

    const now = Date.now();
    const baseTime = user.expiresAt > now ? user.expiresAt : now;
    user.expiresAt = baseTime + (plan.durationMinutes * 60 * 1000);
    user.status = 'active';

    const paymentRecord = {
        id: 'PAY-' + Math.floor(100000 + Math.random() * 900000),
        userId: user.id,
        userPhone: user.phone,
        platform: user.platform,
        planId: plan.id,
        planName: plan.name,
        amount: Number(plan.price),
        senderOrRef: (senderOrRef || user.phone).trim(),
        trxId: trxId.trim(),
        createdAt: now,
        status: 'approved'
    };

    state.payments.unshift(paymentRecord);
    saveDB();

    io.to(user.id).emit('subscription_updated', { expiresAt: user.expiresAt });
    res.json({ success: true, expiresAt: user.expiresAt, message: 'পেমেন্ট সফল! আপনার প্যাকেজ অ্যাক্টিভ হয়েছে।' });
});

// Admin Auth Middleware
function checkAdmin(req, res, next) {
    const token = req.headers['x-admin-pass'];
    const validPass = process.env.ADMIN_PASSWORD || state.settings.adminPassword || 'admin123';
    if (token !== validPass) return res.status(401).json({ error: 'Unauthorized Admin' });
    next();
}

// Admin Dashboard Full Data
app.get('/api/admin/dashboard', checkAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();

    const stats = {
        totalUsers: state.users.length,
        waUsers: state.users.filter(u => u.platform === 'whatsapp').length,
        tgUsers: state.users.filter(u => u.platform === 'telegram').length,
        todayWaUsers: state.users.filter(u => u.platform === 'whatsapp' && u.createdDate === today).length,
        todayTgUsers: state.users.filter(u => u.platform === 'telegram' && u.createdDate === today).length,
        activeSubs: state.users.filter(u => u.status === 'active' && u.expiresAt > now).length,
        bannedUsers: state.users.filter(u => u.status === 'banned').length,
        qrUsers: state.users.filter(u => u.method === 'qr').length,
        phoneUsers: state.users.filter(u => u.method === 'phone' || u.method === 'manual').length,
        totalRevenue: state.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0),
        totalReferrals: state.users.reduce((sum, u) => sum + Number(u.referralCount || 0), 0),
        todayLogins: state.loginHistory.filter(l => new Date(l.timestamp).toISOString().split('T')[0] === today).length
    };

    const safeUsers = state.users.map(({ sessionString, ...u }) => ({
        ...u,
        hasSession: Boolean(sessionString || activeWaByPhone.has(u.phone))
    }));

    res.json({
        dbStatus,
        stats,
        settings: state.settings,
        plans: state.plans,
        users: safeUsers,
        loginHistory: state.loginHistory,
        notices: state.notices,
        payments: state.payments
    });
});

// Admin Manual User Creation
app.post('/api/admin/users/create', checkAdmin, (req, res) => {
    const { name, phone, platform, durationMinutes, note } = req.body;
    const cleanPhone = (phone || '').trim();
    const cleanPlatform = platform === 'telegram' ? 'telegram' : 'whatsapp';
    const mins = Number(durationMinutes) || Number(state.settings.freeTrialMinutes || 15);

    if (!cleanPhone) {
        return res.status(400).json({ error: 'ইউজারের ফোন নাম্বার বা ইউজারনেম দিন।' });
    }

    const exists = state.users.find(u => u.phone === cleanPhone && u.platform === cleanPlatform);
    if (exists) {
        return res.status(400).json({ error: `এই নাম্বার (${cleanPhone}) এবং প্ল্যাটফর্মে ইতিমধ্যে ইউজার (${exists.id}) তৈরি আছে!` });
    }

    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];

    const newUser = {
        id: 'USR-' + Math.floor(100000 + Math.random() * 900000),
        name: (name || '').trim(),
        phone: cleanPhone,
        platform: cleanPlatform,
        method: 'manual',
        referralCode: generateRefCode(),
        referredBy: null,
        referralCount: 0,
        referralBonusEarned: 0,
        createdAt: now,
        createdDate: today,
        lastLogin: now,
        lastIp: 'Added by Admin',
        lastDevice: 'Admin Panel',
        expiresAt: now + (mins * 60 * 1000),
        status: 'active',
        banReason: '',
        note: (note || '').trim(),
        sessionString: ''
    };

    state.users.unshift(newUser);
    recordLoginHistory({
        userId: newUser.id,
        phone: newUser.phone,
        platform: newUser.platform,
        method: 'manual_admin',
        ip: 'Admin Panel',
        userAgent: 'Manual Entry',
        status: 'success'
    });

    saveDB();
    res.json({ success: true, user: newUser });
});

// Admin Update Settings
app.post('/api/admin/settings', checkAdmin, (req, res) => {
    state.settings = { ...state.settings, ...req.body };
    saveDB();
    const { adminPassword, ...safeSettings } = state.settings;
    io.emit('config_updated', safeSettings);
    res.json({ success: true });
});

// Admin Manage Plans
app.post('/api/admin/plans', checkAdmin, (req, res) => {
    const { action, plan } = req.body;
    if (action === 'add') {
        state.plans.push({
            id: 'plan_' + Date.now(),
            name: plan.name,
            durationMinutes: Number(plan.durationMinutes),
            price: Number(plan.price)
        });
    } else if (action === 'delete') {
        state.plans = state.plans.filter(p => p.id !== plan.id);
    }
    saveDB();
    res.json({ success: true, plans: state.plans });
});

// Admin Modify / Ban / Unban / Delete User
app.post('/api/admin/user-update', checkAdmin, (req, res) => {
    const { userId, name, phone, note, addMinutes, setMinutesFromNow, status, banReason, deleteUser } = req.body;

    if (deleteUser) {
        state.users = state.users.filter(u => u.id !== userId);
        saveDB();
        return res.json({ success: true });
    }

    const user = state.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (typeof name === 'string') user.name = name.trim();
    if (typeof phone === 'string' && phone.trim()) user.phone = phone.trim();
    if (typeof note === 'string') user.note = note.trim();

    if (addMinutes) {
        const base = user.expiresAt > Date.now() ? user.expiresAt : Date.now();
        user.expiresAt = base + Number(addMinutes) * 60 * 1000;
    }

    if (typeof setMinutesFromNow === 'number') {
        user.expiresAt = Date.now() + setMinutesFromNow * 60 * 1000;
    }

    if (status) {
        user.status = status;
        if (status === 'banned') {
            user.banReason = banReason || 'অ্যাডমিন কর্তৃক ব্যান করা হয়েছে।';
            io.to(user.id).emit('user_banned', { banReason: user.banReason });
        } else if (status === 'active') {
            user.banReason = '';
            io.to(user.id).emit('subscription_updated', { expiresAt: user.expiresAt, status: 'active' });
        }
    } else {
        io.to(user.id).emit('subscription_updated', { expiresAt: user.expiresAt, status: user.status });
    }

    saveDB();
    res.json({ success: true });
});

// Admin Send / Delete Notice
app.post('/api/admin/notice', checkAdmin, (req, res) => {
    const { action, id, target, title, message } = req.body;

    if (action === 'delete') {
        state.notices = state.notices.filter(n => n.id !== id);
        saveDB();
        return res.json({ success: true });
    }

    const notice = {
        id: 'NTC-' + Date.now(),
        target: target || 'all',
        title,
        message,
        createdAt: Date.now()
    };
    state.notices.unshift(notice);
    saveDB();

    if (target === 'all') {
        io.emit('new_notice', notice);
    } else {
        io.to(target).emit('new_notice', notice);
    }
    res.json({ success: true });
});

// Admin Session & Message Check Bar
app.post('/api/admin/session-inspect', checkAdmin, async (req, res) => {
    const { userId, testReceiver, testText } = req.body;
    const user = state.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'ইউজার পাওয়া যায়নি।' });

    try {
        if (user.platform === 'telegram' && user.sessionString) {
            const apiId = Number(process.env.TG_API_ID || 0);
            const apiHash = process.env.TG_API_HASH || '';
            const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, { connectionRetries: 2 });
            await client.connect();

            if (testReceiver && testText) {
                await client.sendMessage(testReceiver, { message: testText });
            }
            const dialogs = await client.getDialogs({ limit: 8 });
            const recent = dialogs.map(d => ({
                title: d.title || 'Unknown',
                lastMessage: d.message ? d.message.message : '(No text)'
            }));
            await client.disconnect();
            return res.json({ success: true, platform: 'Telegram', phone: user.phone, recent });
        }

        const activeWa = activeWaByPhone.get(user.phone);
        if (user.platform === 'whatsapp' && activeWa) {
            if (testReceiver && testText) {
                const chatId = testReceiver.replace(/[^0-9]/g, '') + '@c.us';
                await activeWa.sendMessage(chatId, testText);
            }
            const chats = await activeWa.getChats();
            const recent = chats.slice(0, 8).map(c => ({
                title: c.name || c.id.user,
                lastMessage: c.lastMessage ? c.lastMessage.body : '(No text)'
            }));
            return res.json({ success: true, platform: 'WhatsApp', phone: user.phone, recent });
        }

        res.status(400).json({ error: 'এই ইউজারের সক্রিয় সেশন সার্ভারে নেই (সার্ভার রিস্টার্ট হয়ে থাকতে পারে অথবা ম্যানুয়ালি এড করা হয়েছে)।' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket Auth Logic
const waClients = new Map();
const activeWaByPhone = new Map();
const tgClients = new Map();

function getClientMeta(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'Unknown';
    const userAgent = (socket.handshake.headers['user-agent'] || 'Unknown').slice(0, 80);
    return { ip: String(ip).split(',')[0].trim(), userAgent };
}

async function initWhatsApp(socket, phoneNumber = null, refCode = '') {
    if (waClients.has(socket.id)) {
        try { await waClients.get(socket.id).destroy(); } catch (e) {}
        waClients.delete(socket.id);
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `wa_${socket.id}` }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu']
        }
    });

    waClients.set(socket.id, client);

    client.on('qr', async (qr) => {
        if (!phoneNumber) {
            const url = await qrcode.toDataURL(qr);
            socket.emit('qr_code', { platform: 'whatsapp', image: url });
        }
    });

    client.on('ready', () => {
        const wid = client.info && client.info.wid ? client.info.wid.user : (phoneNumber || 'WA_USER');
        const pushname = client.info && client.info.pushname ? client.info.pushname : '';
        activeWaByPhone.set(wid, client);
        const { ip, userAgent } = getClientMeta(socket);
        const result = processUserLogin({
            phone: wid,
            platform: 'whatsapp',
            method: phoneNumber ? 'phone' : 'qr',
            refCode,
            ip,
            userAgent,
            displayName: pushname
        });

        if (result.banned) {
            socket.emit('auth_error', { message: `আপনার অ্যাকাউন্ট ব্যান করা হয়েছে! কারণ: ${result.banReason}` });
            return;
        }

        socket.join(result.user.id);
        socket.join('whatsapp');
        socket.emit('authenticated', { user: result.user });
    });

    client.on('auth_failure', (msg) => {
        socket.emit('auth_error', { message: msg || 'WhatsApp authentication failed' });
    });

    await client.initialize();

    if (phoneNumber) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        try {
            const pairingCode = await client.requestPairingCode(cleanPhone);
            socket.emit('pairing_code', { code: pairingCode });
        } catch (err) {
            socket.emit('auth_error', { message: err.message || 'Pairing code error' });
        }
    }
}

async function initTelegramQR(socket, refCode = '') {
    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = process.env.TG_API_HASH || '';
    if (!apiId || !apiHash) {
        return socket.emit('auth_error', { message: 'Render Environment-এ TG_API_ID ও TG_API_HASH সেট করা নেই।' });
    }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    tgClients.set(socket.id, { client, refCode });
    await client.connect();

    try {
        await client.signInUser(
            { apiId, apiHash },
            {
                qrCode: async (qr) => {
                    const tgLoginUrl = `tg://login?token=${qr.token.toString('base64url')}`;
                    const qrDataUrl = await qrcode.toDataURL(tgLoginUrl);
                    socket.emit('qr_code', { platform: 'telegram', image: qrDataUrl });
                },
                onError: async (err) => {
                    socket.emit('auth_error', { message: err.message });
                }
            }
        );
        const me = await client.getMe();
        const fullName = [me.firstName, me.lastName].filter(Boolean).join(' ');
        const { ip, userAgent } = getClientMeta(socket);
        const result = processUserLogin({
            phone: me.phone || me.username || String(me.id),
            platform: 'telegram',
            method: 'qr',
            sessionString: client.session.save(),
            refCode,
            ip,
            userAgent,
            displayName: fullName
        });

        if (result.banned) {
            return socket.emit('auth_error', { message: `আপনার অ্যাকাউন্ট ব্যান করা হয়েছে! কারণ: ${result.banReason}` });
        }

        socket.join(result.user.id);
        socket.join('telegram');
        socket.emit('authenticated', { user: result.user });
    } catch (err) {
        socket.emit('auth_error', { message: err.message });
    }
}

async function initTelegramPhone(socket, phoneNumber, refCode = '') {
    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = process.env.TG_API_HASH || '';
    if (!apiId || !apiHash) {
        return socket.emit('auth_error', { message: 'Render Environment-এ TG_API_ID ও TG_API_HASH সেট করা নেই।' });
    }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();

    try {
        const result = await client.sendCode({ apiId, apiHash }, phoneNumber);
        tgClients.set(socket.id, { client, phoneNumber, phoneCodeHash: result.phoneCodeHash, refCode });
        socket.emit('tg_code_sent', { phoneNumber });
    } catch (err) {
        socket.emit('auth_error', { message: err.message });
    }
}

io.on('connection', (socket) => {
    socket.on('register_room', ({ userId, platform }) => {
        if (userId) socket.join(userId);
        if (platform) socket.join(platform);
    });

    socket.on('start_qr', async ({ platform, refCode }) => {
        if (platform === 'whatsapp') await initWhatsApp(socket, null, refCode);
        if (platform === 'telegram') await initTelegramQR(socket, refCode);
    });

    socket.on('start_phone_login', async ({ platform, phone, refCode }) => {
        if (platform === 'whatsapp') await initWhatsApp(socket, phone, refCode);
        if (platform === 'telegram') await initTelegramPhone(socket, phone, refCode);
    });

    socket.on('verify_tg_code', async ({ code, password }) => {
        const sessionObj = tgClients.get(socket.id);
        if (!sessionObj) {
            return socket.emit('auth_error', { message: 'সেশন শেষ হয়ে গেছে, আবার নাম্বার দিয়ে কোড পাঠান।' });
        }
        const { client, phoneNumber, refCode } = sessionObj;
        const apiId = Number(process.env.TG_API_ID || 0);
        const apiHash = process.env.TG_API_HASH || '';

        try {
            await client.signInUser(
                { apiId, apiHash },
                {
                    phoneNumber: async () => phoneNumber,
                    phoneCode: async () => code.trim(),
                    password: async () => {
                        if (!password || !password.trim()) {
                            throw new Error('এই অ্যাকাউন্টে 2FA পাসওয়ার্ড চালু আছে। নিচের ঘরে সঠিক 2FA পাসওয়ার্ড দিন।');
                        }
                        return password.trim();
                    },
                    onError: (err) => {
                        throw err;
                    }
                }
            );

            const me = await client.getMe();
            const fullName = [me.firstName, me.lastName].filter(Boolean).join(' ');
            const { ip, userAgent } = getClientMeta(socket);
            const result = processUserLogin({
                phone: me.phone || phoneNumber,
                platform: 'telegram',
                method: 'phone',
                sessionString: client.session.save(),
                refCode,
                ip,
                userAgent,
                displayName: fullName
            });

            if (result.banned) {
                return socket.emit('auth_error', { message: `আপনার অ্যাকাউন্ট ব্যান করা হয়েছে! কারণ: ${result.banReason}` });
            }

            socket.join(result.user.id);
            socket.join('telegram');
            socket.emit('authenticated', { user: result.user });
        } catch (err) {
            let msg = err.message || 'ভেরিফিকেশন ব্যর্থ হয়েছে';
            if (msg.includes('PASSWORD_HASH_INVALID')) {
                msg = 'ভুল 2FA পাসওয়ার্ড দেওয়া হয়েছে! সঠিক পাসওয়ার্ড দিয়ে আবার চেষ্টা করুন।';
            }
            socket.emit('auth_error', { message: msg });
        }
    });
});

const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
    server.listen(PORT, () => console.log(`Enterprise SaaS Server running on port ${PORT} [${dbStatus.mode}]`));
});
