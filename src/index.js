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

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetriable(e, mutating) {
  const status = Number(e?.status ?? e?.response?.status ?? e?.code) || 0;
  const reasons = [].concat(e?.errors ?? e?.response?.data?.error?.errors ?? []);
  const rateLimited = status === 429 || (status === 403 && reasons.some((detail) => RATE_LIMIT_REASONS.has(detail?.reason)));
  if (rateLimited) return true; // safe for any verb: Google rejected the request before executing it
  if (mutating) return false; // never re-send non-idempotent work after an ambiguous failure
  return RETRIABLE_STATUS.has(status) || TRANSIENT_CODES.has(e?.code);
}

async function withBackoff(run, mutating) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); } catch (e) {
      if (attempt >= 3 || !isRetriable(e, mutating)) throw e;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
}

const wrapApi = (owner, method, mutating) => {
  const original = owner[method].bind(owner);
  owner[method] = (...args) => {
    const streaming = args.some((arg) => typeof arg?.media?.body?.pipe === "function");
    return streaming ? original(...args) : withBackoff(() => original(...args), mutating);
  };
};

let authPromise;
async function apis() {
  authPromise ??= loadAuth();
  const auth = await authPromise;
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });
  wrapApi(drive.files, "list", false);
  wrapApi(drive.files, "get", false);
  wrapApi(drive.files, "export", false);
  wrapApi(drive.files, "update", false); // PATCH is idempotent: rename, move, trash
  wrapApi(drive.files, "create", true);
  wrapApi(drive.files, "copy", true);
  wrapApi(drive.permissions, "create", true);
  wrapApi(sheets.spreadsheets.values, "batchGet", false);
  wrapApi(sheets.spreadsheets.values, "update", false); // PUT is idempotent
  wrapApi(sheets.spreadsheets.values, "append", true);
  return { drive, sheets };
}

const response = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError });
const fail = (e) => response({ error: e?.message ?? String(e), code: e?.code ?? null }, true);
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const pageSize = (n) => Math.max(1, Math.min(Number(n) || 25, 100));
const tool = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, run });
const cleanFolderPath = (value) => {
  const parts = String(value).split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error(`Invalid folder path: ${value}`);
  return parts;
};

const MAX_RANGE_CELLS = 10000;
const A1_RECT = /^(?:(?:'(?:[^']|'')+'|[^'!:]+)!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/;
const colToNum = (letters) => [...letters.toUpperCase()].reduce((total, ch) => total * 26 + ch.charCodeAt(0) - 64, 0);
function assertBoundedRange(range) {
  const match = A1_RECT.exec(String(range).trim());
  if (!match) throw new Error(`Range "${range}" must be a bounded rectangle such as Sheet1!A1:F200; whole columns, whole rows, or whole sheets are not allowed.`);
  const [, startCol, startRow, endCol = match[1], endRow = match[2]] = match;
  const cells = (Math.abs(colToNum(endCol) - colToNum(startCol)) + 1) * (Math.abs(Number(endRow) - Number(startRow)) + 1);
  if (cells > MAX_RANGE_CELLS) throw new Error(`Range "${range}" covers ${cells} cells; the limit is ${MAX_RANGE_CELLS} cells per range.`);
}

const tools = [
  tool("drive_search", "Search files and folders accessible in Google Drive.", {
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
  tool("drive_list_folder", "List the direct children of a folder; use root for My Drive.", {
    folderId: { type: "string", default: "root" }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string" }
  }, [], async (a) => {
    const { drive } = await apis();
    const folderId = a.folderId || "root";
    const r = await drive.files.list({ q: `'${esc(folderId)}' in parents and trashed = false`, pageSize: pageSize(a.pageSize), pageToken: a.pageToken, orderBy: "folder,name", fields: `nextPageToken,files(${FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true });
    return response({ folderId, files: r.data.files ?? [], nextPageToken: r.data.nextPageToken ?? null });
  }),
  tool("drive_get_folder_tree", "Audit a folder tree recursively, including file metadata and paths.", {
    folderId: { type: "string", default: "root" }, maxDepth: { type: "integer", minimum: 1, maximum: 5, default: 3 },
    maxItems: { type: "integer", minimum: 1, maximum: 500, default: 200 }
  }, [], async (a) => {
    const { drive } = await apis();
    const rootId = a.folderId || "root";
    const maxDepth = Math.max(1, Math.min(Number(a.maxDepth) || 3, 5));
    const maxItems = Math.max(1, Math.min(Number(a.maxItems) || 200, 500));
    const items = [];
    const queue = [{ id: rootId, path: "", depth: 0 }];
    let truncated = false;
    while (queue.length && !truncated) {
      const current = queue.shift();
      let pageToken;
      do {
        const r = await drive.files.list({
          q: `'${esc(current.id)}' in parents and trashed = false`, pageSize: Math.min(100, maxItems - items.length),
          pageToken, orderBy: "folder,name", fields: `nextPageToken,files(${FIELDS})`,
          supportsAllDrives: true, includeItemsFromAllDrives: true
        });
        for (const file of r.data.files ?? []) {
          const itemPath = current.path ? `${current.path}/${file.name}` : file.name;
          items.push({ ...file, path: itemPath, depth: current.depth + 1 });
          if (file.mimeType === FOLDER && current.depth + 1 < maxDepth) queue.push({ id: file.id, path: itemPath, depth: current.depth + 1 });
          if (items.length >= maxItems) { truncated = true; break; }
        }
        pageToken = r.data.nextPageToken;
      } while (pageToken && !truncated);
    }
    return response({ folderId: rootId, maxDepth, items, truncated, remainingFolders: queue.length });
  }),
  tool("drive_get_metadata", "Get file metadata, owners, and permissions.", { fileId: { type: "string" } }, ["fileId"], async (a) => {
    const { drive } = await apis();
    return response((await drive.files.get({ fileId: a.fileId, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_read_file", "Read or export text up to 2 MiB. Binary files must be downloaded.", { fileId: { type: "string" } }, ["fileId"], async (a) => {
    const { drive } = await apis();
    const meta = (await drive.files.get({ fileId: a.fileId, fields: "id,name,mimeType,size", supportsAllDrives: true })).data;
    let data;
    let mimeType = meta.mimeType;
    if (EXPORTS[mimeType]) {
      mimeType = EXPORTS[mimeType];
      data = (await drive.files.export({ fileId: a.fileId, mimeType }, { responseType: "arraybuffer" })).data;
    } else {
      if (!mimeType?.startsWith("text/") && !["application/json", "application/xml"].includes(mimeType)) throw new Error(`Binary file (${mimeType}); use drive_download_file.`);
      if (Number(meta.size || 0) > MAX_TEXT_BYTES) throw new Error("The file exceeds 2 MiB; use drive_download_file.");
      data = (await drive.files.get({ fileId: a.fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" })).data;
    }
    const buffer = Buffer.from(data);
    if (buffer.length > MAX_TEXT_BYTES) throw new Error("The exported file exceeds 2 MiB.");
    return response({ id: meta.id, name: meta.name, mimeType, content: buffer.toString("utf8") });
  }),
  tool("drive_download_file", "Download a file to a new local path; never overwrite an existing file.", {
    fileId: { type: "string" }, destination: { type: "string" }, exportMimeType: { type: "string" }
  }, ["fileId", "destination"], async (a) => {
    if (!path.isAbsolute(a.destination)) throw new Error("destination must be an absolute path");
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
  tool("drive_create_folder", "Create a folder.", { name: { type: "string" }, parentId: { type: "string", default: "root" } }, ["name"], async (a) => {
    const { drive } = await apis();
    return response((await drive.files.create({ requestBody: { name: a.name, mimeType: FOLDER, parents: [a.parentId || "root"] }, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_create_workspace", "Create a repeatable client or project workspace with nested folders and optional template copies.", {
    name: { type: "string" }, parentId: { type: "string", default: "root" },
    folderPaths: { type: "array", maxItems: 50, items: { type: "string" } },
    templates: {
      type: "array", maxItems: 20, items: {
        type: "object", additionalProperties: false, required: ["fileId"],
        properties: { fileId: { type: "string" }, name: { type: "string" }, targetFolderPath: { type: "string" } }
      }
    }
  }, ["name"], async (a) => {
    const { drive } = await apis();
    const root = (await drive.files.create({
      requestBody: { name: a.name, mimeType: FOLDER, parents: [a.parentId || "root"] },
      fields: FIELDS, supportsAllDrives: true
    })).data;
    const folders = new Map([["", root]]);
    const ensureFolder = async (folderPath) => {
      const parts = cleanFolderPath(folderPath);
      let key = "";
      let parent = root;
      for (const part of parts) {
        key = key ? `${key}/${part}` : part;
        if (!folders.has(key)) {
          const created = (await drive.files.create({
            requestBody: { name: part, mimeType: FOLDER, parents: [parent.id] },
            fields: FIELDS, supportsAllDrives: true
          })).data;
          folders.set(key, created);
        }
        parent = folders.get(key);
      }
      return parent;
    };
    for (const folderPath of a.folderPaths ?? []) await ensureFolder(folderPath);
    const copies = [];
    for (const template of a.templates ?? []) {
      const target = template.targetFolderPath ? await ensureFolder(template.targetFolderPath) : root;
      const requestBody = { parents: [target.id] };
      if (template.name) requestBody.name = template.name;
      copies.push((await drive.files.copy({
        fileId: template.fileId, requestBody, fields: FIELDS, supportsAllDrives: true
      })).data);
    }
    return response({
      workspace: root,
      folders: [...folders.entries()].filter(([folderPath]) => folderPath).map(([folderPath, folder]) => ({ path: folderPath, ...folder })),
      templateCopies: copies
    });
  }),
  tool("drive_upload_file", "Upload a new local file.", {
    source: { type: "string" }, name: { type: "string" }, parentId: { type: "string", default: "root" }, mimeType: { type: "string" }
  }, ["source"], async (a) => {
    if (!path.isAbsolute(a.source)) throw new Error("source must be an absolute path");
    const { drive } = await apis();
    const r = await drive.files.create({ requestBody: { name: a.name || path.basename(a.source), parents: [a.parentId || "root"] }, media: { mimeType: a.mimeType || "application/octet-stream", body: fs.createReadStream(a.source) }, fields: FIELDS, supportsAllDrives: true });
    return response(r.data);
  }),
  tool("drive_copy_file", "Copy a file within Drive.", { fileId: { type: "string" }, name: { type: "string" }, parentId: { type: "string" } }, ["fileId"], async (a) => {
    const { drive } = await apis();
    const body = {}; if (a.name) body.name = a.name; if (a.parentId) body.parents = [a.parentId];
    return response((await drive.files.copy({ fileId: a.fileId, requestBody: body, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_move_file", "Move a file or folder.", { fileId: { type: "string" }, newParentId: { type: "string" } }, ["fileId", "newParentId"], async (a) => {
    const { drive } = await apis();
    const old = (await drive.files.get({ fileId: a.fileId, fields: "parents", supportsAllDrives: true })).data.parents ?? [];
    return response((await drive.files.update({ fileId: a.fileId, addParents: a.newParentId, removeParents: old.join(","), fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_rename_file", "Rename a file or folder.", { fileId: { type: "string" }, name: { type: "string" } }, ["fileId", "name"], async (a) => {
    const { drive } = await apis();
    return response((await drive.files.update({ fileId: a.fileId, requestBody: { name: a.name }, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_trash_file", "Move a file or folder to trash; requires confirm=true.", { fileId: { type: "string" }, confirm: { type: "boolean" } }, ["fileId", "confirm"], async (a) => {
    if (a.confirm !== true) throw new Error("Operation cancelled: confirm must be true");
    const { drive } = await apis();
    return response((await drive.files.update({ fileId: a.fileId, requestBody: { trashed: true }, fields: FIELDS, supportsAllDrives: true })).data);
  }),
  tool("drive_share_file", "Share a file or folder with a person, group, or domain; requires confirm=true.", {
    fileId: { type: "string" }, type: { type: "string", enum: ["user", "group", "domain"] },
    role: { type: "string", enum: ["reader", "commenter", "writer"] }, emailAddress: { type: "string" },
    domain: { type: "string" }, sendNotificationEmail: { type: "boolean", default: true }, confirm: { type: "boolean" }
  }, ["fileId", "type", "role", "confirm"], async (a) => {
    if (a.confirm !== true) throw new Error("Operation cancelled: confirm must be true");
    if (["user", "group"].includes(a.type) && !a.emailAddress) throw new Error("emailAddress is required for user or group sharing");
    if (a.type === "domain" && !a.domain) throw new Error("domain is required for domain sharing");
    const { drive } = await apis();
    const requestBody = { type: a.type, role: a.role };
    if (a.emailAddress) requestBody.emailAddress = a.emailAddress;
    if (a.domain) requestBody.domain = a.domain;
    const r = await drive.permissions.create({
      fileId: a.fileId, requestBody, fields: "id,type,role,emailAddress,domain",
      sendNotificationEmail: a.type === "domain" ? false : a.sendNotificationEmail !== false,
      supportsAllDrives: true
    });
    return response(r.data);
  }),
  tool("sheets_read", "Read bounded A1 rectangles from a spreadsheet, such as Sheet1!A1:F200; max 10000 cells per range.", {
    spreadsheetId: { type: "string" }, ranges: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } }, valueRenderOption: { type: "string", enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] }
  }, ["spreadsheetId", "ranges"], async (a) => {
    for (const range of a.ranges) assertBoundedRange(range);
    const { sheets } = await apis();
    return response((await sheets.spreadsheets.values.batchGet({ spreadsheetId: a.spreadsheetId, ranges: a.ranges, valueRenderOption: a.valueRenderOption || "FORMATTED_VALUE" })).data.valueRanges ?? []);
  }),
  tool("sheets_update", "Update a rectangular Google Sheets range.", {
    spreadsheetId: { type: "string" }, range: { type: "string" }, values: { type: "array", minItems: 1, items: { type: "array", items: {} } }, valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] }
  }, ["spreadsheetId", "range", "values"], async (a) => {
    const { sheets } = await apis();
    const r = await sheets.spreadsheets.values.update({ spreadsheetId: a.spreadsheetId, range: a.range, valueInputOption: a.valueInputOption || "USER_ENTERED", requestBody: { values: a.values } });
    return response({ updatedRange: r.data.updatedRange, updatedRows: r.data.updatedRows, updatedColumns: r.data.updatedColumns, updatedCells: r.data.updatedCells });
  }),
  tool("sheets_append_rows", "Append rows to a Google Sheet for logs, intake, and recurring reports.", {
    spreadsheetId: { type: "string" }, range: { type: "string" },
    values: { type: "array", minItems: 1, maxItems: 500, items: { type: "array", items: {} } },
    valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
    insertDataOption: { type: "string", enum: ["OVERWRITE", "INSERT_ROWS"] }
  }, ["spreadsheetId", "range", "values"], async (a) => {
    const { sheets } = await apis();
    const r = await sheets.spreadsheets.values.append({
      spreadsheetId: a.spreadsheetId, range: a.range,
      valueInputOption: a.valueInputOption || "USER_ENTERED", insertDataOption: a.insertDataOption || "INSERT_ROWS",
      requestBody: { values: a.values }
    });
    return response({
      tableRange: r.data.tableRange ?? null, updatedRange: r.data.updates?.updatedRange,
      updatedRows: r.data.updates?.updatedRows, updatedColumns: r.data.updates?.updatedColumns,
      updatedCells: r.data.updates?.updatedCells
    });
  }),
];

const server = new Server({ name: "krakenfy-gdrive", version: "1.2.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ run, ...schema }) => schema) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const selected = tools.find((t) => t.name === request.params.name);
  if (!selected) return fail(new Error(`Unknown tool: ${request.params.name}`));
  try { return await selected.run(request.params.arguments ?? {}); } catch (e) { return fail(e); }
});
await server.connect(new StdioServerTransport());
