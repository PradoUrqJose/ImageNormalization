import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Lanzador del daemon PyTorch (scripts/servidor_torch.py, :8766) — BiRefNet y
// RMBG 2.0. Agregado el 2026-10-05; para quitarlo ver docs/MODELOS_PYTORCH.md.
// Es una copia deliberada de rembgDaemon.ts (y no una generalización) para
// que borrar esta función sea borrar un archivo, sin tocar el daemon de
// isnet/u2net. Mantiene el mismo arreglo de la promesa "envenenada".
export const PUERTO_TORCH = 8766;
export const BASE_TORCH = `http://127.0.0.1:${PUERTO_TORCH}`;
export const MODELOS_TORCH = ["birefnet", "rmbg-2.0"];

let arrancando: Promise<void> | null = null;

async function estaVivo(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_TORCH}/salud`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function asegurarServidorTorch(): Promise<void> {
  if (await estaVivo()) return;
  if (!arrancando) {
    arrancando = (async () => {
      const python = path.join(process.cwd(), "scripts", ".venv-torch", "bin", "python");
      if (!existsSync(python)) {
        throw new Error(
          "Falta el entorno de PyTorch (scripts/.venv-torch). Instalarlo con los pasos de docs/MODELOS_PYTORCH.md",
        );
      }
      const script = path.join(process.cwd(), "scripts", "servidor_torch.py");
      const proc = spawn(python, [script, String(PUERTO_TORCH)], {
        detached: true,
        stdio: "ignore",
        // HF_TOKEN (solo para RMBG 2.0) llega desde .env.local vía process.env.
        env: {
          ...process.env,
          HF_HOME: path.join(os.homedir(), ".cache", "estandarizacion-torch", "huggingface"),
          PYTORCH_ENABLE_MPS_FALLBACK: "1",
        },
      });
      proc.unref();
      for (let i = 0; i < 40; i++) {
        if (await estaVivo()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("El servidor de PyTorch no arrancó a tiempo (10s)");
    })();
    arrancando.finally(() => {
      arrancando = null;
    });
  }
  await arrancando;
}
