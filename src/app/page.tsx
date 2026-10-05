"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Objeto = { key: string; url: string; size: number; lastModified: string | null };
type Buffer2D = { width: number; height: number; data: Uint8ClampedArray };

const RADIO_MIN = 8;
const RADIO_MAX = 120;
const HISTORIAL_MAX = 20;

type ModeloQuitarFondo = "isnet-general-use" | "u2net" | "birefnet" | "rmbg-2.0";

// Se probaron bria-rmbg y birefnet-general (~1GB, ~11-14s/imagen en CPU,
// CoreML no llegaba a compilar) — revertido, hacían sentir lento hasta a
// estos dos. Esos intentos dejaron el compilador de CoreML del sistema
// atascado (isnet/u2net tardaban 60s, y ANECompilerService quedó pegado al
// 100% de CPU). Tras matar ese proceso y confirmar que CoreML compila bien
// de nuevo (6-7s una sola vez), isnet/u2net vuelven a usar CoreML:
// ~0.1-0.3s por clic con el servidor persistente.
//
// 2026-10-05: birefnet y rmbg-2.0 vuelven, pero por otro camino — PyTorch +
// GPU (MPS) en un daemon aparte (scripts/servidor_torch.py), sin CoreML, así
// que no puede repetirse el cuelgue de ANECompilerService. ~1s por imagen;
// la primera vez tarda ~30-60s (descarga + carga). Para quitarlos: borrar
// estas dos entradas y seguir docs/MODELOS_PYTORCH.md.
//
// RMBG 2.0 oculto del botón (licencia CC BY-NC 4.0, no comercial): el
// backend y el daemon siguen intactos, solo se quitó la entrada de abajo.
// Para reactivarlo, agregar de nuevo { id: "rmbg-2.0", etiqueta: "RMBG 2.0",
// aviso: "..." }.
const MODELOS_QUITAR_FONDO: { id: ModeloQuitarFondo; etiqueta: string; aviso?: string }[] = [
  { id: "isnet-general-use", etiqueta: "isnet" },
  { id: "u2net", etiqueta: "u2net" },
  { id: "birefnet", etiqueta: "BiRefNet", aviso: "Modelo grande (MIT) — ~1s por imagen; el primer uso tarda ~30-60s en cargar" },
];

// lib.dom.d.ts reciente tipa ImageData con Uint8ClampedArray<ArrayBuffer>
// puntual; nuestros buffers son Uint8ClampedArray<ArrayBufferLike> genérico.
function comoImageData(b: Buffer2D): ImageData {
  return new ImageData(b.data as Uint8ClampedArray<ArrayBuffer>, b.width, b.height);
}

function clonarBuffer(b: Buffer2D): Buffer2D {
  return { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) };
}

function rotar90CW(b: Buffer2D): Buffer2D {
  const { width: w, height: h, data } = b;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const nx = h - 1 - y;
      const ny = x;
      const d = (ny * h + nx) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: h, height: w, data: out };
}

function espejoH(b: Buffer2D): Buffer2D {
  const { width: w, height: h, data } = b;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const nx = w - 1 - x;
      const d = (y * w + nx) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

// Mismo encuadre que scripts/estandarizar.py del batch: recorta al
// bounding box real del producto (alpha>10) y lo centra en un lienzo
// cuadrado con margen fijo — así una imagen editada a mano queda con la
// misma proporción visual que el resto del catálogo procesado en lote.
const TAM_ESTANDAR = 1600;
const MARGEN_ESTANDAR = 0.08;

type CajaAlpha = { x0: number; y0: number; x1: number; y1: number };

function calcularCajaAlpha(buf: Buffer2D): CajaAlpha | null {
  const { width, height, data } = buf;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++) {
    const filaBase = y * width;
    for (let x = 0; x < width; x++) {
      if (data[(filaBase + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// Recorta `buf` a `caja` y lo centra en un lienzo de `tam`x`tam` — se le
// puede pasar la caja calculada de OTRO buffer (el que sí tiene alpha) para
// aplicar exactamente el mismo recorte/escala/centrado a un segundo buffer
// (así originalRef queda alineado píxel a píxel con bufferRef).
function recortarYCentrar(buf: Buffer2D, caja: CajaAlpha, tam = TAM_ESTANDAR, margen = MARGEN_ESTANDAR): Buffer2D {
  const cropW = caja.x1 - caja.x0 + 1;
  const cropH = caja.y1 - caja.y0 + 1;
  const ladoUtil = tam * (1 - 2 * margen);
  const escala = ladoUtil / Math.max(cropW, cropH);
  const nuevoAncho = Math.max(1, Math.round(cropW * escala));
  const nuevoAlto = Math.max(1, Math.round(cropH * escala));

  const origen = document.createElement("canvas");
  origen.width = buf.width;
  origen.height = buf.height;
  origen.getContext("2d")!.putImageData(comoImageData(buf), 0, 0);

  const destino = document.createElement("canvas");
  destino.width = tam;
  destino.height = tam;
  const ctx = destino.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const offsetX = Math.round((tam - nuevoAncho) / 2);
  const offsetY = Math.round((tam - nuevoAlto) / 2);
  ctx.drawImage(origen, caja.x0, caja.y0, cropW, cropH, offsetX, offsetY, nuevoAncho, nuevoAlto);

  const imgData = ctx.getImageData(0, 0, tam, tam);
  return { width: tam, height: tam, data: new Uint8ClampedArray(imgData.data) };
}

// Reescala sin recortar — se usa para mantener originalRef alineado con
// bufferRef después de "Mejorar calidad" (que cambia el tamaño del buffer
// x2, pero originalRef solo necesita un resize simple, no pasar de nuevo
// por Real-ESRGAN).
function reescalarBuffer(buf: Buffer2D, nuevoAncho: number, nuevoAlto: number): Buffer2D {
  const origen = document.createElement("canvas");
  origen.width = buf.width;
  origen.height = buf.height;
  origen.getContext("2d")!.putImageData(comoImageData(buf), 0, 0);

  const destino = document.createElement("canvas");
  destino.width = nuevoAncho;
  destino.height = nuevoAlto;
  const ctx = destino.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(origen, 0, 0, buf.width, buf.height, 0, 0, nuevoAncho, nuevoAlto);

  const imgData = ctx.getImageData(0, 0, nuevoAncho, nuevoAlto);
  return { width: nuevoAncho, height: nuevoAlto, data: new Uint8ClampedArray(imgData.data) };
}

async function blobABuffer(blob: Blob): Promise<Buffer2D> {
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: new Uint8ClampedArray(imgData.data) };
}

function bufferABase64Png(b: Buffer2D): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = document.createElement("canvas");
    c.width = b.width;
    c.height = b.height;
    const ctx = c.getContext("2d")!;
    ctx.putImageData(comoImageData(b), 0, 0);
    c.toBlob((blob) => {
      if (!blob) return reject(new Error("No se pudo codificar el PNG"));
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }, "image/png");
  });
}

export default function Editor() {
  const [galeria, setGaleria] = useState<Objeto[]>([]);
  const [indice, setIndice] = useState<number>(-1);
  const [cargandoGaleria, setCargandoGaleria] = useState(true);
  const [cargandoAccion, setCargandoAccion] = useState<string | null>(null);
  const [claveActual, setClaveActual] = useState("");
  const [modoPincel, setModoPincel] = useState<"apagado" | "borrar" | "restaurar">("apagado");
  // Toggle "Mejorar contraste" (CLAHE) — probado 2026-09-17: arregla el
  // "fantasma" semi-transparente en objetos casi-blancos sobre fondo blanco
  // (ej. 392291-03) sin regresión en los demás casos. Se puede apagar acá
  // mismo si algún caso sale peor con esto activo; no requiere tocar código
  // en scripts/servidor_rembg.py (ese archivo respeta este flag por pedido).
  const [usarClahe, setUsarClahe] = useState(true);
  const [radioPincel, setRadioPincel] = useState(30);
  const [urlExterna, setUrlExterna] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bufferRef = useRef<Buffer2D | null>(null);
  // Copia del color tal cual se cargó (antes de "Quitar fondo"). rembg pone
  // en (0,0,0) el RGB de los píxeles que marca como fondo — no solo el alfa
  // — apenas corre, no recién al guardar. Por eso "restaurar" no puede sacar
  // el color del buffer actual una vez que el algoritmo ya lo destruyó: hay
  // que guardarlo aparte al cargar, y mantenerlo sincronizado si se rota o
  // se espeja, para poder devolverlo pixel a pixel.
  const originalRef = useRef<Buffer2D | null>(null);
  const historialRef = useRef<Buffer2D[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pintandoRef = useRef(false);
  const galeriaListRef = useRef<HTMLDivElement>(null);

  // Caché LRU de blobs ya bajados (para no re-pedir a R2 lo que ya se vio) +
  // token de petición (para ignorar respuestas que llegan tarde si el usuario
  // ya navegó a otra imagen — antes, al apretar flecha rápido, una respuesta
  // vieja podía pisar la imagen nueva y la navegación se sentía trabada).
  const cacheRef = useRef<Map<string, Blob>>(new Map());
  const tokenRef = useRef(0);
  const CACHE_MAX = 60;

  // Cache-busting para las miniaturas de la galería: son <img src={url pública}>
  // directo a Cloudflare, así que el navegador las cachea por URL — al
  // sobrescribir, el archivo cambia pero la URL no, y la miniatura vieja se
  // queda pegada. Cada key lleva un contador que se suma después de cada
  // sobrescritura y se agrega como query param para forzar el refetch.
  const [versiones, setVersiones] = useState<Record<string, number>>({});

  const cacheGet = useCallback((key: string): Blob | undefined => {
    const m = cacheRef.current;
    const v = m.get(key);
    if (v) {
      m.delete(key);
      m.set(key, v);
    }
    return v;
  }, []);

  const cacheSet = useCallback((key: string, blob: Blob) => {
    const m = cacheRef.current;
    m.delete(key);
    m.set(key, blob);
    while (m.size > CACHE_MAX) {
      const primero = m.keys().next().value;
      if (primero === undefined) break;
      m.delete(primero);
    }
  }, []);

  const obtenerBlob = useCallback(
    async (key: string): Promise<Blob> => {
      const cacheado = cacheGet(key);
      if (cacheado) return cacheado;
      const resp = await fetch(`/api/image?key=${encodeURIComponent(key)}`);
      if (!resp.ok) throw new Error(`No se pudo cargar ${key}`);
      const blob = await resp.blob();
      cacheSet(key, blob);
      return blob;
    },
    [cacheGet, cacheSet],
  );

  useEffect(() => {
    fetch("/api/gallery")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setGaleria(d.objetos);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setCargandoGaleria(false));
  }, []);

  const redibujar = useCallback(() => {
    const buf = bufferRef.current;
    const canvas = canvasRef.current;
    if (!buf || !canvas) return;
    canvas.width = buf.width;
    canvas.height = buf.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(comoImageData(buf), 0, 0);
  }, []);

  const guardarHistorial = useCallback(() => {
    if (!bufferRef.current) return;
    historialRef.current.push(clonarBuffer(bufferRef.current));
    if (historialRef.current.length > HISTORIAL_MAX) historialRef.current.shift();
  }, []);

  const deshacer = useCallback(() => {
    const anterior = historialRef.current.pop();
    if (!anterior) return;
    bufferRef.current = anterior;
    redibujar();
  }, [redibujar]);

  const cargarImagen = useCallback(
    async (blob: Blob, clave: string) => {
      const buf = await blobABuffer(blob);
      bufferRef.current = buf;
      originalRef.current = clonarBuffer(buf);
      historialRef.current = [];
      setClaveActual(clave);
      redibujar();
    },
    [redibujar],
  );

  const seleccionarIndice = useCallback(
    async (i: number) => {
      if (i < 0 || i >= galeria.length) return;
      const miToken = ++tokenRef.current;
      setIndice(i);
      setError(null);
      setMensaje(null);

      const obj = galeria[i];
      // Si ya está en caché no hay ni loading intermedio — se siente instantáneo.
      if (!cacheGet(obj.key)) setCargandoAccion("Cargando imagen…");

      try {
        const blob = await obtenerBlob(obj.key);
        if (tokenRef.current !== miToken) return; // el usuario ya navegó a otra imagen
        await cargarImagen(blob, obj.key.replace(/\.png$/, ""));
      } catch (e) {
        if (tokenRef.current === miToken) setError(String(e));
      } finally {
        if (tokenRef.current === miToken) setCargandoAccion(null);
      }

      // Precarga en segundo plano lo que probablemente sigue (siguiente
      // flecha), sin bloquear ni pisar la imagen que se está mostrando.
      for (const j of [i + 1, i - 1]) {
        if (j < 0 || j >= galeria.length) continue;
        const k = galeria[j].key;
        if (!cacheGet(k)) obtenerBlob(k).catch(() => {});
      }
    },
    [galeria, cargarImagen, cacheGet, obtenerBlob],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const activo = document.activeElement;
      if (activo && (activo.tagName === "INPUT" || activo.tagName === "TEXTAREA" || activo.tagName === "SELECT")) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        seleccionarIndice(Math.min(indice + 1, galeria.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        seleccionarIndice(Math.max(indice - 1, 0));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [indice, galeria.length, seleccionarIndice]);

  // Pegar una imagen del portapapeles (Cmd/Ctrl+V) directo al canvas — mismo
  // criterio que "Cargar enlace": mantiene el código universal actual en vez
  // de pedirlo de nuevo. Se ignora si el foco está en un campo de texto, para
  // no interferir con pegar texto normal ahí (ej. una URL).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const activo = document.activeElement;
      if (activo && (activo.tagName === "INPUT" || activo.tagName === "TEXTAREA")) return;

      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        e.preventDefault();
        setError(null);
        cargarImagen(blob, claveActual)
          .then(() => {
            setMensaje(claveActual ? `Imagen pegada del portapapeles para ${claveActual}.` : "Imagen pegada del portapapeles. Escribe el código universal antes de sobrescribir.");
          })
          .catch((err) => setError(String(err)));
        break;
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [cargarImagen, claveActual]);

  useEffect(() => {
    const el = galeriaListRef.current?.querySelector(`[data-idx="${indice}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [indice]);

  async function quitarFondo(modelo: ModeloQuitarFondo) {
    if (!bufferRef.current) return;
    guardarHistorial();
    const aviso = MODELOS_QUITAR_FONDO.find((m) => m.id === modelo)?.aviso;
    setCargandoAccion(`Quitando fondo (${modelo})…${aviso ? " la primera vez puede tardar ~30-60s" : ""}`);
    setError(null);
    try {
      const imagenBase64 = await bufferABase64Png(bufferRef.current);
      const resp = await fetch("/api/remove-bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagenBase64, modelo, clahe: usarClahe }),
      });
      const d = await resp.json();
      if (d.error) throw new Error(d.error);
      const blob = await (await fetch(`data:image/png;base64,${d.imagenBase64}`)).blob();
      let nuevo = await blobABuffer(blob);

      // Encuadre automático: recorta al producto real y lo centra en el
      // lienzo estándar (mismo criterio que el batch). Se aplica la MISMA
      // caja a originalRef (el color de respaldo para "restaurar") para que
      // los dos buffers sigan alineados píxel a píxel después del recorte.
      const caja = calcularCajaAlpha(nuevo);
      if (caja) {
        nuevo = recortarYCentrar(nuevo, caja);
        if (originalRef.current && originalRef.current.width === bufferRef.current.width && originalRef.current.height === bufferRef.current.height) {
          originalRef.current = recortarYCentrar(originalRef.current, caja);
        }
      }

      bufferRef.current = nuevo;
      redibujar();
      setMensaje(caja ? `Fondo removido con ${modelo} y encuadrado en ${TAM_ESTANDAR}×${TAM_ESTANDAR}.` : `Fondo removido con ${modelo} (sin contenido detectable para encuadrar).`);
    } catch (e) {
      historialRef.current.pop();
      setError(String(e));
    } finally {
      setCargandoAccion(null);
    }
  }

  // Botón aparte, no automático: sube nitidez/resolución x2 con Real-ESRGAN.
  // Probado 2026-09-17 — ayuda de verdad en fotos con blur/compresión leve
  // (~3s por clic, mucho más lento que quitar fondo), pero sobre una foto ya
  // nítida puede aplanar un poco la textura fina. Por eso queda como acción
  // manual que se usa solo cuando la foto lo amerita, no algo por defecto.
  async function mejorarCalidad() {
    if (!bufferRef.current) return;
    guardarHistorial();
    setCargandoAccion("Mejorando calidad (Real-ESRGAN)… esto puede tardar ~3s");
    setError(null);
    try {
      const imagenBase64 = await bufferABase64Png(bufferRef.current);
      const resp = await fetch("/api/mejorar-calidad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagenBase64 }),
      });
      const d = await resp.json();
      if (d.error) throw new Error(d.error);
      const blob = await (await fetch(`data:image/png;base64,${d.imagenBase64}`)).blob();
      const nuevo = await blobABuffer(blob);

      if (originalRef.current) {
        originalRef.current = reescalarBuffer(originalRef.current, nuevo.width, nuevo.height);
      }
      bufferRef.current = nuevo;
      redibujar();
      setMensaje(`Calidad mejorada con Real-ESRGAN (${nuevo.width}×${nuevo.height}).`);
    } catch (e) {
      historialRef.current.pop();
      setError(String(e));
    } finally {
      setCargandoAccion(null);
    }
  }

  function rotar() {
    if (!bufferRef.current) return;
    guardarHistorial();
    bufferRef.current = rotar90CW(bufferRef.current);
    if (originalRef.current) originalRef.current = rotar90CW(originalRef.current);
    redibujar();
  }

  function espejo() {
    if (!bufferRef.current) return;
    guardarHistorial();
    bufferRef.current = espejoH(bufferRef.current);
    if (originalRef.current) originalRef.current = espejoH(originalRef.current);
    redibujar();
  }

  function pintarEn(clientX: number, clientY: number) {
    const buf = bufferRef.current;
    const canvas = canvasRef.current;
    if (!buf || !canvas || modoPincel === "apagado") return;
    const rect = canvas.getBoundingClientRect();
    const escalaX = buf.width / rect.width;
    const escalaY = buf.height / rect.height;
    const cx = (clientX - rect.left) * escalaX;
    const cy = (clientY - rect.top) * escalaY;
    const r = radioPincel;
    const restaurando = modoPincel === "restaurar";
    // Para restaurar, el color sale del original guardado al cargar — el
    // buffer actual ya tiene (0,0,0) ahí si el fondo se quitó con rembg. Si
    // por algo no coincide en tamaño (no debería, se mantiene sincronizado
    // en rotar/espejo), se cae al comportamiento anterior en vez de romper.
    const original = originalRef.current;
    const usarOriginal = restaurando && original && original.width === buf.width && original.height === buf.height;

    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(buf.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(buf.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          const i = (y * buf.width + x) * 4;
          if (!restaurando) {
            buf.data[i + 3] = 0; // borrar: solo apaga el alfa, nunca toca el color
          } else if (usarOriginal) {
            buf.data[i] = original!.data[i];
            buf.data[i + 1] = original!.data[i + 1];
            buf.data[i + 2] = original!.data[i + 2];
            buf.data[i + 3] = 255;
          } else {
            buf.data[i + 3] = 255;
          }
        }
      }
    }
    redibujar();
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (modoPincel === "apagado") return;
    guardarHistorial();
    pintandoRef.current = true;
    pintarEn(e.clientX, e.clientY);
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!pintandoRef.current) return;
    pintarEn(e.clientX, e.clientY);
  }
  function onPointerUp() {
    pintandoRef.current = false;
  }

  async function cargarDesdeEnlace() {
    if (!urlExterna.trim()) return;
    setCargandoAccion("Bajando imagen del enlace…");
    setError(null);
    try {
      const resp = await fetch("/api/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlExterna.trim() }),
      });
      const d = await resp.json();
      if (d.error) throw new Error(d.error);
      const blob = await (await fetch(`data:${d.contentType};base64,${d.imagenBase64}`)).blob();
      // Mantiene el código universal y la selección de galería que ya
      // estaban puestos — el flujo real es: navegás, encontrás una falla,
      // pegás un enlace mejor para ESE mismo producto y sobrescribís. Solo
      // si no había nada seleccionado (carga de un producto nuevo) hace
      // falta escribir el código a mano.
      await cargarImagen(blob, claveActual);
      setMensaje(
        claveActual ? `Imagen cargada del enlace para ${claveActual}. Edítala y sobrescribe cuando esté lista.` : "Imagen cargada del enlace. Escribe el código universal antes de sobrescribir.",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setCargandoAccion(null);
    }
  }

  async function sobrescribirEnCloudflare() {
    if (!bufferRef.current) return;
    if (!claveActual.trim()) {
      setError("Falta el código universal (nombre de archivo) para guardar.");
      return;
    }
    setCargandoAccion("Subiendo a Cloudflare…");
    setError(null);
    try {
      const imagenBase64 = await bufferABase64Png(bufferRef.current);
      const key = `${claveActual.trim()}.png`;
      const resp = await fetch("/api/overwrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, imagenBase64 }),
      });
      const d = await resp.json();
      if (d.error) throw new Error(d.error);

      // Ya tenemos los bytes que se acaban de subir — actualizar nuestro
      // propio caché directo, sin red, para que un clic posterior en esta
      // misma imagen no muestre la versión vieja. Y subir la "versión" de
      // la miniatura para que la galería la vuelva a pedir en vez de usar
      // la que el navegador tenía cacheada por URL.
      const blobSubido = await (await fetch(`data:image/png;base64,${imagenBase64}`)).blob();
      cacheSet(key, blobSubido);
      setVersiones((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));

      setMensaje(`Sobrescrito en Cloudflare: ${key}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargandoAccion(null);
    }
  }

  const objetoActual = indice >= 0 ? galeria[indice] : null;

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      {/* Galería */}
      <aside className="w-64 shrink-0 border-r border-neutral-800 flex flex-col">
        <div className="p-3 border-b border-neutral-800 text-sm text-neutral-400">{cargandoGaleria ? "Cargando galería…" : `${galeria.length} imágenes en Cloudflare`}</div>
        <div ref={galeriaListRef} className="flex-1 overflow-y-auto">
          {galeria.map((obj, i) => (
            <button
              key={obj.key}
              data-idx={i}
              onClick={() => seleccionarIndice(i)}
              className={`flex items-center gap-2 w-full p-2 text-left border-b border-neutral-900 hover:bg-neutral-800 ${i === indice ? "bg-neutral-800 ring-1 ring-inset ring-blue-500" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={versiones[obj.key] ? `${obj.url}?v=${versiones[obj.key]}` : obj.url} alt={obj.key} className="w-10 h-10 object-contain bg-neutral-900 rounded shrink-0" loading="lazy" />
              <span className="text-xs truncate">{obj.key}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Editor */}
      <main className="flex-1 flex flex-col">
        <div className="border-b border-neutral-800">
          <div className="p-3 flex flex-wrap items-center gap-2">
            <button onClick={() => seleccionarIndice(indice - 1)} disabled={indice <= 0} className="btn">
              ◀
            </button>
            <button onClick={() => seleccionarIndice(indice + 1)} disabled={indice >= galeria.length - 1} className="btn">
              ▶
            </button>
            <span className="text-xs text-neutral-400 mr-2">{objetoActual ? `${indice + 1} / ${galeria.length}` : "sin selección"}</span>

            <div className="w-px h-6 bg-neutral-700 mx-1" />

            <span className="text-xs text-neutral-500 uppercase tracking-wide">Quitar fondo</span>
            {MODELOS_QUITAR_FONDO.map((m) => (
              <button key={m.id} onClick={() => quitarFondo(m.id)} className="btn" title={m.aviso}>
                {m.etiqueta}
              </button>
            ))}
            <label
              className="flex items-center gap-1 text-xs text-neutral-400 cursor-pointer select-none"
              title="Sube el contraste antes de detectar el fondo — ayuda en objetos casi blancos sobre fondo blanco. El color final sigue saliendo de la foto original, no se altera."
            >
              <input type="checkbox" checked={usarClahe} onChange={(e) => setUsarClahe(e.target.checked)} />
              Mejorar contraste
            </label>

            <div className="w-px h-6 bg-neutral-700 mx-1" />

            <span className="text-xs text-neutral-500 uppercase tracking-wide">Pincel</span>
            {(["apagado", "borrar", "restaurar"] as const).map((modo) => (
              <button key={modo} onClick={() => setModoPincel(modo)} className="btn" style={modoPincel === modo ? { background: "#1d4ed8", borderColor: "#1d4ed8" } : undefined}>
                {modo}
              </button>
            ))}
            <input type="range" min={RADIO_MIN} max={RADIO_MAX} value={radioPincel} onChange={(e) => setRadioPincel(Number(e.target.value))} className="w-28" />
            <span className="text-xs text-neutral-400">{radioPincel}px</span>

            {claveActual && (
              <a
                href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(claveActual)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn ml-auto text-blue-300 hover:text-blue-200"
                title="Buscar este código en Google Imágenes"
              >
                🔍 {claveActual}
              </a>
            )}
          </div>

          <div className="px-3 pb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500 uppercase tracking-wide">Tools</span>
            <button onClick={rotar} className="btn">
              Rotar 90°
            </button>
            <button onClick={espejo} className="btn">
              Espejo
            </button>
            <button onClick={deshacer} className="btn">
              Deshacer
            </button>

            <div className="w-px h-6 bg-neutral-700 mx-1" />

            <span className="text-xs text-neutral-500 uppercase tracking-wide">Calidad</span>
            <button onClick={mejorarCalidad} className="btn" title="Real-ESRGAN x2 — sube nitidez/resolución. Tarda ~3s por clic; úsalo solo en fotos que estén de verdad borrosas, no en todas.">
              Mejorar calidad <span className="text-neutral-500">(lento)</span>
            </button>
          </div>
        </div>

        {/* bg-[repeating-conic-gradient(#2a2a2a_0%_25%,#1a1a1a_0%_50%)] bg-[length:24px_24px] */}
        <div className="flex-1 overflow-auto flex items-center justify-center bg-green-400">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            className="max-w-full max-h-full"
            style={{ cursor: modoPincel === "apagado" ? "default" : "crosshair" }}
          />
        </div>

        <div className="p-3 border-t border-neutral-800 flex flex-wrap items-center gap-2">
          <input type="text" placeholder="https://... (cargar imagen desde un enlace)" value={urlExterna} onChange={(e) => setUrlExterna(e.target.value)} className="input flex-1 min-w-[240px]" />
          <button onClick={cargarDesdeEnlace} className="btn">
            Cargar enlace
          </button>
          <span className="text-xs text-neutral-500">o pega una imagen (⌘V)</span>

          <div className="w-px h-6 bg-neutral-700 mx-1" />

          <label className="text-xs text-neutral-400">Código universal:</label>
          <input type="text" value={claveActual} onChange={(e) => setClaveActual(e.target.value)} className="input w-48" />
          <button onClick={sobrescribirEnCloudflare} className="btn btn-primary">
            Sobrescribir en Cloudflare
          </button>
        </div>

        <div className="px-3 pb-2 min-h-[1.5rem] text-xs">
          {cargandoAccion && <span className="text-blue-400">{cargandoAccion}</span>}
          {mensaje && !cargandoAccion && <span className="text-green-400">{mensaje}</span>}
          {error && <span className="text-red-400">{error}</span>}
        </div>
      </main>

      <style jsx global>{`
        .btn {
          background: #262626;
          border: 1px solid #404040;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 12px;
          color: #e5e5e5;
          cursor: pointer;
        }
        .btn:hover {
          background: #333;
        }
        .btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .btn-primary {
          background: #1d4ed8;
          border-color: #1d4ed8;
        }
        .btn-primary:hover {
          background: #1e40af;
        }
        .input {
          background: #171717;
          border: 1px solid #404040;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 12px;
          color: #e5e5e5;
        }
      `}</style>
    </div>
  );
}
