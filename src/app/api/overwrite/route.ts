import { NextResponse } from "next/server";
import { subirImagen } from "@/lib/r2";

export async function POST(req: Request) {
  try {
    const { key, imagenBase64 } = await req.json();
    if (!key || !imagenBase64) {
      return NextResponse.json({ error: "Faltan key o imagenBase64" }, { status: 400 });
    }
    const buffer = Buffer.from(imagenBase64, "base64");
    await subirImagen(key, buffer);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
