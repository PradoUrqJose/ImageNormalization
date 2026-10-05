# BiRefNet y RMBG 2.0 (modelos PyTorch) — instalación, uso y desinstalación

Agregado el **2026-10-05**. Suma dos botones a "Quitar fondo" en el editor: **BiRefNet** y
**RMBG 2.0**. Están aislados del resto de la herramienta: si se borran, isnet/u2net, CLAHE y
"Mejorar calidad" siguen funcionando igual.

## Por qué ahora funciona (y antes calentó la Mac)

El intento anterior (septiembre 2026) usó `rembg` + onnxruntime con **CoreML**. CoreML intentaba
compilar el ONNX de ~1 GB para el Neural Engine, y el compilador del sistema
(`ANECompilerService`) se quedaba colgado al 100 % de CPU. Ver el comentario en
`scripts/servidor_rembg.py` y `docs/EXPERIMENTOS.md`.

Ahora se corre con **PyTorch sobre la GPU (MPS / Metal)**. Este camino no compila nada para el
Neural Engine, así que ese cuelgue no puede volver a pasar. Además, todo vive en un **proceso
aparte** (puerto 8766): si algo falla, el daemon de isnet/u2net (puerto 8765) no se entera.

## Medido (Apple M5, foto 1024×1024, zapatilla blanca sobre fondo blanco)

| | BiRefNet |
|---|---|
| Primer uso (descarga 444 MB + carga + calentamiento de la GPU) | ~35 s |
| Primer clic tras reiniciar el daemon (ya descargado), vía Next | ~5 s |
| Clics siguientes | **~0,9–1,1 s** |
| CPU del daemon en reposo | 0 % |
| Píxeles de alfa intermedio ("fantasma"), con CLAHE | 0,33 % de la imagen (es una foto de prueba generada; falta comparar con fotos reales del catálogo) |

RMBG 2.0 no se pudo medir todavía porque necesita el token (ver más abajo). Usa la misma
arquitectura, así que debería tardar lo mismo.

## Licencias ⚠️

| Modelo | Licencia | ¿Uso comercial? |
|---|---|---|
| BiRefNet (`ZhengPeng7/BiRefNet`) | MIT | ✅ Sí |
| RMBG 2.0 (`briaai/RMBG-2.0`) | CC BY-NC 4.0 | ❌ No, salvo con una licencia comercial de Bria |

El tooltip del botón RMBG 2.0 lo recuerda.

---

## Qué se instaló y dónde (inventario completo)

### Fuera del repo (en tu disco)

| Qué | Dónde | Tamaño |
|---|---|---|
| Pesos de BiRefNet (+ código remoto) | `~/.cache/estandarizacion-torch/huggingface/` | ~424 MB |
| Pesos de RMBG 2.0 (cuando se use por primera vez) | misma carpeta | ~900 MB |

Se usa un `HF_HOME` **propio**, no el `~/.cache/huggingface` compartido. Así se puede borrar
entero sin afectar otras cachés de Hugging Face.

**No se tocó** el Python del sistema (`/Library/Frameworks/Python.framework/...`): no se
instaló nada con `pip3` global. Tampoco se tocaron `~/.rembg` ni `~/.cache/real-esrgan`.

### Dentro del repo

| Archivo | Cambio |
|---|---|
| `scripts/.venv-torch/` | **Nuevo** (ignorado por git, ~1.1 GB). venv con torch 2.14.1, torchvision, transformers, timm, kornia, einops, etc. |
| `scripts/requirements-torch.txt` | **Nuevo**. Versiones exactas probadas. |
| `scripts/servidor_torch.py` | **Nuevo**. Daemon en `:8766`. |
| `src/lib/torchDaemon.ts` | **Nuevo**. Arranca el daemon desde Next. |
| `src/app/api/remove-bg/route.ts` | **Editado**. Bloque marcado `--- BiRefNet / RMBG 2.0 ---` + 1 import. |
| `src/app/page.tsx` | **Editado**. Tipo `ModeloQuitarFondo`, lista `MODELOS_QUITAR_FONDO` (campo `lento` → `aviso`), mensaje de carga y `title` del botón. |
| `.gitignore` | **Editado**. `/scripts/.venv-torch/` y `__pycache__/`. |
| `.env.example` | **Editado**. `HF_TOKEN=` documentado. |
| `docs/MODELOS_PYTORCH.md` | **Nuevo** (este archivo). |
| `README.md` | **Editado**. Link a este documento. |

---

## Instalación (por si hay que rehacerla en otra máquina)

```bash
python3 -m venv scripts/.venv-torch
scripts/.venv-torch/bin/python -m pip install -r scripts/requirements-torch.txt
```

No hay que bajar nada a mano: cada modelo se descarga solo con su primer clic.

### Activar RMBG 2.0 (modelo con acceso restringido)

1. Entrar con tu cuenta a https://huggingface.co/briaai/RMBG-2.0 y aceptar los términos.
2. Crear un token de **lectura** en https://huggingface.co/settings/tokens.
3. Agregar a `.env.local`: `HF_TOKEN=hf_xxx`
4. Reiniciar: `pkill -f servidor_torch.py` y reiniciar `npm run dev` (Next lee `.env.local` al
   arrancar).

Sin token, el botón muestra un error claro y no descarga nada.

## Cómo funciona

- Next arranca `scripts/.venv-torch/bin/python scripts/servidor_torch.py 8766` con el primer clic
  en BiRefNet o RMBG 2.0 (igual que con el daemon de rembg).
- Corre en fp16 sobre `mps`. `PYTORCH_ENABLE_MPS_FALLBACK=1` hace que `deform_conv2d` (que MPS
  no implementa) se calcule en CPU en vez de fallar.
- Respeta el toggle "Mejorar contraste": CLAHE solo para calcular la máscara, y el color final
  sale de la foto original (mismo criterio que `servidor_rembg.py`).
- Atiende **un pedido a la vez** y **se apaga solo tras 15 min sin uso** (`MINUTOS_INACTIVO`),
  así libera la memoria. El próximo clic lo vuelve a levantar.
- Las revisiones de Hugging Face están **fijadas por commit** en `MODELOS`
  (`servidor_torch.py`): `trust_remote_code` ejecuta código del repo del modelo, y así no se
  ejecuta código nuevo sin revisarlo.

Comandos útiles:

```bash
pkill -f servidor_torch.py                        # parar el daemon ya
curl -s http://127.0.0.1:8766/salud                # ¿está vivo?
du -sh scripts/.venv-torch ~/.cache/estandarizacion-torch   # cuánto ocupa
```

---

## Desinstalar / deshacer

### Nivel 1 — Liberar disco, dejando el código (los botones darán error claro)

```bash
pkill -f servidor_torch.py
rm -rf scripts/.venv-torch                       # ~1.1 GB (torch y compañía)
rm -rf ~/.cache/estandarizacion-torch            # pesos de los modelos
```

Solo para olvidar uno de los dos modelos:

```bash
rm -rf ~/.cache/estandarizacion-torch/huggingface/hub/models--briaai--RMBG-2.0
rm -rf ~/.cache/estandarizacion-torch/huggingface/hub/models--ZhengPeng7--BiRefNet
```

Si pusiste `HF_TOKEN` en `.env.local`, borralo y **revocalo** en
https://huggingface.co/settings/tokens.

### Nivel 2 — Quitar todo, también el código

Hacer primero el nivel 1, y después:

```bash
rm scripts/servidor_torch.py scripts/requirements-torch.txt src/lib/torchDaemon.ts docs/MODELOS_PYTORCH.md
```

Ediciones a revertir a mano:

1. **`src/app/api/remove-bg/route.ts`**: borrar la línea
   `import { asegurarServidorTorch, BASE_TORCH, MODELOS_TORCH } from "@/lib/torchDaemon";` y el
   bloque entre `// --- BiRefNet / RMBG 2.0` y `// --- fin BiRefNet / RMBG 2.0`.
2. **`src/app/page.tsx`**:
   - `type ModeloQuitarFondo` → dejar solo `"isnet-general-use" | "u2net"`.
   - En `MODELOS_QUITAR_FONDO`, borrar las entradas `birefnet` y `rmbg-2.0` y el comentario
     `// 2026-10-05: ...`. El campo `aviso` puede quedar (es opcional y no molesta).
3. **`.gitignore`**: borrar las 3 líneas bajo `# venv de PyTorch...`.
4. **`.env.example`**: borrar el bloque `HF_TOKEN`.
5. **`README.md`**: borrar el link a este documento.

> Ojo con `git checkout -- src/app/page.tsx`: al momento de este cambio, `page.tsx` ya tenía
> modificaciones tuyas sin commitear, que se perderían. Si ya se commiteó esto por separado,
> `git revert <commit>` es lo más limpio.

Verificar que no quedó nada:

```bash
grep -rn "torch\|birefnet\|rmbg-2.0" src scripts --include=*.ts --include=*.tsx --include=*.py | grep -v servidor_rembg
pgrep -fl servidor_torch || echo "daemon apagado"
ls ~/.cache/estandarizacion-torch 2>/dev/null || echo "caché borrada"
```

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| "Falta el entorno de PyTorch (scripts/.venv-torch)" | No está el venv: ver Instalación. |
| "RMBG 2.0 es un modelo con acceso restringido…" | Falta aceptar la licencia o falta `HF_TOKEN` (ver arriba). |
| El primer clic tarda | Normal. La primera vez de todas (~35 s) descarga el modelo; después de un reinicio del daemon (~5 s) solo lo carga. Los clics siguientes tardan ~1 s. |
| Cambié `HF_TOKEN` y sigue fallando | El daemon viejo sigue vivo con el entorno anterior: `pkill -f servidor_torch.py` y reiniciar `npm run dev`. |
| La Mac se calienta | No debería, porque no usa CoreML. Revisar con `top -o cpu`; si es `servidor_torch.py`, `pkill -f servidor_torch.py`. |
