#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { loadAuth } from "./auth.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,parents,modifiedTime,createdTime,size,webViewLink,trashed,owners(displayName,emailAddress),permissions(id,type,role,emailAddress,domain)";
const EXPORTS = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
};

let authPromise;
async function apis() {
  authPromise ??= loadAuth();
  const auth = await authPromise;
  return { drive: google.drive({ version: "v3", auth }), sheets: google.sheets({ version: "v4", auth }) };
}

const response = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError });
const fail = (e) => response({ error: e?.message ?? String(e), code: e?.code ?? null }, true);
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const pageSize = (n) => Math.max(1, Math.min(Number(n) || 25, 100));
const tool = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, run });

const tools = [
  tool("drive_search", "Busca archivos y carpetas accesibles en Drive.", {
    name: { type: "string" }, mimeType: { type: "string" }, parentId: { type: "string" },
    pageSize: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string" }, includeTrashed: { type: "boolean" }
  }, [], async (a) => {
    const { drive } = await apis();
    const q = [];
    if (a.name) q.push(`name contains '${esc(a.name)}'`);
    if (a.mimeType) q.push(`mimeType = '${esc(a.mimeType)}'`);
    if (a.parentId) q.push(`'${esc(a.parentId)}' in parents`);
    if (!a.includeTrashed) q.push("trashed = false");
    const r = await drive.files.list({ q: q.join(" and ") || undefined, pageSize: pageSize(a.pageSize), pageToken: a.pageToken, orderBy: "modifiedTime desc", fields: `nextPageToken,files(${FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true });
    return response({ files: r.data.files ?? [], nextPageToken: r.data.nextPageToken ?? null });
  }),
  tool("drive_list_folder", "Lista los hijos directos de una carpeta; usa root para Mi unidad.", {
    folderId: { type: "string", default: "root" }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string" }
  }, [], async (a) => {
    const { drive } = await apis();
    const folderId = a.folderId || "root";
    const r = await drive.files.list({ q: `'${esc(folderId)}' in parents and trashed = false`, pageSize: pageSize(a.pageSize), pageToken: a.pageToken, orderBy: "folder,name", fields: `nextPageToken,files(${FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true });
    return response({ folderId, files: r.data.files ?? [], nextPageToken: r.data.nextPageToken ?? null });
  }),
  tool("drive_get_metadata", "Obtiene metadatos, propietarios y permisos.", { fileId: { type: "string" } }, ["fileId"], async (a) => {
    const { drive } = await apis();
    return response((await drive.files.get({ fileId: a.fileId, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_read_file", "Lee o exporta texto; máximo 2 MiB. Los binarios deben descargarse.", { fileId: { type: "string" } }, ["fileId"], async (a) => {
    const { drive } = await apis();
    const meta = (await drive.files.get({ fileId: a.fileId, fields: "id,name,mimeType,size", supportsAllDrives: true })).data;
    let data;
    let mimeType = meta.mimeType;
    if (EXPORTS[mimeType]) {
      mimeType = EXPORTS[mimeType];
      data = (await drive.files.export({ fileId: a.fileId, mimeType }, { responseType: "arraybuffer" })).data;
    } else {
      if (!mimeType?.startsWith("text/") && !["application/json", "application/xml"].includes(mimeType)) throw new Error(`Archivo binario (${mimeType}); usa drive_download_file.`);
      if (Number(meta.size || 0) > MAX_TEXT_BYTES) throw new Error("El archivo supera 2 MiB; usa drive_download_file.");
      data = (await drive.files.get({ fileId: a.fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" })).data;
    }
    const buffer = Buffer.from(data);
    if (buffer.length > MAX_TEXT_BYTES) throw new Error("La exportación supera 2 MiB.");
    return response({ id: meta.id, name: meta.name, mimeType, content: buffer.toString("utf8") });
  }),
  tool("drive_download_file", "Descarga un archivo a una ruta local nueva; nunca sobrescribe.", {
    fileId: { type: "string" }, destination: { type: "string" }, exportMimeType: { type: "string" }
  }, ["fileId", "destination"], async (a) => {
    if (!path.isAbsolute(a.destination)) throw new Error("destination debe ser absoluta");
    const { drive } = await apis();
    const meta = (await drive.files.get({ fileId: a.fileId, fields: "name,mimeType", supportsAllDrives: true })).data;
    const exportMime = a.exportMimeType || EXPORTS[meta.mimeType];
    const r = exportMime
      ? await drive.files.export({ fileId: a.fileId, mimeType: exportMime }, { responseType: "arraybuffer" })
      : await drive.files.get({ fileId: a.fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    await fsp.mkdir(path.dirname(a.destination), { recursive: true });
    await fsp.writeFile(a.destination, Buffer.from(r.data), { flag: "wx" });
    return response({ destination: a.destination, bytes: Buffer.byteLength(r.data), sourceName: meta.name });
  }),
  tool("drive_create_folder", "Crea una carpeta.", { name: { type: "string" }, parentId: { type: "string", default: "root" } }, ["name"], async (a) => {
    const { drive } = await apis();
    return response((await drive.files.create({ requestBody: { name: a.name, mimeType: FOLDER, parents: [a.parentId || "root"] }, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_upload_file", "Sube un archivo local nuevo.", {
    source: { type: "string" }, name: { type: "string" }, parentId: { type: "string", default: "root" }, mimeType: { type: "string" }
  }, ["source"], async (a) => {
    if (!path.isAbsolute(a.source)) throw new Error("source debe ser absoluta");
    const { drive } = await apis();
    const r = await drive.files.create({ requestBody: { name: a.name || path.basename(a.source), parents: [a.parentId || "root"] }, media: { mimeType: a.mimeType || "application/octet-stream", body: fs.createReadStream(a.source) }, fields: FIELDS, supportsAllDrives: true });
    return response(r.data);
  }),
  tool("drive_copy_file", "Copia un archivo dentro de Drive.", { fileId: { type: "string" }, name: { type: "string" }, parentId: { type: "string" } }, ["fileId"], async (a) => {
    const { drive } = await apis();
    const body = {}; if (a.name) body.name = a.name; if (a.parentId) body.parents = [a.parentId];
    return response((await drive.files.copy({ fileId: a.fileId, requestBody: body, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_move_file", "Mueve un archivo o carpeta.", { fileId: { type: "string" }, newParentId: { type: "string" } }, ["fileId", "newParentId"], async (a) => {
    const { drive } = await apis();
    const old = (await drive.files.get({ fileId: a.fileId, fields: "parents", supportsAllDrives: true })).data.parents ?? [];
    return response((await drive.files.update({ fileId: a.fileId, addParents: a.newParentId, removeParents: old.join(","), fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_rename_file", "Renombra un archivo o carpeta.", { fileId: { type: "string" }, name: { type: "string" } }, ["fileId", "name"], async (a) => {
    const { drive } = await apis();
    return response((await drive.files.update({ fileId: a.fileId, requestBody: { name: a.name }, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_trash_file", "Envía a la papelera; requiere confirm=true.", { fileId: { type: "string" }, confirm: { type: "boolean" } }, ["fileId", "confirm"], async (a) => {
    if (a.confirm !== true) throw new Error("Operación cancelada: confirm debe ser true");
    const { drive } = await apis();
    return response((await drive.files.update({ fileId: a.fileId, requestBody: { trashed: true }, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("sheets_read", "Lee rangos A1 acotados de una hoja.", {
    spreadsheetId: { type: "string" }, ranges: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } }, valueRenderOption: { type: "string", enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] }
  }, ["spreadsheetId", "ranges"], async (a) => {
    const { sheets } = await apis();
    return response((await sheets.spreadsheets.values.batchGet({ spreadsheetId: a.spreadsheetId, ranges: a.ranges, valueRenderOption: a.valueRenderOption || "FORMATTED_VALUE" })).data.valueRanges ?? []);
  }),
  tool("sheets_update", "Actualiza un rango rectangular de Sheets.", {
    spreadsheetId: { type: "string" }, range: { type: "string" }, values: { type: "array", minItems: 1, items: { type: "array", items: {} } }, valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] }
  }, ["spreadsheetId", "range", "values"], async (a) => {
    const { sheets } = await apis();
    const r = await sheets.spreadsheets.values.update({ spreadsheetId: a.spreadsheetId, range: a.range, valueInputOption: a.valueInputOption || "USER_ENTERED", requestBody: { values: a.values } });
    return response({ updatedRange: r.data.updatedRange, updatedRows: r.data.updatedRows, updatedColumns: r.data.updatedColumns, updatedCells: r.data.updatedCells });
  }),
];

const server = new Server({ name: "krakenfy-gdrive", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ run, ...schema }) => schema) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const selected = tools.find((t) => t.name === request.params.name);
  if (!selected) return fail(new Error(`Herramienta desconocida: ${request.params.name}`));
  try { return await selected.run(request.params.arguments ?? {}); } catch (e) { return fail(e); }
});
await server.connect(new StdioServerTransport());
