const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, Browsers, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    const stats = fs.readJsonSync(statsFile);
    socket.emit('stats-update', { total: stats.total, live: io.engine.clientsCount });

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
            browser: Browsers.macOS("Desktop"),
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 120000,
            keepAliveIntervalMs: 30000,
            generateHighQualityLinkPreview: false,
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

                console.log("🚀 CONNECTION OPEN! GENERATING STABLE SESSION ID...");
                socket.emit('status', '✅ Connected! Generating Secure Session ID...');

                try {
                    await delay(12000);

                    const credsPath = path.join(sessionPath, 'creds.json');
                    const keysPath = path.join(sessionPath, 'keys');

                    if (!fs.existsSync(credsPath) || !fs.existsSync(keysPath)) {
                        throw new Error("Session files incomplete.");
                    }

                    const credsData = await fs.readFile(credsPath, 'utf-8');

                    if (!credsData.includes("noiseKey") || !credsData.includes("signedIdentityKey")) {
                        throw new Error("Invalid credentials structure.");
                    }

                    const sessionID = "VINNIE-SESSION~" + Buffer.from(credsData).toString('base64');

                    if (!sessionID || sessionID.length < 200) {
                        throw new Error("Generated session appears invalid.");
                    }

                    console.log("\n" + "=".repeat(60));
                    console.log("VINNIE DIGITAL HUB - SECURE SESSION GENERATED");
                    console.log(sessionID);
                    console.log("=".repeat(60) + "\n");

                    socket.emit('session-ready', sessionID);

                    const targetJid = sock.user.id;

                    await sock.sendMessage(targetJid, { text: sessionID });

                    await sock.sendMessage(targetJid, { 
                        text: `╔═════════════════════════╗
║  *SUCCESSFULLY PAIRED!* ║
╚═════════════════════════╝

Your *Comrade's BOT* ID is ready above.

_Give VINNIE DIGITAL HUB Gigs_
_and stay hydrated..._ 💧

© 2026 | *Infinite Impact*`
                    });

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

                    console.log("✅ ID delivered to scanned device successfully.");

                    setTimeout(async () => {
                        if (sock) {
                            try { await sock.logout(); } catch {}
                        }
                        fs.remove(sessionPath);
                    }, 180000);

                } catch (err) {
                    console.log("❌ Session Generation Error:", err.message);
                    socket.emit('status', '❌ Failed to generate valid session. Please retry.');
                }
            }

            if (connection === 'close') {

                const code = lastDisconnect?.error?.output?.statusCode;

                if (pairingInProgress) {
                    console.log("Pairing handshake in progress — not reconnecting.");
                    return;
                }

                if (code !== DisconnectReason.loggedOut) {
                    isStarting = false;
                    console.log("Reconnecting safely...");
                    startVinnieGen(phone);
                }
            }
        });

        if (phone && !state.creds.registered && !pairingInProgress) {
            try {
                pairingInProgress = true;

                await delay(6000);

                const cleanNumber = phone.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanNumber);

                console.log(`🔑 Pairing Code: ${code}`);

                socket.emit('pairing-code', code);
                socket.emit('status', '📲 Check your WhatsApp for device link prompt.');

            } catch (e) {
                pairingInProgress = false;
                console.log("Pairing failed:", e.message);
                socket.emit('status', '❌ Pairing failed. Refresh page.');
            }
        }
    }

    socket.on('start-pairing', (num) => startVinnieGen(num));

    socket.on('disconnect', () => {
        io.emit('stats-update', { total: fs.readJsonSync(statsFile).total, live: io.engine.clientsCount });
    });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`━━━━━━ VINNIE DIGITAL HUB ━━━━━━`);
    console.log(`Backend Robustly Running: http://localhost:${port}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
