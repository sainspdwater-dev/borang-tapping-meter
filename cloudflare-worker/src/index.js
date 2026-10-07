const AREA_TARGETS = {
  "Taman PD Utama": 214,
  "Taman Desa Permai": 86,
  "Taman Samudera": 51,
  "Taman Flora": 36,
  "Rumah Rakyat Kg Paya": 48,
  "Rumah Rakyat Pekan Lukut": 33
};

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/stats") {
        const rows = await readSheet(env);
        const counts = Object.fromEntries(Object.keys(AREA_TARGETS).map((area) => [area, 0]));
        for (const row of rows.slice(1)) if (row[0] in counts) counts[row[0]] += 1;
        return json({ counts, targets: AREA_TARGETS }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/submissions") {
        const body = await request.json();
        const validation = validateSubmission(body);
        if (validation) return json({ error: validation }, 400, cors);

        const turnstile = await verifyTurnstile(body.turnstileToken, request, env);
        if (!turnstile.success) return json({ error: "Pengesahan Turnstile tidak berjaya." }, 403, cors);

        const rows = await readSheet(env);
        const duplicate = rows.slice(1).some((row) => String(row[1] || "").toUpperCase() === body.meter.toUpperCase());
        if (duplicate) return json({ error: "Nombor meter ini sudah wujud dalam rekod." }, 409, cors);

        await appendSheet([body.area, body.meter, "", body.coordinates, ""], env);
        return json({ ok: true }, 201, cors);
      }
      return json({ error: "Laluan tidak ditemui." }, 404, cors);
    } catch (error) {
      console.error(error);
      return json({ error: "Ralat pelayan. Sila cuba semula." }, 500, cors);
    }
  }
};

function validateSubmission(body) {
  if (!body || !AREA_TARGETS[body.area]) return "Nama kawasan tidak sah.";
  if (!/^[A-Z0-9-]{3,30}$/i.test(String(body.meter || ""))) return "Nombor meter tidak sah.";
  const coordinatePattern = /^-?\d{1,2}(?:\.\d+)?,\s*-?\d{1,3}(?:\.\d+)?$/;
  if (!coordinatePattern.test(String(body.coordinates || ""))) return "Format koordinat tidak sah.";
  if (!body.turnstileToken) return "Token Turnstile diperlukan.";
  return null;
}

async function verifyTurnstile(token, request, env) {
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return response.json();
}

async function readSheet(env) {
  const token = await googleAccessToken(env);
  const range = encodeURIComponent(`${env.GOOGLE_SHEET_NAME}!A:E`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Google Sheets read failed: ${response.status}`);
  const data = await response.json();
  return data.values || [];
}

async function appendSheet(values, env) {
  const token = await googleAccessToken(env);
  const range = encodeURIComponent(`${env.GOOGLE_SHEET_NAME}!A:E`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] })
  });
  if (!response.ok) throw new Error(`Google Sheets append failed: ${response.status}`);
}

async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const keyData = pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const key = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Google OAuth failed: ${response.status}`);
  return (await response.json()).access_token;
}

function pemToArrayBuffer(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
}

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const configured = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.includes("*") || configured.includes(origin) ? origin || "*" : configured[0] || "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}
