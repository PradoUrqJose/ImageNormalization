import sharp, { type Metadata } from "sharp";

export class ErrorImagen extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function claveProducto(key: unknown): string {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\.png$/i.test(key) || key.includes("..")) {
    throw new ErrorImagen("Usa CODIGO.png en la raíz, sin carpetas");
  }
  let code = key.slice(0, -4).replace(/[\t\r\n]/g, "").trim().toUpperCase();
  if (!code || /\.PNG$/.test(code)) throw new ErrorImagen("Escribe el código universal sin repetir la extensión");
  if (code === "400497_07") code = "400497-07";
  return `${code}.png`;
}
export function esPngProducto(key: string): boolean {
  try { claveProducto(key); return true; } catch { return false; }
}
export async function validarPng(imagenBase64: unknown): Promise<Buffer> {
  if (typeof imagenBase64 !== "string" || !imagenBase64 || imagenBase64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) {
    throw new ErrorImagen("El PNG debe pesar como máximo 8 MiB", 413);
  }
  const bytes = Buffer.from(imagenBase64, "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new ErrorImagen("PNG vacío o demasiado grande", 413);
  let meta: Metadata;
  try { meta = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata(); }
  catch { throw new ErrorImagen("Imagen inválida o supera 16 millones de píxeles", 422); }
  if (meta.format !== "png") throw new ErrorImagen("La imagen guardada debe ser PNG", 422);
  // Sin recomprimir: se mantienen los píxeles y el alfa generados por el editor.
  return bytes;
}
