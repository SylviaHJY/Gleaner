import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const viteUrl = "http://127.0.0.1:5173";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const electronBin = isWindows
  ? path.join(root, "node_modules", ".bin", "electron.cmd")
  : path.join(root, "node_modules", ".bin", "electron");

function spawnChild(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...env
    }
  });
}

async function waitForVite() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(viteUrl);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error("Vite dev server did not become ready in time.");
}

const vite = spawnChild(npmCommand, ["exec", "vite", "--", "--host", "127.0.0.1", "--port", "5173"]);

let electron;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

vite.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 0);
});

try {
  await waitForVite();
  electron = spawnChild(electronBin, ["."], {
    VITE_DEV_SERVER_URL: viteUrl,
    VOCAB_DESKTOP_DATA_DIR: path.join(root, ".local-data")
  });
  electron.on("exit", (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(error);
  shutdown(1);
}
