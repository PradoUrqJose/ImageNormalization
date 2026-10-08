# Integración de ImageNormalization con el ERP

Revisión: 08/10/2026. Las ramas main (macOS) y windows-cuda (Windows/NVIDIA) permanecen separadas.

## Lo que ya funciona

1. El editor guarda CODIGO.png en el bucket stock-sc-catalogo.
2. El trabajador instalado en el VPS detecta el cambio en R2.
3. Genera WebP transparentes y JPEG/TH blancos; actualiza principal, POS y ecommerce.

Las dos ramas publicadas ya usan PutObject en R2 y no necesitan conectarse a MySQL ni tener una copia del trabajador. La integración depende de configurar el mismo bucket y mantener activo el servicio del VPS. Guardar en R2 no equivale a confirmar que SQL terminó: se comprueba en 4-Ver-estado.

## Correcciones de esta revisión

- Guarda únicamente PNG válidos de producto en raíz. Rechaza diseños/rutas y formatos mal nombrados.
- Canoniza mayúsculas y alias 400497_07 → 400497-07; admite códigos con espacios.
- Valida límite 8 MiB/16 MP, conserva los bytes/alfa del PNG del editor sin recomprimir.
- Galería sólo PNG de producto raíz, sin historial ni diseños. URL incluye revisión del objeto para evitar caché vieja.
- Mensaje de guardado distingue R2 de la actualización posterior del ERP.
- No cambia Python, macOS, modelos, rutas NVIDIA ni requisitos CUDA. No crea copias anteriores de imágenes en R2.

Pruebas: guardado con transporte simulado, nombres/alias/espacios, rechazo de rutas/formato/tamaño y conservación de PNG. Sin subir fotos reales ni escribir ERP. Compilación y comprobación TypeScript de cada rama; inferencia macOS/NVIDIA no ejecutada en esta revisión porque sus archivos no se modificaron.

## Vercel y eliminación de fondo externa: evaluación

El editor web sí puede desplegarse en Vercel. El modo actual de quitar fondo y mejorar calidad arranca servidores Python persistentes en localhost:8765/8766; no hay que trasladar ese diseño tal cual a funciones web. Reutilizar el botón existente con un proveedor externo configurable y conservar el modo local en cada rama.

Candidato para piloto: Cloudinary con cuenta gratuita limitada. Su plan ofrece 25 créditos por 30 días compartidos entre transformaciones/almacenamiento/tráfico; quitar fondo cuenta 75 transformaciones adicionales. Un máximo teórico de unos 329 recortes antes de esos otros consumos NO es una cuota garantizada. Verificar la disponibilidad de la función en la cuenta y probar bordes/calidad con 5 productos antes de elegirlo. Fuente: https://cloudinary.com/documentation/billing_and_plans y https://cloudinary.com/documentation/transformation_counts .

Cloudinary documenta transparencia y límite de entrada 6144x6144 para quitar fondo, suficiente para el lienzo 1600x1600 actual. Esto permite conservar resolución, pero no garantiza que la máscara sea igual a BiRefNet/rembg: probar detalles, cordones y zapatillas blancas. https://cloudinary.com/documentation/background_removal .

remove.bg no cumple bien gratis+alta resolución: 50 previews API gratuitas/mes, hasta 0,25 MP según ayuda oficial. Ampliar ese resultado a 1600 px no recupera detalle. https://www.remove.bg/lt/help/a/is-remove-bg-free- .

Flujo propuesto: botón → subida directa/autorizada al proveedor → esperar máscara/PNG → previsualizar → guardar CODIGO.png en R2 → sincronizadorVPS. Clave del proveedor sólo en servidor; login para la aplicación expuesta. Vercel atendería autenticación/autorización y llamadas ligeras; seguiría teniendo consumo de red/funciones, aunque la IA se ejecute fuera.

Las funciones Vercel limitan petición/respuesta a 4,5 MB. El JSON base64 actual añade aproximadamente un tercio al PNG. Para conservar fotos grandes, usar subida directa firmada y retornar URLs, en lugar de enviar los bytes completos por la función. https://vercel.com/docs/functions/limitations .

No se crea cuenta externa ni se despliega en esta revisión. Gratis ilimitado, buena calidad y servicio estable no quedó demostrado. La mejora Real-ESRGAN también depende del servidor local y necesita otro proveedor o quedar desactivada en modo Vercel.

## Todos los códigos universales del ERP: evaluación

Hoy ambas ramas publicadas usan la lista de archivos R2 más src/data/codigos-nuevos.json, un listado estático. No consultan automáticamente todos los códigos ERP.

El trabajador ya construye un catálogo DISTINCT de PIVMCDR + PIVMCDR_VEND sin filtrar stock, con código/combinaciones/tieneImagen. Pero lo guarda en cola privada LOCAL del VPS: Vercel no puede leer ese disco y el panel8094 es sólo demo.

Propuesta simple:

1. El trabajador publica una copia del catálogo en un bucket R2 PRIVADO separado del público; nunca ponerlo junto a las fotos públicas.
2. Dar al trabajador escritura y a la web lectura de ese bucket, con claves diferentes y guardadas en servidor.
3. La galería toma los códigos del catálogo ERP y relaciona cada uno con su PNG; muestra espacios vacíos donde falta imagen y filtros con/sin imagen. La lista se obtiene del ERP, aunque las fotos transparentes sigan en R2.
4. Actualizar el espejo cuando cambie el contenido; la web recarga periódicamente y muestra fecha de actualización, conservando el último catálogo válido si hay un corte.
5. Código nuevo ERP aparece después de su alta en mercadería y del ciclo siguiente. Subir su PNG activa el mismo flujo actual; el editor no crea productos de negocio.

No requiere abrir puertos/MySQL del VPS, ni cambiar el código del ERP. Requiere agregar la publicación del catálogo al trabajador y el lector/filtros a ambas ramas. Una alternativa es que el VPS envíe el catálogo por HTTPS a una API autenticada y ésta lo guarde en una BD externa; implica más piezas que el espejo privado.

Si también se desea ver fotos que sólo existen en ERP, publicar su referencia y usar una URL de lectura autorizada como alternativa. El PNG transparente R2 sigue siendo preferible para normalización; la foto grande ERP ya tiene fondo blanco.

## Publicación

El usuario autorizó publicar estas correcciones el 08/10/2026. Cada rama se publica por separado, sin combinarlas. Los cambios previos de la carpeta original image-normalization se conservaron intactos. El proveedor externo y el catálogo automático continúan como propuestas pendientes de implementar.
