# facilita-ofertas-bot 🛍️

Sistema automatizado de **ofertas y compras por encargo** desde tiendas de EE.UU. hacia clientes en Costa Rica.

**Costo operativo: \$0/mes** | Stack 100% capa gratuita

---

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────┐
│  PC LOCAL (Windows) — AGY Desktop                   │
│  • filtrar_ofertas.py  → Lee Gmail, filtra con IA   │
│  • Edge MCP           → Valida stock/tallas         │
│  • D1 MCP             → Consulta/actualiza BD       │
└──────────────────┬──────────────────────────────────┘
                   │ Cloudflare D1 (SQLite en la nube)
┌──────────────────▼──────────────────────────────────┐
│  NUBE 24/7 — Cloudflare Workers                     │
│  • telegram-worker/   → Bot Telegram multiusuario   │
│  • Cerebro: Gemini API (fallback entre modelos)     │
└─────────────────────────────────────────────────────┘
```

## 📁 Estructura del Repositorio

```
ofertasbot/
├── telegram-worker/          # Cloudflare Worker (bot Telegram)
│   ├── src/index.js          # Código principal del Worker
│   ├── wrangler.toml         # Configuración de Cloudflare
│   └── package.json
├── schema.sql                # Esquema de base de datos D1
├── filtrar_ofertas.py        # (próximo) Motor de filtrado Python
└── README.md
```

## 🚀 Setup Rápido

### Prerrequisitos
- Node.js ≥ 18 (`nvm install 20`)
- Wrangler CLI (`npm install -g wrangler`)
- Cuenta Cloudflare (gratis)

### 1. Autenticarse
```bash
wrangler login
```

### 2. Crear la base de datos D1
```bash
wrangler d1 create ofertasbot-db
# Copia el database_id que devuelve y ponlo en telegram-worker/wrangler.toml
```

### 3. Crear las tablas
```bash
cd ofertasbot
wrangler d1 execute ofertasbot-db --remote --file=schema.sql
```

### 4. Configurar los parámetros operativos en D1

El bot y Sale Hunter requieren estas cuatro claves en la tabla `configuracion`:
`tipo_cambio_crc`, `flete_libra_usd`, `margen_ganancia` y `peso_default_lbs`.
Provisiónalas con los valores vigentes de FacilitaCR directamente en la base de datos;
los esquemas no incluyen valores operativos y la aplicación no usa valores de respaldo.
Reemplaza cada marcador antes de ejecutar:

```bash
wrangler d1 execute ofertasbot-db --remote --command="INSERT INTO configuracion (clave, valor) VALUES ('tipo_cambio_crc', '<valor>'), ('flete_libra_usd', '<valor>'), ('margen_ganancia', '<valor>'), ('peso_default_lbs', '<valor>') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_el = datetime('now');"
```

Los valores deben ser números positivos, excepto el flete y el margen que pueden ser cero.
El margen se almacena como proporción decimal. Si falta una clave o su valor no es válido,
el bot lo informa y Sale Hunter detiene el cálculo en lugar de aplicar un respaldo.

### 5. Instalar dependencias del Worker
```bash
cd telegram-worker
npm install
```

### 6. Subir secretos
```bash
wrangler secret put TELEGRAM_BOT_TOKEN    # Token de @BotFather
wrangler secret put GEMINI_API_KEY        # De aistudio.google.com/apikey
wrangler secret put TELEGRAM_ALLOWED_IDS  # Tu ID de Telegram (ver @userinfobot)
```

### 7. Desplegar
```bash
wrangler deploy
```

### 8. Registrar webhook de Telegram
```
https://api.telegram.org/bot<TU_TOKEN>/setWebhook?url=<URL_DEL_WORKER>
```

---

## 🔧 Variables de Entorno / Secretos

| Variable | Descripción | Cómo obtenerla |
|----------|-------------|----------------|
| `TELEGRAM_BOT_TOKEN` | Token del bot | @BotFather en Telegram |
| `GEMINI_API_KEY` | API Key de Google AI | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GROQ_API_KEY` | Credencial para el proveedor de respaldo Groq | Consola de Groq |
| `OPENROUTER_API_KEY` | Credencial para el proveedor de respaldo OpenRouter | Consola de OpenRouter |
| `GEMINI_FREE_MODEL_IDS` | IDs de Google confirmados para la política gratuita, separados por coma | Confirmar en cuenta/plan de Google |
| `GROQ_FREE_MODEL_IDS` | IDs de Groq aprobados explícitamente bajo política gratuita, separados por coma | Confirmar en cuenta/plan de Groq |
| `TELEGRAM_ALLOWED_IDS` | IDs autorizados (CSV) | @userinfobot en Telegram |

Para ejecutar `ai-fallback` localmente, configura los proveedores que quieras usar en variables de entorno o en `.env` (copiado de `.env.example`). Node 22 o superior carga `.env` desde la raíz del proyecto mediante `process.loadEnvFile`; con versiones anteriores, exporta las variables al entorno. `.env` está excluido por `.gitignore`; `.env.example` solo contiene valores vacíos. El orden de respaldo es Google → Groq → OpenRouter. Si no hay credenciales configuradas, el módulo informa qué variables faltan sin intentar llamar a un proveedor.

## 🧠 Catálogo de modelos IA

El catálogo consultable se guarda en las tablas `ai_model_catalog` y
`ai_model_catalog_status` de D1. Aplica la actualización del esquema antes del primer
refresco:

```bash
wrangler d1 execute facilita-cr --remote --config=database/wrangler.toml --file=database/schema.sql
```

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

```bash
wrangler d1 execute facilita-cr --remote --config=database/wrangler.toml --file=database/migrations/20261124_ai_model_ranking.sql
```

Para instalaciones que ya aplicaron la migración de ranking, aplica también una sola vez
`database/migrations/20261124_model_eligibility.sql`. Esta restringe el rango a 1–5,
convierte las prioridades anteriores 6–7 en standby y añade estado/error de funcionalidad.
Una respuesta 404 o una respuesta vacía/malformada excluye ese modelo de futuras listas de
ranking y standby; 429 se registra como límite temporal del proveedor, no como fallo
permanente del modelo.

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

Ver [`schema.sql`](schema.sql) para el esquema compartido y
[`database/schema.sql`](database/schema.sql) para el esquema de D1.

Tablas principales: `pedidos` | `historial_ofertas` | `ai_model_catalog` |
`ai_model_catalog_status`

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
