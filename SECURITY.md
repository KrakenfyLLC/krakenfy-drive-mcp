# Security policy

Do not report vulnerabilities in public issues. Email `security@krakenfy.com` with reproduction steps
and affected versions. We will acknowledge reports within five business days.

Never attach OAuth client files, access tokens, refresh tokens, Drive documents, or MCP client
configuration containing secrets. Revoke exposed grants immediately from the Google Account security
page and rotate the OAuth client when applicable.

This project stores OAuth tokens only on the user's machine. Users remain responsible for selecting
least-privilege scopes and protecting their workstation.
