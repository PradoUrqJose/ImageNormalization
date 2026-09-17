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
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

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
MODELOS_PERMITIDOS = {
    "isnet-general-use": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
    "u2net": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
}
sesiones: dict[str, object] = {}


def obtener_sesion(modelo: str):
    if modelo not in MODELOS_PERMITIDOS:
        raise ValueError(f"Modelo no permitido: {modelo!r}")
    if modelo not in sesiones:
        print(f"cargando modelo {modelo}...", file=sys.stderr)
        sesiones[modelo] = new_session(modelo, providers=MODELOS_PERMITIDOS[modelo])
        print(f"{modelo} listo", file=sys.stderr)
    return sesiones[modelo]


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
        if ruta.path != "/quitar-fondo":
            self.send_response(404)
            self.end_headers()
            return

        modelo = parse_qs(ruta.query).get("modelo", ["isnet-general-use"])[0]
        length = int(self.headers.get("Content-Length", 0))
        datos = self.rfile.read(length)
        try:
            sesion = obtener_sesion(modelo)
            resultado = remove(datos, session=sesion)
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
