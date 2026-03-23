import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

// --- ESM FIX FOR __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- IMPORT ROUTES (Note the .js extension is REQUIRED in ESM) ---
import qrRoute from './routes/qr.js';
import pairingRoute from './routes/pairing.js';

const app = express();
const server = http.createServer(app);

// 🛡️ Robust Socket.io Setup (Supports Vercel/Local)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'] // Flexibility for hosting
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 📡 DEEP LOGGING & FRONTEND SYNC ---
io.on('connection', (socket) => {
    // This logs to your terminal/hosting logs
    console.log(`\n📡 [FRONTEND_CONNECT]: Client ID -> ${socket.id}`);
    console.log(`🌍 [REMOTE_ADDR]: ${socket.handshake.address}`);
    
    // Send a "deep-check" to the frontend immediately
    socket.emit('deep-check', {
        status: 'Online',
        serverTime: new Date().toISOString(),
        transport: socket.conn.transport.name
    });

    socket.on('disconnect', (reason) => {
        console.log(`\n📴 [FRONTEND_DISCONNECT]: Client ${socket.id} left. Reason: ${reason}`);
    });

    // Error logging for the socket itself
    socket.on('error', (err) => {
        console.error(`❌ [SOCKET_ERROR] ID ${socket.id}:`, err);
    });
});

// --- 🚀 ROUTE BINDING ---
// We pass (io) so the routes can emit events back to the frontend
app.use('/start-qr', qrRoute(io));
app.use('/start-pairing', pairingRoute(io));

// Test Endpoint
app.get('/', (req, res) => {
    res.status(200).send('Vinnie Bot Generator Running...');
});

// --- 🌍 SERVER BOOT ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n━━━━━━ VINNIE DIGITAL HUB ━━━━━━`);
    console.log(`✅ SERVER: Active`);
    console.log(`🚀 PORT: ${PORT}`);
    console.log(`🔗 LOCAL: http://localhost:${PORT}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
