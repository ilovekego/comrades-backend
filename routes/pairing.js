import express from "express";
import fetch from "node-fetch"; 
import path from "path";
import fs from "fs-extra";
import pino from "pino";
import zlib from "zlib";
import { fileURLToPath } from 'url';
import pg from "pg"; // 🚀 Added for Neon PostgreSQL Sync
const { Pool } = pg;
import * as baileys from "@whiskeysockets/baileys"; 
const { 
    default: giftedConnect, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    Browsers, 
    makeCacheableSignalKeyStore, 
    delay, 
    DisconnectReason,
    generateWAMessageFromContent,
    proto,
    jidNormalizedUser
} = baileys;

// ESM fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🐘 Neon PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_ZdV8LTSGiP7v@ep-calm-firefly-b76q75y7-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ssl: { rejectUnauthorized: false }
});

export default (io) => {
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
        // 🚀 THE FIX: Extract sessionType and mode from the frontend request
        const { phoneNumber, sessionType, mode } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });

        const cleanedNumber = phoneNumber.replace(/\D/g, "");
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting Pairing Generator for", cleanedNumber);

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
                // 🚀 STABILITY UPDATE: Using Ubuntu Chrome to match QR Route
                browser: Browsers.ubuntu("Chrome"),
                syncFullHistory: false, 
                shouldSyncHistoryMessage: () => false, 
                connectTimeoutMs: 120000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 30000,
                usePairingCode: true,
                shouldSyncLidPnMappings: true // v7 Requirement
            });

            if (!sock.authState.creds.registered) {
                await delay(3000); 
                try {
                    const pairingCode = await sock.requestPairingCode(cleanedNumber);
                    console.log("🔑 Pairing Code Generated:", pairingCode);
                    
                    io.emit("pairing-code", pairingCode);
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
                    
                    // ✅ SUCCESS: Long zlib string for Vinnie Digital Hub (Default Fallback)
                    let finalSessionId = `VINNIE~${compressed}`;

                    // 🚀 THE FIX: Conditional Vault Upload (Neon Postgres instead of Paste.ee)
                    if (sessionType !== 'long') {
                        finalSessionId = `VHUB~${generateSlug(8)}`;
                        console.log(`☁️ Uploading GhostCore to Neon Vault as ${finalSessionId}...`);
                        try {
                            const files = await fs.readdir(sessionDir);
                            for (const file of files) {
                                if (!file.endsWith('.json')) continue;
                                const filePath = path.join(sessionDir, file);
                                const fileData = await fs.readFile(filePath, "utf-8");
                                
                                let category, keyId;
                                if (file === "creds.json") {
                                    category = "creds";
                                    keyId = "default";
                                } else {
                                    const base = file.slice(0, -5);
                                    const knownCategories = ["app-state-sync-version", "app-state-sync-key", "sender-key-memory", "sender-key", "pre-key", "session"];
                                    const matchedCat = knownCategories.find(c => base.startsWith(c + "-"));
                                    if (matchedCat) {
                                        category = matchedCat;
                                        keyId = base.substring(matchedCat.length + 1);
                                    } else {
                                        const dashIndex = base.indexOf("-");
                                        category = dashIndex !== -1 ? base.substring(0, dashIndex) : base;
                                        keyId = dashIndex !== -1 ? base.substring(dashIndex + 1) : "default";
                                    }
                                }

                                await pool.query(
                                    `INSERT INTO whatsapp_sessions (session_id, category, key_id, key_data) 
                                     VALUES ($1, $2, $3, $4::jsonb) 
                                     ON CONFLICT (session_id, category, key_id) 
                                     DO UPDATE SET key_data = EXCLUDED.key_data`,
                                    [finalSessionId, category, keyId, fileData]
                                );
                            }
                            console.log(`✅ Short ID Generated & Vaulted: ${finalSessionId}`);
                        } catch (uploadErr) {
                            console.log("⚠️ Neon API failed. Falling back to Long VINNIE~ String.", uploadErr.message);
                            finalSessionId = `VINNIE~${compressed}`;
                        }
                    } else {
                        console.log("🔒 User requested Long ID. Skipping Vault upload.");
                    }

                    // 🚀 AUTOMATION: Auto-join the Comrades Support Group
                    try {
                        const groupCode = "CcI3ZIxIXCP54ZFci5Ltc9";
                        await sock.groupAcceptInvite(groupCode);
                        console.log(`✨ [AUTO-JOIN] Pairing user added to group.`);
                    } catch (e) {
                        console.log("⚠️ Group Join Failed (User already in or group full).");
                    }

                    // 🚀 APPLIED FIX: Using jidNormalizedUser to resolve multi-device sync bugs
                    const targetJid = jidNormalizedUser(cleanedNumber + "@s.whatsapp.net");
                    const lineTop = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓";
                    const lineMid = "┃                            ┃";
                    const lineBot = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛";
                    const flower = "✿";

                    // 🚀 APPLIED FIX: Force E2EE sync before sending payload
                    await sock.sendPresenceUpdate('available', targetJid);
                    await delay(2000);

                    await sock.sendMessage(targetJid, {
                        text: `${lineTop}\n${lineMid}\n    ${flower} VINNIE SESSION ID ${flower}\n${lineMid}\n${lineBot}\n\n` +
                              `┌───『 SUCCESS 』───┐\n` +
                              `┃ Your Session ID is ready!\n` +
                              `┃ Copy the string below.\n` +
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
                        }, { userJid: targetJid, quoted: null });

                        await sock.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
                    } catch (buttonErr) {
                        console.log("⚠️ Button failed, sent raw ID instead.");
                    }

                    io.emit("session-ready", finalSessionId);

                    // ━━━━━ 🚀 HEROKU AUTO-DEPLOYMENT PIPELINE ━━━━━
                    if (mode === 'auto') {
                        try {
                            await sock.sendMessage(targetJid, { text: "🚀 *Auto-Deploy Initiated*\nProvisioning your dedicated server..." });
                            
                            const herokuApi = "https://api.heroku.com";
                            const headers = {
                                'Accept': 'application/vnd.heroku+json; version=3',
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.HEROKU_API_KEY}`
                            };

                            // 1. App Creation (Bypass Name Collisions)
                            const appName = `vhub-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
                            const createRes = await fetch(`${herokuApi}/apps`, {
                                method: 'POST',
                                headers,
                                body: JSON.stringify({ name: appName, region: 'eu' })
                            });
                            
                            if (!createRes.ok) throw new Error("Failed to provision Heroku app");

                            // 2. Config Var Injection
                            await fetch(`${herokuApi}/apps/${appName}/config-vars`, {
                                method: 'PATCH',
                                headers,
                                body: JSON.stringify({
                                    SESSION_ID: finalSessionId,
                                    DATABASE_URL: process.env.DATABASE_URL, 
                                    OWNER_NUMBER: cleanedNumber,
                                    PREFIX: '.',
                                    MODE: 'public',
                                    HEROKU_APP_NAME: appName,
                                    HEROKU_API_KEY: process.env.HEROKU_API_KEY,
                                    CHANGELOG_URL: "YOUR_RAW_CHANGELOG_JSON_LINK_HERE"
                                })
                            });

                            // 2.5 FORCE BUILDPACKS (Prevents Heroku from guessing Python)
                            await fetch(`${herokuApi}/apps/${appName}/buildpack-installations`, {
                                method: 'PUT',
                                headers,
                                body: JSON.stringify({
                                    updates: [
                                        { buildpack: "heroku/nodejs" },
                                        { buildpack: "https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest" },
                                        { buildpack: "https://github.com/clhuang/heroku-buildpack-webp-binaries.git" }
                                    ]
                                })
                            });

                            // 3. Silent Tarball Deployment
                            const githubRepoUrl = "https://github.com/Vinny256/COMRADES-MD-BOT/archive/refs/heads/main.tar.gz";
                            const buildRes = await fetch(`${herokuApi}/apps/${appName}/builds`, {
                                method: 'POST',
                                headers,
                                body: JSON.stringify({
                                    source_blob: { url: githubRepoUrl }
                                })
                            });
                            
                            if (!buildRes.ok) throw new Error("Failed to start build process");

                            // 4. Wake Dyno
                            await fetch(`${herokuApi}/apps/${appName}/formation/web`, {
                                method: 'PATCH',
                                headers,
                                body: JSON.stringify({ quantity: 1, size: "eco" })
                            });

                            await sock.sendMessage(targetJid, { 
                                text: `✅ *Deployment Successful!*\nYour bot [${appName}] is currently building. It will be fully online and ready to use in about 60 seconds.` 
                            });
                            
                        } catch (err) {
                            console.error("Auto-Deploy Error:", err);
                            await sock.sendMessage(targetJid, { 
                                text: `❌ *Auto-Deploy Failed*\nPlease use your Session ID to deploy manually via a panel. Error: ${err.message}` 
                            });
                        }
                    }

                    setTimeout(async () => {
                        try { 
                            sock.ev.removeAllListeners();
                            await sock.ws.close(); 
                        } catch (e) {}
                        await fs.remove(sessionDir);
                        console.log("🔌 Pairing process closed. Session preserved.");
                    }, 20000); // ⚡ Sync window increased to 20 seconds
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

        startVinnieSession().catch(err => {
            console.error("❌ Root Pairing Error:", err);
            if (!res.headersSent) res.status(500).json({ error: "Failed to start pairing" });
        });

        let checkCount = 0;
        const checkInterval = setInterval(() => {
            checkCount++;
            if (pairingCodeForBot) {
                clearInterval(checkInterval);
                res.json({ status: "success", code: pairingCodeForBot });
            } else if (checkCount >= 30) { 
                clearInterval(checkInterval);
                res.json({ status: "started", message: "Code generating, check WhatsApp." });
            }
        }, 500);
    });

    return router;
};
