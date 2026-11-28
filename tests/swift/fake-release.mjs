#!/usr/bin/env node
// Release finta di GitHub per provare l'aggiornamento in-app senza rete (vedi COUNCIL_UPDATE_API in CLAUDE.md).
// Uso: node tests/swift/fake-release.mjs <porta> [file.dmg] [versione] [KB/s]
//   senza DMG serve 60 MB casuali: il download dura abbastanza per premere ⌘Q a metà (la verifica poi
//   fallirebbe su hdiutil, mai sull'SHA256); con un DMG vero di `scripts/make-dmg.sh` si prova anche
//   l'installazione. App: COUNCIL_DATA=<tmp> COUNCIL_UPDATE_API=http://127.0.0.1:<porta>/latest
// Ascolta solo su 127.0.0.1. Non usa dati reali.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch } from "node:os";

const port = Number(process.argv[2] ?? 4995);
const dmgPath = process.argv[3] && process.argv[3] !== "-" ? process.argv[3] : null;
const version = process.argv[4] ?? "99.0.0";
const rate = Number(process.argv[5] ?? 1024) * 1024; // byte al secondo
const dmg = dmgPath ? readFileSync(dmgPath) : randomBytes(60 * 1024 * 1024);
const name = `Conclave-${version}-${arch() === "arm64" ? "apple-silicon" : "intel"}.dmg`;
const sums = `${createHash("sha256").update(dmg).digest("hex")}  ${name}\n`;
const base = `http://127.0.0.1:${port}`;

const server = createServer((req, res) => {
  const log = (code) => console.log(`${req.method} ${req.url} → ${code}`);
  if (req.url === "/latest") {
    log(200);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      tag_name: `v${version}`, html_url: `${base}/page`, body: "Release finta per le prove.",
      assets: [
        { name, browser_download_url: `${base}/${name}` },
        { name: "SHA256SUMS.txt", browser_download_url: `${base}/SHA256SUMS.txt` },
      ],
    }));
  } else if (req.url === "/SHA256SUMS.txt") {
    log(200);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(sums);
  } else if (req.url === `/${name}`) {
    log(200);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": dmg.length });
    // A pezzi da 1/10 del ritmo ogni 100 ms: il download dura dmg.length / rate secondi.
    const chunk = Math.max(1, Math.floor(rate / 10));
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); console.log("download interrotto dal client"); return; }
      const end = Math.min(sent + chunk, dmg.length);
      res.write(dmg.subarray(sent, end));
      sent = end;
      if (sent >= dmg.length) { clearInterval(timer); res.end(); console.log("download completato"); }
    }, 100);
    res.on("close", () => clearInterval(timer));
  } else {
    log(404);
    res.writeHead(404).end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`release finta ${version} su ${base}/latest (${name}, ${dmg.length} byte, ${rate} B/s)`));
