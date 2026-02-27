const BASE_URL = window.location.origin;
const API_URL = `${BASE_URL}/api`;
let allUsers = [];
let incomeLogs = [];
let moduleUsers = [];
let allLicenses = [];
let musicFiles = [];
let auditLogs = [];
let currentDetailsEmail = null;
let incomeChart, usersChart;
let socket;
let sortConfig = { column: null, direction: 'asc', tableId: null };

document.addEventListener('DOMContentLoaded', () => {
    console.log("Admin Panel Loaded. Initializing...");
    setTimeout(setupSockets, 500); // Dar un margen para que carguen las librerías
    initNavigation();
    fetchStats().then(() => console.log("Stats fetched")).catch(e => console.error("Stats fetch error", e));
    fetchGlobalConfig();
    fetchPrices();
    initSortingListeners();
    fetchHealth();
    setInterval(fetchHealth, 10000); // Actualizar salud cada 10s
});

async function fetchHealth() {
    try {
        const response = await fetch(`${API_URL}/health`);
        const data = await response.json();

        const verEl = document.getElementById('server-version');
        const upEl = document.getElementById('server-uptime');
        const cardEl = document.getElementById('server-health-card');

        if (verEl) verEl.innerText = data.version;
        if (upEl) upEl.innerText = `Activo: ${data.uptime}`;
        if (cardEl) cardEl.style.borderColor = "#2ecc71";
    } catch (e) {
        console.warn("Error fetching health:", e);
        const upEl = document.getElementById('server-uptime');
        if (upEl) upEl.innerHTML = '<span style="color:#e74c3c">DISCONNECTED</span>';
    }
}

function setupSockets() {
    console.log("Iniciando Sockets...");
    const statusText = document.getElementById('socket-status-text');

    if (typeof io === 'undefined') {
        console.error("Socket.io library not found!");
        if (statusText) statusText.innerHTML = '<span style="color:red">🔴 ERROR: Librería no cargada</span>';
        return;
    }

    // Conexión específica al servidor en el puerto 4000 para evitar ambigüedades
    // Conexión dinámica basada en el origen de la página
    const socketUrl = BASE_URL;
    console.log(`[Socket] Conectando a: ${socketUrl}`);

    socket = io(socketUrl, {
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
        console.log("✅ Conectado al servidor ADMIN. ID:", socket.id);
        if (statusText) {
            statusText.innerHTML = `<span style="color:#2ecc71">🟢 Servidor Conectado</span> <small style="font-size:0.6rem; opacity:0.5">(${socketUrl})</small>`;
        }
        socket.emit('join_admin');
    });

    socket.on('connect_error', (err) => {
        console.error("⚠️ Error de conexión:", err);
        if (statusText) {
            statusText.innerHTML = `<span style="color:#f1c40f">🟡 Reintentando...</span> <br><small style="font-size:0.6rem; color:#94a3b8">Hacia: ${socketUrl}</small>`;
        }
    });

    socket.on('update_users', () => {
        console.log("📡 WebSocket Event: update_users");
        fetchStats();
        fetchAllUsersForModule();
    });

    socket.on('update_status', (data) => {
        console.log("📡 WebSocket Event: update_status", data);
        fetchStats();
        fetchAllUsersForModule();
    });

    socket.on('update_licenses', () => {
        console.log("📡 WebSocket Event: update_licenses");
        fetchStats();
        fetchAllUsersForModule();
        fetchLicensesForModule();
    });

    socket.on('update_income', () => {
        console.log("📡 WebSocket Event: update_income");
        loadIncomeChart('monthly');
        loadUsersChart('monthly');
        fetchStats();
    });

    socket.on('toast', (data) => {
        showToast(data.message, data.type || 'info', data.title);
    });
}

// --- Navigation ---
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const sectionId = item.getAttribute('data-section');
            const title = item.getAttribute('data-title');
            switchSection(sectionId, title);

            // Set active class
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

function switchSection(sectionId, title) {
    // Hide all sections
    document.querySelectorAll('.content-section').forEach(s => s.classList.add('hidden'));

    // Show target
    const target = document.getElementById(sectionId);
    if (target) {
        target.classList.remove('hidden');
        if (title) document.getElementById('section-title').innerText = title;

        // Specific init for sections
        if (sectionId === 'income-section') {
            loadIncomeChart('monthly');
            loadUsersChart('monthly');
        } else if (sectionId === 'users-module-section') {
            fetchAllUsersForModule();
        } else if (sectionId === 'licenses-module-section') {
            fetchLicensesForModule();
        } else if (sectionId === 'email-config-section') {
            fetchEmailConfig();
        } else if (sectionId === 'audio-management-section') {
            fetchAudios('intros');
            fetchAudios('ambient');
        } else if (sectionId === 'music-library-section') {
            fetchMusicLibrary();
        } else if (sectionId === 'audit-logs-section') {
            fetchAuditLogs();
        } else if (sectionId === 'referral-config-section') {
            fetchReferralConfig();
        }
    }
}

// --- Data Fetching ---
async function fetchStats() {
    console.log("Fetching stats from:", `${API_URL}/admin/stats`);
    try {
        const res = await fetch(`${API_URL}/admin/stats`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        console.log("Stats data received:", data);

        const weeklyUsersEl = document.getElementById('weekly-users');
        const weeklyActivationsEl = document.getElementById('weekly-activations');
        const weeklyIncomeEl = document.getElementById('weekly-income');
        const arpuEl = document.getElementById('stat-arpu');

        const usersCount = data.weeklyUsers || 0;
        const activationsCount = data.weeklyActivations || 0;
        const incomeValue = data.weeklyIncome || 0;

        if (weeklyUsersEl) weeklyUsersEl.innerText = usersCount;
        if (weeklyActivationsEl) weeklyActivationsEl.innerText = activationsCount;
        if (weeklyIncomeEl) weeklyIncomeEl.innerText = `$${incomeValue.toLocaleString()}`;

        if (arpuEl) {
            const arpu = usersCount > 0 ? (incomeValue / usersCount).toFixed(2) : 0;
            arpuEl.innerText = `$${arpu}`;
        }

        allUsers = data.users || [];
        renderRecentUsers();
    } catch (err) {
        console.error("Error fetching stats:", err);
        const tbody = document.getElementById('users-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:red; text-align:center;">Error cargando datos: ${err.message}</td></tr>`;
    }
}

function renderRecentUsers() {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '';

    // Agrupar para detectar multilicencias
    const grouped = {};
    allUsers.forEach(u => {
        const email = u.email || 'anonimo';
        if (!grouped[email]) {
            grouped[email] = { ...u, devices: [] };
        }
        grouped[email].devices.push(u);
    });

    Object.values(grouped).forEach(user => {
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        tr.onclick = (e) => {
            if (!e.target.closest('.action-btn')) openDetailsModal(user.email);
        };

        const lastSeen = new Date(user.last_seen);
        const isOnline = (new Date() - lastSeen) < 5 * 60 * 1000;

        const isMulti = user.devices.length > 1;
        const licType = user.license_type || 'Prueba';

        const refStatus = user.referred_by ? `<span class="ref-badge" onclick="event.stopPropagation(); goToPadrino('${user.referred_by}')" title="Clic para ver Padrino"><i class="fa-solid fa-link"></i> ${user.referred_by}</span>` : '<span class="no-ref">Directo</span>';

        tr.innerHTML = `
            <td>#${user.id}</td>
            <td>${user.name || '---'} ${isMulti ? '<span class="multi-badge">MULTI</span>' : ''}</td>
            <td>${user.email || '---'}</td>
            <td>${user.phone || '---'}</td>
            <td><span class="status-badge ${user.license_type ? 'status-online' : 'status-offline'}">${licType}</span></td>
            <td>${lastSeen.toLocaleString()}</td>
            <td>${refStatus}</td>
            <td><span class="status-badge ${isOnline ? 'status-online' : 'status-offline'}">${isOnline ? 'On' : 'Off'}</span></td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="action-btn edit" onclick="openDetailsModal('${user.email}')"><i class="fa-solid fa-eye"></i></button>
                    <button class="action-btn delete" onclick="deleteUser(${user.id})"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Income & Charts ---
async function loadIncomeChart(period) {
    const canvas = document.getElementById('income-chart');
    if (!canvas) return;

    // Si no se pasa periodo, usar el actual del canvas
    const activePeriod = period || canvas.dataset.period || 'monthly';
    canvas.dataset.period = activePeriod;
    const chartType = canvas.dataset.type || 'line';

    setActiveButton('income', activePeriod);

    try {
        const res = await fetch(`${API_URL}/admin/income?period=${activePeriod}`);
        const data = await res.json();

        incomeLogs = data.logs || [];
        // Ya no renderizamos la tabla aquí para mantener la vista limpia
        // renderIncomeTable(incomeLogs); 

        const labels = data.chart.map(r => r.label);
        const values = data.chart.map(r => r.value);

        if (incomeChart) incomeChart.destroy();

        const ctx = canvas.getContext('2d');

        // Configuración según el tipo
        const isArea = chartType === 'area';
        const isBar = chartType === 'bar';
        const type = isArea ? 'line' : chartType;

        incomeChart = new Chart(ctx, {
            type: type,
            data: {
                labels,
                datasets: [{
                    label: 'Ventas (MXN)',
                    data: values,
                    borderColor: isBar ? '#60a5fa' : '#3b82f6',
                    backgroundColor: isBar ? 'rgba(96, 165, 250, 0.4)' : (isArea ? 'rgba(59, 130, 246, 0.4)' : 'rgba(59, 130, 246, 0.1)'),
                    fill: isArea || type === 'line',
                    tension: 0.4,
                    pointRadius: type === 'line' ? 4 : 0,
                    borderWidth: isBar ? 2 : 3,
                    hoverBackgroundColor: isBar ? 'rgba(96, 165, 250, 0.7)' : undefined,
                    hoverBorderColor: isBar ? '#fff' : undefined
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                return ` $${context.parsed.y.toLocaleString()} MXN`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        border: { display: false },
                        ticks: { color: '#94a3b8' }
                    },
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: { color: '#94a3b8' }
                    }
                }
            }
        });
    } catch (err) { console.error(err); }
}

async function loadUsersChart(period) {
    const canvas = document.getElementById('users-chart');
    if (!canvas) return;

    const activePeriod = period || canvas.dataset.period || 'monthly';
    canvas.dataset.period = activePeriod;
    const chartType = canvas.dataset.type || 'line';

    setActiveButton('users', activePeriod);

    try {
        const res = await fetch(`${API_URL}/admin/user-stats?period=${activePeriod}`);
        const data = await res.json();

        const labels = data.map(r => r.label);
        const values = data.map(r => r.value);

        if (usersChart) usersChart.destroy();

        const ctx = canvas.getContext('2d');

        const isArea = chartType === 'area';
        const isBar = chartType === 'bar';
        const type = isArea ? 'line' : chartType;

        usersChart = new Chart(ctx, {
            type: type,
            data: {
                labels,
                datasets: [{
                    label: 'Usuarios',
                    data: values,
                    borderColor: isBar ? '#34d399' : '#10b981',
                    backgroundColor: isBar ? 'rgba(52, 211, 153, 0.4)' : (isArea ? 'rgba(16, 185, 129, 0.4)' : 'rgba(16, 185, 129, 0.1)'),
                    fill: isArea || type === 'line',
                    tension: 0.4,
                    pointRadius: type === 'line' ? 4 : 0,
                    pointHoverRadius: 6,
                    borderWidth: isBar ? 2 : 3,
                    hoverBackgroundColor: isBar ? 'rgba(52, 211, 153, 0.7)' : undefined,
                    hoverBorderColor: isBar ? '#fff' : undefined
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                return ` ${context.parsed.y} usuarios registrados`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Cantidad de Usuarios',
                            color: '#94a3b8',
                            font: { size: 10 }
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        border: { display: false },
                        ticks: {
                            color: '#94a3b8',
                            precision: 0
                        }
                    },
                    x: {
                        ticks: { color: '#94a3b8' },
                        grid: { display: false }
                    }
                }
            }
        });
    } catch (err) { console.error(err); }
}

function changeChartType(chartId, type) {
    const canvas = document.getElementById(`${chartId}-chart`);
    if (!canvas) return;

    canvas.dataset.type = type;

    // Actualizar botones activos de tipo
    const container = canvas.closest('.chart-card');
    const buttons = container.querySelectorAll('.type-btn');
    buttons.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes(`'${type}'`));
    });

    // Recargar el gráfico manteniendo el periodo actual
    if (chartId === 'income') {
        loadIncomeChart();
    } else {
        loadUsersChart();
    }
}

function setActiveButton(type, period) {
    const containers = document.querySelectorAll('.chart-controls');
    // Swapped order: users is index 0, income is index 1
    const container = type === 'income' ? containers[1] : containers[0];

    if (container) {
        container.querySelectorAll('.filter-btn').forEach(btn => {
            if (btn.getAttribute('onclick').includes(`'${period}'`)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
}

function renderIncomeTable(logs) {
    const tbody = document.getElementById('income-table-body');
    tbody.innerHTML = '';
    logs.forEach(log => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${new Date(log.activated_at).toLocaleString()}</td>
            <td><b>${log.user_name || 'Desconocido'}</b><br><small>${log.device_id}</small></td>
            <td>${log.license_type}</td>
            <td>$${log.price_paid}</td>
        `;
        tbody.appendChild(tr);
    });
}

function filterIncomeTable() {
    const q = document.getElementById('income-search').value.toLowerCase();
    const filtered = incomeLogs.filter(l =>
        (l.user_name && l.user_name.toLowerCase().includes(q)) ||
        l.device_id.toLowerCase().includes(q) ||
        l.activated_at.includes(q)
    );
    renderIncomeTable(filtered);
}

// --- Prices ---
async function fetchPrices() {
    try {
        const res = await fetch(`${API_URL}/admin/config`);
        const config = await res.json();
        if (config.prices) {
            document.getElementById('price-day').value = config.prices['1_DAY'] || 10;
            document.getElementById('price-month').value = config.prices['30_DAYS'] || 250;
            document.getElementById('price-perm').value = config.prices['PERMANENT'] || 1500;
        }
    } catch (err) { console.error(err); }
}

async function savePrices() {
    const prices = {
        '1_DAY': parseFloat(document.getElementById('price-day').value),
        '30_DAYS': parseFloat(document.getElementById('price-month').value),
        'PERMANENT': parseFloat(document.getElementById('price-perm').value)
    };

    try {
        await fetch(`${API_URL}/admin/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prices })
        });
        alert("Precios actualizados!");
    } catch (err) { alert("Error al guardar precios"); }
}

// --- Full User Module ---
async function fetchAllUsersForModule() {
    try {
        console.log("Fetching all users for module...");
        const res = await fetch(`${API_URL}/admin/users`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        moduleUsers = await res.json();
        renderAllUsersTable(moduleUsers);

        // Si el modal de detalles está abierto para un usuario específico, refrescarlo
        if (currentDetailsEmail) {
            refreshDetailsModal();
        }
    } catch (err) {
        console.error("Error fetching module users:", err);
        const tbody = document.getElementById('all-users-module-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:red; text-align:center;">Error: ${err.message}</td></tr>`;
    }
}

function filterTotalUsersTable() {
    const q = document.getElementById('user-total-search').value.toLowerCase();
    const filtered = moduleUsers.filter(u =>
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.device_id && u.device_id.toLowerCase().includes(q))
    );
    renderAllUsersTable(filtered);
}

function renderAllUsersTable(users) {
    const tbody = document.getElementById('all-users-module-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Agrupar usuarios por email para la vista principal
    const grouped = {};
    users.forEach(u => {
        const email = u.email || 'anonimo';
        if (!grouped[email]) {
            grouped[email] = {
                id: u.id,
                name: u.name || '',
                email: u.email || '',
                phone: u.phone || '',
                devices: [],
                lastSeen: u.last_seen,
                referred_by: u.referred_by,
                referral_code: u.referral_code,
                referral_points: u.referral_points,
                pending_gifts: u.pending_gifts,
                total_gifts: u.total_gifts
            };
        }
        grouped[email].devices.push(u);
        if (new Date(u.last_seen) > new Date(grouped[email].lastSeen)) {
            grouped[email].lastSeen = u.last_seen;
        }
    });

    let groupedArray = Object.values(grouped);

    // Apply sorting to the grouped array if the current sort is for this table
    if (sortConfig.tableId === 'all-users-module-table-body') {
        groupedArray = sortTable(groupedArray, sortConfig.column, sortConfig.direction);
    }

    groupedArray.forEach(user => {
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        tr.onclick = (e) => {
            if (!e.target.closest('.action-btn')) openDetailsModal(user.email);
        };

        const isMulti = user.devices.length > 1;
        const licCount = user.devices.filter(d => d.license_type).length;
        const trialCount = user.devices.length - licCount;

        let statusSummary = '';
        if (licCount > 0) statusSummary += `<span class="status-badge status-online">${licCount} Premium</span> `;
        if (trialCount > 0) statusSummary += `<span class="status-badge status-offline">${trialCount} Prueba</span>`;

        const refStatus = user.referred_by ? `<span class="ref-badge" onclick="event.stopPropagation(); goToPadrino('${user.referred_by}')" title="Padrino: ${user.referred_by}"><i class="fa-solid fa-user-group"></i> Referido</span>` : '<span class="no-ref">Directo</span>';

        tr.innerHTML = `
            <td>#${user.id}</td>
            <td>${user.name || '---'} ${isMulti ? '<span class="multi-badge">MULTI</span>' : ''}</td>
            <td>${user.email || '---'}</td>
            <td>${user.phone || '---'}</td>
            <td><span class="device-id-code">${user.devices.length} ${user.devices.length === 1 ? 'Aparato' : 'Aparatos'}</span></td>
            <td>${statusSummary}</td>
            <td>${new Date(user.lastSeen).toLocaleString()}</td>
            <td>${refStatus}</td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="action-btn edit" onclick="openDetailsModal('${user.email}')" title="Ver Detalles"><i class="fa-solid fa-eye"></i></button>
                    <button class="action-btn delete" onclick="deleteAllForUser('${user.email}')" title="Eliminar todo el usuario"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // Actualizar el dropdown de destinatarios de mensajes
    updateMessageTargetDropdown(groupedArray);
}

function updateMessageTargetDropdown(users) {
    const select = document.getElementById('admin-msg-target');
    if (!select) return;

    const currentVal = select.value;
    select.innerHTML = '<option value="ALL">📢 Todos los Usuarios</option>';

    users.forEach(u => {
        if (u.email) {
            const opt = document.createElement('option');
            opt.value = u.email;
            opt.textContent = `👤 ${u.name || u.email}`;
            select.appendChild(opt);
        }
    });

    // Mantener selección si aún existe
    if ([...select.options].some(o => o.value === currentVal)) {
        select.value = currentVal;
    }
}

async function sendAdminMessage() {
    const msg = document.getElementById('admin-msg-input').value.trim();
    const target = document.getElementById('admin-msg-target').value;

    if (!msg) {
        showToast("Escribe un mensaje primero", "warning");
        return;
    }

    console.log("Intento de envío. Socket:", socket ? (socket.connected ? "CONECTADO" : "DESCONECTADO") : "NULO");

    if (!socket || !socket.connected) {
        showToast("Error: No hay conexión con el servidor. Por favor, refresca la página (F5).", "error");
        // Intentar reconectar si no lo está
        if (socket) socket.connect();
        else setupSockets();
        return;
    }

    console.log(`Enviando mensaje: "${msg}" a ${target}`);

    socket.emit('admin_message', {
        message: msg,
        target: target, // 'ALL' o el email del usuario
        timestamp: new Date().toISOString()
    });

    document.getElementById('admin-msg-input').value = "";
    showToast("Mensaje enviado correctamente", "success");
}

function openDetailsModal(email) {
    currentDetailsEmail = email; // Guardar el email actual para refrescos en tiempo real

    // Al abrir detalles, también lo seleccionamos en el messenger por conveniencia
    const select = document.getElementById('admin-msg-target');
    if (select && [...select.options].some(o => o.value === email)) {
        select.value = email;
    }

    refreshDetailsModal();
    document.getElementById('user-details-modal').classList.remove('hidden');
}

function refreshDetailsModal() {
    if (!currentDetailsEmail) return;

    const userDevices = moduleUsers.filter(u => u.email === currentDetailsEmail);
    if (!userDevices.length) {
        closeDetailsModal();
        return;
    }

    const mainUser = userDevices[0];
    document.getElementById('detail-user-name').innerText = mainUser.name || 'Usuario';
    document.getElementById('detail-user-email').innerText = currentDetailsEmail;

    // Info de Referidos
    document.getElementById('detail-my-code').innerText = mainUser.referral_code || '----';
    const invitedBy = mainUser.referred_by || '----';
    document.getElementById('detail-invited-by').innerHTML = invitedBy !== '----'
        ? `<span class="ref-badge" onclick="goToPadrino('${invitedBy}')" style="cursor:pointer" title="Ver Padrino"><i class="fa-solid fa-link"></i> ${invitedBy}</span>`
        : '----';
    document.getElementById('detail-points').innerText = mainUser.referral_points || 0;
    document.getElementById('detail-pending-gifts').innerText = mainUser.pending_gifts || 0;
    document.getElementById('detail-total-gifts').innerText = mainUser.total_gifts || 0;

    const list = document.getElementById('user-devices-list');
    list.innerHTML = '';

    userDevices.forEach(device => {
        const tr = document.createElement('tr');
        const licType = device.license_type || 'Modo Prueba';
        const badgeClass = device.license_type ? 'status-online' : 'status-offline';
        const expDate = device.expires_at ? new Date(device.expires_at).toLocaleDateString() : '--';
        const displayDevice = device.license_device_id || device.device_id;

        tr.innerHTML = `
            <td><code class="device-id-code">${displayDevice}</code></td>
            <td><span class="status-badge ${badgeClass}">${licType}</span></td>
            <td>${expDate}</td>
            <td>${(new Date() - new Date(device.last_seen)) < 5 * 60 * 1000 ? '<span class="status-online">En línea</span>' : '<span class="status-offline">Offline</span>'}</td>
            <td>
                <div style="display: flex; gap: 5px;">
                    <button class="action-btn edit" onclick="openEditModal(${device.id})" title="Editar Perfil"><i class="fa-solid fa-user-pen"></i></button>
                    ${device.license_type ? `<button class="action-btn revoke" onclick="revokeFromModule('${displayDevice}')" title="Revocar Licencia"><i class="fa-solid fa-key"></i></button>` : ''}
                    <button class="action-btn delete" onclick="deleteUserFromModule(${device.id})" title="Eliminar este dispositivo"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </td>
        `;
        list.appendChild(tr);
    });
}

function closeDetailsModal() {
    currentDetailsEmail = null; // Limpiar al cerrar
    document.getElementById('user-details-modal').classList.add('hidden');
}

async function deleteAllForUser(email) {
    if (!confirm(`¿Estás seguro de que quieres eliminar TODOS los dispositivos y datos vinculados a ${email}?`)) return;
    try {
        // En un sistema real, el backend debería manejar la eliminación grupal
        // Por ahora, eliminaremos cada instancia basándonos en el endpoint existente
        const devices = moduleUsers.filter(u => u.email === email);
        for (const dev of devices) {
            await fetch(`${API_URL}/admin/users/${dev.id}`, { method: 'DELETE' });
        }
        fetchAllUsersForModule();
        alert(`Usuario ${email} eliminado por completo.`);
    } catch (err) { alert("Error al eliminar usuario"); }
}

async function fetchStats() {
    try {
        const res = await fetch(`${API_URL}/admin/stats`);
        const stats = await res.json();
        const usersRes = await fetch(`${API_URL}/admin/users`);
        allUsers = await usersRes.json();

        document.getElementById('stat-total-users').innerText = stats.totalUsers || 0;
        document.getElementById('stat-active-licenses').innerText = stats.activeLicenses || 0;
        document.getElementById('stat-today-income').innerText = `$${stats.todayIncome || 0}`;

        // KPI Calculations
        const totalIncome = stats.totalIncome || 1; // avoid / 0
        const activeLics = stats.activeLicenses || 1;
        const totalU = stats.totalUsers || 1;

        const arpu = (totalIncome / totalU).toFixed(2);
        document.getElementById('stat-arpu').innerText = `$${arpu}`;

        // Projection (approximation based on current monthly average)
        const projection = (stats.todayIncome * 30 * 0.7).toFixed(0); // Conservative estimate
        document.getElementById('stat-projection').innerText = `$${projection}`;

        renderRecentUsers();
    } catch (err) {
        console.error("Error fetching stats:", err);
    }
}

function renderRecentUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...allUsers];
    if (sortConfig.tableId === 'users-table-body') {
        data = sortTable(data, sortConfig.column, sortConfig.direction);
    }

    data.slice(0, 10).forEach(user => {
        const tr = document.createElement('tr');
        tr.onclick = (e) => {
            if (!e.target.closest('.action-btn')) openDetailsModal(user.email);
        };
        const lastSeen = new Date(user.last_seen).toLocaleString();
        const diff = (new Date() - new Date(user.last_seen)) / 1000;
        const statusClass = diff < 300 ? 'status-online' : 'status-offline';
        const refStatus = user.referred_by ? `<span class="ref-badge" onclick="event.stopPropagation(); goToPadrino('${user.referred_by}')" title="Ver Padrino"><i class="fa-solid fa-link"></i> ${user.referred_by}</span>` : '<span class="no-ref">Directo</span>';

        tr.innerHTML = `
            <td>#${user.id}</td>
            <td>${user.name || '---'}</td>
            <td>${user.email}</td>
            <td><code class="device-id-code">${user.ip_address || '0.0.0.0'}</code></td>
            <td><span class="status-badge status-online">${user.license_type || 'Prueba'}</span></td>
            <td>${lastSeen}</td>
            <td>${refStatus}</td>
            <td><span class="status-badge ${statusClass}">${diff < 300 ? 'Online' : 'Offline'}</span></td>
            <td><button class="action-btn edit" onclick="openDetailsModal('${user.email}')"><i class="fa-solid fa-eye"></i></button></td>
        `;
        tbody.appendChild(tr);
    });
}

window.goToPadrino = async (padrinoCode) => {
    if (!padrinoCode || padrinoCode === '----') return;

    // Asegurarse de que tenemos la lista de usuarios cargada
    if (moduleUsers.length === 0) {
        try {
            const res = await fetch(`${API_URL}/admin/users`);
            moduleUsers = await res.json();
        } catch (e) {
            console.error("Error al cargar usuarios para buscar padrino", e);
        }
    }

    // Buscar si tenemos al usuario con ese código en memoria (IgnoreCase)
    const searchCode = padrinoCode.trim().toUpperCase();
    const padrino = moduleUsers.find(u => u.referral_code && u.referral_code.trim().toUpperCase() === searchCode);
    if (padrino) {
        console.log("Padrino encontrado:", padrino.email);
        openDetailsModal(padrino.email);

        // Notificación para informar al admin
        if (typeof Toastify !== 'undefined') {
            Toastify({
                text: `Viendo perfil del padrino: ${padrino.name || padrino.email}`,
                duration: 3000,
                gravity: "top",
                position: "center",
                style: { background: "linear-gradient(to right, #3b82f6, #2ecc71)" }
            }).showToast();
        }
    } else {
        alert("No se encontró el usuario padrino con el código: " + padrinoCode);
    }
};

async function fetchLicensesForModule() {
    try {
        const res = await fetch(`${API_URL}/admin/active-licenses`);
        allLicenses = await res.json();
        renderActiveLicensesTable(allLicenses);
    } catch (err) { console.error(err); }
}

function renderActiveLicensesTable(licenses) {
    const tbody = document.getElementById('all-licenses-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    licenses.forEach(lic => {
        const tr = document.createElement('tr');
        const expiry = lic.expires_at ? new Date(lic.expires_at).toLocaleDateString() : 'Nunca';
        tr.innerHTML = `
            <td>${lic.user_name || lic.user_email || '<i>Libre</i>'}</td>
            <td><code>${lic.key}</code></td>
            <td>${lic.type}</td>
            <td>${expiry}</td>
            <td><span class="status-badge ${lic.status === 'USED' ? 'status-online' : 'status-offline'}">${lic.status}</span></td>
            <td>
                <button class="action-btn delete" onclick="deleteLicenseKey('${lic.key}')"><i class="fa-solid fa-trash-can"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Utilities & Compatibility ---
async function generateKeys() {
    const type = document.getElementById('license-type').value;
    const count = document.getElementById('license-count').value;
    try {
        const res = await fetch(`${API_URL}/admin/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, count: parseInt(count) })
        });
        const data = await res.json();
        document.getElementById('generated-keys-output').classList.remove('hidden');
        document.getElementById('keys-area').value = data.keys.join('\n');
        fetchLicensesForModule();
    } catch (err) { alert("Error generando claves"); }
}

function copyKeys() {
    const area = document.getElementById('keys-area');
    area.select();
    document.execCommand('copy');
    alert("Copiado!");
}

async function deleteUser(id) {
    if (!confirm('¿Eliminar usuario?')) return;
    await fetch(`${API_URL}/admin/users/${id}`, { method: 'DELETE' });
    fetchStats();
}

async function deleteUserFromModule(id) {
    if (!confirm('¿Eliminar usuario?')) return;
    await fetch(`${API_URL}/admin/users/${id}`, { method: 'DELETE' });
    fetchAllUsersForModule();
}

async function revokeFromModule(deviceId) {
    if (!confirm('¿Revocar licencia?')) return;
    await fetch(`${API_URL}/admin/licenses/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId })
    });
    fetchAllUsersForModule();
}

async function deleteLicenseKey(key) {
    if (!confirm('¿Borrar clave?')) return;
    await fetch(`${API_URL}/admin/licenses/${key}`, { method: 'DELETE' });
    fetchLicensesForModule();
}

async function deleteAllUnused() {
    if (!confirm('¿Borrar todas las claves libres?')) return;
    await fetch(`${API_URL}/admin/licenses-all/unused`, { method: 'DELETE' });
    fetchLicensesForModule();
}

// Global Config
async function fetchGlobalConfig() {
    try {
        const res = await fetch(`${API_URL}/admin/config`);
        const config = await res.json();

        // App settings
        if (document.getElementById('config-wa-num')) document.getElementById('config-wa-num').value = config.whatsappNumber || '';
        if (document.getElementById('config-wa-msg')) document.getElementById('config-wa-msg').value = config.whatsappMessage || '';
        if (document.getElementById('config-code-num')) document.getElementById('config-code-num').value = config.requestCodeNumber || '';
        if (document.getElementById('config-code-msg')) document.getElementById('config-code-msg').value = config.requestCodeMessage || '';
        if (document.getElementById('config-sync-url')) document.getElementById('config-sync-url').value = config.syncUrl || '';
        if (document.getElementById('config-bucket-name')) document.getElementById('config-bucket-name').value = config.bucketName || '';
        if (document.getElementById('config-s3-endpoint')) document.getElementById('config-s3-endpoint').value = config.s3Endpoint || '';
        if (document.getElementById('config-endpoint')) document.getElementById('config-endpoint').value = config.endpoint || '';
        if (document.getElementById('config-b2-key-id')) document.getElementById('config-b2-key-id').value = config.b2KeyId || '';
        if (document.getElementById('config-b2-app-key')) document.getElementById('config-b2-app-key').value = config.b2AppKey || '';

        // Alts
        if (document.getElementById('config-sync-url-alt1')) document.getElementById('config-sync-url-alt1').value = config.syncUrlAlt1 || '';
        if (document.getElementById('config-bucket-name-alt1')) document.getElementById('config-bucket-name-alt1').value = config.bucketNameAlt1 || '';
        if (document.getElementById('config-s3-endpoint-alt1')) document.getElementById('config-s3-endpoint-alt1').value = config.s3EndpointAlt1 || '';
        if (document.getElementById('config-endpoint-alt1')) document.getElementById('config-endpoint-alt1').value = config.endpointAlt1 || '';
        if (document.getElementById('config-sync-url-alt2')) document.getElementById('config-sync-url-alt2').value = config.syncUrlAlt2 || '';
        if (document.getElementById('config-bucket-name-alt2')) document.getElementById('config-bucket-name-alt2').value = config.bucketNameAlt2 || '';
        if (document.getElementById('config-s3-endpoint-alt2')) document.getElementById('config-s3-endpoint-alt2').value = config.s3EndpointAlt2 || '';
        if (document.getElementById('config-endpoint-alt2')) document.getElementById('config-endpoint-alt2').value = config.endpointAlt2 || '';

        if (document.getElementById('config-music-path')) document.getElementById('config-music-path').value = config.musicPath || '';
        if (document.getElementById('config-vigilante-enabled')) document.getElementById('config-vigilante-enabled').checked = config.vigilanteEnabled !== false;

        // Prices
        if (config.prices) {
            if (document.getElementById('price-day')) document.getElementById('price-day').value = config.prices['1_DAY'] || 10;
            if (document.getElementById('price-month')) document.getElementById('price-month').value = config.prices['30_DAYS'] || 250;
            if (document.getElementById('price-perm')) document.getElementById('price-perm').value = config.prices['PERMANENT'] || 1500;
        }

        // Email SMTP
        if (config.emailServer) {
            if (document.getElementById('email-service')) document.getElementById('email-service').value = config.emailServer.service || '';
            if (document.getElementById('email-user')) document.getElementById('email-user').value = config.emailServer.user || '';
            if (document.getElementById('email-pass')) document.getElementById('email-pass').value = config.emailServer.pass || '';
            if (document.getElementById('email-from-name')) document.getElementById('email-from-name').value = config.emailServer.fromName || '';
        }

        // Referral Meta
        const metaIn = document.getElementById('config-referral-meta');
        if (metaIn) metaIn.value = config.referralMeta || 5;

    } catch (err) {
        console.error("Error fetching global config:", err);
    }
}

async function saveGlobalConfig() {
    const config = {
        whatsappNumber: document.getElementById('config-wa-num').value.trim(),
        whatsappMessage: document.getElementById('config-wa-msg').value.trim(),
        requestCodeNumber: document.getElementById('config-code-num').value.trim(),
        requestCodeMessage: document.getElementById('config-code-msg').value.trim(),
        syncUrl: document.getElementById('config-sync-url').value.trim(),
        bucketName: document.getElementById('config-bucket-name').value.trim(),
        s3Endpoint: document.getElementById('config-s3-endpoint').value.trim(),
        endpoint: document.getElementById('config-endpoint').value.trim(),
        b2KeyId: document.getElementById('config-b2-key-id').value.trim(),
        b2AppKey: document.getElementById('config-b2-app-key').value.trim(),
        syncUrlAlt1: document.getElementById('config-sync-url-alt1').value.trim(),
        bucketNameAlt1: document.getElementById('config-bucket-name-alt1').value.trim(),
        s3EndpointAlt1: document.getElementById('config-s3-endpoint-alt1').value.trim(),
        endpointAlt1: document.getElementById('config-endpoint-alt1').value.trim(),
        syncUrlAlt2: document.getElementById('config-sync-url-alt2').value.trim(),
        bucketNameAlt2: document.getElementById('config-bucket-name-alt2').value.trim(),
        s3EndpointAlt2: document.getElementById('config-s3-endpoint-alt2').value.trim(),
        endpointAlt2: document.getElementById('config-endpoint-alt2').value.trim(),
        musicPath: document.getElementById('config-music-path').value.trim(),
        vigilanteEnabled: document.getElementById('config-vigilante-enabled').checked
    };
    await fetch(`${API_URL}/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    });
    showToast('Configuración guardada y estado de Vigilante actualizado', 'success');
}

// Modal handling
function openEditModal(userId) {
    // Buscar en ambos arreglos para asegurar que lo encontramos
    let user = allUsers.find(u => u.id === userId);
    if (!user) {
        user = moduleUsers.find(u => u.id === userId);
    }

    if (!user) {
        console.error("Usuario no encontrado en las listas locales:", userId);
        return;
    }
    document.getElementById('edit-user-id').value = user.id;
    document.getElementById('edit-name').value = user.name || '';
    document.getElementById('edit-email').value = user.email || '';
    document.getElementById('edit-phone').value = user.phone || '';
    document.getElementById('edit-modal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('edit-modal').classList.add('hidden');
}

async function saveUser() {
    const id = document.getElementById('edit-user-id').value;
    const body = {
        id: id,
        name: document.getElementById('edit-name').value,
        email: document.getElementById('edit-email').value,
        phone: document.getElementById('edit-phone').value
    };

    try {
        const res = await fetch(`${API_URL}/admin/users/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (res.ok) {
            closeModal();
            fetchStats();
            if (currentDetailsEmail) {
                currentDetailsEmail = body.email.toLowerCase().trim();
                setTimeout(refreshDetailsModal, 300);
            }
            showToast("Usuario actualizado correctamente", "success");
        } else {
            const data = await res.json();
            alert("Error: " + data.error);
        }
    } catch (err) {
        console.error("Error saving user:", err);
        alert("Error de conexión al guardar usuario");
    }
}
async function fetchEmailConfig() {
    try {
        const res = await fetch(`${API_URL}/admin/config`);
        const config = await res.json();
        if (config.emailServer) {
            document.getElementById('email-service').value = config.emailServer.service || '';
            document.getElementById('email-user').value = config.emailServer.user || '';
            document.getElementById('email-pass').value = config.emailServer.pass || '';
            document.getElementById('email-from-name').value = config.emailServer.fromName || '';
        }
    } catch (err) { console.error("Error fetching email config:", err); }
}

async function saveEmailConfig() {
    const emailConfig = {
        service: document.getElementById('email-service').value.trim(),
        user: document.getElementById('email-user').value.trim(),
        pass: document.getElementById('email-pass').value.trim(),
        fromName: document.getElementById('email-from-name').value.trim()
    };

    try {
        await fetch(`${API_URL}/admin/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emailServer: emailConfig })
        });
        alert('Configuración de correo guardada!');
    } catch (err) { alert('Error al guardar configuración de correo'); }
}

// --- Referral System Config ---
async function fetchReferralConfig() {
    try {
        const res = await fetch(`${API_URL}/admin/config`);
        const config = await res.json();
        const metaIn = document.getElementById('config-referral-meta');
        if (metaIn) metaIn.value = config.referralMeta || 5;

        // Totales de referidos (aproximado por clientes con referred_by)
        // Usamos la lista de usuarios ya cargada o la refrescamos
        const referStat = document.getElementById('stat-total-referrals');
        if (referStat) {
            const refers = allUsers.filter(u => u.referred_by).length;
            referStat.innerText = refers;
        }
    } catch (err) { console.error("Error fetching referral config:", err); }
}

async function showReferredUsers() {
    // 1. Cambiar visualmente a la sección de usuarios
    switchSection('users-module-section', 'Gestión de Usuarios (Filtrado: Referidos)');

    // Actualizar sidebar
    document.querySelectorAll('.nav-item').forEach(i => {
        i.classList.remove('active');
        if (i.getAttribute('data-section') === 'users-module-section') i.classList.add('active');
    });

    // 2. Forzar carga fresca y esperar a que termine para que no se sobreponga
    await fetchAllUsersForModule();

    // 3. Filtrar
    const referred = moduleUsers.filter(u => u.referred_by);

    // 4. Renderizar solo los filtrados
    renderAllUsersTable(referred);

    // 5. Mostrar aviso
    showToast(`Mostrando los ${referred.length} usuarios referidos`, 'info');

    // 6. Limpiar buscador para no causar confusión
    const searchIn = document.getElementById('user-total-search');
    if (searchIn) searchIn.value = "";
}

async function saveReferralConfig() {
    const meta = parseInt(document.getElementById('config-referral-meta').value);
    if (isNaN(meta) || meta < 1) {
        showToast("La meta debe ser un número válido mayor a 0", "error");
        return;
    }

    try {
        await fetch(`${API_URL}/admin/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ referralMeta: meta })
        });
        showToast('Ajustes de referidos guardados!', 'success');
    } catch (err) { showToast('Error al guardar configuración', 'error'); }
}

function exportToExcel() {
    let csv = "Fecha,Usuario/Dispositivo,Tipo Licencia,Monto (MXN)\n";
    incomeLogs.forEach(log => {
        const date = new Date(log.activated_at).toLocaleString().replace(',', '');
        const user = (log.user_name || 'Desconocido').replace(',', '');
        csv += `${date},${user} (${log.device_id}),${log.license_type},${log.price_paid}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `Reporte_Ventas_TecnoBanda_${new Date().toLocaleDateString()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportToPDF() {
    const printWindow = window.open('', '_blank');
    const tableHtml = document.getElementById('income-table').outerHTML;
    const now = new Date().toLocaleString();

    printWindow.document.write(`
        <html>
            <head>
                <title>Reporte de Ventas - TecnoBanda</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; color: #333; background: white; }
                    h1 { color: #3b82f6; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; color: black; }
                    th { background-color: #f8f9fa; }
                    .footer { margin-top: 30px; font-size: 0.8rem; color: #777; }
                </style>
            </head>
            <body>
                <h1>Reporte de Ventas TecnoBanda</h1>
                <p>Generado el: ${now}</p>
                ${tableHtml}
                <div class="footer">Este es un reporte oficial generado desde el Panel de Administración.</div>
                <script>
                    setTimeout(() => {
                        window.print();
                        window.close();
                    }, 500);
                </script>
            </body>
        </html>
    `);
    printWindow.document.close();
}
// --- Audio Management Logic ---
async function fetchAudios(type) {
    try {
        const res = await fetch(`${API_URL}/admin/audios/${type}`);
        const audios = await res.json();
        renderAudioList(type, audios);
    } catch (err) {
        console.error(`Error fetching ${type}:`, err);
        showToast(`No se pudieron cargar los ${type}.`, "error");
    }
}

function renderAudioList(type, audios) {
    const list = document.getElementById(`${type}-list`);
    if (!list) return;
    list.innerHTML = '';

    if (audios.length === 0) {
        list.innerHTML = `<li style="color: #94a3b8; font-size: 0.9rem; padding: 10px;">No hay archivos cargados.</li>`;
        return;
    }

    audios.forEach(audio => {
        const li = document.createElement('li');
        li.className = 'audio-item-admin';
        const escapedUrl = audio.url.replace(/'/g, "\\'");
        li.innerHTML = `
            <div class="audio-info">
                <i class="fa-solid fa-file-audio"></i>
                <span title="${audio.name}">${audio.name.length > 25 ? audio.name.substring(0, 22) + '...' : audio.name}</span>
            </div>
            <div class="audio-actions">
                <button class="action-btn" onclick="playAudioPreview('${escapedUrl}')" title="Probar"><i class="fa-solid fa-play"></i></button>
                <button class="action-btn delete" onclick="deleteAudio('${type}', '${audio.name.replace(/'/g, "\\'")}')" title="Eliminar"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        `;
        list.appendChild(li);
    });
}

let currentPreviewAudio = null;

function playAudioPreview(url) {
    if (currentPreviewAudio) {
        currentPreviewAudio.pause();
        currentPreviewAudio = null;
    }

    const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
    console.log("Probgando audio preview:", fullUrl);

    currentPreviewAudio = new Audio(fullUrl);
    currentPreviewAudio.play().then(() => {
        showToast("Reproduciendo preview...", "success");
    }).catch(err => {
        console.error("Error al reproducir audio preview:", err);
        showToast("Error: No se pudo reproducir el archivo. Verifica que exista en el servidor.", "error");
    });
}

async function deleteAudio(type, filename) {
    if (!confirm(`¿Estás seguro de eliminar "${filename}"?`)) return;
    try {
        const res = await fetch(`${API_URL}/admin/audios/${type}/${filename}`, { method: 'DELETE' });
        if (res.ok) fetchAudios(type);
    } catch (err) { alert("Error al eliminar archivo"); }
}

// Subida de archivos
const introInput = document.getElementById('upload-intro-input');
const ambientInput = document.getElementById('upload-ambient-input');
const dropZoneIntros = document.getElementById('drop-zone-intros');
const dropZoneAmbient = document.getElementById('drop-zone-ambient');

if (introInput) introInput.addEventListener('change', (e) => handleAudioUpload(e.target.files[0], 'intros'));
if (ambientInput) ambientInput.addEventListener('change', (e) => handleAudioUpload(e.target.files[0], 'ambient'));

// Configurar Drag & Drop
setupDragAndDrop(dropZoneIntros, 'intros');
setupDragAndDrop(dropZoneAmbient, 'ambient');

function setupDragAndDrop(zone, type) {
    if (!zone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        zone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        zone.addEventListener(eventName, () => zone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        zone.addEventListener(eventName, () => zone.classList.remove('dragover'), false);
    });

    zone.addEventListener('drop', handleDrop, false);

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const file = dt.files[0];
        handleAudioUpload(file, type);
    }
}

async function handleAudioUpload(file, type) {
    if (!file) return;

    const formData = new FormData();
    formData.append('audio', file);

    try {
        const res = await fetch(`${API_URL}/admin/audios/${type}`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            alert(`Archivo "${file.name}" subido correctamente.`);
            fetchAudios(type);
        } else {
            alert("Error: " + (data.error || "No se pudo subir el archivo"));
        }
    } catch (err) {
        alert("Error de conexión al subir el archivo");
    } finally {
        // Reset inputs if they are being used
        if (type === 'intros' && introInput) introInput.value = '';
        if (type === 'ambient' && ambientInput) ambientInput.value = '';
    }
}

// --- Sorting Logic ---
function initSortingListeners() {
    document.querySelectorAll('.data-table th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.column;
            const table = th.closest('table');
            const tbodyId = table.querySelector('tbody').id;

            if (sortConfig.column === column && sortConfig.tableId === tbodyId) {
                sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
            } else {
                sortConfig.column = column;
                sortConfig.direction = 'asc';
                sortConfig.tableId = tbodyId;
            }

            // Update UI headers
            table.querySelectorAll('th.sortable').forEach(h => h.classList.remove('asc', 'desc'));
            th.classList.add(sortConfig.direction);

            // Trigger re-render based on table
            if (tbodyId === 'users-table-body') {
                allUsers = sortTable(allUsers, column, sortConfig.direction);
                renderRecentUsers();
            } else if (tbodyId === 'income-table-body') {
                incomeLogs = sortTable(incomeLogs, column, sortConfig.direction);
                renderIncomeTable(incomeLogs);
            } else if (tbodyId === 'all-users-module-table-body') {
                moduleUsers = sortTable(moduleUsers, column, sortConfig.direction);
                renderAllUsersTable(moduleUsers);
            } else if (tbodyId === 'all-licenses-table-body') {
                allLicenses = sortTable(allLicenses, column, sortConfig.direction);
                renderActiveLicensesTable(allLicenses);
            } else if (tbodyId === 'music-library-body') {
                musicFiles = sortTable(musicFiles, column, sortConfig.direction);
                renderMusicTable(musicFiles);
            } else if (tbodyId === 'audit-logs-body') {
                auditLogs = sortTable(auditLogs, column, sortConfig.direction);
                renderAuditLogsTable(auditLogs);
            }
        });
    });
}

function sortTable(data, column, direction) {
    return [...data].sort((a, b) => {
        let valA = a[column];
        let valB = b[column];

        // Special handling for computed fields
        if (column === 'device_count') {
            valA = a.devices ? a.devices.length : 0;
            valB = b.devices ? b.devices.length : 0;
        }

        // Null handling
        if (valA === null || valA === undefined) valA = '';
        if (valB === null || valB === undefined) valB = '';

        // Date detection
        const isDate = (v) => v instanceof Date || (typeof v === 'string' && !isNaN(Date.parse(v)) && v.includes(':'));

        if (isDate(valA) && isDate(valB)) {
            valA = new Date(valA).getTime();
            valB = new Date(valB).getTime();
        }

        // Numeric comparison
        if (!isNaN(valA) && !isNaN(valB) && typeof valA !== 'boolean' && typeof valB !== 'boolean') {
            valA = parseFloat(valA);
            valB = parseFloat(valB);
            return direction === 'asc' ? valA - valB : valB - valA;
        }

        // String comparison
        valA = valA.toString().toLowerCase();
        valB = valB.toString().toLowerCase();

        if (valA < valB) return direction === 'asc' ? -1 : 1;
        if (valA > valB) return direction === 'asc' ? 1 : -1;
        return 0;
    });
}

// --- Advanced Music Library ---
async function fetchMusicLibrary() {
    try {
        const res = await fetch(`${API_URL}/admin/music-library`);
        musicFiles = await res.json();
        renderMusicTable(musicFiles);
    } catch (e) { console.error(e); }
}

async function forceSyncCloud() {
    showToast("📤 Iniciando sincronización con la nube...");
    try {
        const res = await fetch(`${API_URL}/admin/music-library/sync`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast("✅ Sincronización completada con éxito", "success");
            fetchMusicLibrary();
        } else {
            showToast("❌ Error: " + data.error, "error");
        }
    } catch (e) {
        showToast("❌ Error de red al sincronizar", "error");
    }
}

function renderMusicTable(files) {
    const tbody = document.getElementById('music-library-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...files];
    if (sortConfig.tableId === 'music-library-body') {
        data = sortTable(data, sortConfig.column, sortConfig.direction);
    }

    data.forEach(file => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><i class="fa-solid fa-file-zipper"></i> ${file.name}</td>
            <td>${file.size}</td>
            <td>${new Date(file.date).toLocaleDateString()}</td>
            <td>
                <button class="action-btn edit" onclick="renameMusicFile('${file.name}')" title="Renombrar"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="action-btn delete" onclick="deleteMusicFile('${file.name}')" title="Eliminar"><i class="fa-solid fa-trash-can"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function uploadMusicFile() {
    const input = document.getElementById('music-upload-input');
    const file = input.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast(`Subiendo ${file.name}...`, 'info');
    try {
        const res = await fetch(`${API_URL}/admin/music-library/upload`, { method: 'POST', body: formData });
        if (res.ok) {
            showToast('Archivo subido con éxito', 'success');
            fetchMusicLibrary();
        }
    } catch (e) { showToast('Error al subir', 'error'); }
    input.value = '';
}

async function deleteMusicFile(name) {
    if (!confirm(`¿Eliminar permanentemente "${name}"?`)) return;
    try {
        const res = await fetch(`${API_URL}/admin/music-library/${name}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Archivo eliminado', 'success');
            fetchMusicLibrary();
        }
    } catch (e) { showToast('Error al eliminar', 'error'); }
}

async function renameMusicFile(oldName) {
    const newName = prompt('Nuevo nombre (incluye extensión):', oldName);
    if (!newName || newName === oldName) return;
    try {
        const res = await fetch(`${API_URL}/admin/music-library/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldName, newName })
        });
        if (res.ok) {
            showToast('Renombrado con éxito', 'success');
            fetchMusicLibrary();
        }
    } catch (e) { showToast('Error al renombrar', 'error'); }
}

// --- Audit Logs ---
async function fetchAuditLogs() {
    try {
        const res = await fetch(`${API_URL}/admin/audit-logs`);
        auditLogs = await res.json();
        renderAuditLogsTable(auditLogs);
    } catch (e) { console.error(e); }
}

function renderAuditLogsTable(logs) {
    const tbody = document.getElementById('audit-logs-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    let data = [...logs];
    if (sortConfig.tableId === 'audit-logs-body') {
        data = sortTable(data, sortConfig.column, sortConfig.direction);
    }

    data.forEach(log => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${new Date(log.created_at).toLocaleString()}</td>
            <td><strong>${log.action}</strong></td>
            <td>${log.details}</td>
            <td><small>${log.admin_user}</small></td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Universal History Logic ---
let universalHistoryLogs = [];
let universalHistoryFiltered = []; // Global para exportación exacta
const monthNamesSpanish = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
let historyFP = null; // Flatpickr instance

function openUniversalHistory() {
    const modal = document.getElementById('universal-history-modal');
    modal.classList.remove('hidden');

    // Inicializar Flatpickr si no existe
    if (!historyFP) {
        historyFP = flatpickr("#history-range", {
            mode: "range",
            locale: "es",
            dateFormat: "Y-m-d",
            theme: "dark",
            onClose: function (selectedDates) {
                if (selectedDates.length === 2) {
                    loadHistoryByDateRange();
                }
            }
        });
    }

    // Siempre cargar TODO al entrar
    loadAllHistory();
}

function closeUniversalHistory() {
    const modal = document.getElementById('universal-history-modal');
    modal.classList.add('hidden');
}

async function loadHistoryByDateRange() {
    if (!historyFP || historyFP.selectedDates.length < 2) return;

    const from = historyFP.formatDate(historyFP.selectedDates[0], "Y-m-d");
    const to = historyFP.formatDate(historyFP.selectedDates[1], "Y-m-d");

    try {
        showToast(`Buscando desde ${from} hasta ${to}...`, "info");
        const res = await fetch(`${API_URL}/admin/income?period=range&from=${from}&to=${to}&history=true`);
        const data = await res.json();
        universalHistoryLogs = data.logs || [];
        renderUniversalTable(universalHistoryLogs);
    } catch (err) {
        console.error("Error al cargar historial:", err);
        showToast("Error al filtrar historial", "error");
    }
}

function renderUniversalTable(logs) {
    const tbody = document.getElementById('universal-history-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    let totalSum = 0;
    const searchTerm = document.getElementById('universal-search').value.toLowerCase();

    const filtered = logs.filter(log => {
        const name = (log.user_name || '').toLowerCase();
        const device = (log.device_id || '').toLowerCase();
        const type = (log.license_type || '').toLowerCase();
        const key = (log.license_key || '').toLowerCase();

        return name.includes(searchTerm) ||
            device.includes(searchTerm) ||
            type.includes(searchTerm) ||
            key.includes(searchTerm);
    });

    universalHistoryFiltered = filtered; // Guardamos para exportar lo que se ve

    filtered.forEach(log => {
        const tr = document.createElement('tr');
        const amount = parseFloat(log.price_paid || 0);
        totalSum += amount;

        tr.innerHTML = `
            <td>${new Date(log.activated_at).toLocaleString()}</td>
            <td><strong>${log.user_name || 'Desconocido'}</strong></td>
            <td><small>${log.device_id}</small></td>
            <td><span class="status-badge status-online">${log.license_type || 'Licencia'}</span></td>
            <td style="color: #10b981; font-weight: bold;">$${amount.toLocaleString()}</td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('universal-total-count').innerText = filtered.length;
    document.getElementById('universal-total-sum').innerText = `$${totalSum.toLocaleString()}`;
}

async function loadAllHistory() {
    try {
        showToast("Cargando historial completo...", "info");
        const res = await fetch(`${API_URL}/admin/income?history=true`);
        const data = await res.json();
        universalHistoryLogs = data.logs || [];
        renderUniversalTable(universalHistoryLogs);
        showToast("Historial completo cargado", "success");
    } catch (err) {
        console.error("Error:", err);
        showToast("Error al cargar", "error");
    }
}

function filterUniversalTable() {
    renderUniversalTable(universalHistoryLogs);
}

function exportToExcel() {
    if (universalHistoryFiltered.length === 0) {
        showToast("No hay datos para exportar", "error");
        return;
    }

    let totalSum = 0;
    const excelData = universalHistoryFiltered.map(log => {
        const amount = parseFloat(log.price_paid || 0);
        totalSum += amount;
        return {
            "Fecha": new Date(log.activated_at).toLocaleString(),
            "Usuario": log.user_name || 'Desconocido',
            "ID Dispositivo": log.device_id,
            "Tipo": log.license_type || 'Licencia',
            "Monto": amount
        };
    });

    // Agregar fila de totales
    excelData.push({
        "Fecha": "TOTAL",
        "Usuario": "-",
        "ID Dispositivo": "-",
        "Tipo": `Total Registros: ${universalHistoryFiltered.length}`,
        "Monto": totalSum
    });

    const worksheet = XLSX.utils.json_to_sheet(excelData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Ventas");
    XLSX.writeFile(workbook, `HistorialVentas_${new Date().getTime()}.xlsx`);
    showToast("Excel generado", "success");
}

function exportToPDF() {
    const { jsPDF } = window.jspdf;
    if (!jsPDF || universalHistoryFiltered.length === 0) {
        showToast("No hay datos o faltan librerías", "error");
        return;
    }

    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text("Reporte de Ventas - Historial Universal", 14, 20);
    doc.setFontSize(10);
    doc.text(`Generado el: ${new Date().toLocaleString()}`, 14, 28);

    let totalSum = 0;
    const body = universalHistoryFiltered.map(log => {
        const amount = parseFloat(log.price_paid || 0);
        totalSum += amount;
        return [
            new Date(log.activated_at).toLocaleString(),
            log.user_name || 'Desconocido',
            log.device_id,
            log.license_type || 'Licencia',
            `$${amount.toLocaleString()}`
        ];
    });

    // Agregar fila de totales al final
    body.push([
        { content: 'TOTAL', styles: { fillColor: [59, 130, 246], textColor: [255, 255, 255], fontStyle: 'bold' } },
        '',
        '',
        { content: `Registros: ${universalHistoryFiltered.length}`, styles: { fontStyle: 'bold' } },
        { content: `$${totalSum.toLocaleString()}`, styles: { fontStyle: 'bold' } }
    ]);

    doc.autoTable({
        startY: 35,
        head: [['Fecha', 'Usuario', 'Dispositivo', 'Tipo', 'Monto']],
        body: body,
        theme: 'striped',
        headStyles: { fillColor: [59, 130, 246] }
    });

    doc.save(`ReporteVentas_${new Date().getTime()}.pdf`);
    showToast("PDF generado", "success");
}

// --- Helpers ---
function showToast(message, type = 'info', title = '') {
    if (typeof Toastify === 'undefined') {
        alert(title + ": " + message);
        return;
    }
    Toastify({
        text: `${title ? title + ': ' : ''}${message}`,
        duration: 4000,
        gravity: "top",
        position: "right",
        style: {
            background: type === 'success' ? "linear-gradient(to right, #10b981, #059669)" :
                type === 'error' ? "linear-gradient(to right, #ef4444, #dc2626)" :
                    "linear-gradient(to right, #3b82f6, #2563eb)",
            borderRadius: "12px",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.2)"
        }
    }).showToast();
}
