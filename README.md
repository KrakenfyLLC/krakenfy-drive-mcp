# Krakenfy Drive MCP

An open-source MCP server that lets AI agents work with Google Drive and Google Sheets through an
OAuth project controlled by the user. It does not depend on native ChatGPT or Claude connectors.

**[Managed installation for teams →](https://krakenfy.com/drive-agent/)**

## Capabilities

- Search files and browse folders with pagination.
- Read, export, and download files.
- Create folders; upload, copy, move, and rename files.
- Move items to trash with explicit confirmation.
- Read and update bounded Google Sheets ranges.
- Work with shared drives.

## Security

- Credentials live outside the repository.
- Tokens are stored with `0600` permissions.
- Downloads never overwrite local files.
- Destructive actions are recoverable and require `confirm: true`.
- Text responses are limited to 2 MiB.
- Every user supplies their own Google Cloud project.

## Installation

See the [installation guide](docs/INSTALL.md). For managed installation and enterprise adaptations,
see [managed services](docs/MANAGED-SERVICE.md).

## Optional commercial services

The software in this repository is free under the MIT License. Purchasing a service is not required
to use it. Krakenfy LLC optionally offers:

| Service | Starting price | Includes |
| --- | ---: | --- |
| Essential installation | USD 199 one-time | One workstation, one Google account, client-owned OAuth, MCP setup, and validation |
| Private workflow | USD 600 one-time | Essential installation plus one custom workflow tested with real client data |
| Team rollout | USD 1,200 one-time | Up to five users, shared-drive access design, rollout, and training |
| Pilot support | USD 79/month | Updates, one monthly review, and up to one hour of support |

Model-provider and Google Workspace fees are not included. Final scope and total price are agreed
before work begins. [Request a managed installation](https://krakenfy.com/drive-agent/).

This project is independent and is not endorsed by, sponsored by, or affiliated with Google.
Google Drive is a trademark of Google LLC.

## Development

```bash
npm ci
npm run check
npm test
```

## License

MIT. See [LICENSE](LICENSE).
