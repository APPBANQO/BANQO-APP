# Cierre de auditoría · BANQO v1.6

Esta versión incorpora las correcciones de la auditoría funcional, de importación, Supabase, seguridad, rendimiento y experiencia móvil.

| Área | Corrección aplicada |
|---|---|
| Publicación | Las preguntas nuevas quedan pendientes; las reimportaciones idénticas conservan estado; los cambios sustantivos vuelven a revisión. Los simulacros no se publican incompletos. |
| Claves y respuestas | Las sesiones reciben preguntas seguras sin clave. Responder/finalizar revela datos mediante RPC y registra el cupo Free de forma atómica. |
| Persistencia | `localStorage` conserva sólo el estado ligero. Respuestas y marcadas sin conexión se encolan y sincronizan. |
| Temporizador | Usa tiempo consumido, pausa/reanuda de forma controlada, avisa a 5 minutos y auto-finaliza a cero. |
| Dispositivo | El bloqueo protege rutas/hash y mantiene latido; staff queda exento. |
| Compatibilidad | Eliminado el lookbehind; cliente Supabase local; menú móvil con fondo, Escape y cierre accesible. |
| Cuenta | Recuperación/cambio de contraseña y mensajes de error legibles. |
| Estudio | Resaltados por offsets, notas con autoguardado, errores pendientes/históricos, netas, nota sobre 20 y progreso por tema. |
| Roles | Añadido `moderator`; gestión de usuarios; protección del último administrador y de rol/plan propios. |
| Importación | Más formatos de numeración, verdes adaptativos, ambigüedad/conflictos, reintento OCR, cruce de claves, deduplicación y recorte gráfico asistido. |
| Administración | Detalle de lotes/errores, eliminación individual con impacto, archivo masivo seguro y cambio de proyecto Supabase. |
| Interfaz | Tema oscuro consistente, navegador de preguntas desplazable, cuestionario móvil apilado y diálogos con foco/teclado. |

## Despliegue

- Instalación nueva: ejecutar sólo `supabase/schema.sql`.
- Instalación v1.4/v1.5: ejecutar una vez `supabase/v1_6_audit_fix.sql` y luego publicar el frontend.
- Instalación v1.3: ejecutar primero `supabase/v1_4_upgrade.sql` y después `supabase/v1_6_audit_fix.sql`.

Antes de producción, completa la matriz de pruebas de `QA_V1_6.md` sobre una copia del proyecto Supabase. El OCR y el recorte de imágenes son asistencias editoriales y deben verificarse manualmente.
