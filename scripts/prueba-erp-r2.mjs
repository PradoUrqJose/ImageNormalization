import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import sharp from 'sharp';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=path.join(root,'.pruebas-temporales');await fs.mkdir(temp,{recursive:true});
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
await fs.writeFile(path.join(temp,'helper.mjs'),compile(await fs.readFile(path.join(root,'src/lib/imagen-producto.ts'),'utf8')));
await fs.writeFile(path.join(temp,'r2.mjs'),'export const saves=[];export async function subirImagen(key,bytes){saves.push({key,bytes});}');
const source=await fs.readFile(path.join(root,'src/app/api/overwrite/route.ts'),'utf8');
await fs.writeFile(path.join(temp,'route.mjs'),compile(source).replaceAll('"@/lib/r2"','"./r2.mjs"').replaceAll('"@/lib/imagen-producto"','"./helper.mjs"').replaceAll('"next/server"','"next/server.js"'));
try{
  const {claveProducto,validarPng}=await import(pathToFileURL(path.join(temp,'helper.mjs')));
  const {POST}=await import(pathToFileURL(path.join(temp,'route.mjs')));
  const {saves}=await import(pathToFileURL(path.join(temp,'r2.mjs')));
  assert.equal(claveProducto('id3886.PNG'),'ID3886.png');
  assert.equal(claveProducto('400497_07.png'),'400497-07.png');
  assert.equal(claveProducto('FPF 02092.png'),'FPF 02092.png');
  for(const key of ['historial/ID3886.png','plantillas/ID3886.png','../ID3886.png','C:\\foto.png','ID3886.webp','ID3886.png.png'])assert.throws(()=>claveProducto(key));
  const bytes=await sharp({create:{width:1600,height:1600,channels:4,background:{r:230,g:90,b:30,alpha:0.5}}}).png().toBuffer();
  assert.deepEqual(await validarPng(bytes.toString('base64')),bytes);
  await assert.rejects(()=>validarPng('no es imagen'));
  await assert.rejects(()=>validarPng((Buffer.alloc(8*1024*1024+1)).toString('base64')));
  const jpeg=await sharp(bytes).jpeg().toBuffer();await assert.rejects(()=>validarPng(jpeg.toString('base64')));
  const huge=await sharp({create:{width:5000,height:5000,channels:4,background:'#ffffff'}}).png().toBuffer();await assert.rejects(()=>validarPng(huge.toString('base64')));
  const response=await POST(new Request('http://localhost/api/overwrite',{method:'POST',body:JSON.stringify({key:'400497_07.png',imagenBase64:bytes.toString('base64')})}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,key:'400497-07.png',erp:'deteccion_automatica'});
  assert.equal(saves.length,1);assert.equal(saves[0].key,'400497-07.png');assert.deepEqual(saves[0].bytes,bytes);
  const invalid=await POST(new Request('http://localhost/api/overwrite',{method:'POST',body:JSON.stringify({key:'disenos/TEST.png',imagenBase64:bytes.toString('base64')})}));
  assert.equal(invalid.status,400);assert.equal(saves.length,1);
  console.log(JSON.stringify({state:'PRUEBAS_ERP_R2_APROBADAS',branch:process.argv[2],checks:17,realR2Writes:0,erpWrites:0,originalPngBytesPreserved:true}));
}finally{
  assert.equal(path.dirname(temp),root);await fs.rm(temp,{recursive:true,force:true});
}
