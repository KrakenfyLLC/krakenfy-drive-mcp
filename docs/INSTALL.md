# Installation

## 1. Create the OAuth client

In a Google Cloud project, enable Google Drive API and Google Sheets API. Configure the OAuth consent
screen and create an OAuth client of type **Desktop app**. Download it as `gcp-oauth.keys.json`.

For private installations that need the whole Drive, the server uses `drive` and `spreadsheets`. These
are broad permissions: review them before authorizing. A future public SaaS should use `drive.file`
and a file picker instead.

## 2. Install

```bash
git clone https://github.com/KrakenfyLLC/krakenfy-drive-mcp.git
cd krakenfy-drive-mcp
npm ci
install -d -m 700 "$HOME/.config/krakenfy-drive-mcp"
install -m 600 /path/to/gcp-oauth.keys.json "$HOME/.config/krakenfy-drive-mcp/gcp-oauth.keys.json"
GDRIVE_CREDS_DIR="$HOME/.config/krakenfy-drive-mcp" npm run auth
```

## 3. Register in Claude Code

```bash
claude mcp add --scope user gdrive \
  -e "GDRIVE_CREDS_DIR=$HOME/.config/krakenfy-drive-mcp" \
  -- node "$PWD/src/index.js"
```

For other MCP clients, configure a stdio server whose command is `node`, whose first argument is the
absolute path to `src/index.js`, and whose environment contains `GDRIVE_CREDS_DIR`.

## 4. Verify

Restart the MCP client and ask it to list the root folder. Never commit either credentials file.
