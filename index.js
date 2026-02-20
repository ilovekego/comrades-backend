require('dotenv').config();
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    fetchLatestBaileysVersion, 
    Browsers, 
    DisconnectReason, 
    makeCacheableSignalKeyStore 
} = require("@whiskeysockets/baileys");

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const pino = require('pino');
const QRCode = require('qrcode');

// Routes
const qrRoute = require('./routes/qr');
const pairingRoute = require('./routes/pairing');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Stats Management
const statsFile = path.join(__dirname, 'total_stats.json');
if (!fs.existsSync(statsFile)) fs.writeJsonSync(statsFile, { total: 0 });

function incrementTotal() {
    try {
        const stats = fs.readJsonSync(statsFile);
        stats.total += 1;
        fs.writeJsonSync(statsFile, stats);
        io.emit('stats-update', { total: stats.total, live: io.engine.clientsCount });
    } catch (e) { console.log("Stats update failed"); }
}

// Routes registration
app.use('/start-qr', qrRoute(io));
app.use('/start-pairing', pairingRoute(io));
app.get('/', (req, res) => res.send('Vinnie Bot Generator Running...'));

// --- ⚙️ SOCKET.IO CORE LOGIC ---
io.on('connection', (socket) => {
    console.log(`📡 User connected: ${socket.id}`);
    
    // Initial stats send
    try {
        const stats = fs.readJsonSync(statsFile);
        socket.emit('stats-update', { total: stats.total, live: io.engine.clientsCount });
    } catch(e) {}

    let isStarting = false;
    let pairingInProgress = false;
    let sock = null;

    async function startVinnieGen(phone = null) {
        if (isStarting) return;
        isStarting = true;

        const sessionPath = path.join(__dirname, 'sessions', socket.id);
        if (fs.existsSync(sessionPath)) fs.emptyDirSync(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            version,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu("Chrome"), // 🔥 CRITICAL FIX
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 20000,
            getMessage: async () => ({ conversation: 'Vinnie Digital Hub' }),
            maxListeners: 0
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect } = update;

            if (qr) {
                const qrData = await QRCode.toDataURL(qr);
                socket.emit('qr', qrData);
            }

            if (connection === 'open') {
                isStarting = false;
                pairingInProgress = false;
                incrementTotal();

                console.log("🚀 CONNECTION OPEN!");
                socket.emit('status', '✅ Connected! Generating Secure Session ID...');

                try {
                    await delay(15000); // 🔐 Stability Buffer

                    const credsPath = path.join(sessionPath, 'creds.json');
                    const credsData = await fs.readFile(credsPath, 'utf-8');
                    const sessionID = "VINNIE-SESSION~" + Buffer.from(credsData).toString('base64');

                    socket.emit('session-ready', sessionID);
                    const targetJid = sock.user.id;

                    // Send ID and interactive messages
                    await sock.sendMessage(targetJid, { text: sessionID });
                    await sock.sendMessage(targetJid, { 
                        text: `╔═════════════════════════╗\n║  *SUCCESSFULLY PAIRED!* ║\n╚═════════════════════════╝\n\nYour *Comrade's BOT* ID is ready above.\n\n© 2026 | *Infinite Impact*`
                    });

                    // 3️⃣ Copy button
                    await sock.sendMessage(targetJid, {
                        interactiveMessage: {
                            body: { text: "Tap below to copy your Session ID instantly! 👇" },
                            footer: { text: "Vinnie Digital Hub | Secure Pairing" },
                            nativeFlowMessage: {
                                buttons: [{
                                    name: "cta_copy",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📋 Copy Session ID",
                                        copy_code: sessionID
                                    })
                                }]
                            }
                        }
                    });

                    setTimeout(async () => {
                        if (sock) try { await sock.logout(); } catch {}
                        fs.remove(sessionPath);
                    }, 240000);

                } catch (err) {
                    socket.emit('status', '❌ Session generation failed.');
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (pairingInProgress) return;
                if (code !== DisconnectReason.loggedOut) {
                    isStarting = false;
                    startVinnieGen(phone);
                }
            }
        });

        // 🔥 PAIRING CODE REQUEST
        if (phone && !state.creds.registered && !pairingInProgress) {
            try {
                pairingInProgress = true;
                await delay(8000);
                const cleanNumber = phone.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanNumber);
                socket.emit('pairing-code', code);
                socket.emit('status', '📲 Enter code in WhatsApp.');
            } catch (e) {
                pairingInProgress = false;
                socket.emit('status', '❌ Pairing failed.');
            }
        }
    }

    socket.on('start-pairing', (num) => startVinnieGen(num));
    socket.on('disconnect', () => {
        console.log(`📴 Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`━━━━━━ VINNIE DIGITAL HUB ━━━━━━`);
    console.log(`Server Running: http://localhost:${PORT}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
