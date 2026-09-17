"""
Lee bytes de imagen por stdin, quita el fondo con rembg y escribe el PNG
resultante por stdout. Lo invoca la API route /api/remove-bg como subproceso.

Uso: python3 quitar_fondo.py --modelo isnet-general-use
"""
import argparse
import sys

from rembg import new_session, remove

PROVIDERS = ["CoreMLExecutionProvider", "CPUExecutionProvider"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--modelo", default="isnet-general-use", choices=["isnet-general-use", "u2net"])
    args = parser.parse_args()

    datos = sys.stdin.buffer.read()
    session = new_session(args.modelo, providers=PROVIDERS)
    resultado = remove(datos, session=session)
    sys.stdout.buffer.write(resultado)


if __name__ == "__main__":
    main()
