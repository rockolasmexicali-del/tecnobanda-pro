const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const db = require('./database');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const chokidar = require('chokidar');

// --- SERVER METADATA ---
const SERVER_VERSION = "3.2.0 (Cloud Optimized)";
const START_TIME = new Date().toISOString();

console.log(`\n=========================================`);
console.log(`🚀 UNIFIED SERVER STARTING...`);
console.log(`📂 Version: ${SERVER_VERSION}`);
console.log(`🕒 Start Time: ${START_TIME}`);
console.log(`=========================================\n`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

// IMPORTANT: Render/Cloud platforms require listening on process.env.PORT
const PORT = process.env.PORT || 3000;

// --- ANTI-CRASH ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ ERROR (Unhandled Rejection):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('\n❌ ERROR (Uncaught Exception):', err.message);
});

// --- GLOBALS & CONFIG ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const INTROS_DIR = path.join(UPLOADS_DIR, 'intros');
const AMBIENT_DIR = path.join(UPLOADS_DIR, 'ambient');
const MUSICA_JSON_PATH = path.join(__dirname, 'musica.json');

// Ensure essential directories exist
[UPLOADS_DIR, INTROS_DIR, AMBIENT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function getConfig() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return {};
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Cloud Path Fix: If we are on Linux (Render), ignore Windows absolute paths
        if (process.platform === 'linux' && config.musicPath && config.musicPath.includes(':')) {
            config.musicPath = 'musica'; // Default to local folder in cloud
        }
        return config;
    } catch (e) {
        return {};
    }
}

function getMusicDir() {
    const config = getConfig();
    let mPath = config.musicPath || 'musica';
    if (!path.isAbsolute(mPath)) mPath = path.join(__dirname, mPath);
    if (!fs.existsSync(mPath)) {
        try { fs.mkdirSync(mPath, { recursive: true }); } catch (e) { }
    }
    return mPath;
}

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log requests for debugging Render
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Servir archivos estáticos
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.static(__dirname)); // Servir la App Principal (index.html, styles.css, etc)

// --- SOCKET LOGIC ---
const otpStore = new Map();

io.on('connection', (socket) => {
    console.log(`[Socket] 🔗 Conexión [${socket.id}]`);

    socket.on('join_user', (email) => {
        if (email) {
            const cleanEmail = email.trim().toLowerCase();
            db.get("SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1", [cleanEmail], (err, user) => {
                if (user) {
                    socket.join(cleanEmail);
                    console.log(`[Socket] 👤 User ${cleanEmail} joined.`);
                }
            });
        }
    });

    socket.on('join_admin', () => {
        socket.join('admin_room');
    });

    socket.on('admin_message', (data) => {
        const { message, target } = data;
        if (target === 'ALL') {
            io.emit('admin_message', { message });
        } else {
            const room = target.trim().toLowerCase();
            io.to(room).emit('admin_message', { message });
        }
    });
});

// --- API ENDPOINTS ---

app.get('/api/health', (req, res) => {
    res.json({ status: "alive", version: SERVER_VERSION, uptime: process.uptime() });
});

app.get('/api/config', (req, res) => {
    res.json(getConfig());
});

app.post('/api/auth/request-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });

    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (!user) return res.status(404).json({ error: "Usuario no registrado" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(email, { otp, expires: Date.now() + 300000 });

        const config = getConfig();
        if (config.emailServer && config.emailServer.user) {
            const transporter = nodemailer.createTransport({
                service: config.emailServer.service || 'gmail',
                auth: { user: config.emailServer.user, pass: config.emailServer.pass },
                tls: { rejectUnauthorized: false }
            });
            try {
                await transporter.sendMail({
                    from: `"${config.emailServer.fromName || 'TecnoBanda'}" <${config.emailServer.user}>`,
                    to: email,
                    subject: 'Tu Clave de Acceso - TecnoBanda',
                    html: `<h1>${otp}</h1><p>Válida por 5 minutos.</p>`
                });
                res.json({ success: true });
            } catch (error) { res.status(500).json({ error: "Error de email" }); }
        } else {
            res.status(500).json({ error: "Email no configurado" });
        }
    });
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp, deviceId, referralCode } = req.body;
    const stored = otpStore.get(email);
    if (stored && stored.otp === otp && stored.expires > Date.now()) {
        otpStore.delete(email);
        const cleanEmail = email.trim().toLowerCase();
        db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, user) => {
            if (user) {
                res.json({ success: true, user: { name: user.name, email: user.email, referralCode: user.referral_code } });
            } else {
                const myCode = "TB-" + Math.random().toString(36).substr(2, 5).toUpperCase();
                db.run("INSERT INTO users (name, email, device_id, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)",
                    ['Usuario', cleanEmail, deviceId, myCode, referralCode], () => {
                        res.json({ success: true, user: { name: 'Usuario', email: cleanEmail, referralCode: myCode } });
                    });
            }
        });
    } else res.status(401).json({ error: "Clave incorrecta" });
});

app.post('/api/ping', (req, res) => {
    const { deviceId, email } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });
    db.get("SELECT * FROM licenses WHERE user_email = ? AND original_device_id = ? AND status='USED'", [email.toLowerCase(), deviceId], (err, lic) => {
        if (!lic) return res.json({ status: "inactive" });
        res.json({ status: "active", type: lic.type, expiresAt: lic.expires_at });
    });
});

// Static Fallback for SPA
app.get('*', (req, res, next) => {
    if (req.url.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start listening on 0.0.0.0 to ensure external availability in cloud
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    =============================================
    ✅ UNIFIED SERVER V3.2 (CLOUD)
    =============================================
    PORT: ${PORT}
    URL : http://0.0.0.0:${PORT}
    =============================================
    `);
});
