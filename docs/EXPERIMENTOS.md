# Experimentos y decisiones

Registro de lo que se probó, con números, y de por qué se adoptó o descartó cada cosa.
Pruebas del 2026-09-16 al 2026-09-18 · Apple M5, macOS 27 · rembg 2.0.84 · onnxruntime 1.27.0.

**Casos de referencia** (fotos originales del catálogo), para repetir cualquier comparación:

| Código | Qué es | Por qué sirve |
|---|---|---|
| `022356-01` | Gorra Puma roja | Caso fácil; detecta regresiones |
| `EG4958` | Adidas Superstar blanca | Blanco sobre blanco moderado |
| `IE0927` | Adidas blanca | Blanco sobre blanco moderado |
| `JI2843` | Running blanco de malla | El más difícil (malla semitransparente) |
| `392291-03` | Puma caña alta blanca | Blanco sobre blanco extremo: RGB de la puntera ≈ (250,7 · 250,0 · 254,2) contra fondo (255,255,255) |

> **Regla aprendida:** comparar siempre **a resolución completa**. En una miniatura `isnet` parecía
> mejor que `u2net` en `392291-03`; a tamaño real era peor.

---

## 1. Modelos de quitar fondo

| Modelo | Peso | Resultado | Decisión |
|---|---|---|---|
| **u2net** | 168 MB | El mejor de los cuatro modelos comparados en los primeros 4 casos (técnica base); falla en la puntera de `392291-03` sin CLAHE (y ahí también fallaron los otros tres) | **Adoptado** (fue el del lote masivo de 3573 imágenes) |
| **isnet-general-use** | 170 MB | Falla fuerte en blanco sobre blanco *sin* CLAHE (`IE0927` casi transparente, `EG4958` con puntera fantasma). Con CLAHE el usuario lo reporta "increíble" en uso real (no está en la tabla de regresión, que se corrió con u2net) | **Adoptado** |
| u2netp | 4,5 MB | ~0,15–0,27 s en CPU, cerca de u2net en 3 de 4 casos; el usuario encontró un defecto en una zapatilla Puma | Descartado |
| silueta | 44 MB | ~0,2 s en CPU; el peor en `JI2843` (bordes con ruido) | Descartado |
| bria-rmbg | 977 MB | 14,2 s/img en CPU; compilación CoreML colgada | Descartado y borrado |
| birefnet-general | 928 MB (972 666 916 B) | 11,1 s/img en CPU; compilación CoreML colgada | Descartado y borrado |
| birefnet-general-lite | 214 MB (224 005 088 B) | 7–9 s/img en CPU; CoreML colgado > 2 min | Descartado (archivo aún en `~/.rembg/models/`, ver §5) |
| withoutbg | — | Es una **API en la nube**, no un modelo local | Descartado |
| dis_anime / dis_custom | — | Anime-específico / requiere pesos propios | No aplica |

Hechos verificados:

- `isnet-general-use` **ya corre a 1024×1024** (entrada fija `[1,3,1024,1024]` en el grafo ONNX).
  No existe en rembg una variante "isnet-dis" ni una versión a 320: la idea de "subir de 320 a
  1024" no aplica.
- **BiRefNet y CoreML:** además de colgarse con la configuración por defecto, forzar
  `MLComputeUnits=CPUAndGPU` (sin Neural Engine) tampoco lo evitó: la primera imagen tardó 15 s y
  `ANECompilerService` volvió a quedar al ~93–100 % de CPU. Hipótesis (no verificada): las
  operaciones del backbone Swin Transformer no compilan bien. Hacerlo funcionar exigiría
  reconvertir el modelo original con `coremltools` o correrlo con PyTorch+MPS: proyecto aparte,
  sin evidencia previa de que mejore *nuestras* fotos.

## 2. Técnicas de preprocesado / postprocesado

### CLAHE antes de la inferencia → **adoptada** (casilla "Mejorar contraste")

Problema: en blanco sobre blanco el objeto y el fondo difieren en ~5 de 255; los modelos no ven
el borde y dejan zonas semitransparentes ("fantasma").

Implementación (`servidor_rembg.py::quitar_fondo_con_clahe`): canal L de LAB, `clipLimit=2.0`,
`tileGridSize=(8,8)`; la **máscara** se calcula sobre la versión con contraste y se aplica al
**RGB de la foto original** (si se usara el color de la versión con CLAHE, el producto queda más
oscuro: promedio 153 → 144 en la zona del cuerpo).

Resultados (u2net, 5 casos de referencia, comparación visual a resolución completa):

- Sin regresión en la gorra roja; mejora clara en `IE0927`, `JI2843` y `392291-03`; en `EG4958`
  queda igual o algo más limpio.
- `JI2843` (el más difícil) queda mejor que con cualquier otro modelo probado, BiRefNet incluido.
- `392291-03`: píxeles con alfa intermedio (10–245) **16,8 % → 2,1 %**; píxeles casi opacos
  (alfa ≥ 250) **177 512 → 430 418** de 1 440 000.
- Costo: sin diferencia medible (0,9–1,0 s en CPU con u2net, antes y después).

### Guided filter sobre la máscara → **descartado**

`cv2.ximgproc.guidedFilter` (radio 8, eps 200, guía = foto en gris): sin mejora visible. Afina
bordes que ya tienen algo de señal, pero no puede recuperar una zona donde el modelo nunca tuvo
confianza.

## 3. Mejorar calidad: Real-ESRGAN x2 → **adoptado como botón manual**

- **Modelo elegido:** `SceneWorks/real-esrgan-onnx` → `real_esrgan_x2.onnx` (RRDBNet de 23
  bloques, opset 17, fp32, **forma dinámica** `[1,3,h,w]`, BSD-3-Clause, 67 073 434 B,
  sha256 `7115ba92…9002c`). Se procesa en mosaicos de 512 px con 16 px de solape.
- **Descartado:** la variante de Qualcomm (entrada fija de 128×128, habría que hacer mosaicos
  diminutos).
- **CoreML:** compila en 1,3 s (1022 de 1030 nodos soportados, 3 particiones) y **no se cuelga**:
  es una red puramente convolucional, a diferencia de BiRefNet.
- **Velocidad (foto 1000×1000 → 2000×2000):** CPU 32–35 s · CoreML 2,8–3,1 s.
- **Calidad con blur simulado** (gaussiano σ=1,8 + JPEG calidad 45): varianza del Laplaciano
  (nitidez) **3,5 → 76,1**; el original sin degradar tenía 96,4. Mejora visible en bordes y logo.
- **Riesgo confirmado:** sobre una foto **ya nítida** la métrica casi no cambia (96,4 → 93,0),
  pero al hacer zoom **se pierde la textura fina del tejido** (queda "plástica"). Por eso es un
  botón manual y no un paso automático.
- **No probado:** fotos borrosas *reales* del catálogo (solo blur simulado), el modelo x4, y la
  ruta con canal alfa (la función reescala el alfa con Lanczos y procesa solo el RGB, pero en la UI
  solo se probó con una imagen opaca).

## 4. Bugs encontrados y su causa

| Bug | Causa raíz | Arreglo |
|---|---|---|
| Quitar fondo tardaba ~7,7 s por clic | Un `python3` nuevo por clic recargaba el modelo (6,5 s) | Daemon persistente (`servidor_rembg.py`) → ~0,1–0,3 s |
| El pincel "restaurar" no hacía nada | rembg deja RGB = (0,0,0) en los píxeles con alfa 0 (medido: 100 %, incluso en la salida cruda en memoria) | Copia `originalRef` del color original, mantenida alineada en rotar/espejo/quitar fondo/mejorar calidad |
| La miniatura y el editor no se actualizaban tras sobrescribir | `Cache-Control: immutable, max-age=31536000` en objetos que cambian | `public, max-age=300, must-revalidate` + `?v=N` en miniaturas + caché del navegador actualizada al subir |
| Todos los pedidos fallaban al instante (`fetch failed`, ~5 ms) | Promesa de arranque del daemon "envenenada": (a) si fallaba quedaba rechazada para siempre; (b) si tenía éxito quedaba resuelta para siempre y no se relanzaba un daemon muerto | `arrancando.finally(() => arrancando = null)` en `src/lib/rembgDaemon.ts` |
| Mac muy caliente, `ANECompilerService` al 100 % durante 30+ min | Intentos de compilar BiRefNet para CoreML; el servicio es de root, sigue trabajando aunque se mate al cliente | `sudo kill -9 <PID>` (pasó 3 veces) |
| `mds`/`mds_stores` al 100 % | Spotlight indexando ~7,4 GB de archivos nuevos | `.metadata_never_index` en las carpetas de trabajo |

## 5. Qué quedó instalado y cómo borrarlo

| Qué | Dónde | Estado |
|---|---|---|
| rembg 2.0.84 (+ dependencias), onnxruntime 1.27.0 | pip global | **En uso** |
| opencv-contrib-python-headless 5.0.0.93 | pip global | En uso, pero **alcanza `opencv-python-headless`** (contrib fue solo para el guided filter). `pip3 uninstall opencv-contrib-python-headless && pip3 install opencv-python-headless` |
| `isnet-general-use` (170 MB), `u2net` (168 MB) | `~/.rembg/models/` | **En uso** |
| `birefnet-general-lite` (~214 MB), `silueta` (44 MB), `u2netp` (4,5 MB) | `~/.rembg/models/` | **Sobrantes de experimentos:** `rm -rf ~/.rembg/models/{birefnet-general-lite,silueta,u2netp}` |
| `real_esrgan_x2.onnx` (64 MB) | `~/.cache/real-esrgan/` | En uso (solo botón "Mejorar calidad") |
| Archivos `.metadata_never_index` (vacíos) | `~/.rembg`, `~/.cache/real-esrgan`, `~/Downloads/ImagenesU2net`, `~/Downloads/stock-imagenes-export`, `node_modules/` | Se borran para revertir |
| Scripts del lote masivo (descargar → quitar fondo u2net → estandarizar → subir a R2) y sus datos, 3,9 GB + 2,4 GB | `~/Downloads/stock-imagenes-export/`, `~/Downloads/ImagenesU2net/` | **Fuera del repo**, sin versionar |

## 6. Ideas pendientes, sin probar

- Limpiar sombras suaves de estudio (umbral de alfa sobre píxeles grisáceos).
- Probar CLAHE sobre los casos de la sombra y del ojal del talón (no se tenían los originales).
- Medir `isnet + CLAHE` contra `u2net + CLAHE` en los 5 casos (hoy solo hay opinión de uso).
- Enrutar por confianza: modelo rápido por defecto y un modelo más pesado solo para los casos
  problemáticos (habría que definir cómo detectarlos).
- BiRefNet vía PyTorch + MPS o reconvertido con `coremltools` (esfuerzo alto, beneficio no demostrado).
