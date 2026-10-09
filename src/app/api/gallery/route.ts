import { NextResponse } from "next/server";
import { listarTodos, PUBLIC_URL } from "@/lib/r2";
const codigosNuevos: string[] = [];
import {leerCatalogoERP} from "@/lib/catalogo-erp";

export async function GET() {
  try {
    const objetos = await listarTodos();
    const erp=await leerCatalogoERP();
    if(erp){
      const byCode=new Map(objetos.map(o=>[o.key.slice(0,-4).toUpperCase(),o]));
      const gallery=erp.catalog.products.map(p=>({...byCode.get(p.code),key:byCode.get(p.code)?.key??`${p.code}.png`,url:byCode.get(p.code)?.url??"",size:byCode.get(p.code)?.size??0,lastModified:byCode.get(p.code)?.lastModified??null,nuevo:!byCode.has(p.code),erpHasImage:p.hasImage,firstSeenAt:p.firstSeenAt,brands:p.brands??[],stock:p.stock??null}));
      return NextResponse.json({objetos:gallery,pendientes:[],publicUrl:PUBLIC_URL,source:"erp",catalogId:erp.catalog.catalogId,updatedAt:erp.catalog.updatedAt,stale:erp.stale},{headers:{'Cache-Control':'no-store'}});
    }
    // Códigos del Excel que todavía no tienen archivo en Cloudflare: la
    // galería los muestra en blanco para crearlos subiendo la imagen.
    const existentes = new Set(objetos.map((o) => o.key));
    const pendientes = (codigosNuevos as string[]).filter((c) => !existentes.has(`${c}.png`));
    return NextResponse.json({ objetos, pendientes, publicUrl: PUBLIC_URL,source:"r2" },{headers:{'Cache-Control':'no-store'}});
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
