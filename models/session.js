const mongoose = require("mongoose");

const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, unique: true },
    fullCreds: String,
    createdAt: { type: Date, default: Date.now, expires: "30d" }
});

module.exports = mongoose.model("VinnieSession", SessionSchema);
