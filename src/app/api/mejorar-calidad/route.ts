import { NextResponse } from "next/server";
import { asegurarServidor, BASE } from "@/lib/rembgDaemon";

export const runtime = "nodejs";

// Botón aparte "Mejorar calidad" — sube nitidez/resolución x2 con
// Real-ESRGAN (ver el bloque documentado en scripts/servidor_rembg.py para
// el modelo, de dónde sale, y por qué no es un paso automático: ~2.8-3s por
// clic (vs ~0.2s de quitar fondo) y puede aplanar un poco la textura fina
// si se usa sobre una foto que ya estaba nítida.

export async function POST(req: Request) {
  try {
    const { imagenBase64 } = await req.json();
    if (!imagenBase64) return NextResponse.json({ error: "Falta imagenBase64" }, { status: 400 });

    await asegurarServidor();

    const entrada = Buffer.from(imagenBase64, "base64");
    const resp = await fetch(`${BASE}/mejorar-calidad`, {
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
