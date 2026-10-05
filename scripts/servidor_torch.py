"""
Segundo daemon de quitar fondo, SOLO para los modelos grandes de PyTorch:
BiRefNet (MIT) y RMBG 2.0 de Bria (CC BY-NC 4.0, NO comercial). Agregado el
2026-10-05 — ver docs/MODELOS_PYTORCH.md para instalar, probar y DESINSTALAR.

Por qué un proceso aparte (y no dentro de servidor_rembg.py):
  - Vive en su propio venv (scripts/.venv-torch) para no meter torch (~1 GB)
    en el Python del sistema. Desinstalar = borrar esa carpeta.
  - Si algo se cuelga acá, isnet/u2net (servidor_rembg.py, :8765) siguen
    andando. Para matarlo: pkill -f servidor_torch.py

Por qué PyTorch + MPS y NO onnxruntime + CoreML: el intento anterior
(ver comentario en servidor_rembg.py) compilaba el ONNX de ~1 GB con CoreML
para el Neural Engine; ANECompilerService se quedaba colgado al 100% de CPU
y calentaba la Mac. MPS usa la GPU por Metal directamente: no hay paso de
compilación del Neural Engine, así que ese cuelgue no puede repetirse.

Cuidados contra el recalentamiento:
  - Un solo pedido a la vez (HTTPServer no es multihilo).
  - Se apaga solo tras MINUTOS_INACTIVO sin pedidos (libera ~2-4 GB de
    memoria unificada); Next lo vuelve a levantar en el próximo clic.
  - torch se importa recién en el primer pedido: el socket abre al instante.

Uso: scripts/.venv-torch/bin/python servidor_torch.py [puerto]  (default 8766)
"""
import io
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import cv2
import numpy as np
from PIL import Image

# Deben estar antes de importar torch/transformers. Next ya los pasa (ver
# src/lib/torchDaemon.ts); se repiten acá por si se lanza a mano.
#  - HF_HOME propio: los pesos (~1.8 GB) quedan en UNA carpeta aparte, que se
#    borra sin tocar otras cachés de Hugging Face que pueda haber.
#  - MPS_FALLBACK: BiRefNet usa deform_conv2d, que MPS no implementa; esa
#    operación puntual cae a CPU en vez de tirar error.
os.environ.setdefault("HF_HOME", os.path.expanduser("~/.cache/estandarizacion-torch/huggingface"))
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# Revisiones fijadas: trust_remote_code ejecuta el birefnet.py del repo de
# Hugging Face, así que se fija el commit para que un cambio upstream no
# ejecute código nuevo sin que nadie lo revise. Para actualizar: cambiar el
# hash (ver https://huggingface.co/<repo>/commits/main).
MODELOS = {
    "birefnet": ("ZhengPeng7/BiRefNet", "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"),
    "rmbg-2.0": ("briaai/RMBG-2.0", "5df4c9c76d8170882c34f6986e848ee07fd0ba43"),
}
TAM_ENTRADA = (1024, 1024)  # resolución de entrenamiento de ambos modelos
MEDIA = np.array([0.485, 0.456, 0.406], dtype=np.float32)
DESVIO = np.array([0.229, 0.224, 0.225], dtype=np.float32)
MINUTOS_INACTIVO = 15

_modelos: dict[str, object] = {}
_torch = None
_device = None
_ultimo_pedido = time.monotonic()


def _iniciar_torch():
    global _torch, _device
    if _torch is None:
        import torch

        _torch = torch
        if torch.cuda.is_available():
            _device = "cuda"
            # Entrada siempre 1024x1024: dejar que cuDNN elija el algoritmo más
            # rápido una vez (se paga en el calentamiento, no en cada clic).
            torch.backends.cudnn.benchmark = True
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        elif torch.backends.mps.is_available():
            _device = "mps"
        else:
            _device = "cpu"
        print(f"torch {torch.__version__} en {_device}", file=sys.stderr)
    return _torch


def obtener_modelo(nombre: str):
    if nombre not in MODELOS:
        raise ValueError(f"Modelo no permitido: {nombre!r}")
    if nombre not in _modelos:
        torch = _iniciar_torch()
        from transformers import AutoModelForImageSegmentation

        repo, revision = MODELOS[nombre]
        print(f"cargando {repo}@{revision[:8]}...", file=sys.stderr)
        t0 = time.monotonic()
        try:
            modelo = AutoModelForImageSegmentation.from_pretrained(
                repo, revision=revision, trust_remote_code=True
            )
        except Exception as e:  # noqa: BLE001
            if nombre == "rmbg-2.0" and ("gated" in str(e).lower() or "401" in str(e) or "403" in str(e)):
                raise RuntimeError(
                    "RMBG 2.0 es un modelo con acceso restringido: aceptá la licencia en "
                    "https://huggingface.co/briaai/RMBG-2.0 y poné HF_TOKEN=hf_... en .env.local "
                    "(ver docs/MODELOS_PYTORCH.md)"
                ) from e
            raise
        modelo.eval().to(_device)
        if _device != "cpu":
            modelo.half()  # fp16: mitad de memoria y más rápido en la GPU
        _calentar(modelo)
        _modelos[nombre] = modelo
        print(f"{nombre} listo en {time.monotonic() - t0:.1f}s", file=sys.stderr)
    return _modelos[nombre]


def _calentar(modelo) -> None:
    """Una pasada en vacío al cargar: cuDNN/CUDA hacen su autotuning y reservan
    memoria acá, no en el primer clic real."""
    if _device == "cpu":
        return
    torch = _torch
    x = torch.zeros((1, 3, *TAM_ENTRADA), device=_device, dtype=torch.half)
    with torch.inference_mode():
        modelo(x)
    if _device == "cuda":
        torch.cuda.synchronize()


def calcular_alfa(modelo, rgb: np.ndarray) -> np.ndarray:
    """rgb uint8 HxWx3 -> alfa uint8 HxW, mismo tamaño que la entrada."""
    torch = _torch
    h, w = rgb.shape[:2]
    x = cv2.resize(rgb, TAM_ENTRADA, interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
    x = ((x - MEDIA) / DESVIO).transpose(2, 0, 1)[None, ...]
    tensor = torch.from_numpy(np.ascontiguousarray(x)).to(_device)
    if _device != "cpu":
        tensor = tensor.half()
    with torch.inference_mode():
        pred = modelo(tensor)[-1].sigmoid().float().cpu().numpy()[0, 0]
    if _device == "mps":
        torch.mps.empty_cache()  # en CUDA no hace falta: el allocator reutiliza el bloque
    alfa = cv2.resize(pred, (w, h), interpolation=cv2.INTER_LINEAR)
    return (np.clip(alfa, 0, 1) * 255).astype(np.uint8)


def quitar_fondo(datos: bytes, nombre: str, usar_clahe: bool) -> bytes:
    modelo = obtener_modelo(nombre)
    original = Image.open(io.BytesIO(datos)).convert("RGB")
    rgb = np.array(original)

    # Mismo criterio que servidor_rembg.py: CLAHE solo para que el modelo
    # "vea" mejor la máscara; el color final sale SIEMPRE de la foto original.
    if usar_clahe:
        l, a, b = cv2.split(cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB))
        l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
        entrada = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2RGB)
    else:
        entrada = rgb

    alfa = calcular_alfa(modelo, entrada)
    final = original.convert("RGBA")
    final.putalpha(Image.fromarray(alfa, mode="L"))
    salida = io.BytesIO()
    final.save(salida, format="PNG", compress_level=1)
    return salida.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, formato, *args):
        pass

    def do_GET(self):
        if urlparse(self.path).path == "/salud":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global _ultimo_pedido
        ruta = urlparse(self.path)
        if ruta.path != "/quitar-fondo":
            self.send_response(404)
            self.end_headers()
            return
        _ultimo_pedido = time.monotonic()
        datos = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            qs = parse_qs(ruta.query)
            nombre = qs.get("modelo", ["birefnet"])[0]
            usar_clahe = qs.get("clahe", ["1"])[0] == "1"
            t0 = time.monotonic()
            resultado = quitar_fondo(datos, nombre, usar_clahe)
            print(f"{nombre}: {time.monotonic() - t0:.2f}s", file=sys.stderr)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(resultado)
        except Exception as e:  # noqa: BLE001 — se reporta al caller
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(str(e).encode("utf-8"))
        finally:
            _ultimo_pedido = time.monotonic()


def _vigilar_inactividad():
    while True:
        time.sleep(30)
        if time.monotonic() - _ultimo_pedido > MINUTOS_INACTIVO * 60:
            print("inactivo, apagando para liberar memoria", file=sys.stderr)
            os._exit(0)


def main() -> None:
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    threading.Thread(target=_vigilar_inactividad, daemon=True).start()
    server = HTTPServer(("127.0.0.1", puerto), Handler)
    print(f"servidor torch escuchando en :{puerto}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
