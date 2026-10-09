const ROOT_FOLDER_NAME = "BORANG TAPPING METER";

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const expectedSecret = PropertiesService.getScriptProperties().getProperty("UPLOAD_SECRET");
    if (!expectedSecret || body.secret !== expectedSecret) return jsonResponse({ ok: false, error: "Tidak dibenarkan." });
    if (!body.area || !body.meter || !body.image) return jsonResponse({ ok: false, error: "Data gambar tidak lengkap." });

    const match = String(body.image).match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return jsonResponse({ ok: false, error: "Format gambar tidak sah." });
    const bytes = Utilities.base64Decode(match[1]);
    if (bytes.length > 1000000) return jsonResponse({ ok: false, error: "Saiz gambar melebihi 1 MB." });

    const root = getOrCreateFolder(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
    const areaFolder = getOrCreateFolder(root, safeName(body.area));
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
    const fileName = `${safeName(body.meter)}_${timestamp}.jpg`;
    const file = areaFolder.createFile(Utilities.newBlob(bytes, "image/jpeg", fileName));
    return jsonResponse({ ok: true, fileId: file.getId(), fileName: file.getName(), fileUrl: file.getUrl() });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message || error) });
  }
}

function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function safeName(value) {
  return String(value || "").trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 100);
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
