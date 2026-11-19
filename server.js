const express = require('express');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); 

const client = new Client({
    authStrategy: new LocalAuth(),
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

io.on('connection', (socket) => {
    console.log('App User Connected');
});

client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
        io.emit('qr', url);
    });
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    fs.readFile('url.txt', 'utf8', (err, data) => {
        const targetUrl = data ? data.trim() : 'https://google.com';
        io.emit('authenticated', targetUrl);
    });
});

client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
