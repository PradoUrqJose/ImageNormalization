import { NextResponse } from "next/server";
import { asegurarServidor, BASE } from "@/lib/rembgDaemon";

export const runtime = "nodejs";

// Antes: un `python3 scripts/quitar_fondo.py` nuevo por cada clic — medido,
// ~7.7s por pedido, de los cuales 6.5s eran solo cargar el modelo a memoria
// (la inferencia en sí tarda ~0.16s). Ahora: un servidor Python persistente
// (scripts/servidor_rembg.py) que carga cada sesión una sola vez y la reusa
// — esta route solo lo arranca si no está corriendo y le reenvía el pedido.
// El arranque/health-check del daemon vive en src/lib/rembgDaemon.ts,
// compartido con /api/mejorar-calidad (mismo proceso, dos endpoints).

export async function POST(req: Request) {
  try {
    const { imagenBase64, modelo, clahe } = await req.json();
    if (!imagenBase64) return NextResponse.json({ error: "Falta imagenBase64" }, { status: 400 });

    await asegurarServidor();

    const MODELOS = ["isnet-general-use", "u2net"];
    const modeloFinal = MODELOS.includes(modelo) ? modelo : "isnet-general-use";
    // Toggle "Mejorar contraste" del editor — ver servidor_rembg.py para el
    // porqué (ayuda mucho en objetos blancos sobre fondo blanco). Default
    // encendido: activo salvo que el caller mande clahe:false explícito.
    const claheFinal = clahe === false ? "0" : "1";

    const entrada = Buffer.from(imagenBase64, "base64");
    const resp = await fetch(`${BASE}/quitar-fondo?modelo=${modeloFinal}&clahe=${claheFinal}`, {
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
