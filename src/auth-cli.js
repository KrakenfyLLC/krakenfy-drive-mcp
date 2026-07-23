import { authorize, SCOPES } from "./auth.js";
await authorize();
process.stderr.write(`Autorización guardada con scopes:\n${SCOPES.join("\n")}\n`);
