const fetch = require('node-fetch');

async function testProxy() {
    const url = "https://f004.backblazeb2.com/file/tecnobanda/musica.json";
    const proxyUrl = `http://localhost:3000/api/proxy-sync?url=${encodeURIComponent(url)}`;

    console.log("Probando proxy...");
    try {
        const res = await fetch(url);
        console.log("Conductor directo a Backblaze:", res.status);
        if (res.ok) {
            const data = await res.json();
            console.log("Canciones en Backblaze:", data.length);
        }
    } catch (e) {
        console.error("Error directo:", e.message);
    }
}

testProxy();
