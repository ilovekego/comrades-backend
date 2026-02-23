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
    DisconnectReason,
    generateWAMessageFromContent,
    proto 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);

module.exports = (io) => {
    const router = express.Router();
    const sessionDirBase = path.join(__dirname, "../session");

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

        // --- NEW WRAPPER TO CAPTURE CODE FOR BOT ---
        let pairingCodeForBot = null;

        async function startVinnieSession() {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = giftedConnect({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
                },
                logger: pino({ level: "fatal" }),
                browser: Browsers.macOS("Safari"),
                syncFullHistory: false, 
                shouldSyncHistoryMessage: () => false, 
                connectTimeoutMs: 120000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 30000,
                usePairingCode: true 
            });

            if (!sock.authState.creds.registered) {
                await delay(3000); 
                try {
                    const pairingCode = await sock.requestPairingCode(cleanedNumber);
                    console.log("🔑 Pairing Code Generated:", pairingCode);
                    
                    // Keep existing web emission
                    io.emit("pairing-code", pairingCode);
                    
                    // Capture for HTTP response
                    pairingCodeForBot = pairingCode;

                } catch (pairingErr) {
                    console.error("❌ Pairing Code Error:", pairingErr.message);
                }
            }

            sock.ev.on("creds.update", saveCreds);

            let sessionSent = false;

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === "open") {
                    if (sessionSent) return;
                    sessionSent = true;

                    await delay(5000); 

                    const credsFile = path.join(sessionDir, "creds.json");
                    const credsData = await fs.readFile(credsFile, "utf-8");
                    const compressed = zlib.deflateSync(credsData).toString("base64");
                    
                    const uniqueId = generateSlug(10);
                    const finalSessionId = `VINNIE~${uniqueId}`;

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

                    const targetJid = cleanedNumber + "@s.whatsapp.net";
                    const lineTop = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓";
                    const lineMid = "┃                            ┃";
                    const lineBot = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛";
                    const flower = "✿";

                    await sock.sendMessage(targetJid, {
                        text: `${lineTop}\n${lineMid}\n    ${flower} VINNIE SESSION ID ${flower}\n${lineMid}\n${lineBot}\n\n` +
                              `┌───『 SUCCESS 』───┐\n` +
                              `┃ Your Session ID is ready!\n` +
                              `┃ It will expire in 2 hours.\n` +
                              `└───────────────────┘`
                    });

                    await sock.sendMessage(targetJid, { text: finalSessionId });

                    try {
                        let msg = generateWAMessageFromContent(targetJid, {
                            viewOnceMessage: {
                                message: {
                                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                        body: proto.Message.InteractiveMessage.Body.fromObject({
                                            text: "Tap the button below to copy your Session ID to clipboard instantly."
                                        }),
                                        footer: proto.Message.InteractiveMessage.Footer.fromObject({
                                            text: "Powered by Vinnie Digital Hub"
                                        }),
                                        header: proto.Message.InteractiveMessage.Header.fromObject({
                                            hasMediaAttachment: false
                                        }),
                                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                                            buttons: [{
                                                name: "cta_copy",
                                                buttonParamsJson: JSON.stringify({
                                                    display_text: "📋 COPY SESSION ID",
                                                    copy_code: finalSessionId
                                                })
                                            }]
                                        })
                                    })
                                }
                            }
                        }, { userJid: targetJid });

                        await sock.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
                    } catch (buttonErr) {
                        console.log("⚠️ Button failed, sent raw ID instead.");
                    }

                    io.emit("session-ready", finalSessionId);

                    setTimeout(async () => {
                        try { 
                            sock.ev.removeAllListeners();
                            await sock.ws.close(); 
                        } catch (e) {}
                        await fs.remove(sessionDir);
                        console.log("🔌 Pairing process closed. Session preserved.");
                    }, 5000);
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.connectionClosed) {
                        startVinnieSession();
                    } else if (reason !== DisconnectReason.loggedOut && !sessionSent) {
                        startVinnieSession();
                    }
                }
            });
        }

        // --- EXECUTION LOGIC ---
        startVinnieSession().catch(err => {
            console.error("❌ Root Pairing Error:", err);
            if (!res.headersSent) res.status(500).json({ error: "Failed to start pairing" });
        });

        // Wait up to 15 seconds for the pairing code to be generated so we can return it to the bot
        let checkCount = 0;
        const checkInterval = setInterval(() => {
            checkCount++;
            if (pairingCodeForBot) {
                clearInterval(checkInterval);
                res.json({ status: "success", code: pairingCodeForBot });
            } else if (checkCount >= 30) { // 15 seconds timeout (30 * 500ms)
                clearInterval(checkInterval);
                res.json({ status: "started", message: "Code generating, check WhatsApp." });
            }
        }, 500);
    });

    return router;
};
