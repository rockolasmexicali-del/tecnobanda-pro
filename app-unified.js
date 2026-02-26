const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const db = require('./database');

const SERVER_VERSION = "4.0.0 (The Final Boss)";
const PORT = process.env.PORT || 3000;

console.log(`\n=========================================`);
console.log(`🚀 UNIFIED CLOUD SERVER v${SERVER_VERSION}`);
console.log(`=========================================\n`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

function getConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
    catch (e) { return {}; }
}

// --- SEED & AUTO-RECOVERY ---
function seedMasterLicenses() {
    const config = getConfig();
    if (config.masterLicenses) {
        config.masterLicenses.forEach(lic => {
            db.run("INSERT OR IGNORE INTO licenses (key, type, status) VALUES (?, ?, 'UNUSED')", [lic.key, lic.type]);
        });
    }
}

// --- API PUBLIC ---
app.post('/api/ping', (req, res) => {
    const { deviceId, email, name } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });
    const cleanEmail = email.toLowerCase().trim();
    db.run("INSERT OR IGNORE INTO users (name, email, device_id, last_seen) VALUES (?, ?, ?, CURRENT_TIMESTAMP)", [name || 'Usuario', cleanEmail, deviceId]);
    db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE LOWER(email) = ?", [cleanEmail]);
    db.get("SELECT * FROM licenses WHERE LOWER(user_email) = ? AND original_device_id = ? AND status='USED' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY expires_at DESC LIMIT 1",
        [cleanEmail, deviceId], (err, lic) => {
            if (!lic) return res.json({ status: "inactive" });
            res.json({ status: "active", type: lic.type, expiresAt: lic.expires_at });
        });
});

app.post('/api/activate', (req, res) => {
    const { key, deviceId, email } = req.body;
    db.get("SELECT * FROM licenses WHERE key = ? AND status='UNUSED'", [key], (err, lic) => {
        if (!lic) return res.status(400).json({ error: "Llave inválida" });
        let exp = null; const now = new Date();
        if (lic.type === '1_DAY') exp = new Date(now.getTime() + 86400000).toISOString();
        else if (lic.type === '30_DAYS') exp = new Date(now.getTime() + 2592000000).toISOString();
        else exp = new Date(2099, 0, 1).toISOString();
        db.run("UPDATE licenses SET status='USED', user_email=?, expires_at=?, original_device_id=? WHERE key=?", [email.toLowerCase(), exp, deviceId, key], () => {
            db.run("INSERT INTO activations (license_key, device_id, price_paid) VALUES (?, ?, ?)", [key, deviceId, 0]);
            res.json({ success: true, type: lic.type, expiresAt: exp });
        });
    });
});

// --- API ADMIN (ALL MODULES) ---
app.get('/api/admin/stats', (req, res) => {
    db.get("SELECT COUNT(*) as u, (SELECT SUM(price_paid) FROM activations) as i FROM users", (e, row) => {
        res.json({ weeklyUsers: row.u || 0, totalUsers: row.u || 0, weeklyIncome: row.i || 0 });
    });
});

app.get('/api/admin/users', (req, res) => {
    db.all(`SELECT u.*, l.type as license_type, l.expires_at FROM users u LEFT JOIN licenses l ON u.email = l.user_email AND u.device_id = l.original_device_id AND l.status='USED' ORDER BY u.last_seen DESC`, (err, rows) => res.json(rows || []));
});

app.post('/api/admin/generate', (req, res) => {
    const { type, count } = req.body;
    const keys = [];
    for (let i = 0; i < (count || 1); i++) {
        const key = "TB-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        db.run("INSERT INTO licenses (key, type, status) VALUES (?, ?, 'UNUSED')", [key, type]);
        keys.push(key);
    }
    res.json({ success: true, keys });
});

app.get('/api/admin/active-licenses', (req, res) => db.all("SELECT * FROM licenses ORDER BY status DESC", (err, rows) => res.json(rows || [])));
app.get('/api/admin/audios/:type', (req, res) => {
    const dir = path.join(__dirname, 'uploads', req.params.type);
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir).map(f => ({ name: f, url: `/uploads/${req.params.type}/${f}` })));
});

app.get('/api/proxy-sync', async (req, res) => {
    try { const r = await fetch(req.query.url); res.json(await r.json()); }
    catch (e) { res.status(500).json({ error: "Offline" }); }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ SERVER 4.0.0 READY!`);
    seedMasterLicenses();
});
