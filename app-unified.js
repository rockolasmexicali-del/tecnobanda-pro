const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const db = require('./database');
const multer = require('multer');

// --- SERVER METADATA ---
const SERVER_VERSION = "4.7.0 (Ultimate Cloud Suite)";
const START_TIME = new Date().toISOString();

console.log(`\n=========================================`);
console.log(`🚀 UNIFIED CLOUD SERVER v${SERVER_VERSION}`);
console.log(`🕒 Start Time: ${START_TIME}`);
console.log(`=========================================\n`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// --- DIRECTORIOS ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const INTROS_DIR = path.join(UPLOADS_DIR, 'intros');
const AMBIENT_DIR = path.join(UPLOADS_DIR, 'ambient');
const MUSICA_JSON_PATH = path.join(__dirname, 'musica.json');

[UPLOADS_DIR, INTROS_DIR, AMBIENT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging
app.use((req, res, next) => {
    if (!req.url.includes('/api/health')) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    }
    next();
});

// Servir archivos
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.static(__dirname));

// --- HELPERS ---
function getConfig() {
    try {
        const p = path.join(__dirname, 'config.json');
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { return {}; }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4));
        return true;
    } catch (e) { return false; }
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    console.log(`[Socket] Nuevo cliente: ${socket.id}`);

    socket.on('join_admin', () => {
        socket.join('admin_room');
        console.log(`[Socket] ${socket.id} se unió a admin_room`);
    });

    socket.on('join_user', (email) => {
        if (email) {
            socket.join(email.toLowerCase());
            console.log(`[Socket] ${socket.id} (User: ${email}) se unió a su sala propia`);
        }
    });

    socket.on('admin_message', (data) => {
        const { message, target } = data;
        if (target === 'ALL') {
            io.emit('admin_message', { message, timestamp: new Date().toISOString() });
        } else {
            io.to(target.toLowerCase()).emit('admin_message', { message, timestamp: new Date().toISOString() });
        }
    });
});

// --- API: PUBLIC & STATUS ---
app.get('/api/health', (req, res) => {
    res.json({
        status: "alive",
        version: SERVER_VERSION,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/config', (req, res) => res.json(getConfig()));

app.get('/api/proxy-sync', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("Falta URL");
    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        if (fs.existsSync(MUSICA_JSON_PATH)) {
            return res.json(JSON.parse(fs.readFileSync(MUSICA_JSON_PATH, 'utf8')));
        }
        res.status(500).json({ error: e.message });
    }
});

// --- API: AUTH & PING (AUTO-RECOVERY) ---
app.post('/api/ping', (req, res) => {
    const { deviceId, email, name } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });

    const cleanEmail = email.toLowerCase().trim();

    // AUTO-RECOVERY: Si el usuario no está en la DB (por reinicio de Render), lo insertamos
    db.get("SELECT id FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (name, email, device_id, last_seen) VALUES (?, ?, ?, CURRENT_TIMESTAMP)", [name || 'Usuario', cleanEmail, deviceId]);
            console.log(`[Auto-Reg] Usuario ${cleanEmail} (Dispositivo: ${deviceId}) recuperado/registrado.`);
            io.emit('update_users');
        } else {
            db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        }

        db.get("SELECT * FROM licenses WHERE LOWER(user_email) = ? AND original_device_id = ? AND status='USED' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY expires_at DESC LIMIT 1",
            [cleanEmail, deviceId], (err, lic) => {
                if (!lic) return res.json({ status: "inactive" });
                res.json({ status: "active", type: lic.type, expiresAt: lic.expires_at });
            });
    });
});

app.post('/api/activate', (req, res) => {
    const { key, deviceId, email } = req.body;
    if (!key || !deviceId || !email) return res.status(400).json({ error: "Faltan datos" });

    db.get("SELECT * FROM licenses WHERE key = ? AND status='UNUSED'", [key], (err, lic) => {
        if (!lic) return res.status(400).json({ error: "Clave inválida o ya usada" });

        let exp = null;
        const now = new Date();
        if (lic.type === '1_DAY') exp = new Date(now.getTime() + 86400000).toISOString();
        else if (lic.type === '30_DAYS') exp = new Date(now.getTime() + 2592000000).toISOString();
        else if (lic.type === 'PERMANENT') exp = new Date(2100, 0, 1).toISOString();

        db.run("UPDATE licenses SET status='USED', user_email=?, expires_at=?, original_device_id=? WHERE key=?",
            [email.toLowerCase(), exp, deviceId, key], (err) => {
                db.run("INSERT INTO activations (license_key, device_id, price_paid) VALUES (?, ?, ?)", [key, deviceId, 0]);
                io.emit('update_licenses');
                io.emit('update_income');
                res.json({ success: true, type: lic.type, expiresAt: exp });
            });
    });
});

// --- API: ADMIN (FULL MODULES) ---
app.get('/api/admin/config', (req, res) => res.json(getConfig()));

app.post('/api/admin/config', (req, res) => {
    const current = getConfig();
    const updated = { ...current, ...req.body };
    if (saveConfig(updated)) {
        console.log("✅ Configuración guardada desde Admin:", updated);
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "Error al guardar config.json" });
    }
});

app.get('/api/admin/stats', (req, res) => {
    db.get("SELECT COUNT(*) as total FROM users", (e1, users) => {
        db.get("SELECT COUNT(*) as acts FROM activations", (e2, acts) => {
            db.get("SELECT SUM(price_paid) as income FROM activations", (e3, income) => {
                db.all("SELECT * FROM users ORDER BY last_seen DESC LIMIT 15", (e4, recentUsers) => {
                    res.json({
                        totalUsers: users?.total || 0,
                        weeklyUsers: users?.total || 0,
                        weeklyActivations: acts?.acts || 0,
                        weeklyIncome: income?.income || 0,
                        users: recentUsers || []
                    });
                });
            });
        });
    });
});

app.get('/api/admin/users', (req, res) => {
    db.all(`SELECT u.*, 
        (SELECT type FROM licenses WHERE LOWER(user_email) = LOWER(u.email) AND original_device_id = u.device_id AND status = 'USED' ORDER BY expires_at DESC LIMIT 1) as license_type,
        (SELECT expires_at FROM licenses WHERE LOWER(user_email) = LOWER(u.email) AND original_device_id = u.device_id AND status = 'USED' ORDER BY expires_at DESC LIMIT 1) as expires_at
        FROM users u ORDER BY u.last_seen DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/admin/active-licenses', (req, res) => {
    db.all("SELECT * FROM licenses ORDER BY status DESC, created_at DESC", (err, rows) => res.json(rows || []));
});

app.post('/api/admin/generate', (req, res) => {
    const { type, count } = req.body;
    const prefix = type === '1_DAY' ? 'TB-DIA-' : (type === '30_DAYS' ? 'TB-MES-' : 'TB-PERM-');
    const generated = [];
    for (let i = 0; i < (count || 1); i++) {
        const key = prefix + Math.random().toString(36).substr(2, 6).toUpperCase() + "-" + Math.random().toString(36).substr(2, 6).toUpperCase();
        db.run("INSERT INTO licenses (key, type, status) VALUES (?, ?, 'UNUSED')", [key, type]);
        generated.push(key);
    }
    io.emit('update_licenses');
    res.json({ success: true, keys: generated });
});

app.get('/api/admin/audios/:type', (req, res) => {
    const dir = path.join(UPLOADS_DIR, req.params.type);
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir)
        .filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
        .map(f => ({ name: f, url: `/uploads/${req.params.type}/${f}` }))
    );
});

app.get('/api/admin/income', (req, res) => {
    // Simulación de datos para los gráficos si la tabla de ingresos está vacía
    db.all("SELECT * FROM activations ORDER BY activated_at DESC", (err, logs) => {
        res.json({
            logs: logs || [],
            chart: [
                { label: 'Ene', value: 0 }, { label: 'Feb', value: 100 }, { label: 'Mar', value: 0 }
            ]
        });
    });
});

app.get('/api/admin/music-library', (req, res) => {
    if (fs.existsSync(MUSICA_JSON_PATH)) {
        res.json(JSON.parse(fs.readFileSync(MUSICA_JSON_PATH, 'utf8')));
    } else {
        res.json([]);
    }
});

// --- API: PLAYLISTS ---
app.get('/api/playlists', (req, res) => {
    db.all("SELECT * FROM playlists WHERE user_email = ?", [req.query.email], (err, rows) => {
        res.json(rows.map(r => ({ ...r, songs: JSON.parse(r.songs || '[]') })));
    });
});

app.post('/api/playlists', (req, res) => {
    const { email, name } = req.body;
    db.run("INSERT INTO playlists (user_email, name, songs) VALUES (?, ?, '[]')", [email, name], function () {
        res.json({ id: this.lastID, name: name, songs: [] });
    });
});

// --- FALLBACK ---
app.get('*', (req, res, next) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/uploads')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- START ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ ULTIMATE SERVER ${SERVER_VERSION} LIVE ON PORT ${PORT}`);
});
