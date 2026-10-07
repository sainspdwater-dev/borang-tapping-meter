# Borang Tapping Meter

Aplikasi web mesra telefon untuk mengumpul `NAMA KAWASAN`, `NO METER` dan `KORDINAT`. Imej nombor meter diproses oleh OCR dalam pelayar, kemudian dilepaskan daripada memori selepas pengguna mengesahkan nombor. Hanya lima kolum berikut ditulis ke Google Sheet:

1. `NAMA KAWASAN`
2. `NO METER`
3. `NO AKAUN` (kosong, dilengkapkan kemudian)
4. `KORDINAT`
5. `ALAMAT PENGGUNA` (kosong, dilengkapkan kemudian)

## Struktur

- `dist/` — frontend statik untuk GitHub Pages.
- `cloudflare-worker/` — API Cloudflare Worker untuk Turnstile dan Google Sheets.
- `.openai/hosting.json` — konfigurasi pratonton Sites.

## Uji frontend

Frontend bermula dalam `demoMode`. Rekod demo disimpan di `localStorage`, jadi tiada data dihantar keluar.

```powershell
python -m http.server 4173 --directory dist
```

Buka `http://localhost:4173`.

## Sediakan Google Sheet

1. Cipta Google Cloud service account dan aktifkan Google Sheets API.
2. Kongsi Google Sheet dengan e-mel service account sebagai Editor.
3. Pastikan baris header dalam helaian data ialah:

   `NAMA KAWASAN | NO METER | NO AKAUN | KORDINAT | ALAMAT PENGGUNA`

   Konfigurasi semasa membaca jadual data dari `A8:E`, selaras dengan helaian contoh. Jika header dipindahkan, ubah `GOOGLE_DATA_RANGE` dalam `cloudflare-worker/wrangler.toml`.

## Deploy Cloudflare Worker

Di dalam `cloudflare-worker/`:

1. Salin `wrangler.toml.example` kepada `wrangler.toml`.
2. Isi `ALLOWED_ORIGIN`, `GOOGLE_SHEET_ID` dan `GOOGLE_SHEET_NAME`.
3. Pasang kebergantungan: `npm install`.
4. Tambah rahsia (jangan commit nilainya):

   ```powershell
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
   npx wrangler secret put GOOGLE_PRIVATE_KEY
   ```

5. Deploy: `npm run deploy`.

## Sambungkan frontend produksi

Dalam `dist/config.js`:

- Tetapkan `apiBaseUrl` kepada URL Worker.
- Tetapkan `turnstileSiteKey` kepada site key Turnstile.
- Tukar `demoMode` kepada `false`.

Daftarkan domain GitHub Pages dalam konfigurasi hostname Turnstile. Kemudian publish kandungan `dist/` dengan GitHub Pages.

## Keselamatan

- Turnstile disahkan semula pada backend, bukan dipercayai daripada frontend.
- Kunci rahsia Turnstile dan private key Google hanya disimpan sebagai Cloudflare secrets.
- Backend memeriksa kawasan, format meter, koordinat dan nombor meter pendua.
- Imej OCR tidak dimuat naik oleh aplikasi ini dan tidak ditulis ke Google Sheet.
