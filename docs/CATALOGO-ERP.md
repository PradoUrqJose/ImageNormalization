# Lista del ERP y avisos de códigos nuevos

## Qué hace
- Lista todos los CU de mercadería activa/vendida, sin filtrar stock; una tarjeta por CU.
- Fotos transparentes siguen en R2. Con PNG / Sin PNG significa disponible en R2, no asociación SQL comprobada.
- Sincronizador conserva su funcionamiento de fotos; publica una lista privada cuando cambia y una señal de salud cada cinco minutos.
- Web refresca cada minuto. Aviso de códigos añadidos después de la primera publicación; fecha de detección, no fecha contable de ingreso. Marcar vistos recuerda la lectura en ese navegador.
- No modifica ERP ni expone MySQL. Si falla la publicación de lista, las fotos siguen; si falla la lectura, la pantalla conserva la lista actual y muestra advertencia.

## Activación paso a paso (usuario; todavía no instalada)
1. En Cloudflare crea un bucket llamado `stock-sc-erp-privado`. Deja desactivados r2.dev y dominio público: contiene datos del ERP.
2. Crea un token sólo para ese bucket con lectura/escritura para el sincronizador y otro sólo lectura para ImageNormalization. No reutilices el token de las fotos.
3. En VPS: detén con `5-Detener.cmd`, copia `sync/worker.mjs` y `sync/catalog-mirror.mjs` del paquete 0.4.0 a la carpeta del sincronizador. Conserva config.json, worker.env, estado y cola.
4. Abre `sync/worker.env` del VPS con Bloc de notas y agrega las cuatro variables ERP_CATALOG_* del ejemplo. Bucket privado, endpoint R2 y claves del token escritor. Guarda sin enviar secretos al chat.
5. Inicia con `3-Iniciar.cmd` y revisa `4-Ver-estado.cmd`. No vuelvas a ejecutar baseline ni borres `estado/catalogo-publicacion.json`: mantiene la referencia de avisos.
6. En la copia de ImageNormalization del equipo, configura las mismas cuatro variables con el token lector en `.env.local`. Además ERP_CATALOG_APP_USER / ERP_CATALOG_APP_PASSWORD para acceso privado. Reinicia la aplicación. Cada rama se actualiza por separado. Si se publica en Vercel, usar HTTPS y configurar las variables allí; no publicar este catálogo sin autenticación.
7. Comprueba lista, filtros y fecha. Registra un producto nuevo normalmente en el ERP; espera los ciclos de sincronizador + refresco web y comprueba el aviso. Subir foto utiliza el flujo existente.

## Errores
- 401: usuario/contraseña del editor incorrectos; no son los de MySQL ni R2.
- 503 al abrir: falta configurar acceso privado ERP_CATALOG_APP_USER/PASSWORD.
- No se pudo leer catálogo: token lector/bucket/endpoint o publicación faltante. La foto pública no autoriza leer el catálogo privado.
- catalogo_publicacion_error en worker: revisa token escritor. No bloquea cargas de fotos.
- Lista sin actualización reciente: han pasado más de diez minutos; revisa tarea/conexión.
- Primera lectura no muestra todos como nuevos: es intencional. Códigos existentes son baseline.
- Marcar vistos se guarda por navegador; otro equipo puede mostrar los avisos de nuevo.

## Reversión de esta extensión
Detén, retira ERP_CATALOG_* del worker.env y restaura worker.mjs 0.3.0 si hace falta; conserva estado/cola. En la web retira las variables de catálogo y vuelve al listado R2. No cambia datos SQL.

## Validación
Pruebas de metadatos/nuevos/heartbeat y regresión cola/limpieza; lectura real de base demo local; builds independientes y acceso anónimo rechazado. Transporte remoto simulado con un servidor S3 localhost; bucket privado real aún pendiente de configurar. No habilitada en VPS por el agente.
