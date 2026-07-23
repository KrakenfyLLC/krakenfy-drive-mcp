import fs from "node:fs";
import path from "node:path";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

export const CREDS_DIR = process.env.GDRIVE_CREDS_DIR;
if (!CREDS_DIR) throw new Error("GDRIVE_CREDS_DIR is required");

const keyPath = path.join(CREDS_DIR, "gcp-oauth.keys.json");
const tokenPath = path.join(CREDS_DIR, ".gdrive-server-credentials.json");
export const SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"];

function oauthConfig() {
  const source = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  return source.installed ?? source.web;
}

function saveToken(credentials) {
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

export async function loadAuth() {
  if (!fs.existsSync(tokenPath)) throw new Error(`No OAuth token found at ${tokenPath}. Run npm run auth.`);
  const config = oauthConfig();
  const saved = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  const client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris?.[0]);
  client.setCredentials(saved);
  client.on("tokens", (tokens) => saveToken({ ...saved, ...tokens }));
  await client.getAccessToken();
  return client;
}

export async function authorize() {
  const client = await authenticate({ keyfilePath: keyPath, scopes: SCOPES });
  saveToken(client.credentials);
  return client.credentials;
}
