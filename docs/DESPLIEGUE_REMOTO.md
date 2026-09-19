# Correr esto sin la MacBook (recomendación)

**Estado:** propuesta. Nada de esto está implementado ni probado; los números de rendimiento son
los medidos en una Apple M5 y **no se pueden extrapolar** a un servidor sin medirlos allí.

## Qué ya es remoto y qué no

| Pieza | Dónde vive hoy | ¿Depende de la Mac? |
|---|---|---|
| Imágenes finales (3573 PNG) | Cloudflare R2 | **No** — el catálogo solo necesita sus URLs |
| Interfaz + rutas API (Next.js) | `localhost:3000` | Sí |
| Servicio de inferencia (`servidor_rembg.py`) | `127.0.0.1:8765`, acelerado con CoreML | Sí, y **CoreML solo existe en macOS** |

La Mac solo hace falta para **producir y corregir** imágenes. Si mañana nadie abre esta
herramienta, el catálogo sigue funcionando. Lo que se quiere mover es la comodidad de retocar
fotos nuevas o defectuosas desde cualquier lado.

## Recomendación

Separar en tres y empezar barato:

1. **R2:** sin cambios.
2. **UI + rutas API:** desplegar Next.js (Vercel encaja: ya usan Vercel para STOCK_SC) **con
   autenticación obligatoria** (ver "Seguridad").
3. **Inferencia:** empaquetar `servidor_rembg.py` en un **contenedor**.
   - **Fase 1 — CPU:** quitar fondo (isnet/u2net + CLAHE) en un contenedor pequeño siempre
     encendido. En la M5, solo CPU dio ~1 s (u2net) y ~1,7–2 s (isnet); en un servidor será
     distinto y hay que medirlo.
   - **Fase 2 — GPU, solo si "Mejorar calidad" se usa de verdad:** Real-ESRGAN tardó ~35 s en CPU
     (inaceptable) y ~3 s con CoreML. Necesita GPU: un endpoint serverless con escala a cero
     encaja con un uso esporádico. La ruta `/api/mejorar-calidad` ya está separada, así que puede
     apuntar a otro servicio sin tocar la UI.

Por qué no basta "copiar lo de la Mac": la velocidad de hoy viene de CoreML/Neural Engine. En
Linux esa aceleración no existe; hay que elegir CPU o GPU NVIDIA (`onnxruntime-gpu` + CUDA).

## Cambios de código necesarios

1. **`scripts/servidor_rembg.py`**
   - Hoy escucha solo en `127.0.0.1` y **sin autenticación**. Hacer configurables por variable de
     entorno: host/puerto, lista de providers de onnxruntime (`CPUExecutionProvider` /
     `CUDAExecutionProvider`) y la ruta del modelo de Real-ESRGAN.
   - Exigir `Authorization: Bearer <REMBG_TOKEN>` en los POST.
   - Sustituir `HTTPServer` (atiende un pedido a la vez) por un servidor de producción
     (p. ej. FastAPI + uvicorn) o, mínimo, `ThreadingHTTPServer`; escalar con más contenedores.
2. **`src/lib/rembgDaemon.ts`**: si existe `REMBG_URL`, usarla (con el token) y **no** hacer
   `spawn`; conservar el `spawn` solo para desarrollo local.
3. **No pasar imágenes por la función de la UI.** Hoy cada imagen viaja como JSON en base64
   (+33 %). Los hosts serverless suelen limitar el cuerpo de las peticiones (Vercel: alrededor de
   4,5 MB; verificar en la documentación vigente). Un PNG de la galería pesa ~0,8 MB y el
   resultado de "Mejorar calidad" (2000×2000) ~1,3 MB → ~1,7 MB en base64: cabe, pero sin margen
   para fotos grandes. Dos salidas:
   - que el **navegador llame directo** al servicio de inferencia (CORS + token de corta vida
     emitido por una ruta de Next), o
   - enviar **solo la clave de R2** y que el servicio lea y escriba en R2 él mismo; para imágenes
     pegadas o por enlace, subirlas antes a un prefijo temporal con URL prefirmada.
4. **Variables de entorno** en el host: las `R2_*` de `.env.example`, más `REMBG_URL` y
   `REMBG_TOKEN`.

## Seguridad (no negociable antes de exponerlo)

- `/api/overwrite` **sobrescribe objetos del bucket** y no tiene ninguna autenticación: hoy es
  seguro solo porque corre en `localhost`. Ponerlo en internet sin protección permitiría a
  cualquiera con la URL reemplazar el catálogo. Opciones: contraseña por middleware,
  Cloudflare Access delante de la app, o la autenticación de STOCK_SC si se integra allí.
- Token de R2 **limitado a ese bucket**; rotar las claves al pasar a producción.
- `REMBG_TOKEN` largo y aleatorio; el servicio de inferencia no debe quedar abierto.
- Nunca commitear `.env.local` (ya está ignorado; `.env.example` sí se versiona).

## Boceto de contenedor (NO PROBADO)

```dockerfile
FROM python:3.12-slim          # probado hasta hoy solo con Python 3.14 en macOS: validar
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt     # GPU: sustituir onnxruntime por onnxruntime-gpu

# Hornear los modelos en la imagen para no descargarlos en cada arranque en frío
RUN python -c "from rembg import new_session; [new_session(m, providers=['CPUExecutionProvider']) for m in ('isnet-general-use','u2net')]"
RUN mkdir -p /models \
 && curl -L https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx -o /models/real_esrgan_x2.onnx \
 && echo "7115ba92e8a1bfa63d68558ef006ef3d91273a068d321b1439f8bb1c9179002c  /models/real_esrgan_x2.onnx" | sha256sum -c -

COPY scripts/servidor_rembg.py .
# Requiere los cambios de la sección anterior (host 0.0.0.0, token, ruta del modelo por entorno)
CMD ["python", "servidor_rembg.py"]
```

## Dónde correr el servicio (a evaluar, sin precios verificados)

| Opción | Encaja para | Ojo |
|---|---|---|
| VPS o contenedor pequeño siempre encendido (Fly.io, Railway, Render, Hetzner, DigitalOcean…) | Quitar fondo en CPU (fase 1) | Sin arranque en frío; medir la velocidad real de su CPU |
| GPU serverless con escala a cero (Modal, RunPod Serverless, Replicate, Hugging Face Inference Endpoints…) | "Mejorar calidad" (fase 2) | Arranque en frío; onnxruntime-gpu/CUDA; pago por uso |
| GPU dedicada siempre encendida | Solo si el volumen lo justifica | Costo fijo |
| Servicios de cómputo de Cloudflare | No evaluado | No asumo soporte de onnxruntime ni de GPU |
| Dejar la Mac como servidor con un túnel | — | **No cumple** "sin la MacBook" |

## Plan por fases y criterios de aceptación

1. **Contenedor en local (Docker en la Mac), CPU.** Validar que rembg/onnxruntime en Linux dan las
   mismas máscaras. Correr los 5 casos de `docs/EXPERIMENTOS.md`; criterio: `392291-03` con
   CLAHE con ≈ 2 % de píxeles de alfa intermedio (referencia local: 2,1 %) y sin zonas fantasma
   visibles. CoreML puede calcular distinto (precisión reducida), así que hay que revalidar.
2. **Desplegar contenedor + UI** con autenticación. Medir la latencia real desde el navegador
   (subida + inferencia + bajada), no solo el tiempo del modelo.
3. **Decidir GPU para "Mejorar calidad"** con datos de uso y de costo reales.
4. **Lote masivo remoto:** el pipeline que produjo las 3573 imágenes (descargar → quitar fondo
   u2net → estandarizar → subir a R2) vive hoy en `~/Downloads/` de la Mac, sin versionar. Si
   van a entrar productos nuevos en volumen, versionarlo y ejecutarlo como job remoto.

## Desconocidos y riesgos

- **Velocidad de CPU en la nube:** no medida. Un vCPU compartido puede ser varias veces más lento
  que una M5.
- **Costos:** no estimados.
- **Licencias:** Real-ESRGAN es BSD-3-Clause (verificado); revisar las licencias de rembg y de
  los pesos de isnet/u2net antes de un uso comercial en producción.
- **Concurrencia:** el diseño actual atiende un pedido a la vez; con varios usuarios habrá cola.
