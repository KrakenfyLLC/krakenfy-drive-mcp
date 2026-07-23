import { authorize, SCOPES } from "./auth.js";
await authorize();
process.stderr.write(`Authorization saved with scopes:\n${SCOPES.join("\n")}\n`);
