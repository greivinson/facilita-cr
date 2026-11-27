# FacilitaCR — Ofertas y compras por encargo 🛍️

Sistema para **buscar ofertas en tiendas de EE.UU., registrar pedidos y asistir a clientes de Costa Rica**.

El proyecto combina un bot de Telegram en Cloudflare Workers, una base de datos compartida D1,
herramientas locales de búsqueda de ofertas y un módulo de IA con selección explícita de modelos.
Los costos y límites dependen de los planes vigentes de Cloudflare y de cada proveedor externo.

---

## 🏗️ Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│  HERRAMIENTAS LOCALES                                    │
│  • sale-hunter/   → Ofertas Adidas, tallas y manifiesto  │
│  • image-downloader → Descarga individual/en lote        │
│  • ai-fallback/   → Cascada IA y catálogo de modelos     │
│  • database/      → Esquema, migraciones y utilidades D1 │
└───────────────────────┬──────────────────────────────────┘
                        │ Cloudflare D1
┌───────────────────────▼──────────────────────────────────┐
│  CLOUDFLARE WORKERS                                      │
│  • telegram-worker/ → Bot de Telegram multiusuario      │
│  • usa D1 para pedidos, configuración y modelos aprobados│
└──────────────────────────────────────────────────────────┘
```

## 📁 Estructura del Repositorio

```
facilita-cr/
├── telegram-worker/
│   ├── src/index.js              # Webhook y comandos de Telegram
│   ├── wrangler.toml             # Worker y binding D1
│   └── package.json              # Wrangler local
├── sale-hunter/
│   ├── hunters/adidas.js         # Búsqueda PLP, precios y disponibilidad
│   ├── image-downloader.js       # Descarga y conversión individual/en lote
│   ├── index.js                  # Orquestación y sincronización D1
│   └── package.json              # Node y Sharp
├── ai-fallback/
│   ├── providers/                # Adaptadores Google, Groq y OpenRouter
│   ├── refresh-model-catalog.js  # Descubre, valida y clasifica modelos
│   └── index.js                  # Cascada de inferencia
├── database/
│   ├── schema.sql                # Esquema oficial D1
│   ├── migrations/               # Evolución del esquema
│   └── package.json              # Comandos de administración D1
├── shared/
│   ├── d1.js                     # Adaptador D1 para los procesos locales
│   ├── config.js                 # Validación de configuración operativa
│   └── model-catalog.js          # Selección compartida de modelos IA
├── schema.sql                    # Esquema reducido anterior; no sustituye al oficial
├── .env.example                  # Plantilla sin credenciales
├── .nvmrc                        # Versión local recomendada: 22.23.5
└── README.md
```

`database/` se reserva para estructura y mantenimiento de D1. La lógica reutilizada por el Worker,
Sale Hunter y ai-fallback está en `shared/`; `shared/d1.js` contiene el adaptador de ejecución,
no definiciones de esquema.

## 🚀 Setup Rápido

### Prerrequisitos
- Node.js **22.12 o superior** para las herramientas locales. `.nvmrc` fija `22.23.5`.
- npm y una cuenta Cloudflare con acceso al D1 `facilita-cr`.
- Wrangler se instala como dependencia local de `telegram-worker`; no hace falta instalarlo globalmente.

En Windows con NVM for Windows:

```powershell
nvm use 22.23.5
node --version
```

El entorno de desarrollo usado para estos cambios ya tiene Node `22.23.5`. El Worker desplegado
se ejecuta en el runtime de Cloudflare; el requisito de Node aplica a las herramientas locales.

### Instalar dependencias locales

Instala dependencias en los subproyectos que declaran dependencias npm:

```powershell
cd telegram-worker
npm ci
cd ..\sale-hunter
npm ci
cd ..
```

`ai-fallback` y `database` no declaran dependencias npm propias. El cliente D1 de `database`
invoca Wrangler desde la instalación local de `telegram-worker`.

### Configurar Cloudflare D1

El D1 compartido se llama `facilita-cr`; sus identificadores están en
[`telegram-worker/wrangler.toml`](telegram-worker/wrangler.toml) y
[`database/wrangler.toml`](database/wrangler.toml). No crees otra base de datos si vas a usar
la existente. Ejecuta los comandos de Wrangler desde `telegram-worker` para usar la dependencia
local:

```powershell
cd telegram-worker
npx wrangler login
```

El esquema oficial está en [`database/schema.sql`](database/schema.sql). Para una base nueva,
revísalo y aplícalo una vez:

```powershell
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --file=..\database\schema.sql
```

`database/schema.sql` es el esquema completo que usa Sale Hunter y la tabla de modelos IA.
El [`schema.sql`](schema.sql) de la raíz es un esquema reducido con otra forma de historial de
ofertas; no lo mezcles con el esquema oficial ni lo uses como reemplazo de `database/schema.sql`.

Para instalaciones existentes, aplica una sola vez las migraciones en orden:
`20261124_ai_model_ranking.sql`, `20261124_model_eligibility.sql` y, al final,
`20261127_catalogo_ia_nombres_es_y_observaciones.sql`. Las dos primeras conservan los nombres
anteriores porque son migraciones históricas; la última renombra las tablas IA sin perder sus
datos y crea las tablas de corridas/productos/observaciones. No vuelvas a ejecutar una migración
ya aplicada.
La migración deja vistas de solo lectura con los nombres IA anteriores para mantener compatibilidad
con versiones del Worker aún no desplegadas; las tablas reales quedan en español.

Desde `telegram-worker`, el orden para una base que aún no ha recibido esas migraciones es:

```powershell
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --file=..\database\migrations\20261124_ai_model_ranking.sql
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --file=..\database\migrations\20261124_model_eligibility.sql
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --file=..\database\migrations\20261127_catalogo_ia_nombres_es_y_observaciones.sql
```

Aplica la última migración antes de desplegar el código que consulta los nombres nuevos.

El bot y Sale Hunter requieren estas claves en la tabla `configuracion`:
`tipo_cambio_crc`, `flete_libra_usd`, `margen_ganancia` y `peso_default_lbs`.
Provisiónalas con valores vigentes; el código no usa valores de respaldo cuando faltan o no
son válidos. Sustituye los marcadores antes de ejecutar:

```powershell
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --command="INSERT INTO configuracion (clave, valor) VALUES ('tipo_cambio_crc', '<valor>'), ('flete_libra_usd', '<valor>'), ('margen_ganancia', '<valor>'), ('peso_default_lbs', '<valor>') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_el = datetime('now');"
```

Los valores deben ser números positivos, excepto el flete y el margen, que pueden ser cero.
El margen se almacena como proporción decimal.

### Desplegar el bot de Telegram

Desde `telegram-worker`, configura secretos con Wrangler y despliega:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_ALLOWED_IDS
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

Después de desplegar, registra en Telegram el webhook `https://api.telegram.org/bot<TU_TOKEN>/setWebhook?url=<URL_DEL_WORKER>`.

### Sale Hunter de Adidas

Hay dos formas de ejecutarlo. `npm run hunt:adidas` ejecuta la prueba independiente del
provider (50% de descuento mínimo, una página) y guarda el manifiesto, pero no sincroniza D1.
Para la corrida orquestada con configuración y sincronización a D1, ejecuta desde la raíz:

```powershell
cd sale-hunter
npm start
cd ..
```

Para una consulta independiente:

```powershell
cd sale-hunter
npm run hunt:adidas
cd ..
```

La corrida orquestada usa `top-sellers`, cuatro páginas por defecto (48 artículos por página,
hasta 192 productos) y un descuento mínimo de 45%. El provider deduplica y ordena los candidatos
antes de consultar disponibilidad; verifica tallas solo para las 30 mejores ofertas, con pausas
de 300–800 ms. La ejecución independiente usa sus valores de prueba: una página y 50% mínimo.

Una respuesta 403/429 detiene toda la corrida; las fallas de tallas se conservan como
`sizesChecked: false`. Las peticiones tienen timeout de 10 segundos y el `buildId` se renueva una
vez si el listado devuelve 404; no hay buildId fijo de respaldo. Los precios exclusivos para
miembros se omiten por defecto. El filtro `sale_percentage_en_us` no está habilitado porque falta
confirmar que el endpoint actual lo acepte.

Si una etapa falla, Sale Hunter crea un JSON por corrida en `sale-hunter/logs/`, indicando
hunter, etapa, mensaje, URL saneada y, cuando existe, estado HTTP, encabezados diagnósticos
seleccionados y hasta 4 KB del cuerpo de respuesta. No registra encabezados de solicitud,
cookies ni credenciales. La carpeta está excluida de Git.

Las ofertas se sincronizan con D1 en `ofertas`; los triggers registran cambios de precio en
`ofertas_historial_precios`. Cada corrida también se guarda en `corridas_escaneo`; la identidad
estable es proveedor + mercado + ID externo en `productos_tienda`, sus tallas/SKU se registran en
`variantes_producto` y cada precio visto se conserva en `observaciones_producto`. Así se puede
consultar el mínimo histórico sin usar el precio como identidad del producto. `membersOnly`,
`sizesChecked`, tallas y el precio se guardan por observación; un valor de disponibilidad nulo
significa que no se pudo verificar el inventario.

La corrida escribe un manifiesto de hasta 30 promociones, incluyendo `scanRunId`, `scanStatus`,
URL de producto y URL de imagen, en la ruta siguiente. Un bloqueo 403/429 se refleja en el estado
del manifiesto y el comando termina con código de error; no se presenta como una corrida exitosa:

```text
C:\Users\angec\OneDrive\Documents\Facilita-CR\adidas\YYYY-MM-DD\promos.json
```

Define `ADIDAS_EXPORT_DIR` para cambiar la carpeta raíz. El escaneo **no descarga imágenes
automáticamente**: la descarga queda desacoplada para que un error o timeout de imágenes no
interrumpa la consulta de tiendas.

### Downloader de imágenes

[`sale-hunter/image-downloader.js`](sale-hunter/image-downloader.js) exporta `downloadImage`
para una URL y `downloadImages` para un array. Solo acepta URLs HTTPS de hosts públicos,
limita cada imagen original a 10 MB y cada petición HTTP a 10 segundos por defecto.
Convierte imágenes JPEG, PNG, GIF, WebP o AVIF a JPG (calidad 80 por defecto) o PNG, limitando
las dimensiones a 1600 × 1600 para reducir el tamaño. El paralelismo predeterminado es 2.
Los resultados incluyen el éxito o el error de cada URL; no se reintentan bloqueos ni errores.

Ejemplo desde la raíz en PowerShell:

```powershell
$destino = "C:\Users\angec\OneDrive\Documents\Facilita-CR\adidas\2026-11-26"
node .\sale-hunter\image-downloader.js --batch jpg $destino "https://sitio-publico.example/imagen1.webp" "https://sitio-publico.example/imagen2.avif"
```

Para importarlo desde un módulo dentro de `sale-hunter`:

```js
import { downloadImages } from './image-downloader.js';

const results = await downloadImages(urls, destinationDirectory, {
  format: 'jpg',
  quality: 80,
  concurrency: 2,
  timeoutMs: 10_000,
});
```

El downloader usa Sharp para decodificar, redimensionar y volver a codificar la imagen. Esa
dependencia requiere Node 20.9+, y Wrangler 4.166 requiere Node 22.12+; por eso el proyecto
estandariza en Node 22.12 o superior.

### Job de imágenes para AGY

[`image-job/`](image-job) es un job independiente que consume el manifiesto sin consultar de nuevo
la tienda. Instala primero las dependencias del downloader compartido y ejecútalo con la ruta
explícita del manifiesto:

```powershell
cd sale-hunter
npm ci
cd ..\image-job
npm run download -- "C:\Users\angec\OneDrive\Documents\Facilita-CR\adidas\YYYY-MM-DD\promos.json" jpg
```

Por defecto, las imágenes y un reporte JSON quedan junto al manifiesto, dentro de la carpeta
`adidas\YYYY-MM-DD`. El job omite archivos ya descargados con la misma URL, intenta de nuevo los
fallidos y sale con código distinto de cero si alguna descarga falla. También puede usar PNG:

```powershell
npm run download -- "C:\ruta\promos.json" png
```

Recomendación de ejecución: mantenerlo como etapa posterior y desacoplada. AGY puede invocar
`node image-job/index.js <manifestPath> jpg` cuando `npm start` termine, o correrlo/schedulearlo
por separado para reintentar sin volver a escanear Adidas. No lo ejecutes dentro del provider ni
bloquees el guardado de ofertas por un fallo de imágenes.

---

## 🔧 Variables de Entorno / Secretos

| Variable | Descripción | Cómo obtenerla |
|----------|-------------|----------------|
| `TELEGRAM_BOT_TOKEN` | Token del bot desplegado | @BotFather; guardar como secreto de Wrangler |
| `TELEGRAM_ALLOWED_IDS` | IDs de Telegram autorizados, separados por coma | @userinfobot; secreto de Wrangler |
| `GEMINI_API_KEY` | Credencial de Google AI | [Google AI Studio](https://aistudio.google.com/apikey); secreto del Worker y entorno local |
| `GROQ_API_KEY` | Credencial para la cascada local | Consola de Groq; entorno local |
| `OPENROUTER_API_KEY` | Credencial para la cascada local | Consola de OpenRouter; entorno local |
| `GEMINI_FREE_MODEL_IDS` | IDs de Google aprobados explícitamente como gratuitos | Verificar plan/cuota de Google; entorno local |
| `GROQ_FREE_MODEL_IDS` | IDs de Groq aprobados explícitamente como gratuitos | Verificar plan/cuota de Groq; entorno local |
| `MODEL_RANKER_PROVIDER` | Proveedor del ranker (`google`, `groq` u `openrouter`) | Entorno local/programado |
| `MODEL_RANKER_MODEL_ID` | ID de un modelo activo y aprobado del catálogo | Entorno local/programado |

Para ejecutar `ai-fallback` localmente, configura las credenciales necesarias en el entorno o
en `.env` (copiado de `.env.example`). Node 22.12 o superior carga `.env` desde la raíz mediante
`process.loadEnvFile`. `.env` está excluido por `.gitignore`; no guardes credenciales en el
repositorio. El orden de respaldo es Google → Groq → OpenRouter. Si faltan credenciales, el
módulo informa qué variables hacen falta sin llamar a los proveedores.

## 🧠 Catálogo de modelos IA

El catálogo consultable se guarda en las tablas `catalogo_modelos_ia` y
`estado_catalogo_modelos_ia` de D1. Antes del primer refresco, asegúrate de haber aplicado
[`database/schema.sql`](database/schema.sql) desde `telegram-worker`, como se describe en
[Configurar Cloudflare D1](#configurar-cloudflare-d1).

El proceso consulta los catálogos oficiales con `GEMINI_API_KEY`, `GROQ_API_KEY` y
`OPENROUTER_API_KEY` tomados del entorno. Los catálogos de Google y Groq no informan precio
ni cuota del plan, así que **no se consideran gratuitos por defecto** y no se usan para
inferir hasta que sus IDs se incluyan explícitamente en `GEMINI_FREE_MODEL_IDS` o
`GROQ_FREE_MODEL_IDS`, respectivamente. Verifica esos IDs contra la cuenta/plan antes de
autorizarla; en Groq, la API de modelos no permite inferir si el uso queda dentro de una
cuota gratuita. OpenRouter solo autoriza modelos texto→texto cuyo precio de entrada y
salida el endpoint publica exactamente como cero. Nunca se fabrican entradas para llegar
a diez si el proveedor devuelve menos modelos elegibles. D1 conserva como máximo los
primeros 10 candidatos de texto por proveedor; `is_free=1` solo expresa la política de
autorización anterior.

Ejemplo de política explícita para el proceso programado (IDs reales separados por coma;
no incluir claves aquí):

```text
GEMINI_FREE_MODEL_IDS=<google-model-id>,<another-google-model-id>
GROQ_FREE_MODEL_IDS=<groq-model-id>,<another-groq-model-id>
```

Después de un primer refresco exitoso, configura el ranker IA únicamente con un modelo que
ya esté activo y aprobado como gratuito en el catálogo:

```text
MODEL_RANKER_PROVIDER=google|groq|openrouter
MODEL_RANKER_MODEL_ID=<exact-model-id-from-approved-catalog>
```

El ranker ordena por separado hasta 7 candidatos elegibles de cada proveedor según el uso
de FacilitaCR: calidad en español, generación de texto fiable, contexto suficiente y coste
publicado cuando esté disponible. La salida se valida contra los IDs recibidos. Guarda
hasta 5 prioridades (1 = primera opción) y hasta 2 como standby; se permiten menos de 5
prioridades. La inferencia intenta primero los rankeados y luego los standby. Sin un ranker
explícito, aprobado y disponible, no se inventa una clasificación ni se elige por heurística:
se preserva la prioridad anterior, las opciones nuevas quedan sin ranking y el resultado
indica `ranking_status`. En un D1 vacío, se requiere un primer refresco de catálogo y una
segunda ejecución con ranker configurado para crear la primera clasificación.

Ejecuta el refresco manual desde la raíz del proyecto:

```bash
node ai-fallback/refresh-model-catalog.js
```

Para automatizarlo semanalmente, configura en AGY `/schedule` que ejecute ese comando
desde la raíz, con las variables de entorno privadas disponibles y Wrangler autenticado.
El script escribe en el D1 remoto `facilita-cr`; no se debe ejecutar hasta aplicar el
esquema/migración y habilitar intencionalmente esa escritura. Para instalaciones existentes,
aplica una sola vez:

```powershell
cd telegram-worker
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --file=..\database\migrations\20261124_ai_model_ranking.sql
cd ..
```

Para instalaciones que ya aplicaron la migración de ranking, aplica también una sola vez
`database/migrations/20261124_model_eligibility.sql`. Esta restringe el rango a 1–5,
convierte las prioridades anteriores 6–7 en standby y añade estado/error de funcionalidad.
Una respuesta 404 o una respuesta vacía/malformada excluye ese modelo de futuras listas de
ranking y standby; 429 se registra como límite temporal del proveedor, no como fallo
permanente del modelo.

```powershell
cd telegram-worker
npx wrangler d1 execute facilita-cr --remote --config=..\database\wrangler.toml --file=..\database\migrations\20261124_model_eligibility.sql
```

El Worker de Telegram no consulta los endpoints de proveedores: usa solo modelos Google
aprobados en D1, primero rankeados y después standby. `/modelos` muestra ranking, standby,
candidatos excluidos por falta de verificación gratuita o falla funcional y estado del
ranker. `ai-fallback` aplica la misma selección y cachea el catálogo D1 por una hora.

El historial local se añade como JSONL a
`ai-fallback/history/model-catalog-history.jsonl` (ruta excluida por `.gitignore`). Cada
registro incluye fecha, proveedores, hasta 7 candidatos, evidencia de elegibilidad,
prioridades/standby, estado de ranking/refresco y errores saneados; no guarda claves ni
prompts. Se conservan las últimas 2,000 entradas en el mismo archivo.

La cascada de inferencia conserva el orden Google → Groq → OpenRouter. Un modelo 404 se
omite; un 429 y errores de autenticación saltan al siguiente proveedor; errores de
solicitud 4xx no recuperables se detienen; fallas transitorias de red/5xx se reintentan
una vez. Los registros incluyen proveedor, modelo, estado/código y acción de fallback,
pero no credenciales ni contenido de solicitudes.

## 💬 Comandos del Bot

| Comando / Mensaje | Acción |
|-------------------|--------|
| `/start` | Mensaje de bienvenida |
| "Nuevo pedido para [cliente]" | Inicia registro de pedido |
| "¿Qué debe [cliente]?" | Consulta saldos de un cliente |
| "¿Quién tiene saldo pendiente?" | Lista pedidos sin pagar |
| "Abono de ₡50,000 al pedido #3" | Registra un abono |
| "Pedido #5 ya fue entregado" | Actualiza estado |

## 📊 Base de Datos (Cloudflare D1)

El esquema oficial usado por la aplicación está en
[`database/schema.sql`](database/schema.sql); los cambios evolutivos están en
[`database/migrations/`](database/migrations/). El `schema.sql` de la raíz conserva un esquema
reducido anterior y no sustituye al esquema oficial.

Tablas principales: `pedidos`, `ofertas`, `ofertas_historial_precios`,
`corridas_escaneo`, `productos_tienda`, `variantes_producto`, `observaciones_producto`,
`tipo_cambio_diario`, `configuracion`, `catalogo_modelos_ia` y `estado_catalogo_modelos_ia`.

---

## 🔌 MCP para AGY Desktop

Agrega esto a tu `mcp_config.json` en AGY:

```json
{
  "mcpServers": {
    "cloudflare-d1": {
      "command": "npx",
      "args": ["@cloudflare/mcp-server-cloudflare", "d1",
               "--database-id", "TU_DATABASE_ID",
               "--account-id", "TU_ACCOUNT_ID"],
      "env": { "CLOUDFLARE_API_TOKEN": "TU_API_TOKEN" }
    },
    "edge-browser": {
      "command": "npx",
      "args": ["@playwright/mcp", "--browser", "msedge"]
    }
  }
}
```
