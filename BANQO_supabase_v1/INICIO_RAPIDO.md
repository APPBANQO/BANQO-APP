# BANQO Perú — inicio rápido con Supabase + GitHub Pages

## 1. Crear Supabase

1. Crea un proyecto en Supabase.
2. Abre **SQL Editor**.
3. Copia y ejecuta todo `supabase/schema.sql` una sola vez.

## 2. Crear tu cuenta admin

1. Publica o abre BANQO y regístrate con tu correo.
2. En Supabase → SQL Editor ejecuta:

```sql
select id, email from auth.users;
```

3. Copia tu UUID y ejecuta:

```sql
update public.profiles
set role = 'admin', plan = 'admin'
where id = 'TU-UUID';
```

4. Cierra sesión y vuelve a entrar.

## 3. Conectar el frontend

En **Project Settings / API** de Supabase copia:

- Project URL
- anon/publishable key

Puedes pegarlas en la primera pantalla de BANQO o fijarlas en `assets/config.js`.

**No uses service_role en el navegador.**

## 4. Probar el importador

Entra como admin → **Admin → Importar**.

Ya hay dos ejemplos:

- **Bioética 1**: 39 preguntas.
- **Simulacro 1**: 200 preguntas.

También puedes subir directamente XLSX/CSV/JSON o un PDF de solucionario con la alternativa correcta resaltada en verde.

Todo entra como `PENDIENTE`.

## 5. Publicar contenido

Admin → Preguntas → Editar:

1. revisa enunciado y alternativas;
2. revisa clave;
3. completa especialidad → tema → subtema;
4. añade imagen si corresponde;
5. añade explicación si deseas;
6. pulsa **Publicar**.

Para un simulacro, luego entra a **Admin → Simulacros** y cambia el simulacro de `BORRADOR` a `PUBLICADO`.

## 6. GitHub Pages

Sube esta carpeta a tu repositorio y activa GitHub Pages desde la rama `main` y carpeta raíz. También se incluye un workflow en `.github/workflows/pages.yml` por si prefieres GitHub Actions.

## Flujo de trabajo recomendado

`PDF/XLSX → previsualización → validación → importación PENDIENTE → revisión admin → PUBLICADA → alumno`

Al reimportar el mismo banco, BANQO distingue preguntas nuevas, modificadas y sin cambios. No publica ni archiva automáticamente por diferencias.
