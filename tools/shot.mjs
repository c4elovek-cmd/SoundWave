// Скриншот окна SoundWave встроенными средствами Electron.
// Запуск: pwsh -NoProfile -File tools/shot.js.ps1  (или node tools/shot.mjs)
import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const out = path.join(process.env.TEMP || ".", "soundwave-shot.png");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#121212",
    webPreferences: {
      preload: path.join(root, "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(root, "dist", "index.html"));
  await new Promise((r) => setTimeout(r, 2500));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log(`saved ${out}`);
  app.quit();
});
