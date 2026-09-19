# BANQO Perú · Supabase v1

Versión migrada del prototipo local de BANQO a una arquitectura gratuita para MVP:

- **Frontend:** HTML/CSS/JavaScript estático, apto para **GitHub Pages**.
- **Backend:** **Supabase** (Auth + Postgres + Storage + RLS).
- **Objetivo:** Residentado Médico Perú, ENAM y EsSalud.
- **Costo inicial:** puede funcionar con los planes gratuitos de GitHub Pages y Supabase.

## Qué ya incluye

### Alumno
- Registro e inicio de sesión con Supabase Auth.
- Banqueo por examen, banco, especialidad, tema y subtema.
- Corrección inmediata o al final.
- Persistencia del examen en curso si se recarga la página.
- Advertencia antes de salir de una sesión activa.
- Simulacros administrables desde Supabase.
- Mapa de preguntas y navegación anterior/siguiente.
- Marcar preguntas para revisión.
- Descartar alternativas.
- Favoritas.
- Notas privadas por pregunta.
- Reporte de preguntas con problemas.
- Resultados y revisión final.
- Historial y estadísticas básicas.
- Plan free preparado para 15 preguntas/día desde la interfaz.
- Base para una sesión de dispositivo por cuenta (excepto admin).

### Administrador
- Rol `admin` con acceso ilimitado.
- Panel de preguntas con estados:
  - `PENDIENTE`
  - `APROBADA`
  - `PUBLICADA`
  - `ARCHIVADA`
- Editor completo de pregunta, con carga de imágenes a Supabase Storage.
- Bandeja de reportes de alumnos con estados PENDIENTE / REVISADO / RESUELTO.
- Importación de:
  - XLSX / CSV
  - JSON
  - PDF de solucionario con respuesta correcta resaltada en verde
- Previsualización antes de importar.
- Detección de:
  - preguntas sin clave;
  - ID duplicado;
  - alternativas faltantes;
  - falta de clasificación;
  - falta de explicación;
  - preguntas que parecen depender de imagen.
- Todas las importaciones entran como `PENDIENTE`: nunca se publican automáticamente.
- Historial de lotes/importaciones.
- Creación automática de un `simulation_set` cuando el lote es un simulacro.
- Publicación / vuelta a borrador de simulacros.
- Campos `source_uid`, `source_hash` y `version` preparados para sincronización diferencial, como en el flujo de NexMIR.

## Ejemplos integrados

La carpeta `data/` incluye dos ejemplos generados a partir de los archivos proporcionados:

- `sample_bioetica1.json` — Banco Histórico Bioética 1, 39 preguntas.
- `sample_simulacro1.json` — Simulacro 1, 200 preguntas.

En el panel **Admin → Importar** hay botones para cargar estos ejemplos en la previsualización y luego enviarlos a Supabase.

Las imágenes detectadas en el Simulacro 1 fueron extraídas a `assets/question-images/`.

---

# Instalación paso a paso

## 1. Crear Supabase

Crea un proyecto gratuito en Supabase.

En el panel de Supabase abre **SQL Editor**, crea una consulta nueva y pega todo el contenido de:

`supabase/schema.sql`

Ejecuta el script completo.

Esto crea las tablas, políticas RLS, buckets de Storage y funciones necesarias.

## 2. Crear tu usuario administrador

Abre BANQO, crea tu cuenta normalmente y confirma el correo si tu proyecto de Supabase exige confirmación.

Luego ve a **Supabase → SQL Editor** y ejecuta:

```sql
select id, email from auth.users;
```

Busca tu `id` y luego:

```sql
update public.profiles
set role = 'admin', plan = 'admin'
where id = 'PEGA-AQUI-TU-UUID';
```

Cierra sesión en BANQO y vuelve a entrar.

Ahora aparecerá **Admin** en la barra superior.

## 3. Conectar BANQO con Supabase

Tienes dos maneras.

### Opción A — recomendada para GitHub Pages

Edita:

`assets/config.js`

Y rellena:

```js
export const DEFAULT_SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY = 'TU-ANON-KEY';
```

**Nunca pongas la `service_role` key en el frontend.**

### Opción B — para probar rápido

Deja `config.js` vacío.

La primera vez que abras BANQO aparecerá una pantalla para pegar la URL y la anon key. Se guardarán en `localStorage` de ese navegador.

## 4. Probar localmente

No abras `index.html` directamente con doble clic porque los módulos ES funcionan mejor desde HTTP.

Desde la carpeta del proyecto puedes ejecutar:

```bash
python -m http.server 8000
```

Y abrir:

`http://localhost:8000`

## 5. Publicar gratis en GitHub Pages

Sube todo el contenido de esta carpeta a un repositorio de GitHub.

Luego:

**Settings → Pages → Build and deployment → Deploy from a branch → main / root**

GitHub mostrará una URL similar a:

`https://tuusuario.github.io/banqo/`

---

# Flujo de carga recomendado

## Banco temático

Ejemplo:

- Tipo: `BANCO`
- Examen: `RESIDENTADO`
- Nombre: `Banco Histórico - Bioética 1`
- Prefijo: `BIO1`
- Especialidad: `Salud Pública y Gestión`
- Tema: `Bioética y Deontología`

Subes el PDF/XLSX → **Analizar archivo** → revisar errores → **Importar a Supabase**.

Las preguntas quedan `PENDIENTE`.

Después:

**Admin → Preguntas → Editar → Aprobar/Publicar**.

## Simulacro

Ejemplo:

- Tipo: `SIMULACRO`
- Examen: `RESIDENTADO`
- Nombre: `Simulacro 1`
- Prefijo: `SIM1`
- Duración: la que corresponda al simulacro que estés cargando.

Al importar, BANQO crea automáticamente:

- las preguntas;
- el `simulation_set`;
- el orden de las preguntas;
- el estado `BORRADOR`.

Cuando termines la revisión:

**Admin → Simulacros → Publicar**.

---

# Formato PDF soportado actualmente

El importador PDF v1 está optimizado para solucionarios como los ejemplos proporcionados:

- preguntas numeradas `1.`, `2.`, `3.`…;
- alternativas `A.`, `B.`, `C.`, etc.;
- respuesta correcta con fondo verde claro;
- dos columnas por página también son compatibles.

El detector rasteriza la página en el navegador y busca el resaltado verde detrás de la alternativa correcta.

Como medida de seguridad editorial:

- el PDF nunca publica directamente;
- se muestra una previsualización;
- las preguntas sin clave o con imagen pendiente se marcan;
- todo se guarda inicialmente como `PENDIENTE`.

## Imágenes

El importador web detecta por texto preguntas que probablemente requieren una imagen, pero en esta versión **no recorta automáticamente la imagen del PDF**. Se marca la incidencia para que el admin cargue la imagen antes de publicar.

Los dos ejemplos integrados sí incluyen las imágenes que se pudieron extraer durante la construcción del proyecto.

---

# Qué heredamos de NexMIR

BANQO v1 ya incorpora la lógica que más valor daba al flujo de NexMIR, adaptada a Perú:

- jerarquía **especialidad → tema → subtema → apartado**;
- contenido editable y versionable;
- `source_uid` y `source_hash` para detectar cambios;
- estado editorial antes de publicar;
- revisión humana obligatoria;
- importación masiva;
- banqueo filtrado;
- simulacros;
- errores/favoritas/marcadas/notas;
- persistencia del examen;
- administración separada del alumno.

Los siguientes módulos están preparados como evolución natural, pero no requieren pagar para diseñarlos:

- **Mis errores** como banqueo específico;
- diagnóstico inicial y calendario de estudio;
- “Mi plaza soñada” con cortes históricos por especialidad/sede;
- teoría, flashcards y repasos conectados a la misma jerarquía;
- pregunta gemela con IA;
- clasificación médica automática al importar;
- explicación automática cuando falte;
- extracción automática de imágenes desde PDF en el navegador;
- dashboard por especialidad/tema y dificultad dinámica.


---

# Mejoras de esta versión frente al prototipo local

- **Mis errores**: genera un nuevo banqueo a partir de preguntas falladas anteriormente.
- **Reportes administrables**: el alumno puede reportar una pregunta y el admin abrirla, revisarla y resolver el reporte.
- **Límite Free de 15 preguntas/día también en Supabase**: no depende únicamente del botón del navegador.
- **Un dispositivo por cuenta**: la reclamación del dispositivo se hace mediante una función controlada en Supabase; admin queda exento.
- **Seguridad de roles**: un alumno no puede cambiar desde el navegador su `role` o `plan` a `admin`.
- **Sincronización diferencial de importaciones**:
  - `NUEVA`: no existía en BANQO;
  - `MODIFICADA`: mismo ID, pero cambió el hash del contenido;
  - `SIN_CAMBIOS`: se omite para no pisar una pregunta ya revisada;
  - `AUSENTE`: estaba en ese banco en Supabase pero no aparece en el nuevo archivo. Se informa, no se archiva automáticamente.
- **Versionado**: antes de sobrescribir una pregunta modificada se guarda la versión anterior en `question_versions`.
- **Simulacro seguro editorialmente**: se crea como `BORRADOR`; las preguntas importadas quedan `PENDIENTE`.
- **Confirmación antes de iniciar un simulacro** y persistencia de la sesión en curso.

## Nota de seguridad

La `anon/publishable key` de Supabase sí puede estar en un frontend público cuando las políticas RLS están bien configuradas. **Nunca** publiques la `service_role` key.

El esquema incluye RLS para que:

- el alumno solo vea preguntas `PUBLICADA`;
- el alumno solo vea/modifique sus propios intentos, notas, favoritas y sesiones;
- solo `admin` importe, edite o publique contenido;
- los archivos de importación queden en un bucket privado;
- los roles/planes no sean autoasignables por un alumno.

## Estado del importador PDF

El detector de PDF resaltado está pensado para el formato de los solucionarios entregados. Funciona como una primera capa de extracción y **siempre exige revisión humana**. No debe considerarse un OCR médico infalible.

En particular, la detección de imágenes del importador web es conservadora: marca expresiones como “se adjunta”, “siguiente imagen” o “imagen adjunta”. Los ejemplos integrados fueron revisados durante la creación del proyecto y contienen sus recursos locales cuando estaban disponibles.
