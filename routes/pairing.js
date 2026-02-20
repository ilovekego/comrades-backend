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

    // --- 🛠️ HELPER: Generate Random 10 Chars ---
    const generateSlug = (length = 10) => {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    };

    router.post("/", async (req, res) => {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });

        const cleanedNumber = phoneNumber.replace(/\D/g, "");
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting Pairing Generator for", cleanedNumber);

        async function startVinnieSession() {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = giftedConnect({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
                },
                logger: pino({ level: "debug" }), 
                browser: Browsers.macOS("Safari"),
                syncFullHistory: false, 
                shouldSyncHistoryMessage: () => false, 
                connectTimeoutMs: 120000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 30000,
                usePairingCode: true 
            });

            if (!state.creds.registered) {
                setTimeout(async () => {
                    try {
                        const pairingCode = await sock.requestPairingCode(cleanedNumber);
                        console.log("🔑 Pairing Code Generated:", pairingCode);
                        io.emit("pairing-code", pairingCode);
                    } catch (pairingErr) {
                        console.error("❌ Pairing Code Error:", pairingErr.message);
                    }
                }, 7000);
            }

            sock.ev.on("creds.update", saveCreds);

            let sessionSent = false;

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;
                console.log("📡 [BAILEYS_EVENT]:", JSON.stringify(update, null, 2));

                if (connection === "open") {
                    if (sessionSent) return;
                    sessionSent = true;

                    await delay(10000); 

                    // 1️⃣ COMPRESS EVERYTHING (ZLIB)
                    const credsFile = path.join(sessionDir, "creds.json");
                    const credsData = await fs.readFile(credsFile, "utf-8");
                    const compressed = zlib.deflateSync(credsData).toString("base64");
                    
                    // 2️⃣ FORMAT TO 10 CHARACTERS
                    const uniqueId = generateSlug(10);
                    const finalSessionId = `VINNIE~${uniqueId}`;

                    // 3️⃣ SAVE TO MONGODB (WITH 2HR TTL)
                    try {
                        await client.connect();
                        const db = client.db("vinnieBot");
                        const sessions = db.collection("sessions");
                        await sessions.createIndex({ "createdAt": 1 }, { expireAfterSeconds: 7200 });

                        await sessions.insertOne({
                            sessionId: finalSessionId,
                            data: compressed,
                            createdAt: new Date(),
                            status: "active"
                        });
                    } catch (dbErr) {
                        console.error("❌ MongoDB Error:", dbErr);
                    }

                    // 4️⃣ SEND STYLIZED MESSAGES (FLORAL/LINES)
                    const targetJid = cleanedNumber + "@s.whatsapp.net";
                    const lineTop = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓";
                    const lineMid = "┃                            ┃";
                    const lineBot = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛";
                    const flower = "✿";

                    // MESSAGE A: The Header
                    await sock.sendMessage(targetJid, {
                        text: `${lineTop}\n${lineMid}\n    ${flower} VINNIE SESSION ID ${flower}\n${lineMid}\n${lineBot}\n\n` +
                              `┌───『 SUCCESS 』───┐\n` +
                              `┃ Your Session ID is ready!\n` +
                              `┃ It will expire in 2 hours.\n` +
                              `└───────────────────┘`
                    });

                    // MESSAGE B: The Raw ID (Easy to copy manually)
                    await sock.sendMessage(targetJid, { text: finalSessionId });

                    // MESSAGE C: The Copy Button (Interactive)
                    await sock.sendMessage(targetJid, {
                        viewOnce: true,
                        interactiveMessage: {
                            header: { hasMediaAttachment: false },
                            body: { text: "Tap the button below to copy your Session ID to clipboard instantly." },
                            footer: { text: "Powered by Vinnie Digital Hub" },
                            nativeFlowMessage: {
                                buttons: [{
                                    name: "cta_copy",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📋 COPY SESSION ID",
                                        copy_code: finalSessionId
                                    })
                                }]
                            }
                        }
                    });

                    io.emit("session-ready", finalSessionId);

                    setTimeout(async () => {
                        try { await sock.logout(); } catch (e) {}
                        await fs.remove(sessionDir);
                    }, 5000);
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.connectionClosed) {
                        console.log("🔄 Stable Restarting...");
                        startVinnieSession();
                    } else if (reason !== DisconnectReason.loggedOut && !sessionSent) {
                        startVinnieSession();
                    } else if (reason === DisconnectReason.loggedOut) {
                        await fs.remove(sessionDir);
                    }
                }
            });
        }

        startVinnieSession().catch(err => {
            console.error("❌ Root Pairing Error:", err);
            res.status(500).json({ error: "Failed to start pairing" });
        });

        res.json({ status: "Pairing process started" });
    });

    return router;
};
