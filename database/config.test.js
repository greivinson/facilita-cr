import test from "node:test";
import assert from "node:assert/strict";
import { parseOperationalSetting, parseOperationalSettings } from "./config.js";
import { calculatePriceCRC } from "../sale-hunter/index.js";

const validRows = [
  { clave: "tipo_cambio_crc", valor: "440" },
  { clave: "flete_libra_usd", valor: "7.5" },
  { clave: "margen_ganancia", valor: "0.18" },
  { clave: "peso_default_lbs", valor: "1.5" },
];

test("parses all required operational settings from database rows", () => {
  assert.deepEqual(parseOperationalSettings(validRows), {
    tipo_cambio_crc: 440,
    flete_libra_usd: 7.5,
    margen_ganancia: 0.18,
    peso_default_lbs: 1.5,
  });
});

test("rejects missing and invalid operational settings", () => {
  assert.throws(() => parseOperationalSettings(validRows.slice(0, 3)), /peso_default_lbs/);
  assert.throws(
    () =>
      parseOperationalSettings(
        validRows.map((row) =>
          row.clave === "tipo_cambio_crc" ? { ...row, valor: "no es número" } : row
        )
      ),
    /tipo_cambio_crc/
  );
  assert.throws(() => parseOperationalSetting("peso_default_lbs", "0"), /peso_default_lbs/);
});

test("accepts a percent-form margin and calculates with database settings", () => {
  const config = parseOperationalSettings(
    validRows.map((row) =>
      row.clave === "margen_ganancia" ? { ...row, valor: "18%" } : row
    )
  );
  assert.equal(config.margen_ganancia, 0.18);
  assert.equal(calculatePriceCRC(20, config), 16225);
  assert.equal(calculatePriceCRC(20, config, 2), 18172);
});
