# BANQO Perú v1.6 — inicio rápido

## 1. Base de datos Supabase

### Si es una instalación nueva
Ejecuta una sola vez `supabase/schema.sql`.

### Si ya usabas BANQO Supabase v1.4 o v1.5
Haz una copia de seguridad y ejecuta una sola vez `supabase/v1_6_audit_fix.sql` en Supabase → SQL Editor. No borra preguntas, usuarios ni progreso.

### Si aún estabas en v1.3
Ejecuta primero `supabase/v1_4_upgrade.sql` y después `supabase/v1_6_audit_fix.sql`.

## 2. Usuario administrador

Crea tu cuenta normalmente. Después, en Supabase → SQL Editor:

```sql
select id, email from auth.users;
```

Copia tu UUID y ejecuta:

```sql
update public.profiles
set role = 'admin', plan = 'admin'
where id = 'TU-UUID';
```

Cierra sesión y vuelve a entrar.

## 3. Conectar el frontend

En Supabase copia el Project URL y la anon/publishable key. Puedes pegarlas en la pantalla inicial de BANQO o fijarlas en `assets/config.js`.

Nunca pongas la `service_role` key en el navegador.

## 4. Explicación + Dato clave: GRATIS y local

Esta versión NO requiere OpenAI, API key, Supabase Edge Functions ni pagos.

Al importar una pregunta con clave detectada, BANQO crea localmente una explicación de apoyo y un Dato clave a partir de:

- respuesta oficial detectada;
- texto de la alternativa correcta;
- datos orientadores extraídos del enunciado;
- tipo de pregunta (diagnóstico, tratamiento, prueba, mecanismo, etc.).

La clave oficial nunca se modifica. Las explicaciones locales se guardan como `AUTO_LOCAL` y no se muestran al alumno hasta que un revisor las valide y guarde como `MANUAL`.

Flujo:

`archivo → OCR/texto → alternativas → detección verde → clave oficial → explicación local → dato clave → revisión → PENDIENTE`

## 5. Importar bancos o simulacros

Admin → Importar.

El importador admite XLSX, CSV, JSON y PDF. En PDF reconoce una o dos columnas, texto extraíble u OCR de respaldo y alternativas correctas con fondo, resaltado, subrayado o texto verde.

Deja activada la opción **Generar automáticamente Explicación + Dato clave de forma local y gratuita**.

Si una clave no puede detectarse con suficiente seguridad, la pregunta queda para revisión manual y no se inventa una respuesta.

## 6. Publicar contenido

Admin → Preguntas → Editar. Revisa enunciado, alternativas, clave, Explicación y Dato clave; clasifica la pregunta y pulsa Publicar.

## 7. Actualizar el frontend

Reemplaza los archivos publicados por los de esta carpeta. Después usa una recarga completa (`Ctrl+F5` o borrar los datos del sitio) para evitar que quede la caché de v1.5.

## 8. GitHub Pages

Cuando todo funcione localmente, sube el contenido de esta carpeta al repositorio y publica desde `main` / raíz.

BANQO usa Supabase como backend. No utiliza Google Apps Script, Google Sheets ni una API de IA de pago para generar explicaciones.
