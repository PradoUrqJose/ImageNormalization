import { NextResponse } from "next/server";
import { PUBLIC_URL } from "@/lib/r2";

// Proxy same-origin: cargar la imagen directo desde la URL pública de R2 en
// un <canvas> lo "mancha" (CORS) y getImageData() tira SecurityError. Al
// pasar por nuestro propio origen, el canvas queda limpio para editar píxel
// a píxel (pincel, rotar, espejo).
//
// Antes pegaba a R2 vía S3 GetObject (sin pasar por el CDN de Cloudflare) y
// con Cache-Control: no-store — cada vez que volvías a una imagen ya vista
// se volvía a bajar entera. Ahora usa la URL pública (que sí cachea Cloudflare)
// y deja que el navegador cachee/revalide, que es lo que hace la navegación
// rápida entre productos.
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "Falta key" }, { status: 400 });
  try {
    const origen = await fetch(`${PUBLIC_URL}/${key}`, { cache: "no-store" });
    if (!origen.ok) return NextResponse.json({ error: `R2 respondió ${origen.status}` }, { status: 502 });
    const buffer = await origen.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=60, must-revalidate",
        ETag: origen.headers.get("etag") ?? "",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
