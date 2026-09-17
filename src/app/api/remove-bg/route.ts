import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";

export const runtime = "nodejs";

// Antes: un `python3 scripts/quitar_fondo.py` nuevo por cada clic — medido,
// ~7.7s por pedido, de los cuales 6.5s eran solo cargar el modelo a memoria
// (la inferencia en sí tarda ~0.16s). Ahora: un servidor Python persistente
// (scripts/servidor_rembg.py) que carga cada sesión una sola vez y la reusa
// — esta route solo lo arranca si no está corriendo y le reenvía el pedido.
const PUERTO = 8765;
const BASE = `http://127.0.0.1:${PUERTO}`;

let arrancando: Promise<void> | null = null;

async function estaVivo(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/salud`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function asegurarServidor(): Promise<void> {
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
      // vez!) con el primer pedido real de quitar fondo, no acá.
      for (let i = 0; i < 40; i++) {
        if (await estaVivo()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("El servidor de rembg no arrancó a tiempo (10s)");
    })();
    // Hay que olvidar la promesa tanto si falla como si tiene éxito: si solo
    // se resetea en el fallo, un arranque exitoso queda cacheado para
    // siempre, y si el proceso de rembg muere después (por ej. lo mata algo
    // externo) ningún pedido futuro vuelve a intentar levantarlo — cree que
    // "ya está arrancado" y falla al toque contra un proceso que no existe
    // (esto pasó de verdad al matar el daemon a mano para aplicar un cambio).
    arrancando.finally(() => {
      arrancando = null;
    });
  }
  await arrancando;
}

export async function POST(req: Request) {
  try {
    const { imagenBase64, modelo } = await req.json();
    if (!imagenBase64) return NextResponse.json({ error: "Falta imagenBase64" }, { status: 400 });

    await asegurarServidor();

    const MODELOS = ["isnet-general-use", "u2net"];
    const modeloFinal = MODELOS.includes(modelo) ? modelo : "isnet-general-use";

    const entrada = Buffer.from(imagenBase64, "base64");
    const resp = await fetch(`${BASE}/quitar-fondo?modelo=${modeloFinal}`, {
      method: "POST",
      body: entrada,
    });
    if (!resp.ok) throw new Error(await resp.text());

    const resultado = Buffer.from(await resp.arrayBuffer());
    return NextResponse.json({ imagenBase64: resultado.toString("base64") });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
