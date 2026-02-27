/**
 * TecnoBanda - Logic Fixes & Cleanup
 */

const state = {
    audioContext: null,
    masterGain: null,
    eqNodes: { bass: null, mid: null, treble: null },
    gains: [],
    sources: [],
    buffers: [],
    tracksActive: [true, true, true, true, true],
    isPlaying: false,
    startTime: 0,
    pausedAt: 0,
    currentPosition: 0,

    localDb: [],
    queue: [],
    settings: JSON.parse(localStorage.getItem('rockola_v2_settings')) || {
        intro: false, ambient: false, persistQueue: false,
        apuntador: false,
        selectedIntro: '',
        selectedAmbient: '',
        ambientVolume: 100,
        eq: { bass: 0, mid: 0, treble: 0, master: 100 }
    },
    currentTrack: null,

    preloadedBuffers: [],
    preloadedTrack: null,
    isPreloading: false,
    preloadTimer: null,
    uiUpdateInterval: null,

    ambientBuffer: null,
    ambientSource: null,
    ambientGain: null,
    introSource: null,

    // FX Nodes
    vocalReverb: null,
    vocalWet: null,
    vocalDry: null,
    pannerInstruments: null,
    pannerVocals: null,
    pannerAmbient: null,
    reverbLevel: 0,
    compressor: null, // Normalizador de audio
    config: {}, // Configuración dinámica desde el servidor
    licenseInterval: null,
    socket: null,
    toastQueue: [],
    isShowingToast: false,
    recentActivity: [],
    userPlaylists: [],
    isLoading: false,
    tabAutoSwitchTimer: null
};

const ui = {
    mainSearch: document.getElementById('main-search-input'),
    mainResults: document.getElementById('main-search-results'),
    queueList: document.getElementById('queue-list'),
    queueCount: document.getElementById('queue-count'),
    trackTitle: document.getElementById('current-track-title'),
    trackArtist: document.getElementById('current-track-artist'),
    playBtn: document.getElementById('play-pause-btn'),
    nextBtn: document.getElementById('next-track-btn'),
    seekBar: document.getElementById('seek-bar'),
    currentTimeTxt: document.getElementById('current-time'),
    totalTimeTxt: document.getElementById('total-time'),
    settingsModal: document.getElementById('settings-modal'),
    settingsBtn: document.getElementById('settings-btn'),
    eqModal: document.getElementById('eq-modal'),
    openEqBtn: document.getElementById('open-eq-btn'),
    dbStatus: document.getElementById('db-status-text'),
    libraryCount: document.getElementById('library-count-display'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingPct: document.getElementById('loading-pct-value'),
    loadingRing: () => document.getElementById('progress-ring-bar'),
    loadingText: document.getElementById('loading-step-text'),
    toggles: [
        document.getElementById('toggle-bass'), document.getElementById('toggle-drums'),
        document.getElementById('toggle-guitar'), document.getElementById('toggle-harmony'),
        document.getElementById('toggle-vocals')
    ],
    sliders: [
        document.getElementById('vol-bass'), document.getElementById('vol-drums'),
        document.getElementById('vol-guitar'), document.getElementById('vol-harmony'),
        document.getElementById('vol-vocals')
    ],
    masterVol: document.getElementById('master-vol-eq'),
    eqBass: document.getElementById('eq-bass'),
    eqMid: document.getElementById('eq-mid'),
    eqTreble: document.getElementById('eq-treble'),
    persistQueueIn: document.getElementById('setting-persist-queue'),
    apuntadorIn: document.getElementById('setting-apuntador'),
    reverbSlider: document.getElementById('vocal-reverb-slider'),
    reverbValTxt: document.getElementById('reverb-val'),
    defaultIntroSelect: document.getElementById('default-intro-select'),
    defaultAmbientSelect: document.getElementById('default-ambient-select'),
    previewIntroBtn: document.getElementById('preview-intro-btn'),
    previewAmbientBtn: document.getElementById('preview-ambient-btn'),
    ambientVolSlider: document.getElementById('ambient-vol-slider'),
    ambientVolValTxt: document.getElementById('ambient-vol-val'),
    recentList: document.getElementById('recent-list'),
    referralBox: document.getElementById('referral-box-sidebar')
};

// --- Gestor de Base de Datos para Archivos Grandes ---
const dbName = "TecnoBandaDB";
const storeName = "files";

async function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveFileDB(key, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(blob, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getFileDB(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
// --- Generador de Reverb Sintético ---
function createReverbIR(context, duration = 2.0, decay = 2.0) {
    const sampleRate = context.sampleRate;
    const length = sampleRate * duration;
    const impulse = context.createBuffer(2, length, sampleRate);
    for (let i = 0; i < 2; i++) {
        const channelData = impulse.getChannelData(i);
        for (let j = 0; j < length; j++) {
            channelData[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, decay);
        }
    }
    return impulse;
}

async function init() {
    // --- Lógica de Registro (Primera Vez) ---
    const savedUser = localStorage.getItem('tecnobanda_user');
    const regModal = document.getElementById('registration-modal');
    const regForm = document.getElementById('registration-form');
    const headerTitle = document.querySelector('.premium-title');

    // Generar Device ID si no existe
    if (!localStorage.getItem('tecnobanda_device_id')) {
        localStorage.setItem('tecnobanda_device_id', 'DEV-' + Math.random().toString(36).substr(2, 9).toUpperCase());
    }

    // --- Handlers Globales de Autenticación ---
    window.saveUserDataAndReload = (user) => {
        localStorage.setItem('tecnobanda_user', user.name);
        localStorage.setItem('tecnobanda_email', user.email || '');
        localStorage.setItem('tecnobanda_phone', user.phone || '');
        location.reload();
    };

    window.showEmailLogin = () => {
        document.getElementById('registration-form').classList.add('hidden');
        document.getElementById('email-login-form').classList.remove('hidden');
    };

    window.hideAllAuthForms = () => {
        document.getElementById('registration-form').classList.remove('hidden');
        document.getElementById('email-login-form').classList.add('hidden');
    };

    window.requestOTP = async () => {
        const email = document.getElementById('login-email').value.trim();
        if (!email) return alert("Por favor, ingresa tu correo");

        console.log("Solicitando OTP para:", email);
        const btn = document.querySelector('#step-request-otp button');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';

        try {
            const res = await fetch(`/api/auth/request-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();

            if (res.ok) {
                document.getElementById('step-request-otp').classList.add('hidden');
                document.getElementById('step-verify-otp').classList.remove('hidden');
                showToast("Clave enviada al correo");
            } else {
                alert(data.error || "Error al enviar clave");
            }
        } catch (err) {
            console.error("Fetch Error (OTP):", err);
            alert("Error de conexión con el servidor. Verifica que el servidor admin esté corriendo.");
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    };

    window.verifyOTP = async () => {
        const email = document.getElementById('login-email').value.trim();
        const otp = document.getElementById('login-otp').value.trim();
        const deviceId = localStorage.getItem('tecnobanda_device_id');
        const referralInput = document.getElementById('reg-referral');
        const referralCode = referralInput ? referralInput.value.trim() : null;

        if (!otp) return alert("Ingresa la clave de 6 dígitos");

        try {
            const res = await fetch(`/api/auth/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, otp, deviceId, referralCode })
            });
            const data = await res.json();
            if (data.success) {
                if (data.user.referralCode) localStorage.setItem('tecnobanda_my_referral', data.user.referralCode);
                window.saveUserDataAndReload(data.user);
            } else {
                alert(data.error || "Clave inválida o expirada");
            }
        } catch (err) {
            console.error("Fetch Error (Verify):", err);
            alert("Error de conexión al verificar.");
        }
    };

    if (!savedUser && regModal) {
        regModal.classList.add('active');

        if (regForm) {
            regForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const userName = document.getElementById('reg-username').value.trim();
                const userEmail = document.getElementById('reg-email').value.trim();
                const userPhone = document.getElementById('reg-phone').value.trim();
                const referralInput = document.getElementById('reg-referral');
                const referralCode = referralInput ? referralInput.value.trim() : null;
                const deviceId = localStorage.getItem('tecnobanda_device_id');

                console.log(`[Frontend] Intentando registrar: ${userEmail} (ID: ${deviceId})`);

                if (userName && userEmail && userPhone) {
                    try {
                        const res = await fetch(`/api/register`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: userName, email: userEmail, phone: userPhone, deviceId, referralCode })
                        });

                        if (res.ok) {
                            const data = await res.json();
                            if (data.user && data.user.referralCode) localStorage.setItem('tecnobanda_my_referral', data.user.referralCode);
                            window.saveUserDataAndReload({ name: userName, email: userEmail, phone: userPhone });
                        } else if (res.status === 409) {
                            // SI EL USUARIO YA EXISTE, PASAR DIRECTO AL LOGIN POR OTP
                            document.getElementById('login-email').value = userEmail;
                            window.showEmailLogin();
                            // Disparar el envío de OTP automáticamente para ahorrar un clic
                            setTimeout(() => { window.requestOTP(); }, 500);
                        } else {
                            const data = await res.json().catch(() => ({}));
                            alert(data.error || "Error al conectar con el servidor de registro.");
                        }

                    } catch (err) {
                        alert("Error de conexión. Asegúrate que tienes internet.");
                        console.error(err);
                    }
                }
            });
        }
    } else if (savedUser && headerTitle) {
        // VALIDACIÓN DE LICENCIA AL INICIO
        await refreshLicenseUI();
        refreshReferralUI(); // Mostrar código de invitación si existe

        // Verificar si falta el email para Playlists
        if (!localStorage.getItem('tecnobanda_email')) {
            console.warn("Falta el correo en session. Las listas no se sincronizarán.");
            showToast("⚠️ Para usar Listas, por favor cierra sesión y vuelve a entrar con tu correo.", 10000);
        }
    }

    initSocket();
    setupAudio();
    setupEvents();
    initSortable();
    initProgressRing();
    console.log("TecnoBanda - Restaurando Perfil...");

    // 1. Restaurar Ajustes UI
    ui.persistQueueIn.checked = state.settings.persistQueue;
    ui.apuntadorIn.checked = state.settings.apuntador;
    document.getElementById('setting-intro-sound').checked = state.settings.intro;
    document.getElementById('setting-ambient-sound').checked = state.settings.ambient;

    // 2. Restaurar Ecualizador
    if (state.settings.eq) {
        ui.eqBass.value = state.settings.eq.bass;
        ui.eqMid.value = state.settings.eq.mid;
        ui.eqTreble.value = state.settings.eq.treble;
        ui.masterVol.value = state.settings.eq.master;

        state.eqNodes.bass.gain.value = state.settings.eq.bass;
        state.eqNodes.mid.gain.value = state.settings.eq.mid;
        state.eqNodes.treble.gain.value = state.settings.eq.treble;
        state.masterGain.gain.value = state.settings.eq.master / 100;
    }

    // 4. Asegurar que las propiedades nuevas existan en settings (migración)
    if (state.settings.selectedIntro === undefined) state.settings.selectedIntro = '';
    if (state.settings.selectedAmbient === undefined) state.settings.selectedAmbient = '';
    if (state.settings.ambientVolume === undefined) state.settings.ambientVolume = 100;
    if (state.settings.apuntador === undefined) state.settings.apuntador = false;

    // Actualizar UI con volumen guardado
    if (ui.ambientVolSlider) {
        ui.ambientVolSlider.value = state.settings.ambientVolume;
        ui.ambientVolValTxt.innerText = state.settings.ambientVolume + "%";
    }

    // 3. Cargar Listas de Audios desde el Servidor Admin e inicializar
    await refreshAudioLists();

    // 5. Cargar Configuración Dinámica y Sincronizar
    try {
        const configRes = await fetch('/api/config');
        state.config = await configRes.json();

        // Aplicar configuraciones UI...
        if (state.config.appTitle) {
            document.title = state.config.appTitle;
            const titleEl = document.querySelector('.premium-title');
            if (titleEl) titleEl.innerText = state.config.appTitle;
        }
        if (state.config.themeColor) {
            document.documentElement.style.setProperty('--primary', state.config.themeColor);
        }

        // Aplicar link de solicitud de código
        const reqBtn = document.getElementById('wa-request-code-btn');
        if (reqBtn && state.config.requestCodeNumber) {
            reqBtn.href = `https://wa.me/${state.config.requestCodeNumber}`;
            reqBtn.innerHTML = `<i class="fa-brands fa-whatsapp"></i> ${state.config.requestCodeMessage || 'Solicitar Código'}`;
        }

        refreshReferralUI(); // Asegurar que el número "5" aparezca
    } catch (e) {
        console.warn("No se pudo cargar config.json, usando valores por defecto.");
    }

    // --- CARGA DE MÚSICA (Versión Original Estable) ---
    const urls = [
        state.config.syncUrl,
        state.config.syncUrlAlt1,
        state.config.syncUrlAlt2
    ].filter(u => u && u.trim() !== "");

    let loaded = false;
    for (const url of urls) {
        console.log(`Intentando conectar con: ${url}`);
        const success = await loadFromUrl(url);
        if (success) {
            loaded = true;
            break;
        }
    }

    if (!loaded && urls.length > 0) {
        ui.dbStatus.innerText = "Error: No se pudo conectar a ninguna base de datos.";
        ui.dbStatus.style.color = "#ff4757";
    }

    if (state.settings.persistQueue) {
        const savedQueue = JSON.parse(localStorage.getItem('rockola_v2_queue')) || [];
        state.queue = savedQueue;
        renderQueue();
    }

    // --- Validación de Licencia en Tiempo Real (Cada 30 segundos) ---
    if (state.licenseInterval) clearInterval(state.licenseInterval);
    state.licenseInterval = setInterval(() => {
        refreshLicenseUI();
    }, 30000);

    // 6. Cargar Playlists del Servidor
    await syncPlaylists();
}

async function syncPlaylists() {
    const email = localStorage.getItem('tecnobanda_email');
    if (!email) return;

    try {
        const res = await fetch(`/api/playlists?email=${email}`);
        if (res.ok) {
            state.userPlaylists = await res.json();
            renderPlaylists();
        } else {
            const errData = await res.json();
            console.error("Error syncPlaylists:", errData);
        }
    } catch (e) {
        console.warn("No se pudieron sincronizar las listas:", e);
    }
}

function initProgressRing() {
    const circle = ui.loadingRing();
    if (!circle) return;
    const radius = circle.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;
    circle.style.strokeDasharray = `${circumference} ${circumference}`;
    circle.style.strokeDashoffset = circumference;
}

function setProgress(percent, text) {
    if (ui.loadingOverlay.classList.contains('hidden')) ui.loadingOverlay.classList.remove('hidden');
    ui.loadingPct.innerText = Math.round(percent);
    if (text) ui.loadingText.innerText = text;
    const circle = ui.loadingRing();
    if (circle) {
        const radius = circle.r.baseVal.value;
        const circumference = radius * 2 * Math.PI;
        circle.style.strokeDashoffset = circumference - (percent / 100 * circumference);
    }
}

function initSocket() {
    if (typeof io === 'undefined') {
        console.warn("Socket.io no cargado. Reintentando en 2s...");
        setTimeout(initSocket, 2000);
        return;
    }

    // --- Socket Servidor Admin ---
    // Mensajes, licencias, regalos, logout Y VIGILANTE
    state.socket = io();

    state.socket.on('connect', () => {
        console.log("📡 Conectado al servidor en tiempo real.");
        const email = localStorage.getItem('tecnobanda_email');
        if (email) {
            state.socket.emit('join_user', email);
        }
    });

    // Escuchar mensajes del Administrador
    state.socket.on('admin_message', (data) => {
        console.log("📩 Mensaje del Administrador:", data.message);
        showToast(`📢 MENSAJE ADMIN: ${data.message}`, 8000);
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    });

    // Cierre forzado de sesión (ej: usuario eliminado por admin)
    state.socket.on('force_logout', (data) => {
        if (typeof window.forceGlobalLogout === 'function') {
            window.forceGlobalLogout(data.message || "Usuario eliminado por el administrador.");
        } else {
            localStorage.clear();
            location.reload();
        }
    });

    state.socket.on('toast', (data) => {
        console.log("☁️ Toast remoto:", data);
        showToast((data.title ? data.title + ": " : "") + data.message);
    });

    state.socket.on('new_gift', (data) => {
        console.log("🎁 ¡Tienes un nuevo regalo!", data);
        checkForGifts();
    });

    // --- Vigilante Remoto ---
    state.socket.on('song_added', (song) => {
        console.log("✨ Nueva canción añadida (Vigilante):", song);
        showToast(`✨ Añadida: ${song.title} - ${song.artist}`);

        // Añadir optimísticamente a la base de datos local para refrescar la UI al instante
        // Creamos un objeto similar a los del DB
        const tempTrack = {
            title: song.title,
            artist: song.artist,
            isCompressed: true,
            dateAdded: new Date().toISOString()
        };

        // Evitar duplicados y poner al principio
        if (!state.localDb.find(t => t.title === song.title)) {
            state.localDb.unshift(tempTrack);
        }

        renderRecentSongs();
        if (ui.libraryCount) {
            ui.libraryCount.innerHTML = `<i class="fa-solid fa-list-music"></i> <b>${state.localDb.length}</b> canciones disponibles`;
        }
    });

    state.socket.on('song_deleted', (song) => {
        console.log("🗑️ Canción eliminada (Vigilante):", song);
        showToast(`🗑️ Eliminada: ${song.title}`);
        // Quitar de la lista local
        state.localDb = state.localDb.filter(t => t.title !== song.title);
        renderRecentSongs();
        if (ui.libraryCount) {
            ui.libraryCount.innerHTML = `<i class="fa-solid fa-list-music"></i> <b>${state.localDb.length}</b> canciones disponibles`;
        }
    });

    state.socket.on('database_updated', (newDb) => {
        console.log("🔄 Base de datos sincronizada por el Vigilante.");

        // Obtener base URL de la configuración actual
        const syncUrl = state.config.syncUrl || "";
        const baseUrl = syncUrl.substring(0, syncUrl.lastIndexOf('/') + 1);

        // Actualizar base de datos local con las URLs correctas
        state.localDb = newDb.map(track => {
            if (track.isCompressed && typeof track.archiveFile === 'string' && !track.archiveFile.startsWith('http')) {
                track.archiveFile = baseUrl + track.archiveFile;
            }
            return track;
        });

        if (ui.libraryCount) {
            ui.libraryCount.innerHTML = `<i class="fa-solid fa-list-music"></i> <b>${state.localDb.length}</b> canciones disponibles`;
        }

        renderRecentSongs(); // <--- Aquí es donde se refrescan las novedades visualmente

        if (ui.mainSearch && ui.mainSearch.value.trim() !== "") {
            handleSearch();
        }
    });

    // El servidor unificado maneja todo
}

function setupAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContext();
    state.masterGain = state.audioContext.createGain();
    state.eqNodes.bass = state.audioContext.createBiquadFilter();
    state.eqNodes.bass.type = "lowshelf";
    state.eqNodes.bass.frequency.value = 200;
    state.eqNodes.mid = state.audioContext.createBiquadFilter();
    state.eqNodes.mid.type = "peaking";
    state.eqNodes.mid.frequency.value = 1000;
    state.eqNodes.treble = state.audioContext.createBiquadFilter();
    state.eqNodes.treble.type = "highshelf";
    state.eqNodes.treble.frequency.value = 3000;
    state.eqNodes.bass.connect(state.eqNodes.mid);
    state.eqNodes.mid.connect(state.eqNodes.treble);
    state.eqNodes.treble.connect(state.masterGain);

    // --- NORMALIZADOR (Dynamics Compressor) ---
    state.compressor = state.audioContext.createDynamicsCompressor();
    state.compressor.threshold.setValueAtTime(-24, state.audioContext.currentTime);
    state.compressor.knee.setValueAtTime(40, state.audioContext.currentTime);
    state.compressor.ratio.setValueAtTime(12, state.audioContext.currentTime);
    state.compressor.attack.setValueAtTime(0.003, state.audioContext.currentTime);
    state.compressor.release.setValueAtTime(0.25, state.audioContext.currentTime);

    state.masterGain.connect(state.compressor);
    state.compressor.connect(state.audioContext.destination);

    // --- PANNER NODES (Apuntador) --- 
    state.pannerInstruments = state.audioContext.createStereoPanner();
    state.pannerVocals = state.audioContext.createStereoPanner();
    state.pannerAmbient = state.audioContext.createStereoPanner();

    state.pannerInstruments.connect(state.eqNodes.bass);
    state.pannerVocals.connect(state.eqNodes.bass);
    state.pannerAmbient.connect(state.eqNodes.bass);

    // Node de ganancia para ambiente
    state.ambientGain = state.audioContext.createGain();
    state.ambientGain.gain.value = (state.settings.ambientVolume || 100) / 100;
    state.ambientGain.connect(state.pannerAmbient);

    // Set initial pan based on settings
    const panVal = state.settings.apuntador ? -1 : 0;
    state.pannerInstruments.pan.value = panVal;
    state.pannerAmbient.pan.value = panVal; // Ambiente con instrumentos
    state.pannerVocals.pan.value = state.settings.apuntador ? 1 : 0;

    for (let i = 0; i < 5; i++) {
        const g = state.audioContext.createGain();
        if (i === 4) { // Canal Vocal con FX
            state.vocalDry = state.audioContext.createGain();
            state.vocalWet = state.audioContext.createGain();
            state.vocalReverb = state.audioContext.createConvolver();
            state.vocalReverb.buffer = createReverbIR(state.audioContext);

            g.connect(state.vocalDry);
            g.connect(state.vocalReverb);
            state.vocalReverb.connect(state.vocalWet);

            // Conectar a panner de Vocales en lugar de directo a EQ
            state.vocalDry.connect(state.pannerVocals);
            state.vocalWet.connect(state.pannerVocals);

            state.vocalWet.gain.value = 0;
            state.vocalDry.gain.value = 1;
        } else {
            // Conectar a panner de Instrumentos en lugar de directo a EQ
            g.connect(state.pannerInstruments);
        }
        state.gains.push(g);
    }
}

function initSortable() {
    if (typeof Sortable === 'undefined' || !ui.queueList) return;
    Sortable.create(ui.queueList, {
        animation: 150, handle: '.queue-item', ghostClass: 'sortable-ghost',
        onEnd: () => {
            // Reconstruir la cola lógica basada en el nuevo orden visual
            const newQueue = [];
            ui.queueList.querySelectorAll('.queue-item').forEach(el => {
                const uid = el.getAttribute('data-uid');
                const track = state.queue.find(q => q.uid === uid);
                if (track) newQueue.push(track);
            });
            state.queue = newQueue;
            console.log("Cola reordenada, nueva prioridad:", state.queue[0]?.title);

            // Actualizar persistencia y pre-carga
            if (state.settings.persistQueue) localStorage.setItem('rockola_v2_queue', JSON.stringify(state.queue));
            preloadNextTrack();
        }
    });
}

async function loadAndPlay(track, autoStart = false) {
    if (state.isPlaying) stopAudio();
    if (state.isLoading) return; // Prevent concurrent loads
    if (state.audioContext.state === 'suspended') await state.audioContext.resume();

    state.isLoading = true;
    ui.trackTitle.innerText = "Cargando...";
    ui.trackArtist.innerText = track.artist || "";
    setProgress(0, "Cargando TecnoBanda...");

    try {
        let stemsToDecode = track.isCompressed ? await extractStemsFromArchive(track.archiveFile, p => setProgress(p * 0.5, "Descomprimiendo...")) : track.stems;

        // RESTRICCIÓN: Usar índices fijos para no mezclar canales si falta uno
        const decodedBuffers = [null, null, null, null, null];

        for (let i = 0; i < 5; i++) {
            if (!stemsToDecode[i]) continue; // Saltar si el canal está vacío

            try {
                const buf = await (stemsToDecode[i] instanceof Blob ? stemsToDecode[i].arrayBuffer() : fetch(stemsToDecode[i]).then(r => r.arrayBuffer()));
                decodedBuffers[i] = await state.audioContext.decodeAudioData(buf);
            } catch (err) { console.warn(`Error en canal ${i + 1}:`, err); }

            setProgress(50 + ((i + 1) / 5 * 50), "Analizando " + (['Bajo', 'Batería', 'Guitarra', 'Armonía', 'Voz'][i]) + "...");
        }

        state.buffers = decodedBuffers;
        state.currentTrack = track;
        state.currentPosition = 0;
        state.pausedAt = 0;
        ui.trackTitle.innerText = track.title;
        ui.trackArtist.innerText = track.artist || "";
        setTimeout(() => {
            state.isLoading = false;
            ui.loadingOverlay.classList.add('hidden');
            updatePlayIcon(false);
            updateTimeDisplay(0, state.buffers[0].duration);
            if (autoStart) playBuffers(0);
            preloadNextTrack();
        }, 500);
    } catch (e) {
        console.error(e);
        state.isLoading = false;
        ui.loadingOverlay.classList.add('hidden');
        showToast("Error de carga.");
    }
}

function playBuffers(offset = 0) {
    if (state.buffers.length < 5) return;
    if (state.audioContext.state === 'suspended') state.audioContext.resume();
    stopAudio();

    let introDelay = 0;
    const now = state.audioContext.currentTime;

    if (state.settings.intro && offset === 0) {
        if (state.introBuffer) {
            introDelay = Math.max(0, state.introBuffer.duration - 0.02);
            const s = state.audioContext.createBufferSource();
            s.buffer = state.introBuffer;
            s.connect(state.masterGain);
            s.start(now);
            state.introSource = s;
        } else {
            playDing();
            introDelay = 0.28;
        }
    }

    const startAt = now + introDelay;
    state.sources = state.buffers.map((buffer, i) => {
        if (!buffer) return null;
        const s = state.audioContext.createBufferSource();
        s.buffer = buffer;
        s.connect(state.gains[i]);
        state.gains[i].gain.value = state.tracksActive[i] ? (ui.sliders[i].value / 100) : 0;

        // El fin del tema lo controla el primer canal disponible
        const isControlChannel = i === 0 || (!state.buffers[0] && i === 1);
        if (isControlChannel) {
            s.onended = () => {
                if (state.isPlaying) handleTrackEnd();
            };
        }
        return s;
    }).filter(s => s !== null);

    state.startTime = startAt;
    state.currentPosition = offset;
    state.sources.forEach(s => s.start(startAt, offset));
    state.isPlaying = true;
    updatePlayIcon(true);
    stopAmbient();

    if (state.uiUpdateInterval) clearInterval(state.uiUpdateInterval);
    state.uiUpdateInterval = setInterval(updateUIProgress, 500);
}

function updateUIProgress() {
    if (!state.isPlaying || !state.buffers[0]) return;
    let elapsed = state.audioContext.currentTime - state.startTime;
    if (elapsed < 0) elapsed = 0;
    const currentPos = state.currentPosition + elapsed;

    // Lógica de Licencia / Modo Prueba
    const license = localStorage.getItem('tecnobanda_license_expiry');
    const isPremium = license && new Date(license) > new Date();

    if (!isPremium && currentPos >= 70) {
        console.log("⏳ Límite de prueba alcanzado (70s) - Licencia invalida o expirada");
        showToast("🔒 MODO PRUEBA: 70 seg máx.");
        handleTrackEnd();
        return;
    }

    updateTimeDisplay(currentPos, state.buffers[0].duration);
}

function updateTimeDisplay(current, total) {
    const percent = total > 0 ? (current / total) * 100 : 0;
    ui.seekBar.value = percent;
    ui.seekBar.style.setProperty('--progress', percent + '%');
    ui.currentTimeTxt.innerText = formatTime(current);
    ui.totalTimeTxt.innerText = formatTime(total);
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

async function preloadNextTrack() {
    if (state.isPreloading || state.queue.length === 0) return;
    const nextTrack = state.queue[0];
    if (state.preloadedTrack === nextTrack) return;
    state.isPreloading = true;
    renderQueue();
    try {
        let stems = nextTrack.isCompressed ? await extractStemsFromArchive(nextTrack.archiveFile) : nextTrack.stems;
        const promises = stems.map(async s => {
            if (!s) return null; // Manejar canales vacíos
            const buf = await (s instanceof Blob ? s.arrayBuffer() : fetch(s).then(r => r.arrayBuffer()));
            return await state.audioContext.decodeAudioData(buf);
        });
        state.preloadedBuffers = await Promise.all(promises);
        state.preloadedTrack = nextTrack;
    } catch (e) { console.error(e); } finally { state.isPreloading = false; renderQueue(); }
}

function handleTrackEnd() {
    stopAudio();
    if (state.settings.ambient) playAmbient();
    if (state.preloadedBuffers.length === 5) {
        state.buffers = state.preloadedBuffers;
        state.currentTrack = state.preloadedTrack;
        state.queue.shift();
        state.preloadedBuffers = []; state.preloadedTrack = null;
        ui.trackTitle.innerText = state.currentTrack.title;
        ui.trackArtist.innerText = state.currentTrack.artist;
        updateTimeDisplay(0, state.buffers[0].duration);
        showToast("✓ SIGUIENTE LISTA.");
        renderQueue();
        preloadNextTrack();
    } else if (state.queue.length > 0) {
        loadAndPlay(state.queue.shift(), false);
        renderQueue();
    } else {
        state.buffers = [];
        state.preloadedBuffers = [];
        state.currentTrack = null;
        state.pausedAt = 0;
        ui.trackTitle.innerText = "TecnoBanda";
        ui.trackArtist.innerText = "Lista vacía";
        updateTimeDisplay(0, 0);
    }
}

function skipNextTrack() { if (state.queue.length > 0 || state.preloadedBuffers.length === 5) handleTrackEnd(); else showToast("No hay más."); }
function stopAudio() {
    state.sources.forEach(s => { try { s.onended = null; s.stop(); } catch (e) { } });
    state.sources = [];
    if (state.introSource) { try { state.introSource.stop(); } catch (e) { } state.introSource = null; }
    state.isPlaying = false;
    if (state.uiUpdateInterval) clearInterval(state.uiUpdateInterval);
    updatePlayIcon(false);
}

function togglePlay() {
    if (state.isPlaying) {
        state.pausedAt = state.currentPosition + (state.audioContext.currentTime - state.startTime);
        stopAudio();
    } else {
        if (state.buffers.length === 5) { playBuffers(state.pausedAt || 0); state.pausedAt = 0; }
        else if (state.queue.length > 0) {
            loadAndPlay(state.queue.shift(), true);
            renderQueue();
        }
        else showToast("Cola vacía.");
    }
}

function playAmbient() {
    stopAmbient(); if (!state.ambientBuffer) return;
    const s = state.audioContext.createBufferSource(); s.buffer = state.ambientBuffer;
    s.loop = true; s.connect(state.ambientGain); s.start(0); state.ambientSource = s;
}
function stopAmbient() { if (state.ambientSource) { try { state.ambientSource.stop(); } catch (e) { } state.ambientSource = null; } }

function setupEvents() {
    if (ui.mainSearch) ui.mainSearch.addEventListener('input', handleSearch);
    if (ui.playBtn) ui.playBtn.addEventListener('click', togglePlay);
    if (ui.nextBtn) ui.nextBtn.addEventListener('click', skipNextTrack);
    if (ui.seekBar) ui.seekBar.addEventListener('change', () => {
        if (state.buffers[0]) {
            const pos = (ui.seekBar.value / 100) * state.buffers[0].duration;
            if (state.isPlaying) playBuffers(pos); else { state.pausedAt = pos; updateTimeDisplay(pos, state.buffers[0].duration); }
        }
    });

    const saveSettings = () => {
        const wasAmbientActive = state.settings.ambient;

        state.settings.intro = document.getElementById('setting-intro-sound').checked;
        state.settings.ambient = document.getElementById('setting-ambient-sound').checked;
        state.settings.ambientVolume = parseInt(ui.ambientVolSlider.value);
        state.settings.persistQueue = ui.persistQueueIn.checked;
        state.settings.apuntador = ui.apuntadorIn.checked;

        // Actualizar ganancia inmediata
        if (state.ambientGain) {
            state.ambientGain.gain.setTargetAtTime(state.settings.ambientVolume / 100, state.audioContext.currentTime, 0.05);
        }

        // Control de Audio Inmediato (Ambiente)
        if (!state.settings.ambient) {
            stopAmbient();
        } else if (!wasAmbientActive && !state.isPlaying) {
            playAmbient();
        }

        // Control de Audio Inmediato (Intro)
        if (!state.settings.intro && state.introSource) {
            try { state.introSource.stop(); } catch (e) { }
            state.introSource = null;
        }

        if (state.pannerInstruments && state.pannerVocals) {
            const panInstr = state.settings.apuntador ? -1 : 0;
            const panVocals = state.settings.apuntador ? 1 : 0;
            state.pannerInstruments.pan.setValueAtTime(panInstr, state.audioContext.currentTime);
            state.pannerAmbient.pan.setValueAtTime(panInstr, state.audioContext.currentTime); // Ambiente con instrumentos
            state.pannerVocals.pan.setValueAtTime(panVocals, state.audioContext.currentTime);
        }

        localStorage.setItem('rockola_v2_settings', JSON.stringify(state.settings));
        ui.settingsModal.classList.remove('active');
        showToast("Configuración guardada.");
    };

    if (ui.settingsBtn) {
        ui.settingsBtn.addEventListener('click', () => {
            ui.settingsModal.classList.add('active');
            // Esperar a que el modal se anime/muestre para calcular scroll
            setTimeout(updateSettingsScrollIndicators, 100);
        });
    }

    const settingsScrollContent = ui.settingsModal.querySelector('.modal-content');
    if (settingsScrollContent) {
        settingsScrollContent.addEventListener('scroll', updateSettingsScrollIndicators);
    }

    const settingsXBtn = document.getElementById('settings-x-btn');
    if (settingsXBtn) settingsXBtn.addEventListener('click', saveSettings);

    const closeSettingsBtn = document.getElementById('close-settings');
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', saveSettings);

    if (ui.openEqBtn) ui.openEqBtn.addEventListener('click', () => ui.eqModal.classList.add('active'));

    const saveEq = () => {
        state.settings.eq = {
            bass: parseFloat(ui.eqBass.value),
            mid: parseFloat(ui.eqMid.value),
            treble: parseFloat(ui.eqTreble.value),
            master: parseFloat(ui.masterVol.value)
        };
        localStorage.setItem('rockola_v2_settings', JSON.stringify(state.settings));
    };

    if (ui.masterVol) ui.masterVol.addEventListener('input', () => { state.masterGain.gain.value = ui.masterVol.value / 100; saveEq(); });
    if (ui.eqBass) ui.eqBass.addEventListener('input', () => { state.eqNodes.bass.gain.value = ui.eqBass.value; saveEq(); });
    if (ui.eqMid) ui.eqMid.addEventListener('input', () => { state.eqNodes.mid.gain.value = ui.eqMid.value; saveEq(); });
    if (ui.eqTreble) ui.eqTreble.addEventListener('input', () => { state.eqNodes.treble.gain.value = ui.eqTreble.value; saveEq(); });

    if (ui.dbStatus) ui.dbStatus.innerText = "Base de Datos lista.";

    const logoutMini = document.getElementById('logout-btn-mini');
    if (logoutMini) {
        logoutMini.addEventListener('click', () => {
            if (confirm("¿Estás seguro de que quieres cerrar tu sesión?")) {
                forceGlobalLogout("Cierre de sesión manual.");
            }
        });
    }

    if (ui.defaultIntroSelect) {
        ui.defaultIntroSelect.addEventListener('change', async () => {
            const val = ui.defaultIntroSelect.value;
            state.settings.selectedIntro = val;
            if (val) {
                try {
                    const res = await fetch(val);
                    if (!res.ok) throw new Error("File not found");
                    const arrayBuf = await res.arrayBuffer();
                    state.introBuffer = await state.audioContext.decodeAudioData(arrayBuf);
                    showToast("Sonido de entrada actualizado.");
                } catch (err) {
                    showToast("Error al cargar sonido.");
                    console.error(err);
                }
            }
            localStorage.setItem('rockola_v2_settings', JSON.stringify(state.settings));
        });
    }

    if (ui.defaultAmbientSelect) {
        ui.defaultAmbientSelect.addEventListener('change', async () => {
            const val = ui.defaultAmbientSelect.value;
            state.settings.selectedAmbient = val;
            if (val) {
                try {
                    const res = await fetch(val);
                    if (!res.ok) throw new Error("File not found");
                    const arrayBuf = await res.arrayBuffer();
                    state.ambientBuffer = await state.audioContext.decodeAudioData(arrayBuf);
                    showToast("Música de ambiente actualizada.");
                    if (state.settings.ambient) playAmbient();
                } catch (err) {
                    showToast("Error al cargar ambiente.");
                    console.error(err);
                }
            }
            localStorage.setItem('rockola_v2_settings', JSON.stringify(state.settings));
        });
    }

    if (ui.previewIntroBtn) {
        ui.previewIntroBtn.addEventListener('click', async () => {
            if (state.audioContext.state === 'suspended') await state.audioContext.resume();
            if (state.introBuffer) {
                const s = state.audioContext.createBufferSource();
                s.buffer = state.introBuffer;
                s.connect(state.masterGain);
                s.start(0);
            } else {
                showToast("No hay audio cargado.");
            }
        });
    }

    if (ui.previewAmbientBtn) {
        ui.previewAmbientBtn.addEventListener('click', async () => {
            if (state.audioContext.state === 'suspended') await state.audioContext.resume();
            if (state.ambientBuffer) {
                // Si ya está sonando el ambiente normal, no hacemos nada o lo reiniciamos
                // Para "probar" mejor creamos un trigger temporal si no está en modo ambiente
                const s = state.audioContext.createBufferSource();
                s.buffer = state.ambientBuffer;
                s.connect(state.ambientGain);
                s.start(0);
                setTimeout(() => { try { s.stop(); } catch (e) { } }, 5000); // Probar solo 5 segundos
            } else {
                showToast("No hay ambiente cargado.");
            }
        });
    }

    if (ui.ambientVolSlider) {
        ui.ambientVolSlider.addEventListener('input', () => {
            const val = ui.ambientVolSlider.value;
            ui.ambientVolValTxt.innerText = val + "%";
            if (state.ambientGain) {
                state.ambientGain.gain.setTargetAtTime(val / 100, state.audioContext.currentTime, 0.05);
            }
        });
    }

    if (ui.dbFolderInput) ui.dbFolderInput.addEventListener('change', handleFolder);

    ui.toggles.forEach((t, i) => {
        if (t) t.addEventListener('change', () => {
            state.tracksActive[i] = t.checked;
            if (state.gains[i]) state.gains[i].gain.setTargetAtTime(t.checked ? (ui.sliders[i].value / 100) : 0, state.audioContext.currentTime, 0.05);
        });
    });
    ui.sliders.forEach((s, i) => {
        if (s) s.addEventListener('input', () => {
            if (state.tracksActive[i] && state.gains[i]) state.gains[i].gain.setTargetAtTime(s.value / 100, state.audioContext.currentTime, 0.05);
        });
    });




    // Botón de Cerrar Sesión (Ahora pequeño dentro de configuración)
    const logoutBtn = document.getElementById('logout-btn-mini');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm("¿Cerrar sesión y borrar licencia actual?")) {
                localStorage.removeItem('tecnobanda_user');
                localStorage.removeItem('tecnobanda_license_expiry');
                location.reload();
            }
        });
    }

    // Lógica de Mi Perfil
    const profileBtn = document.getElementById('profile-btn-mini');
    const profileModal = document.getElementById('user-profile-modal');
    if (profileBtn && profileModal) {
        profileBtn.addEventListener('click', () => {
            // Cargar datos actuales
            document.getElementById('profile-name-in').value = localStorage.getItem('tecnobanda_user') || "";
            document.getElementById('profile-email-in').value = localStorage.getItem('tecnobanda_email') || "";
            document.getElementById('profile-phone-in').value = localStorage.getItem('tecnobanda_phone') || "";

            ui.settingsModal.classList.remove('active');
            profileModal.classList.add('active');
        });
    }

    const saveProfileBtn = document.getElementById('save-profile-btn');
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
            const newName = document.getElementById('profile-name-in').value.trim();
            const newPhone = document.getElementById('profile-phone-in').value.trim();
            const email = localStorage.getItem('tecnobanda_email');
            const deviceId = localStorage.getItem('tecnobanda_device_id');

            if (!newName) return alert("El nombre no puede estar vacío");

            saveProfileBtn.disabled = true;
            saveProfileBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Guardando...';

            try {
                const apiHost = window.location.hostname;
                const res = await fetch(`/api/users/profile`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, deviceId, name: newName, phone: newPhone })
                });

                if (res.ok) {
                    localStorage.setItem('tecnobanda_user', newName);
                    localStorage.setItem('tecnobanda_phone', newPhone);
                    showToast("✅ Perfil actualizado correctamente");
                    profileModal.classList.remove('active');
                    // Actualizar el título del header si es necesario
                    const headerTitle = document.querySelector('.premium-title');
                    if (headerTitle) headerTitle.innerText = `TecnoBanda: ${newName}`;
                } else {
                    const data = await res.json();
                    alert(data.error || "Error al actualizar perfil");
                }
            } catch (err) {
                console.error(err);
                alert("Error de conexión con el servidor");
            } finally {
                saveProfileBtn.disabled = false;
                saveProfileBtn.innerHTML = 'Guardar Cambios';
            }
        });
    }

    // Botón Abrir Modal Activación
    const openActBtn = document.getElementById('open-activation-btn');
    if (openActBtn) {
        openActBtn.addEventListener('click', () => {
            ui.settingsModal.classList.remove('active');
            document.getElementById('activation-modal').classList.add('active');
        });
    }

    // Lógica de Activación de Licencia
    const submitAct = document.getElementById('submit-activation');
    const actInput = document.getElementById('activation-code');
    const actMsg = document.getElementById('activation-msg');

    if (submitAct && actInput) {
        submitAct.addEventListener('click', async () => {
            const code = actInput.value.trim().toUpperCase();
            const deviceId = localStorage.getItem('tecnobanda_device_id');
            const actMsg = document.getElementById('activation-msg');

            actMsg.innerText = "Verificando con servidor...";
            actMsg.style.color = "white";

            try {
                const apiHost = window.location.hostname;
                const email = localStorage.getItem('tecnobanda_email');
                const res = await fetch(`/api/activate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: code, deviceId, email })
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    localStorage.setItem('tecnobanda_license_expiry', data.expiresAt);

                    actMsg.style.color = "#2ecc71";
                    actMsg.innerText = `✅ ¡Código Válido! Tipo: ${data.type}`;

                    setTimeout(() => {
                        document.getElementById('activation-modal').classList.remove('active');
                        actInput.value = "";
                        actMsg.innerText = "";
                        showToast(`Licencia Activada Correctamente`);
                        location.reload(); // Recargar para aplicar cambios
                    }, 2000);
                } else {
                    actMsg.style.color = "#ff4757";
                    actMsg.innerText = `❌ ${data.error || "Código inválido"}`;
                }

            } catch (err) {
                console.error(err);
                actMsg.style.color = "#ff4757";
                actMsg.innerText = "❌ Error de conexión con el servidor.";
            }
        });
    }

    if (ui.reverbSlider) {
        ui.reverbSlider.addEventListener('input', () => {
            const level = ui.reverbSlider.value / 100;
            state.reverbLevel = level;
            ui.reverbValTxt.innerText = Math.round(level * 100) + "%";
            if (state.vocalWet) {
                // El nivel de Reverb afecta a la mezcla Wet/Dry
                state.vocalWet.gain.setTargetAtTime(level, state.audioContext.currentTime, 0.05);
                // Bajamos un poco el dry para mantener volumen constante si hay mucho reverb
                state.vocalDry.gain.setTargetAtTime(1 - (level * 0.3), state.audioContext.currentTime, 0.05);
            }
        });
    }

    // --- Hotkeys (Optimizado para tablets con teclado o PC) ---
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return; // No disparar si está escribiendo en búsqueda

        const key = e.key.toLowerCase();
        if (key === ' ' || key === 'k') { e.preventDefault(); togglePlay(); }
        if (key === 'n') { e.preventDefault(); skipNextTrack(); }

        // Teclas 1-5 para Mute/Unmute
        if (['1', '2', '3', '4', '5'].includes(key)) {
            const idx = parseInt(key) - 1;
            if (ui.toggles[idx]) {
                ui.toggles[idx].checked = !ui.toggles[idx].checked;
                ui.toggles[idx].dispatchEvent(new Event('change'));
                showToast(`${['Bajo', 'Batería', 'Guitarra', 'Armonía', 'Voz'][idx]} ${ui.toggles[idx].checked ? 'ON' : 'OFF'}`);
            }
        }
    });

    // --- Cierre automático del buscador al hacer clic fuera ---
    document.addEventListener('click', (e) => {
        if (!ui.mainSearch || !ui.mainResults) return;
        const isSearchInput = e.target === ui.mainSearch;
        const isInsideResults = ui.mainResults.contains(e.target);
        if (!isSearchInput && !isInsideResults && ui.mainSearch.value !== "") {
            ui.mainSearch.value = "";
            ui.mainResults.classList.add('hidden');
        }
    });
}

function updateSettingsScrollIndicators() {
    const modal = ui.settingsModal;
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const down = document.getElementById('settings-scroll-down');

    if (!content || !down) return;

    const isScrollable = content.scrollHeight > content.clientHeight + 1;
    const isAtBottom = Math.abs(content.scrollHeight - content.clientHeight - content.scrollTop) < 5;

    if (isScrollable && !isAtBottom) {
        down.classList.remove('hidden');
    } else {
        down.classList.add('hidden');
    }
}

async function loadFromUrl(url) {
    if (!url) return false;
    ui.dbStatus.innerText = "Sincronizando...";

    // Si la URL es externa (http), usamos el puente del servidor para evitar bloqueos de CORS
    let finalUrl = url;
    if (url.startsWith('http')) {
        finalUrl = `/api/proxy-sync?url=${encodeURIComponent(url)}`;
    }

    try {
        const response = await fetch(finalUrl);
        if (!response.ok) throw new Error("Network response was not ok");

        const data = await response.json();
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
        state.localDb = data.map(track => {
            if (track.isCompressed && typeof track.archiveFile === 'string') {
                if (!track.archiveFile.startsWith('http')) {
                    track.archiveFile = baseUrl + track.archiveFile;
                }
            }
            if (!track.isCompressed && Array.isArray(track.stems)) {
                track.stems = track.stems.map(s => (typeof s === 'string' && !s.startsWith('http')) ? baseUrl + s : s);
            }
            return track;
        });

        // Mostrar contador total de la biblioteca
        if (ui.libraryCount) {
            ui.libraryCount.innerHTML = `<i class="fa-solid fa-list-music"></i> <b>${data.length}</b> canciones disponibles`;
        }

        // Restaurar estado de licencia después de sincronizar
        refreshLicenseUI();

        showToast("✓ Biblioteca sincronizada.");
        renderRecentSongs();
        return true;
    } catch (e) {
        console.error(`Error al conectar con ${url}:`, e);
        return false;
    }
}

function handleFolder(e) {
    const files = Array.from(e.target.files);
    const folders = {}; const archives = [];
    files.forEach(f => {
        const path = f.webkitRelativePath; if (!path) return;
        if (f.name.toLowerCase().endsWith('.zip')) { archives.push(f); return; }
        const p = path.split('/'); if (p.length < 2) return;
        const dir = p.slice(0, -1).join('/');
        if (!folders[dir]) folders[dir] = []; folders[dir].push(f);
    });
    state.localDb = [];
    archives.forEach(f => state.localDb.push({ title: f.name.replace(".zip", ""), artist: "Local", isCompressed: true, archiveFile: f }));

    for (const [dir, fList] of Object.entries(folders)) {
        const stems = [null, null, null, null, null];
        let usedFiles = new Set();

        const findAndStore = (words, index) => {
            const found = fList.find(f => {
                if (usedFiles.has(f.name)) return false;
                const n = f.name.toLowerCase();
                return words.some(w => {
                    const idx = n.indexOf(w);
                    if (idx === -1) return false;

                    // Formato Moises: debe estar rodeado de guiones o espacios
                    // Ej: "Cancion - bass - mix.mp3"
                    const charBefore = idx > 0 ? n[idx - 1] : ' ';
                    const charAfter = n[idx + w.length] || ' ';
                    const isIsolated = /[^a-z0-9]/.test(charBefore) && /[^a-z0-9]/.test(charAfter);

                    return isIsolated;
                });
            });
            if (found) { stems[index] = found; usedFiles.add(found.name); return true; }
            return false;
        };

        // Prioridad 1: Números exactos
        for (let i = 0; i < 5; i++) {
            const numF = fList.find(f => f.name.startsWith((i + 1).toString()) && !usedFiles.has(f.name));
            if (numF) { stems[i] = numF; usedFiles.add(numF.name); }
        }

        // Prioridad 2: Palabras clave Moises
        if (!stems[0]) findAndStore(['bass'], 0);
        if (!stems[1]) findAndStore(['drums'], 1);
        if (!stems[2]) findAndStore(['guitars', 'guitar', 'piano'], 2);
        if (!stems[3]) findAndStore(['other', 'others'], 3);
        if (!stems[4]) findAndStore(['vocals', 'voice'], 4);

        if (stems.filter(s => s !== null).length >= 3) {
            const p = dir.split('/'); state.localDb.push({ title: p.pop(), artist: p.pop() || "Local", stems, isCompressed: false });
        }
    }
    ui.dbStatus.innerText = `DB: ${state.localDb.length} temas Moises/Local.`;
}

function handleSearch() {
    const q = ui.mainSearch.value.trim().toLowerCase();
    if (!q) { ui.mainResults.classList.add('hidden'); return; }
    const matches = state.localDb.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
    renderResults(matches);
}

function renderResults(matches) {
    ui.mainResults.classList.remove('hidden');
    if (matches.length === 0) {
        const waNum = state.config.whatsappNumber || "526861329430";
        const waMsg = state.config.whatsappMessage || "Solicitarla por WhatsApp";

        // Verificar licencia para el botón de solicitud
        const license = localStorage.getItem('tecnobanda_license_expiry');
        const isPremium = license && new Date(license) > new Date();

        if (isPremium) {
            ui.mainResults.innerHTML = `
                <div style="padding: 20px; text-align:center;">
                    <p>No encontrada.</p>
                    <a href="https://wa.me/${waNum}" target="_blank" class="wa-action-btn">
                        <i class="fa-brands fa-whatsapp"></i> ${waMsg}
                    </a>
                </div>`;
        } else {
            ui.mainResults.innerHTML = `
                <div style="padding: 20px; text-align:center;">
                    <p>No encontrada.</p>
                    <div class="wa-action-btn" style="cursor: pointer;" onclick="showToast('Solo disponible modo premium')">
                        <i class="fa-brands fa-whatsapp"></i> ${waMsg}
                    </div>
                </div>`;
        }
        return;
    }
    ui.mainResults.innerHTML = matches.map(m => {
        const dbIdx = state.localDb.indexOf(m);
        const artistLine = m.artist ? `<span>${m.artist}</span><br>` : "";
        return `
            <div class="search-result-item" 
                 draggable="true" 
                 onselectstart="return false"
                 ondragstart="window.handleSongDragStart(event, ${dbIdx})"
                 onclick="window.addToQueue(${dbIdx})">
                <div class="result-info">
                    ${artistLine}
                    <b>${m.title}</b>
                </div>
                <div class="result-actions">
                    <small style="opacity:0.5; font-size:0.6rem;"><i class="fa-solid fa-hand-pointer"></i> Arrastra</small>
                </div>
            </div>`;
    }).join('');
}

// --- Drag & Drop Logic for Playlists ---
window.handleSongDragStart = (e, songIdx) => {
    e.dataTransfer.setData("songIdx", songIdx);
    e.dataTransfer.effectAllowed = "copy";
    // Feedback visual opcional
    showToast("Arrastrando canción...");
};

// --- Logic for Setlists (Playlists) ---
window.startTabAutoSwitchTimer = () => {
    if (state.tabAutoSwitchTimer) clearTimeout(state.tabAutoSwitchTimer);

    state.tabAutoSwitchTimer = setTimeout(() => {
        const isListasActive = document.getElementById('tab-listas').classList.contains('active');
        const isDetailVisible = !document.getElementById('tab-content-playlist-detail').classList.contains('hidden');

        if (isListasActive || isDetailVisible) {
            window.switchLeftTab('novedades');
        }
    }, 50000);
}

window.switchLeftTab = (tabId) => {
    // Limpiar timer anterior si existe
    if (state.tabAutoSwitchTimer) {
        clearTimeout(state.tabAutoSwitchTimer);
        state.tabAutoSwitchTimer = null;
    }

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content-view').forEach(v => v.classList.add('hidden'));

    const tabBtn = document.getElementById(`tab-${tabId}`);
    if (tabBtn) tabBtn.classList.add('active');

    document.getElementById(`tab-content-${tabId}`).classList.remove('hidden');

    if (tabId === 'listas' || tabId === 'playlist-detail') {
        if (tabId === 'listas') renderPlaylists();
        window.startTabAutoSwitchTimer();
    }
};

window.showActionModal = ({ title, desc, icon, showInput, confirmText, onConfirm }) => {
    const modal = document.getElementById('action-modal');
    const titleEl = document.getElementById('action-modal-title');
    const descEl = document.getElementById('action-modal-desc');
    const iconEl = document.getElementById('action-modal-icon');
    const inputContainer = document.getElementById('action-modal-input-container');
    const input = document.getElementById('action-modal-input');
    const confirmBtn = document.getElementById('action-modal-confirm');
    const cancelBtn = document.getElementById('action-modal-cancel');

    titleEl.innerText = title || "Confirmación";
    descEl.innerText = desc || "";
    iconEl.innerHTML = `<i class="fa-solid fa-${icon || 'circle-question'}"></i>`;
    confirmBtn.innerText = confirmText || "Aceptar";

    if (showInput) {
        inputContainer.classList.remove('hidden');
        input.value = "";
    } else {
        inputContainer.classList.add('hidden');
    }

    modal.classList.add('active');

    const close = () => modal.classList.remove('active');

    confirmBtn.onclick = () => {
        const val = input.value.trim();
        if (showInput && !val) return showToast("Por favor ingresa un nombre");
        onConfirm(val);
        close();
    };

    cancelBtn.onclick = close;
};

window.renderPlaylists = () => {
    const container = document.getElementById('user-playlists-container');
    if (!container) return;

    if (state.userPlaylists.length === 0) {
        container.innerHTML = '<div class="empty-msg">No tienes listas creadas</div>';
        return;
    }

    container.innerHTML = state.userPlaylists.map((p, idx) => `
        <div class="playlist-entry" 
             ondragover="window.handleListDragOver(event)" 
             ondragleave="window.handleListDragLeave(event)"
             ondrop="window.handleListDrop(event, ${idx})"
             onclick="window.viewPlaylist(${idx})">
            <i class="fa-solid fa-music-list"></i>
            <div class="playlist-info">
                <span class="playlist-name">${p.name}</span>
                <span class="playlist-count">${p.songs.length} canciones</span>
            </div>
            <button class="action-btn delete" onclick="window.deletePlaylist(event, ${idx})" style="background:none; border:none; color:#ff4757; cursor:pointer;">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
    `).join('');
};

window.handleListDragOver = (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
    e.dataTransfer.dropEffect = "copy";
};

window.handleListDragLeave = (e) => {
    e.currentTarget.classList.remove('drag-over');
};

window.handleListDrop = async (e, listIdx) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const songIdx = e.dataTransfer.getData("songIdx");
    const song = state.localDb[songIdx];

    if (song && state.userPlaylists[listIdx]) {
        const playlist = state.userPlaylists[listIdx];
        const updatedSongs = [...playlist.songs, song];

        try {
            const apiHost = window.location.hostname;
            const res = await fetch(`/api/playlists/${playlist.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songs: updatedSongs })
            });

            if (res.ok) {
                playlist.songs = updatedSongs;
                renderPlaylists();
                window.startTabAutoSwitchTimer();
                showToast(`✓ "${song.title}" añadida.`);
            }
        } catch (err) {
            showToast("Error al guardar en el servidor");
        }
    }
};

// --- Logic for Queue Drop ---
window.handleQueueDragOver = (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('queue-drag-over');
    e.dataTransfer.dropEffect = "copy";
};

window.handleQueueDragLeave = (e) => {
    e.currentTarget.classList.remove('queue-drag-over');
};

window.handleQueueDrop = (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('queue-drag-over');
    const songIdx = e.dataTransfer.getData("songIdx");
    if (songIdx !== "") {
        window.addToQueue(parseInt(songIdx));
    }
};

window.deletePlaylist = async (e, idx) => {
    e.stopPropagation();
    const p = state.userPlaylists[idx];

    window.showActionModal({
        title: "Borrar Lista",
        desc: `¿Estás seguro que deseas eliminar "${p.name}"? Esta acción no se puede deshacer.`,
        icon: "trash-can",
        confirmText: "Eliminar",
        onConfirm: async () => {
            try {
                const res = await fetch(`/api/playlists/${p.id}`, { method: 'DELETE' });
                if (res.ok) {
                    state.userPlaylists.splice(idx, 1);
                    renderPlaylists();
                    window.startTabAutoSwitchTimer();
                    showToast("Lista eliminada.");
                    if (!document.getElementById('tab-content-playlist-detail').classList.contains('hidden')) {
                        switchLeftTab('listas');
                    }
                }
            } catch (err) {
                showToast("Error al eliminar del servidor");
            }
        }
    });
};

window.createNewList = async () => {
    window.showActionModal({
        title: "Nueva Lista",
        desc: "Ponle un nombre profesional a tu próximo set musical.",
        icon: "folder-plus",
        showInput: true,
        confirmText: "Crear Lista",
        onConfirm: async (name) => {
            const email = localStorage.getItem('tecnobanda_email');
            if (!email) return showToast("Debes iniciar sesión");

            try {
                const res = await fetch(`/api/playlists`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, name })
                });

                const data = await res.json();
                if (res.ok) {
                    state.userPlaylists.push(data);
                    renderPlaylists();
                    window.startTabAutoSwitchTimer();
                    showToast(`Lista "${name}" creada.`);
                } else {
                    showToast("Error: " + (data.error || "No se pudo crear"));
                }
            } catch (err) {
                showToast("Error de conexión con el servidor.");
            }
        }
    });
};

window.promptAddToList = (songIdx) => {
    const song = state.localDb[songIdx];
    if (state.userPlaylists.length === 0) {
        if (confirm("No tienes listas. ¿Quieres crear una nueva?")) {
            createNewList();
        }
        return;
    }

    // Dynamic selection (could be a modal, but for demo let's use prompt/simple logic)
    const listNames = state.userPlaylists.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    const choice = prompt(`Añadir "${song.title}" a:\n${listNames}\n\nIngresa el número:`);
    const idx = parseInt(choice) - 1;

    if (state.userPlaylists[idx]) {
        state.userPlaylists[idx].songs.push(song);
        showToast(`Añadida a ${state.userPlaylists[idx].name}`);
        if (document.getElementById('tab-listas').classList.contains('active')) renderPlaylists();
    }
};

window.viewPlaylist = (idx) => {
    const p = state.userPlaylists[idx];
    if (!p) return;

    // Cambiar a vista de detalle
    window.switchLeftTab('playlist-detail');
    document.getElementById('detail-list-name').innerText = p.name;
    document.getElementById('detail-list-count').innerText = `${p.songs.length} canciones`;

    const container = document.getElementById('playlist-songs-container');
    if (!container) return;

    if (p.songs.length === 0) {
        container.innerHTML = '<div class="empty-msg">Esta lista está vacía. Jala canciones aquí para agregarlas.</div>';
    } else {
        container.innerHTML = p.songs.map((song, sIdx) => `
            <div class="recent-item">
                <div class="ri-info">
                    <span class="ri-title">${song.title}</span>
                    <span class="ri-artist">${song.artist || 'Artista'}</span>
                </div>
                <button class="action-btn delete" onclick="window.removeFromPlaylist(event, ${idx}, ${sIdx})" style="background:none; border:none; color:#ff4757; cursor:pointer; font-size:0.8rem;">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `).join('');
    }

    // Configurar el botón de cargar todo
    const loadBtn = document.getElementById('load-playlist-to-queue-btn');
    loadBtn.onclick = () => {
        if (p.songs.length === 0) return showToast("La lista está vacía.");

        // 1. Agregar todas las canciones a la cola "en silencio" (sin disparar descargas)
        p.songs.forEach(song => {
            const dbIdx = state.localDb.findIndex(t => t.title === song.title && t.artist === song.artist);
            if (dbIdx !== -1) {
                const original = state.localDb[dbIdx];
                const t = { ...original, uid: 'tr-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5) };
                state.queue.push(t);
            }
        });

        renderQueue();
        showToast(`✓ ${p.songs.length} canciones añadidas.`);

        // 2. Disparar solo la primera si el player está libre
        if (!state.isPlaying && state.buffers.length === 0 && !state.isLoading && state.queue.length > 0) {
            loadAndPlay(state.queue.shift(), false);
            renderQueue();
        } else {
            preloadNextTrack(); // O precargar la siguiente si ya hay algo
        }
    };
};

window.removeFromPlaylist = async (e, listIdx, songIdx) => {
    e.stopPropagation();
    const playlist = state.userPlaylists[listIdx];
    const updatedSongs = [...playlist.songs];
    updatedSongs.splice(songIdx, 1);

    try {
        const res = await fetch(`/api/playlists/${playlist.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songs: updatedSongs })
        });

        if (res.ok) {
            playlist.songs = updatedSongs;
            window.viewPlaylist(listIdx); // Refrescar vista
            window.startTabAutoSwitchTimer();
            showToast("Canción quitada.");
        }
    } catch (err) {
        showToast("Error al sincronizar");
    }
};

function renderQueue() {
    ui.queueCount.innerText = state.queue.length;
    if (state.queue.length === 0) { ui.queueList.innerHTML = `<div class="empty-queue-msg">Cola vacía</div>`; return; }
    ui.queueList.innerHTML = state.queue.map((t, i) => {
        const st = (state.isPreloading && i === 0) ? `<div class="queue-loading-wrapper"><div class="queue-loading-text">CARGANDO</div><div class="cd-spinner"></div></div>` : (state.preloadedTrack === t ? `<i class="fa-solid fa-check" title="Listo para sonar"></i>` : '');
        const artistLine = t.artist ? `<br><small>${t.artist}</small>` : "";
        return `<div class="queue-item" data-uid="${t.uid}"><div class="qi-info"><b>${t.title}</b>${artistLine}</div><div class="qi-status">${st}</div><button class="qi-btn" onclick="window.removeFromQueue(event, ${i})"><i class="fa-solid fa-trash"></i></button></div>`;
    }).join('');
    if (state.settings.persistQueue) localStorage.setItem('rockola_v2_queue', JSON.stringify(state.queue));
}

window.removeFromQueue = (e, i) => {
    e.stopPropagation();
    const removedTrack = state.queue.splice(i, 1)[0];
    if (state.preloadedTrack === removedTrack) { state.preloadedBuffers = []; state.preloadedTrack = null; }
    renderQueue();
    preloadNextTrack();
};
window.addToQueue = (idx) => {
    const original = state.localDb[idx]; if (!original) return;
    // Crear copia con UID único para poder moverla en la cola
    const t = { ...original, uid: 'tr-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5) };
    state.queue.push(t); renderQueue(); showToast("Añadida.");
    renderQueue();
    ui.mainResults.classList.add('hidden'); ui.mainSearch.value = "";
    if (!state.isPlaying && state.buffers.length === 0) {
        loadAndPlay(state.queue.shift(), false);
        renderQueue();
    }
    else if (state.queue.length === 1 || state.queue.indexOf(t) === 0) preloadNextTrack();
};

function renderRecentSongs() {
    if (!ui.recentList || state.localDb.length === 0) {
        if (ui.recentList) ui.recentList.innerHTML = `<div class="empty-msg">No hay canciones nuevas.</div>`;
        return;
    }

    // El servidor ya nos entrega la DB ordenada por fecha (lo más nuevo primero)
    // Así que simplemente mostramos las primeras 9 canciones como "Novedades"
    const toRender = state.localDb.slice(0, 9);

    ui.recentList.innerHTML = toRender.map(track => {
        const originalIdx = state.localDb.indexOf(track);
        const clickAction = (originalIdx !== -1) ? `onclick="window.addToQueue(${originalIdx})"` : '';
        const dragAction = (originalIdx !== -1) ? `draggable="true" ondragstart="window.handleSongDragStart(event, ${originalIdx})"` : '';

        return `
            <div class="recent-item" ${clickAction} ${dragAction}>
                <div class="ri-info">
                    <span class="ri-title">${track.title}</span>
                    <span class="ri-artist">${track.artist || 'Artista Desconocido'}</span>
                </div>
            </div>
        `;
    }).join('');
}

async function extractStemsFromArchive(file, onProgress) {
    let data = file;
    if (typeof file === 'string') { const response = await fetch(file); data = await response.arrayBuffer(); }
    const zip = await JSZip.loadAsync(data);
    const audioPaths = Object.keys(zip.files).filter(fn => !zip.files[fn].dir && (fn.endsWith('.mp3') || fn.endsWith('.wav')));
    const blobs = [null, null, null, null, null];

    const keywords = [
        ['bass', 'bajo', '1', '01'],
        ['drums', 'bateria', '2', '02'],
        ['guitar', 'guitars', 'guitarra', 'piano', '3', '03'],
        ['other', 'others', 'armonia', '4', '04'],
        ['vocals', 'voice', 'voz', '5', '05']
    ];

    let usedPaths = new Set();
    for (let i = 0; i < 5; i++) {
        const fn = audioPaths.find(p => {
            if (usedPaths.has(p)) return false;
            const name = p.toLowerCase();
            return keywords[i].some(k => {
                const idx = name.indexOf(k);
                if (idx === -1) return false;

                const charBefore = idx > 0 ? name[idx - 1] : ' ';
                const charAfter = name[idx + k.length] || ' ';
                const isIsolated = /[^a-z0-9]/.test(charBefore) && /[^a-z0-9]/.test(charAfter);

                return isIsolated;
            });
        });
        if (fn) {
            usedPaths.add(fn);
            blobs[i] = await zip.files[fn].async("blob");
            if (onProgress) onProgress(((i + 1) / 5) * 100);
        }
    }
    return blobs.some(b => b !== null) ? blobs : null;
}

function updatePlayIcon(play) { ui.playBtn.innerHTML = play ? `<i class="fa-solid fa-pause"></i>` : `<i class="fa-solid fa-play"></i>`; }
function showToast(m) {
    // Evitar que el mismo mensaje se encole varias veces si el usuario hace clic rápido
    if (state.toastQueue.includes(m)) return;
    state.toastQueue.push(m);
    processToastQueue();
}

function processToastQueue() {
    if (state.isShowingToast || state.toastQueue.length === 0) return;

    state.isShowingToast = true;
    const m = state.toastQueue.shift();
    const t = document.getElementById('toast');

    if (t) {
        t.innerText = m;
        t.classList.remove('hidden');
        t.classList.add('active'); // Asegurarnos de usar una clase active para animaciones

        setTimeout(() => {
            t.classList.remove('active');
            t.classList.add('hidden');
            setTimeout(() => {
                state.isShowingToast = false;
                processToastQueue();
            }, 600); // Pausa breve entre notificaciones
        }, 4000);
    } else {
        state.isShowingToast = false;
    }
}
function playDing() {
    const o = state.audioContext.createOscillator(); const g = state.audioContext.createGain();
    o.connect(g); g.connect(state.masterGain); o.frequency.value = 880;
    g.gain.setValueAtTime(0.1, state.audioContext.currentTime); g.gain.exponentialRampToValueAtTime(0.001, state.audioContext.currentTime + 0.3);
    o.start(); o.stop(state.audioContext.currentTime + 0.3);
}

window.forceGlobalLogout = (reason) => {
    console.warn("KICK SYSTEM:", reason);
    localStorage.removeItem('tecnobanda_user');
    localStorage.removeItem('tecnobanda_email');
    localStorage.removeItem('tecnobanda_phone');
    localStorage.removeItem('tecnobanda_license_expiry');
    alert("⚠️ SESIÓN CERRADA: " + reason);
    location.reload();
};

async function refreshLicenseUI() {
    const savedUser = localStorage.getItem('tecnobanda_user');
    const deviceId = localStorage.getItem('tecnobanda_device_id');
    const email = localStorage.getItem('tecnobanda_email');

    if (!savedUser || !deviceId) return;

    try {
        console.log(`[Ping] Verificando sesión para ${email}...`);

        const res = await fetch(`/api/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, email, name: savedUser })
        });

        if (res.status === 404 || res.status === 401) {
            console.warn("🚫 Usuario no encontrado en el servidor (404/401).");
            forceGlobalLogout("Cuenta no encontrada en el servidor.");
            return;
        }

        const data = await res.json();

        // Si el servidor indica que el usuario debe cerrar sesión (ej. fue eliminado)
        if (data && data.status === 'logout') {
            console.warn("🚫 SESIÓN INVALIDADA por el servidor.");
            forceGlobalLogout(data.message || "Usuario eliminado.");
            return;
        }

        const wasPremium = localStorage.getItem('tecnobanda_license_expiry') !== null;
        const isCurrentlyPremium = data.status === 'active';

        if (isCurrentlyPremium) {
            localStorage.setItem('tecnobanda_license_expiry', data.expiresAt);
            updateLicenseUI(true, savedUser, data.expiresAt);

            // Si antes no era premium y ahora sí (ej. activación remota)
            if (!wasPremium && state.licenseInterval) {
                showToast("✨ ¡Licencia Activada remotamente!");
            }
        } else {
            localStorage.removeItem('tecnobanda_license_expiry');
            updateLicenseUI(false, savedUser, null);

            // Si antes era premium y ya no lo es (ej. revocación o expiración)
            if (wasPremium) {
                showToast("⚠️ Licencia revocada o expirada.");
                // Si la música está sonando y pasó los 70s, el updateUIProgress lo detendrá en el próximo tick
            }
        }
    } catch (err) {
        // Offline Fallback
        const license = localStorage.getItem('tecnobanda_license_expiry');
        const isPremium = license && new Date(license) > new Date();
        updateLicenseUI(isPremium, savedUser, license);
    }
}

function updateLicenseUI(isActive, user, expiry) {
    const headerTitle = document.querySelector('.premium-title');
    const actBtn = document.getElementById('open-activation-btn');
    const statusText = document.getElementById('db-status-text');

    // Título principal con el nombre del usuario
    if (headerTitle) {
        headerTitle.innerText = `TecnoBanda: ${user}`;
    }

    if (isActive) {
        // 1. Status en el modal (junto al botón de reset)
        if (statusText) {
            statusText.innerHTML = `<span class="license-badge badge-premium">✨ PREMIUM</span> Licencia Activa`;
            statusText.style.color = "#2ecc71";
            statusText.style.fontWeight = "bold";
        }

        // 2. Botón: Verde y con fecha
        if (actBtn) {
            actBtn.style.background = "#2ecc71"; // Verde
            actBtn.style.color = "white";
            actBtn.style.textAlign = "center";
            const dateStr = new Date(expiry).toLocaleDateString();
            const timeStr = new Date(expiry).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            actBtn.innerHTML = `<i class="fa-solid fa-check-circle"></i> LICENCIA ACTIVADA <br><small style="font-size:0.75rem; opacity: 0.9;">Vence: ${dateStr} ${timeStr}</small>`;
            actBtn.disabled = true;
        }

    } else {
        // 1. Status en el modal (junto al botón de reset)
        if (statusText) {
            statusText.innerHTML = `<span class="license-badge badge-trial">🔒 MODO PRUEBA</span> (Demo 70s)`;
            statusText.style.color = "#e74c3c";
        }

        // 2. Botón: Original (Naranja/Amarillo)
        if (actBtn) {
            actBtn.style.background = "linear-gradient(45deg, #f1c40f, #e67e22)";
            actBtn.style.color = "black";
            actBtn.style.textAlign = "center";
            actBtn.innerHTML = `<i class="fa-solid fa-key"></i> ACTIVAR LICENCIA PREMIUM`;
            actBtn.disabled = false;

            // Asegurar que abra el modal al hacer click
            actBtn.onclick = () => {
                ui.settingsModal.classList.remove('active');
                document.getElementById('activation-modal').classList.add('active');
            };
        }
    }
}

async function refreshAudioLists() {
    console.log("🔄 Actualizando listas de audio...");
    const apiHost = window.location.hostname || 'localhost';

    try {
        // Cargar Intros
        const resIntros = await fetch(`/api/admin/audios/intros`);
        const intros = await resIntros.json();
        if (ui.defaultIntroSelect) {
            ui.defaultIntroSelect.innerHTML = intros.map(i => `<option value="${i.url}">${i.name}</option>`).join('');

            // Si hay una selección guardada, aplicarla
            if (state.settings.selectedIntro) {
                ui.defaultIntroSelect.value = state.settings.selectedIntro;
                loadAudioToBuffer(state.settings.selectedIntro, 'intro');
            } else if (intros.length > 0) {
                const first = intros[0].url;
                ui.defaultIntroSelect.value = first;
                state.settings.selectedIntro = first;
                loadAudioToBuffer(first, 'intro');
            }
        }

        // Cargar Ambientes
        const resAmbient = await fetch(`/api/admin/audios/ambient`);
        const ambients = await resAmbient.json();
        if (ui.defaultAmbientSelect) {
            ui.defaultAmbientSelect.innerHTML = ambients.map(a => `<option value="${a.url}">${a.name}</option>`).join('');

            // Si hay una selección guardada, aplicarla
            if (state.settings.selectedAmbient) {
                ui.defaultAmbientSelect.value = state.settings.selectedAmbient;
                loadAudioToBuffer(state.settings.selectedAmbient, 'ambient');
            } else if (ambients.length > 0) {
                const first = ambients[0].url;
                ui.defaultAmbientSelect.value = first;
                state.settings.selectedAmbient = first;
                loadAudioToBuffer(first, 'ambient');
            }
        }
    } catch (e) {
        console.warn("No se pudieron cargar las listas de audios desde el servidor admin.");
    }
}

async function loadAudioToBuffer(url, type) {
    console.log(`📥 Cargando audio (${type}):`, url);
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`❌ Fallo al cargar ${type}: ${res.status}`);
            return;
        }
        const arrayBuf = await res.arrayBuffer();
        const decoded = await state.audioContext.decodeAudioData(arrayBuf);
        console.log(`✅ Audio decodificado (${type})`);
        if (type === 'intro') state.introBuffer = decoded;
        else {
            state.ambientBuffer = decoded;
            if (state.settings.ambient && state.isPlaying === false) playAmbient();
        }
    } catch (e) { console.error(`Error cargando buffer ${type}:`, e); }
}

// --- Referral & Gift System Functions ---

window.copyMyReferralCode = () => {
    let code = localStorage.getItem('tecnobanda_my_referral');

    // Fallback: try to get it from the UI if not in storage
    if (!code) {
        const codeEl = document.getElementById('my-referral-code');
        if (codeEl && codeEl.innerText !== '----') {
            code = codeEl.innerText;
        }
    }

    if (!code) {
        showToast("❌ No hay código para copiar");
        return;
    }

    const successMsg = "📋 Código copiado al portapapeles";
    const errorMsg = "❌ Error al copiar. Por favor escríbelo manualmente.";

    // Intentar con la API moderna de Clipboard
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(code).then(() => {
            showToast(successMsg);
        }).catch(err => {
            console.error('Clipboard error:', err);
            if (fallbackCopyText(code)) {
                showToast(successMsg);
            } else {
                showToast(errorMsg);
            }
        });
    } else {
        // Fallback for non-secure contexts (HTTP)
        if (fallbackCopyText(code)) {
            showToast(successMsg);
        } else {
            showToast(errorMsg);
        }
    }
};

function fallbackCopyText(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    let successful = false;
    try {
        successful = document.execCommand('copy');
    } catch (err) {
        console.error('Fallback: no se pudo copiar', err);
    }

    document.body.removeChild(textArea);
    return successful;
}

async function checkForGifts() {
    const email = localStorage.getItem('tecnobanda_email');
    if (!email) return;

    try {
        const res = await fetch(`/api/users/gifts?email=${email}`);
        const data = await res.json();

        const giftEl = document.getElementById('floating-gift');
        if (data.pendingGifts > 0) {
            giftEl.classList.remove('hidden');
            giftEl.querySelector('.gift-count').innerText = data.pendingGifts;
        } else {
            giftEl.classList.add('hidden');
        }
    } catch (e) {
        console.warn("No se pudieron verificar los regalos.");
    }
}

window.openGiftModal = () => {
    document.getElementById('gift-claim-modal').classList.add('active');
};

window.claimGift = async () => {
    const email = localStorage.getItem('tecnobanda_email');
    if (!email) return;

    try {
        await fetch(`/api/users/gifts/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        document.getElementById('gift-claim-modal').classList.remove('active');
        checkForGifts(); // Actualizar icono
    } catch (e) {
        console.error("Error al reclamar regalo:", e);
    }
};

// Add check to the main loop or on specific events
setInterval(checkForGifts, 60000); // Revisar cada minuto
setTimeout(checkForGifts, 2000); // Revisar al iniciar

// Initialize Referral UI in Profile
window.openProfileModal = () => {
    document.getElementById('user-profile-modal').classList.add('active');
};

window.fetchMyReferralCode = async () => {
    const email = localStorage.getItem('tecnobanda_email');
    if (!email) return showToast("Debes iniciar sesión primero", "error");

    const btn = document.getElementById('generate-referral-btn');
    const displayArea = document.getElementById('referral-code-display-area');
    const codeEl = document.getElementById('my-referral-code');

    try {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Obteniendo...';

        const res = await fetch(`/api/admin/users`);
        const users = await res.json();

        // Buscamos al usuario actual entre todos (forma rápida con la API existente)
        const me = users.find(u => u.email.toLowerCase().trim() === email.toLowerCase().trim());

        if (me && me.referral_code) {
            localStorage.setItem('tecnobanda_my_referral', me.referral_code);
            codeEl.innerText = me.referral_code;
            displayArea.classList.remove('hidden');
            btn.classList.add('hidden');
        } else {
            showToast("No se encontró tu código. Contacta a soporte.", "error");
        }
    } catch (e) {
        console.error(e);
        showToast("Error al conectar con el servidor", "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> VER MI CÓDIGO';
        }
        refreshReferralUI();
    }
};

function refreshReferralUI() {
    const savedUser = localStorage.getItem('tecnobanda_user');
    const referralBox = document.getElementById('referral-box-sidebar');
    if (!referralBox) return;

    if (!savedUser) {
        referralBox.classList.add('hidden');
        return;
    }

    referralBox.classList.remove('hidden');

    const savedCode = localStorage.getItem('tecnobanda_my_referral');
    const displayArea = document.getElementById('referral-code-display-area');
    const btn = document.getElementById('generate-referral-btn');
    const codeEl = document.getElementById('my-referral-code');
    const metaEl = document.getElementById('referral-meta-number');

    // Inyectar el número de meta desde la configuración (ej: 5)
    if (metaEl && state.config && state.config.referralMeta) {
        metaEl.innerText = state.config.referralMeta;
    }

    if (savedCode && codeEl && displayArea && btn) {
        codeEl.innerText = savedCode;
        displayArea.classList.remove('hidden');
        btn.classList.add('hidden');
    } else if (displayArea && btn) {
        displayArea.classList.add('hidden');
        btn.classList.remove('hidden');
    }
}


init();
