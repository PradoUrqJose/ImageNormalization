import { NextResponse } from "next/server";
import { listarTodos } from "@/lib/r2";

export async function GET() {
  try {
    const objetos = await listarTodos();
    return NextResponse.json({ objetos });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
