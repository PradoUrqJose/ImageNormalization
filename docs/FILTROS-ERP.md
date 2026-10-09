# Filtros del catálogo

Marca, stock general (con/sin), con/sin PNG, sólo nuevos del ERP y búsqueda por CU se combinan. Orden por código, fecha de foto/detección o stock; limpiar restablece selección de filtros. La imagen en edición se conserva al cambiar filtros; navegación recorre sólo resultados. Orden reciente se refiere a cambios de foto/detección, no fecha de ingreso.

Requiere sincronizador0.5.0 y SELECT de PIVMARC para marca/stock. El catálogo0.4 sigue válido y muestra aviso para actualizar; stock desconocido no se cuenta como cero. Una marca puede estar asociada a más de un CU y un CU a varias marcas.

Stock general: unidades no vendidas ni anuladas, total entre almacenes; no es stock disponible ecommerce. Sin imagen: falta PNG de R2. No se modifican modelos de eliminación de fondo ni calidad, ni se mezclan ramas.

Activación: seguir guía FILTROS-IMAGENORMALIZATION.md del paquete sincronizador, luego actualizar esta rama y reiniciar conservando .env.local.

### Distribución de la pantalla

- Arriba: contadores Todos/Con imagen/Sin imagen y filtros de código, marca, stock, nuevos y orden.
- Izquierda: miniatura, código y badges Pendiente de imagen/Nuevo, con desplazamiento independiente.
- Editor: selección y navegación siguen los resultados filtrados.
- Este ajuste visual no requiere actualizar el sincronizador del VPS ni las variables de entorno.
