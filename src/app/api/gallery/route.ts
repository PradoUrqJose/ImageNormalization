import { NextResponse } from "next/server";
import { listarTodos, PUBLIC_URL } from "@/lib/r2";
import codigosNuevos from "@/data/codigos-nuevos.json";

export async function GET() {
  try {
    const objetos = await listarTodos();
    // Códigos del Excel que todavía no tienen archivo en Cloudflare: la
    // galería los muestra en blanco para crearlos subiendo la imagen.
    const existentes = new Set(objetos.map((o) => o.key));
    const pendientes = (codigosNuevos as string[]).filter((c) => !existentes.has(`${c}.png`));
    return NextResponse.json({ objetos, pendientes, publicUrl: PUBLIC_URL });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
