import fs from 'node:fs/promises';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';

export type ProductoERP={code:string;hasImage:boolean;combinations:number;model:string;firstSeenAt:string|null};
export type CatalogoERP={schema:1;catalogId:string;updatedAt:string;revision:string;products:ProductoERP[]};
export function validarCatalogo(value: unknown): CatalogoERP {
  const c=value as CatalogoERP;
  if(!c||c.schema!==1||typeof c.catalogId!=="string"||typeof c.revision!=="string"||!Number.isFinite(Date.parse(c.updatedAt))||!Array.isArray(c.products)||c.products.length>50000)throw new Error("Catálogo ERP inválido");
  const seen=new Set<string>();
  for(const p of c.products){
    if(!p||typeof p.code!=="string"||!/^[A-Z0-9][A-Z0-9 ._-]{0,79}$/.test(p.code)||p.code.includes("..")||seen.has(p.code)||typeof p.hasImage!=="boolean"||!Number.isInteger(p.combinations)||p.combinations<1||typeof p.model!=="string"||(p.firstSeenAt!==null&&!Number.isFinite(Date.parse(p.firstSeenAt))))throw new Error("Producto ERP inválido o repetido");
    seen.add(p.code);
  }
  return c;
}
let cached: {catalog:CatalogoERP;checkedAt:number}|undefined;
export async function leerCatalogoERP(): Promise<{catalog:CatalogoERP;stale:boolean}|null> {
  if(!process.env.ERP_CATALOG_BUCKET&&!process.env.ERP_CATALOG_FILE)return null;
  if(cached&&Date.now()-cached.checkedAt<15000)return {catalog:cached.catalog,stale:Date.now()-Date.parse(cached.catalog.updatedAt)>600000};
  try {
    let bytes:Buffer;
    if(process.env.ERP_CATALOG_FILE){
      if(process.env.NODE_ENV==="production")throw new Error("El catálogo local es sólo para pruebas de desarrollo");
      bytes=await fs.readFile(process.env.ERP_CATALOG_FILE);
    }else{
      if(process.env.ERP_CATALOG_BUCKET===process.env.R2_BUCKET)throw new Error("El catálogo debe estar en un bucket privado separado");
      for(const name of ['ERP_CATALOG_ENDPOINT','ERP_CATALOG_ACCESS_KEY_ID','ERP_CATALOG_SECRET_ACCESS_KEY'])if(!process.env[name])throw new Error(`Falta ${name}`);
      const client=new S3Client({endpoint:process.env.ERP_CATALOG_ENDPOINT!,region:'auto',maxAttempts:1,credentials:{accessKeyId:process.env.ERP_CATALOG_ACCESS_KEY_ID!,secretAccessKey:process.env.ERP_CATALOG_SECRET_ACCESS_KEY!}});
      try{
        const response=await client.send(new GetObjectCommand({Bucket:process.env.ERP_CATALOG_BUCKET,Key:'catalogo/erp.json'}),{abortSignal:AbortSignal.timeout(8000)});
        if((response.ContentLength??0)>20000000)throw new Error('Catálogo demasiado grande');
        bytes=Buffer.from(await response.Body!.transformToByteArray());
      }finally{client.destroy();}
    }
    if(bytes.length>20000000)throw new Error('Catálogo demasiado grande');
    const catalog=validarCatalogo(JSON.parse(bytes.toString('utf8')));cached={catalog,checkedAt:Date.now()};
    return {catalog,stale:Date.now()-Date.parse(catalog.updatedAt)>600000};
  }catch{
    if(cached)return {catalog:cached.catalog,stale:true};
    throw new Error('No se pudo leer el catálogo ERP. Comprueba el bucket privado y las credenciales de lectura.');
  }
}
