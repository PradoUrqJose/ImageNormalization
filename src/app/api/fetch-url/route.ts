import { NextResponse } from "next/server";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "Falta url" }, { status: 400 });

    const resp = await fetch(url, { headers: { "User-Agent": UA, Referer: url } });
    if (!resp.ok) return NextResponse.json({ error: `HTTP ${resp.status} al bajar la imagen` }, { status: 400 });

    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get("content-type") ?? "image/jpeg";
    return NextResponse.json({ imagenBase64: buffer.toString("base64"), contentType });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
