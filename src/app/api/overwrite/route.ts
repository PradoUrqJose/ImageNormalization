import { NextResponse } from "next/server";
import { subirImagen } from "@/lib/r2";
import { claveProducto, validarPng, ErrorImagen } from "@/lib/imagen-producto";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const key = claveProducto(body.key);
    const buffer = await validarPng(body.imagenBase64);
    await subirImagen(key, buffer);
    // Guardar en R2 activa la detección del trabajador del VPS. No confirma SQL aquí.
    return NextResponse.json({ ok: true, key, erp: "deteccion_automatica" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) },
      { status: e instanceof ErrorImagen ? e.status : 500 });
  }
}
