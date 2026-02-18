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

    async function startVinnieGen(phone = null) {
        const sessionPath = path.join(__dirname, 'sessions', socket.id);
        
        // Clean old session data to ensure QR is always fresh and valid
        if (fs.existsSync(sessionPath)) fs.emptyDirSync(sessionPath);
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                // 🛡️ CRITICAL FIX: Captures security keys to prevent "Bad MAC"
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            version,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS("Desktop"), // Use native Baileys browser string for better QR stability
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 120000,
            keepAliveIntervalMs: 30000,
            generateHighQualityLinkPreview: false,
            getMessage: async (key) => { return { conversation: 'Vinnie Digital Hub' } }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect, receivedPendingNotifications } = update;
            
            if (qr) {
                const qrData = await QRCode.toDataURL(qr);
                socket.emit('qr', qrData);
            }

            if (connection === 'open') {
                incrementTotal();
                console.log("🚀 CONNECTION OPEN! GENERATING STABLE SESSION ID...");
                socket.emit('status', '✅ Connected! Sending ID to your WhatsApp...');
                
                try {
                    await delay(10000); // 10s wait to ensure keys are fully written to disk
                    
                    // 🔒 Read the creds.json file
                    const credsData = await fs.readJson(path.join(sessionPath, 'creds.json'));
                    
                    // 🧬 Generate the ID (Same format as index.js)
                    const sessionID = "VINNIE-SESSION~" + Buffer.from(JSON.stringify(credsData)).toString('base64');

                    console.log("\n" + "=".repeat(60));
                    console.log("VINNIE DIGITAL HUB - SECURE SESSION GENERATED");
                    console.log(sessionID);
                    console.log("=".repeat(60) + "\n");

                    // Emit to Frontend
                    socket.emit('session-ready', sessionID);

                    // 📤 DELIVER TO OWNER NUMBER (Even for one-device owners)
                    const targetJid = sock.user.id; // Sends to yourself

                    // 1. Raw Session for easy copy
                    await sock.sendMessage(targetJid, { text: sessionID });

                    // 2. Branding Header
                    await sock.sendMessage(targetJid, { 
                        text: `╔═════════════════════════╗\n║  *SUCCESSFULLY PAIRED!* ║\n╚═════════════════════════╝\n\nYour *Comrade's BOT* ID is ready above.\n\n_Give VINNIE DIGITAL HUB Gigs_\n_and stay hydrated..._ 💧\n\n© 2026 | *Infinite Impact*` 
                    });

                    // 3. Native Copy Button (Now delivered to the phone that just scanned)
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
                    }, { viewOnce: true });

                    console.log("✅ ID delivered to scanned device successfully.");
                    
                    // Cleanup session folder after successful use
                    setTimeout(() => fs.remove(sessionPath), 60000);

                } catch (err) {
                    console.log("❌ Delivery Error:", err.message);
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut) {
                    startVinnieGen(phone);
                }
            }
        });

        if (phone && !state.creds.registered) {
            await delay(5000);
            try {
                const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                socket.emit('pairing-code', code);
                console.log(`🔑 Pairing Code: ${code}`);
            } catch (e) {
                console.log("Pairing failed. Refresh page.");
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
