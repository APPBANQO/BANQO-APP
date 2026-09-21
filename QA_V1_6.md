# QA BANQO v1.6

## Comprobaciones automáticas del paquete

- Sintaxis válida en `assets/app.js`, `assets/importers.js`, `assets/supabase-client.js` y `assets/config.js` con `node --check`.
- El cliente Supabase se carga desde `assets/vendor/supabase.min.js`; el arranque no depende de un CDN.
- No hay expresiones regulares con lookbehind.
- El frontend de alumno no consulta `correct_answer`, `explanation` ni `galactic_tip` directamente: inicio, respuesta, reanudación y finalización pasan por RPC.
- `localStorage` guarda identificadores y estado ligero, no cuerpos de preguntas ni claves.
- El temporizador persiste tiempo consumido, pausa al salir, avisa a cinco minutos y finaliza al llegar a cero.
- Las respuestas y estados pendientes se sincronizan antes de terminar una sesión.
- La reimportación conserva el estado cuando no hay cambios y sólo reabre contenido modificado.
- Los simulacros requieren el número esperado de preguntas publicadas.
- Las explicaciones `AUTO_LOCAL` permanecen ocultas al alumno hasta revisión humana.
- Se validan duplicados, saltos de numeración, conflictos de claves, verdes ambiguos, baja confianza e imágenes pendientes.

## Pruebas obligatorias en el proyecto real

1. Ejecutar la migración sobre una copia de la base y comprobar que finaliza sin errores.
2. Probar registro, confirmación de correo, inicio, cierre y recuperación de contraseña.
3. Verificar alumno Free al responder la pregunta 15 y al intentar la 16, también desde dos pestañas.
4. Recargar una sesión en curso y confirmar preguntas, respuestas, descartes, marcadas y tiempo restante.
5. Cortar Internet al responder, reconectar y comprobar la sincronización antes de finalizar.
6. Probar bloqueo del segundo dispositivo y navegación por URL/hash mientras está bloqueado.
7. Confirmar que un alumno no obtiene claves mediante la API REST de `questions`.
8. Confirmar permisos de `moderator`: revisar/editar sí; importar, eliminar y publicar no.
9. Importar un banco ya publicado sin cambios y comprobar que sigue publicado; cambiar una clave y comprobar que vuelve a pendiente.
10. Importar PDF de una y dos columnas, PDF escaneado, XLSX/CSV y JSON; revisar los recortes de imagen.
11. Intentar publicar un simulacro incompleto y luego usar la publicación masiva controlada.
12. Probar en Chrome, Firefox y Safari/iOS 15 o superior, incluyendo vista móvil.

El importador PDF/OCR y los recortes gráficos siempre requieren revisión editorial: no son un sistema médico infalible.
