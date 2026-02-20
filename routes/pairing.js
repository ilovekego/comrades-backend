const express = require("express");
const path = require("path");
const fs = require("fs-extra");
const pino = require("pino");
const zlib = require("zlib");
const {
    default: giftedConnect,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore,
    delay,
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);

module.exports = (io) => {
    const router = express.Router();
    const sessionDirBase = path.join(__dirname, "../session");

    router.post("/", async (req, res) => {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });

        const cleanedNumber = phoneNumber.replace(/\D/g, "");
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting Pairing Generator for", cleanedNumber);

        // --- ⚙️ REUSABLE CONNECTION FUNCTION ---
        async function startVinnieSession() {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = giftedConnect({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
                },
                // 📝 ENABLE FULL LOGGING
                logger: pino({ level: "debug" }), 
                browser: Browsers.macOS("Safari"),
                syncFullHistory: false, 
                shouldSyncHistoryMessage: () => false, 
                connectTimeoutMs: 120000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 30000,
                usePairingCode: true 
            });

            // Handle pairing code request
            if (!state.creds.registered) {
                setTimeout(async () => {
                    try {
                        const pairingCode = await sock.requestPairingCode(cleanedNumber);
                        console.log("🔑 Pairing Code Generated:", pairingCode);
                        io.emit("pairing-code", pairingCode);
                    } catch (pairingErr) {
                        console.error("❌ Pairing Code Error:", pairingErr.message);
                    }
                }, 7000); // Handshake buffer
            }

            sock.ev.on("creds.update", saveCreds);

            let sessionSent = false;

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;
                
                // Detailed logging for every state
                console.log("📡 [BAILEYS_EVENT]:", JSON.stringify(update, null, 2));

                if (connection === "open") {
                    console.log("✅ SUCCESS: Connected to WhatsApp!");
                    if (sessionSent) return;
                    sessionSent = true;

                    await delay(10000); // Key flush wait

                    const credsFile = path.join(sessionDir, "creds.json");
                    const credsData = await fs.readFile(credsFile);
                    const compressed = zlib.gzipSync(credsData);
                    const sessionText = "VINNIE~" + compressed.toString("base64");

                    await client.connect();
                    const db = client.db("vinnieBot");
                    const sessions = db.collection("sessions");
                    const shortKey = sessionText.split("~")[1].slice(0, 10);

                    await sessions.insertOne({
                        key: shortKey,
                        session: sessionText,
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) 
                    });

                    const targetJid = cleanedNumber + "@s.whatsapp.net";
                    await sock.sendMessage(targetJid, {
                        text: `╔══════════════════════╗\n║       VINNIE SESSION      ║\n╚══════════════════════╝\n\nYour Session ID:\n\n${sessionText}\n\nPowered by Vinnie Digital Hub`
                    });

                    await sock.sendMessage(targetJid, {
                        interactiveMessage: {
                            body: { text: "Tap below to copy your Session ID instantly! 👇" },
                            footer: { text: "Vinnie Digital Hub Security" },
                            nativeFlowMessage: {
                                buttons: [{
                                    name: "cta_copy",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📋 Copy Session ID",
                                        copy_code: sessionText
                                    })
                                }]
                            }
                        }
                    }, { viewOnce: true });

                    io.emit("session-ready", shortKey);

                    setTimeout(async () => {
                        try { await sock.logout(); } catch (e) {}
                        await fs.remove(sessionDir);
                    }, 2 * 60 * 1000);
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    
                    let reasonMsg = "Unknown Error";
                    if (reason === DisconnectReason.loggedOut) reasonMsg = "Device Logged Out";
                    else if (reason === DisconnectReason.connectionClosed) reasonMsg = "Server Closed Connection";
                    else if (reason === DisconnectReason.connectionLost) reasonMsg = "Network Connection Lost";
                    else if (reason === DisconnectReason.timedOut) reasonMsg = "Connection Timed Out";
                    else if (reason === DisconnectReason.restartRequired) reasonMsg = "Restart Required (Stream Error)";
                    else if (reason === DisconnectReason.badSession) reasonMsg = "Bad Session File";

                    console.log(`❌ Connection Failed | Reason: ${reasonMsg} (${reason})`);

                    // 🚀 CRITICAL: AUTO-RESTART FOR 515 ERRORS
                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.connectionClosed) {
                        console.log("🔄 Stable Restarting... (Resuming session generation)");
                        startVinnieSession(); // Reboot the socket
                    } else if (reason !== DisconnectReason.loggedOut && !sessionSent) {
                        console.log("🔄 Generic Reconnect...");
                        startVinnieSession();
                    } else if (reason === DisconnectReason.loggedOut) {
                        await fs.remove(sessionDir);
                    }
                }
            });
        }

        // Start the process
        startVinnieSession().catch(err => {
            console.error("❌ Root Pairing Error:", err);
            res.status(500).json({ error: "Failed to start pairing" });
        });

        res.json({
            status: "Pairing process started",
            message: "Enter the pairing code in WhatsApp."
        });
    });

    return router;
};