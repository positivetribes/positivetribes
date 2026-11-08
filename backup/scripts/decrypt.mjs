// Restore step 1: decrypt and unzip a backup file into a SQL script.
//   npx wrangler r2 object get tribe-backups/hub/2026-11-08.sql.gz.enc --remote --file hub.enc
//   BACKUP_KEY=<key from paper> node scripts/decrypt.mjs hub.enc > hub.sql
// Restore step 2 (into a scratch or preview database first, never straight over production):
//   npx wrangler d1 execute <database> --remote --file hub.sql
import { readFileSync } from "node:fs";
import { decrypt, gunzip } from "../src/dump.js";

const [file] = process.argv.slice(2);
if (!file || !process.env.BACKUP_KEY) { console.error("Usage: BACKUP_KEY=... node scripts/decrypt.mjs <file.enc> > out.sql"); process.exit(1); }
process.stdout.write(await gunzip(await decrypt(new Uint8Array(readFileSync(file)), process.env.BACKUP_KEY)));
