// ============================================================
// FacilitaCR — Cloudflare Worker + Telegram + D1 + Gemini AI
// Sistema de compras por encargo USA -> Costa Rica
// Versión: 3.0 (Descubrimiento Dinámico de Modelos Flash/Lite)
// Costo operativo: $0/mes | 100% Nativo Google AI
// ============================================================

import {
  OPERATIONAL_CONFIG_KEYS,
  parseOperationalSetting,
  parseOperationalSettings,
} from "../../shared/config.js";
import {
  selectInferenceFreeTextModels,
  selectRankedFreeTextModels,
} from "../../shared/model-catalog.js";

async function getCandidateModels(db, provider = "google") {
  const rows = await db
    .prepare(
      `SELECT provider, model_id, supports_text, active, is_free, priority_rank,
              ranking_status, functional_status, catalog_order
       FROM catalogo_modelos_ia
       WHERE provider = ? AND active = 1 AND supports_text = 1 AND is_free = 1
         AND functional_status != 'failed'
         AND (priority_rank BETWEEN 1 AND 5 OR ranking_status = 'standby')
       ORDER BY CASE WHEN priority_rank BETWEEN 1 AND 5 THEN 0 ELSE 1 END,
                priority_rank, catalog_order LIMIT 7`
    )
    .bind(provider)
    .all();
  return selectInferenceFreeTextModels(rows.results || [], provider);
}

async function getAvailableCatalogModels(db) {
  const rows = await db
    .prepare(
      `SELECT provider, model_id, supports_text, active, is_free, catalog_order,
              priority_rank, ranking_status, functional_status
       FROM (
         SELECT provider, model_id, supports_text, active, is_free, catalog_order,
                priority_rank, ranking_status, functional_status,
                ROW_NUMBER() OVER (PARTITION BY provider ORDER BY catalog_order) AS candidate_number
         FROM catalogo_modelos_ia
         WHERE active = 1 AND supports_text = 1
       )
       WHERE candidate_number <= 7
       ORDER BY CASE provider WHEN 'google' THEN 1 WHEN 'groq' THEN 2 ELSE 3 END,
                COALESCE(priority_rank, 99), catalog_order`
    )
    .all();
  return rows.results || [];
}

async function getModelCatalogStatus(db) {
  const rows = await db
    .prepare(
      `SELECT provider, status, last_attempt_at, last_success_at, model_count, error_code, error_message,
              ranking_status, ranker_provider, ranker_model_id, ranking_error
       FROM estado_catalogo_modelos_ia ORDER BY provider`
    )
    .all();
  return rows.results || [];
}

// ── Leer configuración de D1 ──────────────────────────────────────────────
async function getConfig(db) {
  const keys = OPERATIONAL_CONFIG_KEYS.map((key) => `'${key}'`).join(", ");
  const rows = await db
    .prepare(`SELECT clave, valor FROM configuracion WHERE clave IN (${keys})`)
    .all();
  return parseOperationalSettings(rows.results || []);
}

// ── Construir System Prompt dinámico ──────────────────────────────────────
function buildSystemPrompt(config) {
  const tc = config.tipo_cambio_crc;
  const flete = config.flete_libra_usd;
  const margen = config.margen_ganancia;
  const pesoDefault = config.peso_default_lbs;
  const margenPct = (margen * 100).toFixed(0);

  return `Eres el asistente inteligente de FacilitaCR, especializado en compras por encargo USA 🇺🇸 -> Costa Rica 🇨🇷.
Tu función es registrar pedidos, cotizar precios en colones (CRC) y gestionar clientes.

PARÁMETROS DEL NEGOCIO (D1):
- Tipo de Cambio: 1 USD = ${tc} CRC
- Flete USA -> CR: $${flete} USD por libra
- Margen Comercial: ${margenPct}% (${margen})
- Peso predeterminado: ${pesoDefault} lbs

CÁLCULO DEL TOTAL EN CRC:
  peso_libras = peso proporcionado o ${pesoDefault}
  costo_usd = precio_usd + (peso_libras × ${flete})
  total_crc = Math.round(costo_usd × (1 + ${margen}) × ${tc})

REGLAS:
- Responde SIEMPRE en español, directo, profesional y claro.
- Para NUEVO PEDIDO: solicita los datos faltantes (cliente, producto, tienda, talla, precio USD). Si no se indica el peso, usa ${pesoDefault} lbs.
- El tipo de cambio aplicado al pedido se toma de la configuración validada en D1; nunca lo incluyas ni lo solicites como dato de la acción.
- Si el usuario te pide actualizar tipo de cambio, flete, margen o peso predeterminado, ejecuta la acción "update_config".
- Si el usuario pregunta qué modelos hay disponibles, ejecuta "query_models". El catálogo se actualiza desde el proceso programado externo.
- Para ejecutar acciones en la base de datos o sistema, incluye un bloque JSON al final:

ACCIONES DISPONIBLES:
  {"action":"insert_pedido","data":{"cliente":"...","producto":"...","tienda":"...","talla":"...","costo_usd":0,"total_crc":0,"detalles":{"peso_lbs":0,"url":"..."}}}
  {"action":"update_abono","id":X,"monto_crc":Y}
  {"action":"update_estado","id":X,"estado":"Confirmado|Enviado|Entregado|Cancelado|Pagado"}
  {"action":"query_cliente","nombre":"..."}
  {"action":"query_pendientes"}
  {"action":"query_pedido","id":X}
  {"action":"update_config","clave":"tipo_cambio_crc|flete_libra_usd|margen_ganancia|peso_default_lbs","valor":"..."}
  {"action":"query_config"}
  {"action":"query_models"}

ESTADOS VÁLIDOS: Cotizado → Confirmado → Enviado → Entregado | Pagado | Cancelado`;
}

// ── Verificar ID autorizado ───────────────────────────────────────────────
function isAuthorized(userId, env) {
  const allowed = (env.TELEGRAM_ALLOWED_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowed.includes(String(userId));
}

// ── Llamada con cascada nativa a Google Gemini API ────────────────────────
async function callGemini(candidateModels, systemPrompt, userText, env) {
  if (!env.GEMINI_API_KEY) {
    return {
      answer: "⚠️ Falta el secreto GEMINI_API_KEY del Worker. Configúralo en Cloudflare y vuelve a intentarlo.",
      modelUsed: null,
    };
  }
  if (!candidateModels.length) {
    return {
      answer: "⚠️ No hay modelos de Google activos en el catálogo D1. Ejecuta el refresco del catálogo y vuelve a intentarlo.",
      modelUsed: null,
    };
  }

  const promptPayload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `[INSTRUCCIONES INTERNAS]\n${systemPrompt}\n\n[MENSAJE DEL CLIENTE/ADMIN]\n${userText}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  };

  for (const model of candidateModels) {
    const modelPath = model.startsWith("models/") ? model : `models/${model}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY,
            },
            body: JSON.stringify(promptPayload),
          }
        );

        if (!res.ok) {
          let details = {};
          try {
            const body = await res.json();
            details = body.error || body;
          } catch {}
          const errorMessage = String(details.message || res.statusText || "Request failed")
            .replace(env.GEMINI_API_KEY, "[REDACTED]")
            .replace(/[\r\n\t]+/g, " ")
            .slice(0, 240);
          const errorCode = details.status || details.code || null;
          const logEntry = {
            provider: "google",
            model,
            status: res.status,
            error_code: errorCode,
            message: errorMessage,
          };

          if (res.status === 404) {
            console.warn("Provider model unavailable", { ...logEntry, fallback_action: "next-model" });
            break;
          }
          if (res.status === 429 || res.status === 401 || res.status === 403) {
            console.warn("Provider unavailable", {
              ...logEntry,
              fallback_action: res.status === 429 ? "stop-provider_rate_limited" : "stop-provider_auth",
            });
            return {
              answer: res.status === 429
                ? "⚠️ Google alcanzó su cuota. El catálogo no tiene otro proveedor configurado para Telegram; inténtalo más tarde."
                : "⚠️ Google rechazó la credencial del Worker. Revisa GEMINI_API_KEY en los secretos de Cloudflare.",
              modelUsed: null,
            };
          }
          if ((res.status === 408 || res.status >= 500) && attempt === 0) continue;

          const fatal = res.status < 500 && res.status !== 408;
          console.warn("Provider request rejected", {
            ...logEntry,
            fallback_action: fatal ? "stop_invalid_request" : "next-model",
          });
          if (fatal) {
            return {
              answer: "⚠️ Google rechazó la solicitud del modelo. Revisa el formato de la solicitud antes de reintentar.",
              modelUsed: null,
            };
          }
          break;
        }

        const data = await res.json();
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (answer) {
          console.log(`⚡ Modelo exitoso en la cascada: ${modelPath}`);
          return { answer, modelUsed: modelPath };
        }
        return {
          answer: "⚠️ Google respondió sin texto. Revisa el catálogo o el formato de la solicitud.",
          modelUsed: null,
        };
      } catch (err) {
        if (attempt === 0) continue;
        console.warn("Provider network failure", {
          provider: "google",
          model,
          error_code: err.name || "network_error",
          message: String(err.message || "Network error")
            .replace(env.GEMINI_API_KEY, "[REDACTED]")
            .replace(/[\r\n\t]+/g, " ")
            .slice(0, 240),
          fallback_action: "next-model",
        });
      }
    }
  }

  return {
    answer: "⚠️ No pude conectar con los modelos activos de Google en D1. Revisa el estado del catálogo y la cuota.",
    modelUsed: null,
  };
}

// ── Ejecutar acciones sobre D1 y Sistema ──────────────────────────────────
async function executeAction(action, db, env) {
  switch (action.action) {
    case "insert_pedido": {
      const d = action.data || {};
      const config = await getConfig(db);
      await db
        .prepare(
          `INSERT INTO pedidos
             (cliente, producto, tienda, talla, costo_usd, tipo_cambio_aplicado, total_crc, estado, detalles_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          d.cliente || "Sin nombre",
          d.producto || "Sin producto",
          d.tienda || "",
          d.talla || "",
          d.costo_usd || 0,
          config.tipo_cambio_crc,
          d.total_crc || 0,
          "Confirmado",
          JSON.stringify(d.detalles || {})
        )
        .run();
      return "✅ Pedido registrado en la base de datos.";
    }

    case "query_pedido": {
      const pedido = await db
        .prepare(
          `SELECT id, fecha, cliente, producto, tienda, talla, costo_usd,
                  tipo_cambio_aplicado, total_crc, abono_crc, estado, detalles_json
           FROM pedidos WHERE id = ?`
        )
        .bind(action.id)
        .first();
      if (!pedido) return `❌ Pedido #${action.id} no encontrado.`;

      const total = Number(pedido.total_crc || 0);
      const abono = Number(pedido.abono_crc || 0);
      const saldo = Math.max(0, total - abono);
      const costoUsd = Number(pedido.costo_usd || 0);
      const tipoCambio = Number(pedido.tipo_cambio_aplicado || 0);
      const formatCrc = (amount) => `₡${amount.toLocaleString("es-CR")}`;
      const formatUsd = (amount) =>
        `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      return (
        `📦 *Pedido #${pedido.id}*\n` +
        `• Fecha: ${pedido.fecha || "—"}\n` +
        `• Cliente: ${pedido.cliente}\n` +
        `• Producto: ${pedido.producto}\n` +
        `• Tienda: ${pedido.tienda || "—"} | Talla: ${pedido.talla || "—"}\n` +
        `• Costo: ${formatUsd(costoUsd)}\n` +
        `• Tipo de cambio aplicado: ₡${tipoCambio.toLocaleString("es-CR")} por USD\n` +
        `• Total: ${formatCrc(total)} | Abonado: ${formatCrc(abono)}\n` +
        `• Saldo: ${formatCrc(saldo)}\n` +
        `• Detalles: ${pedido.detalles_json || "{}"}\n` +
        `• Estado: *${pedido.estado || "—"}*`
      );
    }

    case "update_abono": {
      const pedido = await db
        .prepare("SELECT id, cliente, abono_crc, total_crc FROM pedidos WHERE id = ?")
        .bind(action.id)
        .first();
      if (!pedido) return `❌ Pedido #${action.id} no encontrado.`;
      const nuevo_abono = (pedido.abono_crc || 0) + (action.monto_crc || 0);
      const saldo = (pedido.total_crc || 0) - nuevo_abono;
      const nuevo_estado = saldo <= 0 ? "Pagado" : "Confirmado";
      await db
        .prepare("UPDATE pedidos SET abono_crc = ?, estado = ? WHERE id = ?")
        .bind(nuevo_abono, nuevo_estado, action.id)
        .run();
      return (
        `✅ Abono registrado para *${pedido.cliente}*\n` +
        `• Total abonado: ₡${nuevo_abono.toLocaleString("es-CR")}\n` +
        `• Saldo pendiente: ₡${Math.max(0, saldo).toLocaleString("es-CR")}\n` +
        `• Estado: *${nuevo_estado}*`
      );
    }

    case "update_estado": {
      const validos = ["Cotizado", "Confirmado", "Enviado", "Entregado", "Pagado", "Cancelado"];
      if (!validos.includes(action.estado)) {
        return `❌ Estado no válido. Opciones: ${validos.join(", ")}`;
      }
      const res = await db
        .prepare("UPDATE pedidos SET estado = ? WHERE id = ?")
        .bind(action.estado, action.id)
        .run();
      return res.meta.changes > 0
        ? `✅ Pedido #${action.id} actualizado a: *${action.estado}*`
        : `❌ Pedido #${action.id} no encontrado.`;
    }

    case "query_cliente": {
      const rows = await db
        .prepare(
          `SELECT id, producto, tienda, talla, total_crc, abono_crc, estado
           FROM pedidos WHERE cliente LIKE ? ORDER BY fecha DESC LIMIT 10`
        )
        .bind(`%${action.nombre}%`)
        .all();
      if (!rows.results?.length) return `No se encontraron pedidos para "${action.nombre}".`;
      return (
        `📋 *Pedidos de ${action.nombre}:*\n\n` +
        rows.results
          .map((r) => {
            const saldo = (r.total_crc || 0) - (r.abono_crc || 0);
            return (
              `📦 *#${r.id}* ${r.producto} (${r.tienda || "—"}) T:${r.talla || "—"}\n` +
              `   Total: ₡${(r.total_crc || 0).toLocaleString("es-CR")} | Saldo: ₡${Math.max(0, saldo).toLocaleString("es-CR")} | *${r.estado}*`
            );
          })
          .join("\n\n")
      );
    }

    case "query_pendientes": {
      const rows = await db
        .prepare(
          `SELECT id, cliente, producto, total_crc, abono_crc
           FROM pedidos WHERE abono_crc < total_crc AND estado != 'Cancelado'
           ORDER BY fecha DESC`
        )
        .all();
      if (!rows.results?.length) return "🎉 ¡No hay pedidos con saldo pendiente!";
      const total_pendiente = rows.results.reduce(
        (sum, r) => sum + Math.max(0, (r.total_crc || 0) - (r.abono_crc || 0)),
        0
      );
      return (
        `💰 *Pedidos con saldo pendiente (${rows.results.length}):*\n\n` +
        rows.results
          .map((r) => {
            const saldo = (r.total_crc || 0) - (r.abono_crc || 0);
            return `#${r.id} *${r.cliente}* — ${r.producto}\n   Saldo: ₡${saldo.toLocaleString("es-CR")}`;
          })
          .join("\n\n") +
        `\n\n*Total por cobrar:* ₡${total_pendiente.toLocaleString("es-CR")}`
      );
    }

    case "update_config": {
      const clave = typeof action.clave === "string" ? action.clave.trim() : "";
      if (!OPERATIONAL_CONFIG_KEYS.includes(clave)) {
        throw new Error(`Configuración no reconocida: ${clave || "(vacía)"}`);
      }
      const valor = String(parseOperationalSetting(clave, action.valor));
      await db
        .prepare(
          `INSERT INTO configuracion (clave, valor, actualizado_el)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_el = datetime('now')`
        )
        .bind(clave, valor)
        .run();
      return `⚙️ *Parámetro actualizado en D1:*\n• *${clave}* = ${valor}`;
    }

    case "query_config": {
      const rows = await db.prepare("SELECT clave, valor, descripcion FROM configuracion").all();
      if (!rows.results?.length) return "No hay configuración registrada en D1.";
      return (
        `⚙️ *Configuración actual (D1):*\n\n` +
        rows.results.map((r) => `• *${r.clave}*: ${r.valor}`).join("\n")
      );
    }

    // ── El refresco ocurre en el proceso programado externo ────────────────
    case "refresh_models": {
      return "El catálogo se actualiza desde el proceso semanal del equipo administrador; el Worker no consulta proveedores ni modifica el catálogo.";
    }

    case "query_models": {
      let models;
      let statuses;
      try {
        [models, statuses] = await Promise.all([
          getAvailableCatalogModels(db),
          getModelCatalogStatus(db),
        ]);
      } catch (error) {
        console.error("No se pudo leer el catálogo de modelos D1:", error.message);
        return "⚠️ No se pudo consultar el catálogo D1. Verifica que la migración esté aplicada.";
      }
      const catalogText = models.length
        ? ["google", "groq", "openrouter"]
            .map((provider) => {
              const providerModels = selectRankedFreeTextModels(models, provider);
              const providerRows = models.filter(
                (row) => row.provider === provider && Number(row.active) === 1 && Number(row.supports_text) === 1
              );
              const unverifiedCount = providerRows.filter((row) => Number(row.is_free) !== 1).length;
              const standby = providerRows.filter(
                (row) => Number(row.is_free) === 1 &&
                  row.ranking_status === "standby" && row.functional_status !== "failed"
              );
              const failedCount = models.filter(
                (row) => row.provider === provider && row.functional_status === "failed"
              ).length;
              const approved = providerModels.length
                ? providerModels.map((model, index) => `${index + 1}. \`${model}\``).join("; ")
                : "ninguno";
              const standbyText = standby.length
                ? `; standby: ${standby.map((row) => `\`${row.model_id}\``).join(", ")}`
                : "";
              const providerStatus = statuses.find((item) => item.provider === provider);
              const rankingStatus = providerStatus?.ranking_status || "sin ranking";
              const policyNote = provider === "openrouter"
                ? ""
                : `; ${unverifiedCount} sin política gratuita verificada, excluidos`;
              const failedText = failedCount ? `; ${failedCount} excluidos por falla funcional` : "";
              return `*${provider} (ranking: ${rankingStatus}):* ${approved}${standbyText}${policyNote}${failedText}`;
            })
            .join("\n")
        : "No hay modelos de texto activos en D1.";
      const statusText = statuses.length
        ? statuses.map((item) => {
            const refreshed = item.last_success_at || "sin refresco exitoso";
            const stale =
              item.last_success_at &&
              Date.now() - new Date(item.last_success_at).getTime() > 7 * 24 * 60 * 60 * 1000;
            const safeMessage = String(item.error_message || "")
              .replace(/([_*`[\]])/g, "\\$1")
              .slice(0, 180);
            const failure = item.status === "success"
              ? stale ? " — catálogo obsoleto (>7 días)" : ""
              : ` — ${item.status}${item.error_code ? ` (${item.error_code})` : ""}${safeMessage ? `: ${safeMessage}` : ""}`;
            const ranker = item.ranker_provider && item.ranker_model_id
              ? `; ranker ${item.ranker_provider}/${item.ranker_model_id}`
              : "";
            const rankingError = item.ranking_error
              ? `; detalle ranking: ${String(item.ranking_error).replace(/([_*`[\]])/g, "\\$1").slice(0, 120)}`
              : "";
            return `• ${item.provider}: ${item.model_count ?? 0} candidatos; último éxito ${refreshed}${ranker}${rankingError}${failure}`;
          }).join("\n")
        : "No existe información de refresco; ejecuta la migración del catálogo.";
      return `📋 *Modelos de texto aprobados para uso gratuito en D1:*\n${catalogText}\n\n*Estado del catálogo:*\n${statusText}`;
    }

    default:
      return null;
  }
}

// ── Enviar mensaje a Telegram ────────────────────────────────────────────
async function sendTelegram(chatId, text, env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.substring(0, 4096),
      parse_mode: "Markdown",
    }),
  });
}

// ── Handler principal ─────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("FacilitaCR Bot activo ✅", { status: 200 });
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return new Response("Bad Request", { status: 400 });
    }

    const message = body?.message;
    if (!message?.text) return new Response("OK");

    const chatId = message.chat.id;
    const userId = message.from.id;
    const userText = message.text.trim();
    const userName = message.from.first_name || "Usuario";

    // Validar autorización
    if (!isAuthorized(userId, env)) {
      await sendTelegram(
        chatId,
        `⛔ Acceso denegado.\n\nTu ID es: \`${userId}\`\nAgrega este ID a \`TELEGRAM_ALLOWED_IDS\` en Cloudflare.`,
        env
      );
      return new Response("OK");
    }

    // Comando rápido para consultar el catálogo persistido
    if (userText === "/modelos") {
      const result = await executeAction({ action: "query_models" }, env.DB, env);
      await sendTelegram(chatId, result, env);
      return new Response("OK");
    }
    if (userText.toLowerCase().includes("actualizar modelos")) {
      const result = await executeAction({ action: "refresh_models" }, env.DB, env);
      await sendTelegram(chatId, result, env);
      return new Response("OK");
    }

    // Leer configuración y modelos candidatos
    let currentConfig;
    try {
      currentConfig = await getConfig(env.DB);
    } catch (err) {
      console.error("Configuración operativa no disponible:", err.message);
      await sendTelegram(
        chatId,
        `⚠️ No puedo procesar pedidos porque la configuración operativa de D1 está incompleta o inválida.\n${err.message}\nConfigura las claves obligatorias y vuelve a intentarlo.`,
        env
      );
      return new Response("OK");
    }
    let candidateModels;
    try {
      candidateModels = await getCandidateModels(env.DB);
    } catch (err) {
      console.error("No se pudo leer el catálogo de modelos D1:", err.message);
      await sendTelegram(
        chatId,
        "⚠️ No pude leer el catálogo de modelos desde D1. Verifica que la migración esté aplicada y vuelve a intentarlo.",
        env
      );
      return new Response("OK");
    }

    // Comando /start
    if (userText === "/start") {
      await sendTelegram(
        chatId,
        `¡Hola ${userName}! 👋\n\n` +
          `Soy *FacilitaCR Bot* (@Facilita_CR_bot), tu asistente inteligente de compras por encargo USA 🇺🇸 → Costa Rica 🇨🇷\n\n` +
          `*📊 Parámetros actuales:*\n` +
          `• Tipo de cambio: ₡${currentConfig.tipo_cambio_crc} / USD\n` +
          `• Flete: $${currentConfig.flete_libra_usd} USD por libra\n` +
          `• Margen: ${(currentConfig.margen_ganancia * 100).toFixed(0)}%\n` +
          `• Peso predeterminado: ${currentConfig.peso_default_lbs} lbs\n\n` +
          `*Modelos activos:* ${candidateModels.length} modelos en cascada automática (Flash-Lite / Flash).\n\n` +
          `*¿Qué puedes decirme?*\n` +
          `📦 "Nuevo pedido para Carlos: Tenis Nike $<precio>, peso <libras>, talla <talla>"\n` +
          `💰 "¿Quiénes tienen saldo pendiente?"\n` +
          `⚙️ "Actualiza el tipo de cambio a <valor>" o "/modelos"\n\n` +
          `¡Listo para cotizar y registrar! 🚀`,
        env
      );
      return new Response("OK");
    }

    // Construir System Prompt dinámico
    const systemPrompt = buildSystemPrompt(currentConfig);

    // Llamar a Gemini con la cascada de modelos descubiertos
    const { answer: aiResponse, modelUsed } = await callGemini(
      candidateModels,
      systemPrompt,
      `${userName} dice: ${userText}`,
      env
    );

    // Detectar si la IA solicita ejecutar una acción
    const actionMatch = aiResponse.match(/\{[\s\S]*?"action"\s*:[\s\S]*?\}(?=\s*$|\s*\n)/m);
    let finalResponse = actionMatch
      ? aiResponse.replace(actionMatch[0], "").trim()
      : aiResponse;

    if (actionMatch) {
      try {
        const action = JSON.parse(actionMatch[0]);
        const actionResult = await executeAction(action, env.DB, env);
        if (actionResult) {
          finalResponse = finalResponse + (finalResponse ? "\n\n" : "") + actionResult;
        }
      } catch (err) {
        console.error("Error ejecutando acción:", err.message);
        finalResponse = `⚠️ No se pudo completar la acción: ${err.message}`;
      }
    }

    await sendTelegram(chatId, finalResponse || "✅ Listo.", env);
    return new Response("OK");
  },
};
