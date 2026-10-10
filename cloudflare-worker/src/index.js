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
      if (request.method === "POST" && url.pathname === "/api/ocr") {
        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > 5_000_000) return json({ error: "Saiz gambar terlalu besar." }, 413, cors);
        const body = await request.json();
        if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(body?.image || ""))) {
          return json({ error: "Format gambar tidak sah." }, 400, cors);
        }

        const imageFile = dataUrlToBlob(body.image);
        const result = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
          messages: [{
            role: "user",
            content: [
              {
                type: "text",
                text: "Read the water meter serial embossed or printed on the meter body. It starts with SAINS or JBANS. Ignore m3 and the rolling consumption counter. Reply only with the complete serial in uppercase without spaces."
              },
              { type: "image_url", image_url: { url: body.image } }
            ]
          }],
          temperature: 0,
          max_completion_tokens: 40,
          chat_template_kwargs: { enable_thinking: false }
        });
        const raw = aiText(result);
        const meter = extractMeterSerial(raw);
        if (!meter) return json({ meter: "", error: "Nombor penuh tidak dapat dibaca dengan yakin." }, 422, cors);
        return json({ meter }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/submissions") {
        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > 1_600_000) return json({ error: "Saiz gambar melebihi had 1 MB." }, 413, cors);
        const body = await request.json();
        const validation = validateSubmission(body);
        if (validation) return json({ error: validation }, 400, cors);

        const turnstile = await verifyTurnstile(body.turnstileToken, request, env);
        if (!turnstile.success) return json({ error: "Pengesahan Turnstile tidak berjaya." }, 403, cors);

        const rows = await readSheet(env);
        const duplicate = rows.slice(1).some((row) => String(row[1] || "").toUpperCase() === body.meter.toUpperCase());
        if (duplicate) return json({ error: "Nombor meter ini sudah wujud dalam rekod." }, 409, cors);

        let photoUrl = "";
        if (body.image) {
          try {
            const upload = await uploadPhotoToDrive(body, env);
            photoUrl = upload.fileUrl || "";
          } catch (error) {
            console.error(error);
            return json({ error: "Gambar tidak dapat disimpan ke Google Drive. Sila cuba semula." }, 502, cors);
          }
        }
        await ensureSheetHeaders(env);
        await appendSheet([body.area, body.meter, "", body.coordinates, "", "", photoUrl], env);
        return json({ ok: true }, 201, cors);
      }
      return json({ error: "Laluan tidak ditemui." }, 404, cors);
    } catch (error) {
      console.error(error);
      return json({ error: "Ralat pelayan. Sila cuba semula." }, 500, cors);
    }
  }
};

function aiText(result) {
  return String(result?.response || result?.choices?.[0]?.message?.content || "");
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data URL");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  return { extension, blob: new Blob([bytes], { type: `image/${match[1]}` }) };
}

function extractMeterSerial(text) {
  const original = String(text || "").toUpperCase();
  const direct = original.match(/(?:SAINS|JBANS)[A-Z0-9-]{4,25}/);
  if (direct) return direct[0];
  const normalized = original.replace(/[^A-Z0-9-]/g, "");
  return normalized.match(/(?:SAINS|JBANS)[A-Z0-9-]{4,15}/)?.[0] || "";
}

function validateSubmission(body) {
  if (!body || !AREA_TARGETS[body.area]) return "Nama kawasan tidak sah.";
  if (!/^(?:SAINS|JBANS)[A-Z0-9-]{4,25}$/i.test(String(body.meter || ""))) return "Nombor meter mesti bermula dengan SAINS atau JBANS.";
  const coordinatePattern = /^-?\d{1,2}(?:\.\d+)?,\s*-?\d{1,3}(?:\.\d+)?$/;
  if (!coordinatePattern.test(String(body.coordinates || ""))) return "Format koordinat tidak sah.";
  if (!body.turnstileToken) return "Token Turnstile diperlukan.";
  if (body.image) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(body.image))) return "Format gambar tidak sah.";
    if (dataUrlByteLength(body.image) > 1_000_000) return "Saiz gambar melebihi had 1 MB.";
  }
  return null;
}

function dataUrlByteLength(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  const padding = (base64.match(/=+$/) || [""])[0].length;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

async function uploadPhotoToDrive(body, env) {
  if (!env.GOOGLE_DRIVE_UPLOAD_URL || !env.GOOGLE_DRIVE_UPLOAD_SECRET) {
    throw new Error("Google Drive upload is not configured");
  }
  const response = await fetch(env.GOOGLE_DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.GOOGLE_DRIVE_UPLOAD_SECRET,
      area: body.area,
      meter: body.meter,
      image: body.image
    }),
    redirect: "follow"
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error(`Google Drive upload failed: ${response.status}`); }
  if (!response.ok || !result.ok) throw new Error(`Google Drive upload failed: ${result.error || response.status}`);
  return result;
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
  const range = encodeURIComponent(`${env.GOOGLE_SHEET_NAME}!${env.GOOGLE_DATA_RANGE || "A8:E"}`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Google Sheets read failed: ${response.status}`);
  const data = await response.json();
  return data.values || [];
}

async function appendSheet(values, env) {
  const token = await googleAccessToken(env);
  const range = encodeURIComponent(`${env.GOOGLE_SHEET_NAME}!${env.GOOGLE_DATA_RANGE || "A8:E"}`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] })
  });
  if (!response.ok) throw new Error(`Google Sheets append failed: ${response.status}`);
}

async function ensureSheetHeaders(env) {
  const token = await googleAccessToken(env);
  const metadataResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!metadataResponse.ok) throw new Error(`Google Sheets metadata failed: ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const sheet = metadata.sheets?.find((item) => item.properties?.title === env.GOOGLE_SHEET_NAME);
  if (!sheet) throw new Error("Google Sheet tab not found");

  const columnCount = Number(sheet.properties.gridProperties?.columnCount || 0);
  if (columnCount < 7) {
    const requests = [
      { appendDimension: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", length: 7 - columnCount } },
      {
        copyPaste: {
          source: { sheetId: sheet.properties.sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 4, endColumnIndex: 5 },
          destination: { sheetId: sheet.properties.sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 6, endColumnIndex: 7 },
          pasteType: "PASTE_FORMAT"
        }
      }
    ];
    const resizeResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests })
    });
    if (!resizeResponse.ok) throw new Error(`Google Sheets resize failed: ${resizeResponse.status} ${await resizeResponse.text()}`);
  }

  const range = encodeURIComponent(`${env.GOOGLE_SHEET_NAME}!G8`);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [["LINK GAMBAR"]] })
  });
  if (!response.ok) throw new Error(`Google Sheets header update failed: ${response.status} ${await response.text()}`);
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
