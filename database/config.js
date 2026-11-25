const SETTING_RULES = Object.freeze({
  tipo_cambio_crc: { min: 0, exclusive: true },
  flete_libra_usd: { min: 0, exclusive: false },
  margen_ganancia: { min: 0, exclusive: false },
  peso_default_lbs: { min: 0, exclusive: true },
});

export const OPERATIONAL_CONFIG_KEYS = Object.freeze(Object.keys(SETTING_RULES));

export function parseOperationalSetting(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule) {
    throw new Error(`Configuración no reconocida: ${key}`);
  }

  const rawValue = String(value).trim();
  const isPercent = key === "margen_ganancia" && rawValue.endsWith("%");
  const number = isPercent
    ? Number(rawValue.slice(0, -1).trim()) / 100
    : Number(rawValue);

  if (
    rawValue === "" ||
    !Number.isFinite(number) ||
    (rule.exclusive ? number <= rule.min : number < rule.min)
  ) {
    throw new Error(`Configuración inválida para "${key}": debe ser un número válido.`);
  }

  return number;
}

export function parseOperationalSettings(rows) {
  const values = new Map(rows.map(({ clave, valor }) => [clave, valor]));
  const settings = {};

  for (const key of OPERATIONAL_CONFIG_KEYS) {
    if (!values.has(key)) {
      throw new Error(`Falta la configuración obligatoria "${key}" en la tabla configuracion.`);
    }
    settings[key] = parseOperationalSetting(key, values.get(key));
  }

  return settings;
}
