import { claveProducto, esPngProducto } from "./imagen-producto";
import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

function env(nombre: string): string {
  const v = process.env[nombre];
  if (!v) throw new Error(`Falta ${nombre} en .env.local`);
  return v;
}

export const BUCKET = env("R2_BUCKET");
export const PUBLIC_URL = env("R2_PUBLIC_URL");

export const r2 = new S3Client({
  endpoint: env("R2_ENDPOINT"),
  region: "auto",
  credentials: {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  },
});

export type ObjetoGaleria = { key: string; url: string; size: number; lastModified: string | null };

// Lista solo PNG de productos en raíz (pagina sola, no expone cursor —
// para una galería de unos pocos miles de imágenes alcanza sobrado).
export async function listarTodos(): Promise<ObjetoGaleria[]> {
  const objetos: ObjetoGaleria[] = [];
  let continuationToken: string | undefined;
  do {
    const resp = await r2.send(
      new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: continuationToken, MaxKeys: 1000 })
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key || !esPngProducto(obj.Key)) continue;
      objetos.push({
        key: obj.Key,
        url: `${PUBLIC_URL}/${encodeURIComponent(obj.Key)}?v=${encodeURIComponent(obj.ETag ?? obj.LastModified?.toISOString() ?? "")}`,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
      });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  objetos.sort((a, b) => a.key.localeCompare(b.key));
  return objetos;
}

export async function subirImagen(key: string, buffer: Buffer): Promise<void> {
  key = claveProducto(key);
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
      // "immutable, max-age=31536000" asumía que estas imágenes nunca se
      // vuelven a tocar una vez subidas — ya no es cierto con el editor de
      // este proyecto, que sobrescribe la misma key. Con eso puesto,
      // Cloudflare/el navegador podían seguir sirviendo la versión vieja
      // por un año aunque el objeto ya hubiera cambiado.
      CacheControl: "public, max-age=300, must-revalidate",
    })
  );
}

export async function bajarImagen(key: string): Promise<Buffer> {
  const resp = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await resp.Body?.transformToByteArray();
  if (!bytes) throw new Error(`No se pudo leer ${key} de R2`);
  return Buffer.from(bytes);
}
