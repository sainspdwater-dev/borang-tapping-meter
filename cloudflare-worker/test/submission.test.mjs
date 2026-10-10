import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

function pem(bytes) {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

test("camera submission stores the Drive link in column G", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const privateKey = pem(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("siteverify")) return Response.json({ success: true });
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "test-token" });
    if (url === "https://script.example/upload") {
      const body = JSON.parse(init.body);
      assert.equal(body.secret, "drive-secret");
      assert.equal(body.area, "Taman PD Utama");
      return Response.json({ ok: true, fileUrl: "https://drive.google.com/file/d/test/view" });
    }
    if (url.includes("?fields=sheets.properties")) {
      return Response.json({ sheets: [{ properties: { sheetId: 0, title: "Sheet1", gridProperties: { columnCount: 5 } } }] });
    }
    if (url.includes(":batchUpdate")) return Response.json({ replies: [{}, {}] });
    if (url.includes("sheets.googleapis.com") && init.method === "PUT") return Response.json({ updatedCells: 1 });
    if (url.includes(":append")) return Response.json({ updates: { updatedRows: 1 } });
    if (url.includes("sheets.googleapis.com")) {
      return Response.json({ values: [["NAMA KAWASAN", "NO METER", "NO AKAUN", "KORDINAT", "ALAMAT PENGGUNA", "", "LINK GAMBAR"]] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = {
      ALLOWED_ORIGINS: "https://example.com",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "test@example.iam.gserviceaccount.com",
      GOOGLE_PRIVATE_KEY: privateKey,
      GOOGLE_SHEET_ID: "sheet-id",
      GOOGLE_SHEET_NAME: "Sheet1",
      GOOGLE_DATA_RANGE: "A8:G",
      GOOGLE_DRIVE_UPLOAD_URL: "https://script.example/upload",
      GOOGLE_DRIVE_UPLOAD_SECRET: "drive-secret"
    };
    const response = await worker.fetch(new Request("https://worker.example/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({
        area: "Taman PD Utama",
        meter: "SAINS17A22557",
        coordinates: "2.7259, 101.9378",
        turnstileToken: "valid-token",
        image: "data:image/jpeg;base64,YWJj"
      })
    }), env);

    assert.equal(response.status, 201);
    const resize = requests.find(({ url }) => url.includes(":batchUpdate"));
    assert.equal(JSON.parse(resize.init.body).requests[0].appendDimension.length, 2);
    const headerUpdate = requests.find(({ url, init }) => url.includes("!G8") && init.method === "PUT");
    assert.deepEqual(JSON.parse(headerUpdate.init.body).values, [["LINK GAMBAR"]]);
    const append = requests.find(({ url }) => url.includes(":append"));
    assert.deepEqual(JSON.parse(append.init.body).values[0], [
      "Taman PD Utama",
      "SAINS17A22557",
      "",
      "2.7259, 101.9378",
      "",
      "",
      "https://drive.google.com/file/d/test/view"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
