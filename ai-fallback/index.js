/**
 * FacilitaCR — AI Fallback Orchestrator ($0/mes)
 * Cascada de proveedores gratuitos:
 * Prioridad 1: Google AI Studio (Gemini 2.5 Flash / Lite)
 * Prioridad 2: Groq Cloud (Llama 3.3 / Qwen)
 * Prioridad 3: OpenRouter (Modelos :free)
 */

import { fileURLToPath } from 'node:url';
import { callGoogleAI } from './providers/google.js';
import { callGroq } from './providers/groq.js';
import { callOpenRouter } from './providers/openrouter.js';
import { getModelCatalog } from './model-catalog.js';
import { runProviderCascade } from './provider-cascade.js';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function readProviderKeys(env = process.env) {
  const normalize = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

  return {
    GEMINI_API_KEY: normalize(env.GEMINI_API_KEY),
    GROQ_API_KEY: normalize(env.GROQ_API_KEY),
    OPENROUTER_API_KEY: normalize(env.OPENROUTER_API_KEY),
  };
}

/**
 * Consulta la IA pasando automáticamente al siguiente proveedor si uno falla o agota cuota.
 * @param {string} prompt - El texto o tarea para la IA
 * @param {string} systemInstruction - Rol o instrucciones del sistema
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
export async function askAI(prompt, systemInstruction = '') {
  const keys = readProviderKeys();
  if (!Object.values(keys).some(Boolean)) {
    throw new Error(
      'No AI provider credentials configured. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY.'
    );
  }

  const catalog = await getModelCatalog();
  return runProviderCascade({
    prompt,
    systemInstruction,
    keys,
    catalog,
    providers: [
      { id: 'google', keyName: 'GEMINI_API_KEY', call: callGoogleAI },
      { id: 'groq', keyName: 'GROQ_API_KEY', call: callGroq },
      { id: 'openrouter', keyName: 'OPENROUTER_API_KEY', call: callOpenRouter },
    ],
  });
}

/**
 * Especializado: Redacta un mensaje de WhatsApp atractivo listo para enviar.
 */
export async function generateWhatsAppDealCopy(deal) {
  const systemPrompt = `Eres un redactor de ventas para FacilitaCR, un servicio de compras por encargo desde EE.UU. a Costa Rica.
Escribe un mensaje de WhatsApp corto, emocionante y persuasivo (con emojis) para compartir una oferta irresistible.
Incluye:
- Nombre del producto
- Descuento destacado (ej. 60% OFF)
- Precio de liquidación en colones (CRC) puesto en Costa Rica (sin sorpresas)
- Tallas disponibles
- Llamado a la acción rápido (ej. "¡Pide el tuyo antes de que se agoten las tallas!").
Solo devuelve el texto final del mensaje de WhatsApp, sin explicaciones adicionales.`;

  const userPrompt = `Producto: ${deal.title}
Marca: ${deal.brand}
Precio en USA: $${deal.salePriceUsd} (Antes $${deal.originalPriceUsd})
Descuento: -${deal.discountPercentage}%
Total en Costa Rica: ₡${deal.totalCrcEstimado?.toLocaleString('es-CR')}
Tallas disponibles: ${deal.sizes?.slice(0, 6).join(', ') || 'Consultar tallas'}
Enlace: ${deal.url}`;

  const { text } = await askAI(userPrompt, systemPrompt);
  return text;
}
