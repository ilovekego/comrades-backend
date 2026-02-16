const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, Browsers, DisconnectReason } = require("@whiskeysockets/baileys");
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

// Serve frontend and fix "Cannot GET /"
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- PERSISTENT TOTAL COUNTER ---
// This ensures your "Total Users" count stays permanent even after server restarts.
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
    // Send initial stats to the new connection
    socket.emit('stats-update', { total: stats.total, live: io.engine.clientsCount });

    async function startVinnieGen(phone = null) {
        // Unique folder per socket to prevent multi-user conflict in a shared server
        const sessionPath = path.join(__dirname, 'sessions', socket.id);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: 'silent' }), // FOCUS MODE: Prevents console spam from Baileys
            browser: ["Ubuntu", "Chrome", "20.0.04"], // Fixed Browser string for best Pairing Trigger
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false, // PREVENT SYNC CHOKE: Don't download old chats
            connectTimeoutMs: 120000, // 2-MINUTE CONNECTION TIMEOUT
            defaultQueryTimeoutMs: 120000,
            keepAliveIntervalMs: 30000,
            getMessage: async (key) => { return { conversation: 'Vinnie Digital Hub' } }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection, lastDisconnect, receivedPendingNotifications } = update;
            
            // Emit QR as DataURL for robust display on the frontend
            if (qr) {
                const qrData = await QRCode.toDataURL(qr);
                socket.emit('qr', qrData);
            }

            // Monitor sync status
            if (receivedPendingNotifications) {
                console.log("📥 Sync: All pending notifications received.");
                socket.emit('status', '✅ Sync Complete! Finalizing ID...');
            }

            if (connection === 'open') {
                incrementTotal();
                console.log("🚀 CONNECTION OPEN! GENERATING SESSION ID...");
                socket.emit('status', '✅ Connected! Waiting for Sync (60s)...');
                
                try {
                    // 1. Generate Session ID immediately from current credentials
                    await delay(5000); 
                    const credsData = await fs.readJson(path.join(sessionPath, 'creds.json'));
                    const sessionID = "VINNIE-SESSION~" + Buffer.from(JSON.stringify(credsData)).toString('base64');

                    // 2. PRINT TO TERMINAL (DEEP LOGGING)
                    console.log("\n" + "=".repeat(60));
                    console.log("VINNIE DIGITAL HUB - COMRADE'S SESSION ID:");
                    console.log(sessionID);
                    console.log("=".repeat(60) + "\n");

                    // 3. EMIT TO FRONTEND TEXTBOX
                    socket.emit('session-ready', sessionID);

                    // 4. SMART SYNC WAIT: Use either the notification flag OR the safety delay
                    await sock.waitForConnectionUpdate(u => u.receivedPendingNotifications === true);
                    console.log("Waiting 60s safety buffer for heavy group accounts...");
                    await delay(60000); 

                    // 5. SEND STYLED MESSAGES TO WHATSAPP
                    // Raw ID for easy mobile copy-pasting
                    await sock.sendMessage(sock.user.id, { text: sessionID });

                    // Branding Header Message
                    await sock.sendMessage(sock.user.id, { 
                        text: `╔═════════════════════════╗\n║  *SUCCESSFULLY PAIRED!* ║\n╚═════════════════════════╝\n\nYour *Comrade's BOT* ID is ready above.\n\n_Give VINNIE DIGITAL HUB Gigs_\n_and stay hydrated..._ 💧\n\n© 2026 | *Infinite Impact*` 
                    });

                    // 6. IMPROVED NATIVE COPY BUTTON (Using ViewOnce to force rendering)
                    await sock.sendMessage(sock.user.id, {
                        viewOnceMessage: {
                            message: {
                                interactiveMessage: {
                                    header: { title: "Session ID Secured", hasMediaAttachment: false },
                                    body: { text: "Tap the button below to copy your ID instantly! 👇" },
                                    footer: { text: "Comrade's BOT by Vinnie Digital Hub" },
                                    nativeFlowMessage: {
                                        buttons: [{
                                            name: "cta_copy",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "📋 Copy Session ID",
                                                id: "copy_vinnie_id",
                                                copy_code: sessionID
                                            })
                                        }]
                                    }
                                }
                            }
                        }
                    });

                    console.log("✅ ID delivered with Copy Button to WhatsApp Inbox");
                    
                    // Auto-delete session folder after 5 mins to keep the server clean for other users
                    setTimeout(() => fs.remove(sessionPath), 300000);

                } catch (err) {
                    console.log("❌ Error during ID delivery:", err.message);
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut) {
                    console.log("🔄 Connection lost. Reconnecting...");
                    startVinnieGen(phone);
                }
            }
        });

        // Trigger Pairing Code for Phone Number Login (Modern Method)
        if (phone && !state.creds.registered) {
            await delay(5000); // Wait for socket to stabilize
            try {
                const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                socket.emit('pairing-code', code);
                console.log(`🔑 Pairing Code for ${phone}: ${code}`);
            } catch (e) {
                console.log("Pairing code trigger failed. Refresh the page.");
            }
        }
    }

    socket.on('start-pairing', (num) => startVinnieGen(num));
    
    socket.on('disconnect', () => {
        // Update live comrade count when a user leaves the browser tab
        io.emit('stats-update', { total: fs.readJsonSync(statsFile).total, live: io.engine.clientsCount });
    });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`━━━━━━ VINNIE DIGITAL HUB ━━━━━━`);
    console.log(`Backend Robustly Running: http://localhost:${port}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});