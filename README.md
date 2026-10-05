# Estandarización de Imágenes

Editor web local para dejar las fotos de producto del catálogo de Sportcenter Peru como
**PNG transparentes, centrados y con el mismo encuadre**, y guardarlas en Cloudflare R2.

## La idea (por qué existe)

Marketing necesita generar catálogos con su propio diseño. Los datos (código, tallas, stock,
precios) salen del ERP, pero las fotos del ERP/STOCK_SC tienen fondo y tamaños dispares: puestas
sobre un diseño se ven mal. Solución:

1. Todas las fotos se procesan **una vez**: se quita el fondo, se recorta al producto real y se
   centra en un lienzo de **1600×1600** con **8 % de margen**.
2. Se guardan en Cloudflare R2 con nombre `<CODIGO_UNIVERSAL>.png`. Así la URL de cualquier
   producto es predecible (`<R2_PUBLIC_URL>/<CODIGO>.png`) y el generador de catálogos **no
   necesita llamar a ninguna API para obtener imágenes**, solo armar la URL.
3. El quitado de fondo automático no es perfecto (sobre todo en blanco sobre blanco), así que esta
   herramienta permite **revisar y corregir una por una** las 3573 imágenes: reintentar con otro
   modelo, pintar/borrar a mano, reemplazar la foto por otra mejor, y sobrescribir en R2.

Esta herramienta es de **back-office**: el catálogo en sí solo depende de R2, no de esta app.
Está pensada para correr en local (en una Mac con Apple Silicon; en Windows + NVIDIA ver
[docs/WINDOWS_CUDA.md](docs/WINDOWS_CUDA.md), rama `windows-cuda`); para llevarla a un
servidor ver [docs/DESPLIEGUE_REMOTO.md](docs/DESPLIEGUE_REMOTO.md).

## Qué hace

- **Galería** de todo el bucket (3573 imágenes) con navegación por flechas del teclado.
- **Quitar fondo** con dos modelos a elegir: `isnet` (`isnet-general-use`) y `u2net`. Después de
  cada corrida **encuadra automáticamente** (recorte al contenido + centrado 1600×1600, margen 8 %).
- **Mejorar contraste (CLAHE)**, casilla activada por defecto: sube el contraste local *antes* de
  detectar el fondo. Arregla el "fantasma" semitransparente en objetos casi blancos sobre fondo
  blanco. El color final sale siempre de la foto original.
- **Mejorar calidad (Real-ESRGAN x2)**, botón aparte y manual: afila fotos borrosas o muy
  comprimidas y duplica la resolución. ~3 s por clic. Ver limitaciones.
- **Pincel** borrar / restaurar (el restaurar trae el color de la foto original).
- **Rotar 90°**, **Espejo**, **Deshacer** (20 pasos).
- **Cargar enlace** y **pegar del portapapeles (⌘V)**: reemplazan la foto conservando el código
  universal de la imagen seleccionada.
- **Sobrescribir en Cloudflare**: sube el PNG a R2 con el código universal indicado.

## Arquitectura

```
Navegador (src/app/page.tsx — canvas RGBA en memoria, historial, encuadre)
   │  fetch JSON (imagen en base64)
Next.js API routes (src/app/api/*)
   ├─ gallery, image, fetch-url, overwrite ──► Cloudflare R2 (S3 API, src/lib/r2.ts)
   └─ remove-bg, mejorar-calidad ──► HTTP 127.0.0.1:8765
                                       │
scripts/servidor_rembg.py  (daemon Python persistente, un solo proceso)
   ├─ POST /quitar-fondo?modelo=isnet-general-use|u2net&clahe=1|0   (rembg + onnxruntime + OpenCV)
   ├─ POST /mejorar-calidad                                        (Real-ESRGAN x2, onnxruntime)
   └─ GET  /salud

scripts/servidor_torch.py  (daemon PyTorch aparte, :8766, venv propio — ver docs/MODELOS_PYTORCH.md)
   └─ POST /quitar-fondo?modelo=birefnet|rmbg-2.0&clahe=1|0         (PyTorch + GPU/MPS, sin CoreML)
```

- **Por qué un daemon:** lanzar un `python3` por clic recargaba el modelo cada vez (~7,7 s por
  clic medidos, 6,5 s solo en cargar). El daemon carga cada modelo una vez y lo reutiliza:
  ~0,1–0,3 s por clic con CoreML. `src/lib/rembgDaemon.ts` lo arranca solo si no está vivo.
- **Aceleración:** onnxruntime con `CoreMLExecutionProvider` (Apple Neural Engine / GPU) y
  `CPUExecutionProvider` de respaldo.
- **El encuadre y el pincel viven en el navegador** (`page.tsx`): `calcularCajaAlpha` (umbral
  alfa > 10), `recortarYCentrar`, y un `originalRef` (copia del color original) que sirve al
  pincel "restaurar" — necesario porque rembg pone RGB = (0,0,0) en los píxeles transparentes.
- Cache: LRU de imágenes en el navegador + parámetro `?v=N` para refrescar miniaturas tras
  sobrescribir; los PNG se suben a R2 con `Cache-Control: public, max-age=300, must-revalidate`.

## Instalación (macOS Apple Silicon)

Requisitos: Node 25, Python 3.14 (probado), cuenta y bucket de Cloudflare R2.

```bash
npm install
pip3 install -r scripts/requirements.txt
cp .env.example .env.local        # completar las credenciales de R2
```

Modelos de quitar fondo (`isnet-general-use`, `u2net`): los descarga rembg solo, la primera vez
que se usan, en `~/.rembg/models/` (~170 MB c/u).

Modelo de **Mejorar calidad** (opcional, 67 MB, licencia BSD-3-Clause):

```bash
mkdir -p ~/.cache/real-esrgan
curl -L https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx \
     -o ~/.cache/real-esrgan/real_esrgan_x2.onnx
shasum -a 256 ~/.cache/real-esrgan/real_esrgan_x2.onnx
# esperado: 7115ba92e8a1bfa63d68558ef006ef3d91273a068d321b1439f8bb1c9179002c
```

## Uso

```bash
npm run dev          # http://localhost:3000
```

No hace falta arrancar el daemon: se levanta solo con el primer clic en "Quitar fondo" o
"Mejorar calidad". **La primera vez tras arrancarlo tarda ~6–8 s** (compila el modelo para
CoreML una sola vez); después ~0,2 s. Para pararlo: `pkill -f servidor_rembg.py`.

Flujo típico: elegir imagen en la galería → *Quitar fondo* (isnet o u2net) → retocar con el
pincel si hace falta → *Sobrescribir en Cloudflare*. Para una foto borrosa: *Mejorar calidad*
**antes** de quitar el fondo.

## Rendimiento medido (Apple M5)

| Operación | CPU sola | CoreML |
|---|---|---|
| Quitar fondo `u2net` | ~1,0 s | ~0,1 s |
| Quitar fondo `isnet` | ~1,7–2,0 s | ~0,2 s |
| Mejorar calidad (Real-ESRGAN x2, foto 1000×1000) | ~35 s | ~2,8–3 s |
| Primera petición tras arrancar el daemon | — | ~6–8 s (compilación única) |

## Limitaciones conocidas (sin resolver)

- **Sombras suaves de estudio:** a veces `u2net` deja la sombra pegada bajo la suela. No se
  probó ninguna solución (ideas: umbral de alfa más agresivo sobre píxeles grises, o limpiarlo
  con el pincel).
- **Agujeros dentro de piezas finas** (p. ej. el ojal del talón de una zapatilla) no siempre se
  recortan: es un problema de topología de la máscara, no de contraste. CLAHE no se probó ahí.
- **Mejorar calidad no es gratis:** sobre una foto ya nítida puede aplanar la textura fina (tejido
  de una gorra). Úsalo solo en fotos realmente borrosas. Un desenfoque de movimiento o de foco
  fuerte no se recupera con este tipo de modelo.
- El daemon (`HTTPServer` estándar) atiende **un pedido a la vez**: suficiente para un usuario.
- Sin autenticación: solo debe correr en `localhost`.

## Cómo revertir un cambio

Cada mejora está aislada y marcada en el código:

- **CLAHE:** desmarcar "Mejorar contraste" en la barra (por imagen, sin tocar código). Para
  quitarlo del todo: función `quitar_fondo_con_clahe` y parámetro `clahe` en `servidor_rembg.py`,
  estado `usarClahe` y la casilla en `page.tsx`, campo `clahe` en `api/remove-bg/route.ts`.
- **Mejorar calidad:** borrar el bloque `--- "Mejorar calidad" ---` de `servidor_rembg.py`, la
  carpeta `src/app/api/mejorar-calidad/`, y `mejorarCalidad()` + el botón en `page.tsx`; después
  `rm -rf ~/.cache/real-esrgan`.
- **BiRefNet / RMBG 2.0:** pasos completos (liberar disco o quitar todo el código) en
  [docs/MODELOS_PYTORCH.md](docs/MODELOS_PYTORCH.md#desinstalar--deshacer).
- **Volver a una versión anterior:** `git log --oneline` y `git checkout <commit>`; ver etiquetas
  con `git tag`.

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| La Mac se calienta y un proceso `ANECompilerService` está al ~100 % de CPU | El compilador de CoreML quedó atascado (pasó al probar modelos grandes). Matarlo: `sudo kill -9 <PID>` (es de root; macOS lo relanza solo). |
| `mds` / `mds_stores` al 100 % tras bajar modelos o imágenes | Spotlight reindexando. Se excluyeron las carpetas de trabajo con un archivo vacío `.metadata_never_index` (borrarlo lo revierte). |
| Todos los "Quitar fondo" fallan al instante con `fetch failed` | El daemon murió y Next creía que seguía vivo. Ya corregido en `rembgDaemon.ts` (la promesa de arranque se descarta al terminar); si reaparece, reiniciar `npm run dev`. |
| "Falta el modelo de Real-ESRGAN" | Falta descargar `real_esrgan_x2.onnx` (ver Instalación). |

## Estructura

```
src/app/page.tsx                  UI completa: galería, canvas, herramientas, encuadre
src/app/api/{gallery,image,fetch-url,overwrite}/   acceso a R2 y descarga de enlaces
src/app/api/remove-bg/            → daemon /quitar-fondo
src/app/api/mejorar-calidad/      → daemon /mejorar-calidad
src/lib/r2.ts                     cliente S3 de R2
src/lib/rembgDaemon.ts            arranque y health-check del daemon
scripts/servidor_rembg.py         daemon de inferencia (rembg, CLAHE, Real-ESRGAN)
scripts/requirements.txt          dependencias Python
scripts/quitar_fondo.py           LEGADO: esquema viejo (un proceso por clic). No se usa; se puede borrar.
docs/EXPERIMENTOS.md              qué se probó, con números, y por qué se descartó lo que se descartó
docs/DESPLIEGUE_REMOTO.md         cómo correr esto sin la MacBook
docs/MODELOS_PYTORCH.md           BiRefNet + RMBG 2.0: instalar, licencias, desinstalar
scripts/servidor_torch.py         daemon PyTorch (BiRefNet, RMBG 2.0) — venv en scripts/.venv-torch
src/lib/torchDaemon.ts            arranque del daemon PyTorch
```

## Documentación relacionada

- [docs/EXPERIMENTOS.md](docs/EXPERIMENTOS.md) — comparativas de modelos, técnicas descartadas, bugs y su causa.
- [docs/DESPLIEGUE_REMOTO.md](docs/DESPLIEGUE_REMOTO.md) — recomendación para dejar de depender de la Mac.
