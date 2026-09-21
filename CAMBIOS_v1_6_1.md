# BANQO v1.6.1 · cambios solicitados

## Navegador de preguntas

Las preguntas respondidas ahora muestran fondo azul y borde más notorios. La pregunta actual mantiene un contorno más intenso para distinguirla de las demás.

## Subrayados

- Se mantienen al avanzar o retroceder durante el mismo banco o simulacro.
- Se eliminan automáticamente al finalizar la sesión.
- Al iniciar otra sesión se limpia cualquier subrayado residual de versiones anteriores.

## Importación de Admin

Se reforzaron los privilegios de las tablas de importación y sus políticas RLS. La interfaz comprueba el permiso antes de presentar el importador.

Si ya habías instalado v1.6, ejecuta una sola vez:

`supabase/v1_6_1_hotfix.sql`

Después publica los archivos nuevos, cierra sesión, vuelve a entrar como administrador y fuerza una recarga completa.
