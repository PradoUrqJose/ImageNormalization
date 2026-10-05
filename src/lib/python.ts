import { existsSync } from "node:fs";
import path from "node:path";

// Intérprete de Python compartido por los dos daemons. Rama windows-cuda: un
// solo venv (scripts/.venv) con PyTorch+CUDA y onnxruntime-gpu; ver README.
// Si el venv no existe se cae al Python del sistema (python3 en Unix, python
// en Windows) para que el daemon de isnet/u2net siga arrancando en CPU.
export function rutaPython(): string | null {
  const venv = path.join(process.cwd(), "scripts", ".venv");
  const exe =
    process.platform === "win32"
      ? path.join(venv, "Scripts", "python.exe")
      : path.join(venv, "bin", "python");
  return existsSync(exe) ? exe : null;
}

export const PYTHON_SISTEMA = process.platform === "win32" ? "python" : "python3";
