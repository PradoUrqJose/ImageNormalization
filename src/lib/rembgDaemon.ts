import { spawn } from "node:child_process";
import path from "node:path";

// Compartido por /api/remove-bg y /api/mejorar-calidad — ambos hablan con el
// mismo servidor Python persistente (scripts/servidor_rembg.py) en :8765.
// Antes esta lógica vivía duplicada solo en remove-bg/route.ts; se movió acá
// al agregar el segundo endpoint para no repetir (y volver a romper) el
// arreglo del bug de la promesa "envenenada" documentado abajo.
export const PUERTO = 8765;
export const BASE = `http://127.0.0.1:${PUERTO}`;

let arrancando: Promise<void> | null = null;

async function estaVivo(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/salud`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function asegurarServidor(): Promise<void> {
  if (await estaVivo()) return;
  if (!arrancando) {
    arrancando = (async () => {
      const script = path.join(process.cwd(), "scripts", "servidor_rembg.py");
      const proc = spawn("python3", [script, String(PUERTO)], {
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
      // El socket abre casi al toque; el modelo recién se carga (¡una sola
      // vez!) con el primer pedido real, no acá.
      for (let i = 0; i < 40; i++) {
        if (await estaVivo()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("El servidor de rembg no arrancó a tiempo (10s)");
    })();
    // Hay que olvidar la promesa tanto si falla como si tiene éxito: si solo
    // se resetea en el fallo, un arranque exitoso queda cacheado para
    // siempre, y si el proceso muere después ningún pedido futuro vuelve a
    // intentar levantarlo (esto pasó de verdad al matar el daemon a mano).
    arrancando.finally(() => {
      arrancando = null;
    });
  }
  await arrancando;
}
