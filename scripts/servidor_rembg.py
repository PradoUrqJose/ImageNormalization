"""
Servidor local persistente para /api/remove-bg. Reemplaza el esquema
anterior (un subproceso `python3` nuevo por cada clic, que pagaba ~6.5s de
carga de modelo cada vez) — este proceso queda corriendo de fondo, carga
cada sesión (isnet-general-use, u2net) una sola vez, la primera vez que se
pide, y la reusa para todos los pedidos siguientes mientras siga vivo. Así
"Quitar fondo" pasa de ~7.7s a ~0.2s por clic (con el modelo ya en memoria),
sin cambiar el modelo ni la calidad del resultado.

/api/remove-bg lo arranca solo si no lo encuentra corriendo — no hace falta
lanzarlo a mano. Para pararlo: pkill -f servidor_rembg.py

Uso: python3 servidor_rembg.py [puerto]   (default 8765)
"""
import io
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image
from rembg import new_session, remove

# Se probaron bria-rmbg y birefnet-general (~1GB cada uno) como alternativas
# — se revirtió: en CPU tardaban 11-14s/imagen, y con CoreML la compilación
# de un modelo tan grande se quedaba colgada varios minutos. Esos intentos
# (varios, interrumpidos a la fuerza) dejaron el compilador de CoreML del
# sistema con un cuello de botella — después de eso, hasta isnet/u2net (que
# antes compilaban rápido) tardaron 60s en un pedido, y el proceso
# ANECompilerService quedó atascado al 100% de CPU (calentando la máquina)
# hasta matarlo a mano. Se probaron ambos otra vez en aislado tras matar ese
# proceso: compilan bien (6-7s, una sola vez) y vuelven a la velocidad
# original (~0.1-0.3s/imagen), así que se restaura CoreML acá.
MODELOS_PERMITIDOS = ("isnet-general-use", "u2net")


def _elegir_proveedores() -> list[str]:
    """CUDA (PC con NVIDIA) > CoreML (Mac) > CPU. En Windows/Linux, las DLL de
    CUDA/cuDNN las trae PyTorch dentro del mismo venv: preload_dlls() las carga
    desde ahí, así no hace falta instalar el CUDA Toolkit aparte."""
    try:
        ort.preload_dlls()
    except Exception as e:  # noqa: BLE001 — sin GPU o sin DLLs: se sigue con lo que haya
        print(f"preload_dlls: {e}", file=sys.stderr)
    disponibles = ort.get_available_providers()
    elegidos = [p for p in ("CUDAExecutionProvider", "CoreMLExecutionProvider") if p in disponibles]
    return elegidos + ["CPUExecutionProvider"]


PROVEEDORES = _elegir_proveedores()
print(f"onnxruntime {ort.__version__}, proveedores: {PROVEEDORES}", file=sys.stderr)
sesiones: dict[str, object] = {}


def obtener_sesion(modelo: str):
    if modelo not in MODELOS_PERMITIDOS:
        raise ValueError(f"Modelo no permitido: {modelo!r}")
    if modelo not in sesiones:
        print(f"cargando modelo {modelo}...", file=sys.stderr)
        sesiones[modelo] = new_session(modelo, providers=PROVEEDORES)
        print(f"{modelo} listo", file=sys.stderr)
    return sesiones[modelo]


# --- CLAHE opcional (toggle "Mejorar contraste" en el editor) -------------
#
# Probado en 2026-09-17: en fotos de calzado/ropa blanca sobre fondo blanco
# (ej. código 392291-03), el objeto y el fondo llegan a diferir por solo
# ~5 valores de RGB sobre 255 — ni isnet ni u2net (ni birefnet-lite, ni
# u2netp, ni silueta) tienen señal suficiente ahí, y dejan zonas enteras
# semi-transparentes ("fantasma"). Aplicar CLAHE (sube contraste local)
# ANTES de la inferencia le da esa señal al modelo. Medido en 5 casos reales
# (incluido el más difícil, un running de malla): baja los píxeles de alfa
# intermedio de ~17% a ~2% de la imagen, sin regresión en los casos que ya
# andaban bien, y sin costo de tiempo real (<10ms).
#
# Importante: CLAHE se usa SOLO para calcular la máscara (le da al modelo
# una versión más contrastada para "ver" mejor) — el color final sale
# siempre de la imagen ORIGINAL sin tocar, no de la versión con contraste
# subido (si no, el resultado queda más oscuro/grisáceo que la foto real).
#
# Para revertir esto por completo: borrar esta función, el parámetro
# `clahe` de do_POST, y volver a `remove(datos, session=sesion)` a secas.
def quitar_fondo_con_clahe(datos: bytes, sesion) -> bytes:
    original = Image.open(io.BytesIO(datos)).convert("RGBA")
    rgb = np.array(original.convert("RGB"))

    l, a, b = cv2.split(cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB))
    l_realzado = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
    realzado = cv2.cvtColor(cv2.merge((l_realzado, a, b)), cv2.COLOR_LAB2RGB)

    # Se le pasa la imagen PIL directo y se pide solo la máscara: evita
    # codificar/decodificar un PNG intermedio (decenas de ms en fotos grandes).
    alfa = remove(Image.fromarray(realzado), session=sesion, only_mask=True)

    final = original.copy()
    final.putalpha(alfa)
    return _a_png(final)


def _a_png(img: Image.Image) -> bytes:
    # compress_level=1: ~5x más rápido que el default (6) y el archivo es solo
    # un intermedio local (el navegador lo reencuadra antes de subirlo a R2).
    salida = io.BytesIO()
    img.save(salida, format="PNG", compress_level=1)
    return salida.getvalue()


# --- "Mejorar calidad" (botón aparte, Real-ESRGAN x2) ----------------------
#
# Probado en 2026-09-17. Modelo: real_esrgan_x2.onnx (RRDBNet, BSD-3-Clause,
# exportado por SceneWorks — https://huggingface.co/SceneWorks/real-esrgan-onnx),
# descargado a mano en ~/.cache/real-esrgan/ (NO vive en este repo ni en
# ~/.rembg). Para borrarlo del todo: `rm -rf ~/.cache/real-esrgan` y sacar
# este bloque completo (desde el import de onnxruntime de más arriba hasta
# el endpoint /mejorar-calidad en do_POST).
#
# Por qué x2 y no x4: nuestras fotos ya vienen en resolución decente
# (1200-1500px); el objetivo era "afilar" fotos con blur/compresión leve,
# no agrandarlas 4x. Es una red convolucional (no transformer, a diferencia
# de BiRefNet), así que CoreML la compila sin colgarse (~1.3s, una vez).
#
# Medido en un caso simulado (blur + jpeg agresivo): nitidez (var. de
# Laplaciano) subió de 3.5 a 76 (el original sin borrosidad daba 96) —
# mejora real y visible. CPU: ~35s/imagen (inaceptable). CoreML: ~2.8-3s —
# mucho más lento que quitar fondo (~0.2s), por eso es un botón aparte y
# no algo automático.
#
# OJO — probado también sobre una foto YA nítida: la métrica global casi no
# cambió, pero de cerca se ve que la textura fina de la tela se aplana un
# poco (efecto típico de estos modelos GAN). No es gratis aplicarlo siempre
# — está pensado para usarlo puntualmente en fotos que de verdad estén
# borrosas, no como paso automático en todas.
RUTA_MODELO_ESRGAN = os.path.expanduser("~/.cache/real-esrgan/real_esrgan_x2.onnx")
ESCALA_ESRGAN = 2
TILE_ESRGAN = 256  # medido en RTX 4060: 256 -> 2.0s, 384 -> 2.7s, 512 -> 2.7s (1200x1200)
_sesion_esrgan = None


def _modelo_esrgan_para_gpu() -> str:
    """En CUDA usa una copia fp16 del modelo (~2x más rápido en una RTX 4060;
    diferencia máxima medida 0.0014 sobre 1.0, imperceptible). Se genera una
    sola vez junto al original; si faltan `onnx`/`onnxconverter-common` o falla
    la conversión, se sigue con el fp32."""
    if "CUDAExecutionProvider" not in PROVEEDORES:
        return RUTA_MODELO_ESRGAN
    ruta16 = RUTA_MODELO_ESRGAN.replace(".onnx", "_fp16.onnx")
    if not os.path.exists(ruta16):
        try:
            import onnx
            from onnxconverter_common import float16

            modelo = onnx.load(RUTA_MODELO_ESRGAN)
            onnx.save(float16.convert_float_to_float16(modelo, keep_io_types=True), ruta16)
            print("real-esrgan: copia fp16 generada", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"real-esrgan fp16 no disponible, se usa fp32: {e}", file=sys.stderr)
            return RUTA_MODELO_ESRGAN
    return ruta16


def obtener_sesion_esrgan():
    global _sesion_esrgan
    if _sesion_esrgan is None:
        if not os.path.exists(RUTA_MODELO_ESRGAN):
            raise FileNotFoundError(
                f"Falta el modelo de Real-ESRGAN en {RUTA_MODELO_ESRGAN} "
                "(bajarlo de https://huggingface.co/SceneWorks/real-esrgan-onnx)"
            )
        print("cargando modelo real-esrgan x2...", file=sys.stderr)
        ruta, proveedores = _modelo_esrgan_para_gpu(), PROVEEDORES
        if "CUDAExecutionProvider" in PROVEEDORES:
            # Los mosaicos tienen tamaños distintos: con el default (EXHAUSTIVE)
            # cuDNN probaría algoritmos en cada forma nueva.
            proveedores = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]
        _sesion_esrgan = ort.InferenceSession(ruta, providers=proveedores)
        print("real-esrgan x2 listo", file=sys.stderr)
    return _sesion_esrgan


def _mejorar_bgr(sesion, bgr: np.ndarray) -> np.ndarray:
    """Sube nitidez/resolución x2 de un array BGR, procesando en mosaicos (con
    PAD px de solape) para no disparar el uso de memoria en fotos grandes —
    mismo criterio documentado por el modelo (ver README de
    SceneWorks/real-esrgan-onnx).

    Todos los mosaicos tienen EXACTAMENTE el mismo tamaño (la imagen se rellena
    por los bordes y se recorta al final): en CUDA, cada cambio de forma de la
    entrada cuesta ~0.8s de re-planificación en onnxruntime, y con mosaicos de
    borde más chicos eso pasaba en casi todos. Medido en 1200x1200: 7.2s -> 2.0s.
    """
    TILE, PAD = TILE_ESRGAN, 16
    h, w = bgr.shape[:2]
    nombre_in = sesion.get_inputs()[0].name
    E = ESCALA_ESRGAN
    salida = np.zeros((h * E, w * E, 3), dtype=np.float32)

    # Rellena PAD alrededor y lo que falte para que h,w sean múltiplos de TILE.
    extra_y, extra_x = (-h) % TILE, (-w) % TILE
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    rgb = cv2.copyMakeBorder(rgb, PAD, PAD + extra_y, PAD, PAD + extra_x, cv2.BORDER_REPLICATE)
    rgb = rgb.astype(np.float32) / 255.0

    for y0 in range(0, h, TILE):
        for x0 in range(0, w, TILE):
            ventana = rgb[y0 : y0 + TILE + 2 * PAD, x0 : x0 + TILE + 2 * PAD]
            entrada = np.ascontiguousarray(ventana.transpose(2, 0, 1)[None, ...])
            salida_tile = sesion.run(None, {nombre_in: entrada})[0][0]
            salida_tile = np.clip(salida_tile.transpose(1, 2, 0), 0, 1)

            y1, x1 = min(y0 + TILE, h), min(x0 + TILE, w)
            util = salida_tile[PAD * E : PAD * E + (y1 - y0) * E, PAD * E : PAD * E + (x1 - x0) * E]
            salida[y0 * E : y1 * E, x0 * E : x1 * E] = util

    return cv2.cvtColor((salida * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)


def mejorar_calidad(datos: bytes) -> bytes:
    sesion = obtener_sesion_esrgan()
    arr = cv2.imdecode(np.frombuffer(datos, np.uint8), cv2.IMREAD_UNCHANGED)
    if arr is None:
        raise ValueError("No se pudo decodificar la imagen")

    tiene_alfa = arr.ndim == 3 and arr.shape[2] == 4
    bgr = arr[:, :, :3]
    bgr_mejorado = _mejorar_bgr(sesion, bgr)

    if tiene_alfa:
        alfa = arr[:, :, 3]
        alfa_mejorada = cv2.resize(
            alfa, (bgr_mejorado.shape[1], bgr_mejorado.shape[0]), interpolation=cv2.INTER_LANCZOS4
        )
        salida = cv2.merge((bgr_mejorado, alfa_mejorada))
        ok, buf = cv2.imencode(".png", salida)
    else:
        ok, buf = cv2.imencode(".png", bgr_mejorado)

    if not ok:
        raise ValueError("No se pudo codificar el resultado")
    return buf.tobytes()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, formato, *args):
        pass  # silencioso — si no, ensucia stdout con una línea por pedido

    def do_GET(self):
        if urlparse(self.path).path == "/salud":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        ruta = urlparse(self.path)
        if ruta.path not in ("/quitar-fondo", "/mejorar-calidad"):
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        datos = self.rfile.read(length)
        try:
            if ruta.path == "/mejorar-calidad":
                resultado = mejorar_calidad(datos)
            else:
                qs = parse_qs(ruta.query)
                modelo = qs.get("modelo", ["isnet-general-use"])[0]
                usar_clahe = qs.get("clahe", ["1"])[0] == "1"
                sesion = obtener_sesion(modelo)
                resultado = (
                    quitar_fondo_con_clahe(datos, sesion)
                    if usar_clahe
                    else remove(datos, session=sesion)
                )
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(resultado)
        except Exception as e:  # noqa: BLE001 — se reporta al caller
            mensaje = str(e).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(mensaje)


def main() -> None:
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = HTTPServer(("127.0.0.1", puerto), Handler)
    print(f"servidor rembg escuchando en :{puerto}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
