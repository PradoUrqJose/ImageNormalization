# Rama `windows-cuda` — PC con Windows y GPU NVIDIA

La rama `main` está pensada para una Mac con Apple Silicon (CoreML + MPS). Esta rama corre lo
mismo en **Windows + NVIDIA (CUDA)**. Probada en RTX 4060 8 GB, Ryzen 5 5600G, 32 GB de RAM.

## Qué cambia respecto a `main`

| Pieza | `main` (Mac) | `windows-cuda` |
|---|---|---|
| isnet / u2net / Real-ESRGAN | onnxruntime + CoreML | onnxruntime-gpu + `CUDAExecutionProvider` (cae a CPU si no hay GPU; a CoreML si algún día se corre en Mac) |
| BiRefNet / RMBG 2.0 | PyTorch fp16 en MPS | PyTorch fp16 en CUDA, con `cudnn.benchmark`, TF32 y calentamiento al cargar |
| Python | `python3` del sistema + `scripts/.venv-torch` | un solo venv `scripts/.venv` (ver `src/lib/python.ts`) |
| Espera de arranque del daemon | 10 s | 60 s (importar onnxruntime+CUDA en frío tarda) |
| CLAHE | PNG intermedio codificado/decodificado | pasa la imagen PIL directo y pide solo la máscara |
| PNG de salida | compresión 6 | compresión 1 (≈5× más rápido; es un intermedio local) |

## Instalación

Requisitos: Node 24+, Python 3.13, driver NVIDIA reciente (no hace falta el CUDA Toolkit).

```powershell
npm install
python -m venv scripts\.venv
scripts\.venv\Scripts\python -m pip install torch==2.14.1 torchvision==0.29.1 --index-url https://download.pytorch.org/whl/cu130
scripts\.venv\Scripts\python -m pip install -r scripts/requirements-cuda.txt
scripts\.venv\Scripts\python -m pip uninstall -y onnxruntime
scripts\.venv\Scripts\python -m pip install --force-reinstall --no-deps onnxruntime-gpu==1.30.0
```

`.env.local` (credenciales de R2) no se versiona: hay que copiarlo desde la Mac.

Modelo opcional de **Mejorar calidad** (67 MB):

```powershell
mkdir $HOME\.cache\real-esrgan
curl.exe -L https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx -o $HOME\.cache\real-esrgan\real_esrgan_x2.onnx
(Get-FileHash $HOME\.cache\real-esrgan\real_esrgan_x2.onnx).Hash   # 7115BA92E8A1BFA63D68558EF006EF3D91273A068D321B1439F8BB1C9179002C
```

## Uso

```powershell
npm run dev          # http://localhost:3000
```

Parar los daemons (en vez de `pkill`):

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ? { $_.CommandLine -match 'servidor_(rembg|torch)' } | % { Stop-Process -Id $_.ProcessId -Force }
```

Si en el Administrador de tareas aparece `python.exe` por cada daemon, es normal: el venv usa un
lanzador que a su vez abre el intérprete real.

## Rendimiento medido (RTX 4060, foto 1200×1200, daemon ya caliente)

| Operación | Tiempo |
|---|---|
| Quitar fondo `u2net` | ~0,08 s |
| Quitar fondo `isnet` (con o sin CLAHE) | ~0,2 s |
| Arranque del daemon (sin modelo) | ~3 s (hasta ~25 s la primera vez tras instalar) |
| Primer clic con cada modelo | ~4–5 s (carga + autotuning de CUDA, una sola vez) |

Esto ya es comparable con el CoreML de la Mac. El resto del tiempo por clic es CPU (redimensionar,
postproceso de rembg, codificar PNG), no la GPU.
