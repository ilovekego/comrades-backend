const mongoose = require("mongoose");

const SessionSchema = new mongoose.Schema({
    // We keep the short ID for easy lookups
    sessionId: { 
        type: String, 
        unique: true, 
        required: true,
        index: true // 🚀 Added indexing for instant retrieval
    },
    // The actual Base64 string of the creds.json
    fullCreds: { 
        type: String, 
        required: true 
    },
    // Automatic cleanup after 30 days
    createdAt: { 
        type: Date, 
        default: Date.now, 
        expires: 2592000 // 30 days in seconds (Mongoose standard)
    }
});

// Clean Small-Caps Log for Terminal
SessionSchema.post('save', function(doc) {
    console.log(`📑 [DB_LOG]: sᴇssɪᴏɴ_sᴀᴠᴇᴅ -> ${doc.sessionId}`);
});

module.exports = mongoose.model("VinnieSession", SessionSchema);
