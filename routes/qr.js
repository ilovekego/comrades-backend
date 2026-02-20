const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs-extra");
const pino = require("pino");
const zlib = require("zlib");
const { default: giftedConnect, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore, delay } = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGO_URI; // add your MongoDB URI in .env
const client = new MongoClient(mongoUri);

module.exports = (io) => {
    const router = express.Router();
    const sessionDirBase = path.join(__dirname, "../session");

    router.post("/", async (req, res) => {
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting stable QR Generator...");

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = giftedConnect({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            shouldIgnoreJid: jid => !!jid?.endsWith("@g.us"),
            getMessage: async () => undefined
        });

        sock.ev.on("creds.update", saveCreds);

        let qrSent = false;

        sock.ev.on("connection.update", async (update) => {
            const { connection, qr, lastDisconnect } = update;
            console.log("📡 Connection Update:", update);

            if (qr && !qrSent) {
                const qrDataUrl = await QRCode.toDataURL(qr, { scale: 4 });
                io.emit("qr", qrDataUrl);
                console.log("📡 QR emitted to frontend.");
                qrSent = true;
            }

            if (connection === "open") {
                console.log("✅ Connected to WhatsApp!");

                // Compress and encode session
                const credsFilePath = path.join(sessionDir, "creds.json");
                const credsData = await fs.readFile(credsFilePath);
                const compressed = zlib.gzipSync(credsData);
                const sessionText = "VINNIE~" + compressed.toString("base64");

                // Store in MongoDB
                await client.connect();
                const db = client.db("vinnieBot");
                const sessions = db.collection("sessions");
                await sessions.insertOne({
                    key: sessionText.split("~")[1].slice(0, 10), // short identifier for lookup
                    session: sessionText,
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) // expires in 2 hours
                });

                // Send to self (debug)
                await sock.sendMessage(sock.user.id, {
                    text: `🔑 *Your VINNIE Session ID:*\n────────────────────\n${sessionText}\n────────────────────\nValid for 2 hours. Copy it and deploy!`
                });

                // Auto logout after 2 minutes
                setTimeout(async () => {
                    await sock.logout().catch(() => {});
                    await fs.remove(sessionDir);
                    console.log("🗑️ Temporary session folder removed.");
                }, 2 * 60 * 1000);
            }

            if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) {
                console.log("🔄 Reconnecting...");
                await delay(5000);
                router.post("/"); // restart QR generator
            }
        });

        res.json({ status: "Stable QR Generator started. Scan the QR code in frontend." });
    });

    return router;
};