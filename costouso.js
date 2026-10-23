import { resolver, esPropia, AGRUPAR, mejorVersion, norm as normF } from "./fichas.js";
// Costo de uso estimado (combustible/energía) por categoría. NO es consumo homologado.
// Curvas calibradas para ~100 km; se escalan con el precio actual del combustible (precio hoy / precio de calibración).
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const G = [[1000, 6.0], [1500, 8.0], [2000, 9.2], [3500, 11.0], [5000, 13.0]]; // gasolina: cc -> $/100 km
const DZ = [[1500, 5.8], [2000, 6.5], [2800, 7.0], [4000, 9.0]]; // diésel (no camión)
const F_MILD = 0.9, F_HIBRIDO = 0.43, EV_BASE = 1.5, TURBO = 1.15, EFIC_CARGA = 0.9;
// Camiones y buses: km por galón de diésel referencial por clase de PBV (por calibrar con consumo real).
const CLASES_CAMION = [
  [5000, "liviano (hasta 5 t PBV)", 14], [12000, "mediano (5 a 12 t)", 9],
  [20000, "pesado (12 a 20 t)", 6.5], [Infinity, "tracto/extrapesado (más de 20 t)", 4.5],
];

const interp = (x, pts) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [a, ya] = pts[i - 1], [b, yb] = pts[i];
    if (x <= b) return ya + ((yb - ya) * (x - a)) / (b - a);
  }
  return pts[pts.length - 1][1];
};

export async function cargarParametros(admin) {
  try {
    const { data, error } = await admin.from("parametros_costo").select("clave,valor,actualizado");
    if (error) return {};
    return Object.fromEntries((data || []).map((r) => [r.clave, { valor: r.valor === null ? null : Number(r.valor), actualizado: r.actualizado }]));
  } catch { return {}; }
}
const P = (params, k) => (params?.[k]?.valor ?? null);

// Estado de los precios para avisar al asesor (la fecha es la última vez que el admin guardó precios)
export function estadoPrecios(params) {
  const hay = P(params, "gasolina") || P(params, "diesel") || P(params, "kwh");
  if (!hay) return { ok: false, aviso: "Los precios de combustible aún no están cargados: las cifras usan los valores base de la curva (sin ajuste por precio)." };
  const t = params.fecha_precios?.actualizado;
  const dias = t ? Math.round((Date.now() - new Date(t).getTime()) / 86400000) : null;
  if (dias !== null && dias > 60) return { ok: false, aviso: `Los precios de combustible tienen ${dias} días sin actualizar: confirma antes de prometer ahorros.` };
  return { ok: true };
}
const factor = (params, tipo) => {
  const p = P(params, tipo), c = P(params, tipo + "_calib");
  return p && c ? p / c : 1;
};

// Devuelve { usd100, metodo, nota } o { sin_estimado: motivo }
export function estimar(f, params) {
  const prop = norm(f.propulsion);
  const txt = norm([f.propulsion, f.version, f.notas].join(" "));
  const ev = prop.includes("ELECTR") && !/HIBRID|HEV|PHEV/.test(prop);
  const diesel = prop.includes("DIESEL");
  const seg = norm(f.segmento);

  if (ev) {
    const kwh = P(params, "kwh");
    const bat = num(f.bateria_kwh), aut = num(f.autonomia_km);
    if (kwh && bat && aut) {
      const c = (bat / aut) * 100 / EFIC_CARGA; // kWh por 100 km desde la red
      return { usd100: c * kwh, metodo: `consumo de la ficha (${bat} kWh / ${aut} km) × tarifa del kWh`, nota: "Autonomía de ficha en ciclo de homologación; el consumo real suele ser mayor." };
    }
    return { usd100: EV_BASE * factor(params, "kwh"), metodo: "referencia eléctrica por categoría" };
  }

  if (["CAMION", "BUS"].includes(seg)) {
    const pbv = num(f.pbv_kg) ?? (num(f.carga_kg) && num(f.peso_vacio_kg) ? num(f.carga_kg) + num(f.peso_vacio_kg) : null);
    if (!pbv) return { sin_estimado: "no hay PBV en la ficha para clasificar el camión" };
    const [, clase, kmgal] = CLASES_CAMION.find(([lim]) => pbv <= lim);
    const dz = P(params, "diesel");
    if (!dz) return { sin_estimado: "falta el precio del diésel en parámetros" };
    const usd100 = (100 / kmgal) * dz;
    const carga = num(f.carga_kg);
    return { usd100, metodo: `camión ${clase}: ${kmgal} km/gal referencial × diésel`, por_calibrar: true, usd_ton_100: carga ? usd100 / (carga / 1000) : null,
      nota: "Referencial por clase, por calibrar con consumo real. No incluye mantenimiento ni llantas." };
  }

  const cc = num(f.cc);
  if (!cc) return { sin_estimado: "la ficha no trae cilindrada" };
  const turbo = /TURBO|TGDI|\bTSI\b|\b1\.\dT\b/.test(txt);
  const mild = /MILD|MHEV|48 ?V|SHVS/.test(prop);
  const phev = /PHEV|ENCHUFABLE/.test(prop);
  const full = !phev && !mild && /HIBRID|HEV|E-?POWER/.test(prop);
  const ccEq = cc * (turbo ? TURBO : 1);
  const esSuper = !diesel && /SUPER/.test(txt) && !/EXTRA|ECOPA/.test(txt);
  const fx = factor(params, diesel ? "diesel" : esSuper ? "super" : "gasolina");
  let base = diesel ? interp(cc, DZ) : interp(ccEq, G);
  let metodo = `${diesel ? "diésel" : "gasolina"} ${(cc / 1000).toFixed(1)} L${turbo ? " turbo" : ""} (curva por cilindrada)`;
  let nota;
  if (mild) { base *= F_MILD; metodo += " con mild hybrid (×0,9)"; }
  else if (phev) { base *= F_HIBRIDO; metodo += " como PHEV (×0,43)"; nota = "Solo si el cliente carga la batería con regularidad; sin carga se acerca al de un gasolina."; }
  else if (full) { base *= F_HIBRIDO; metodo += " como híbrido (×0,43)"; }
  return { usd100: base * fx, metodo, nota };
}

export const ETIQUETA = "Estimación por categoría (tamaño de motor, tecnología y precio del combustible), NO consumo homologado. Úsala para comparar tecnologías, no para prometer un consumo exacto.";

export const TOOL_COSTO = {
  name: "comparar_costo_uso",
  description:
    "Estima el costo de combustible/energía por 100 km, por mes y por año de 1 a 4 modelos y calcula el ahorro entre ellos. " +
    "Úsala cuando el cliente pregunte por consumo, gasto mensual, ahorro, si le conviene híbrido/eléctrico/diésel, o para sustentar el costo total de propiedad. " +
    "El resultado es una estimación por categoría (no consumo homologado): preséntala siempre como tal.",
  input_schema: {
    type: "object",
    properties: {
      modelos: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" }, description: "Ej. ['Renault Duster', 'Hyundai Creta', 'Omoda E5']." },
      km_anio: { type: "integer", description: "Kilómetros al año del cliente. Si no lo dice, pregunta o usa el valor por defecto (indícalo)." },
      anios: { type: "integer", description: "Años para proyectar el ahorro acumulado (por defecto 5)." },
    },
    required: ["modelos"],
  },
};

export function ejecutarCosto(a, { fichas, marcasPropias, params, admin, registrarFaltante }) {
  a = a || {};
  const propias = new Set((marcasPropias || []).map(normF));
  const km = a.km_anio || P(params, "km_anio") || 15000;
  const kmDefault = !a.km_anio;
  const anios = a.anios || P(params, "anios_horizonte") || 5;
  const items = [], no_encontrados = [], sin_estimado = [];
  const vistos = new Set();
  for (const q of (a.modelos || []).slice(0, 4)) {
    const r = resolver(fichas, q);
    if (!r.length) { no_encontrados.push(q); registrarFaltante?.(q); continue; }
    const f = mejorVersion(AGRUPAR(r)[0]);
    if (vistos.has(f)) continue;
    vistos.add(f);
    const e = estimar(f, params);
    const nombre = `${f.marca} ${f.modelo}${f.version ? " " + f.version : ""}`;
    if (e.sin_estimado) { sin_estimado.push({ modelo: nombre, motivo: e.sin_estimado }); continue; }
    items.push({
      modelo: nombre, marca_de_la_empresa: esPropia(propias, f.marca), propulsion: f.propulsion,
      usd_por_100km: Math.round(e.usd100 * 100) / 100,
      usd_por_mes: Math.round((e.usd100 * km) / 100 / 12),
      usd_por_anio: Math.round((e.usd100 * km) / 100),
      ...(e.usd_ton_100 ? { usd_por_tonelada_100km: Math.round(e.usd_ton_100 * 100) / 100 } : {}),
      metodo: e.metodo, ...(e.nota ? { nota: e.nota } : {}), ...(e.por_calibrar ? { por_calibrar: true } : {}),
    });
  }
  items.sort((x, y) => x.usd_por_anio - y.usd_por_anio);
  const out = {
    km_anio_usados: km, km_anio_es_valor_por_defecto: kmDefault, etiqueta_obligatoria: ETIQUETA,
    modelos: items, no_encontrados, sin_estimado,
  };
  if (items.length >= 2) {
    const caro = items[items.length - 1], barato = items[0];
    out.ahorro = {
      entre: `${barato.modelo} vs ${caro.modelo}`,
      usd_por_anio: caro.usd_por_anio - barato.usd_por_anio,
      usd_acumulado: (caro.usd_por_anio - barato.usd_por_anio) * anios, anios,
    };
  }
  const est = estadoPrecios(params);
  if (!est.ok) out.aviso_precios = est.aviso;
  out.regla =
    "Presenta primero los modelos de la empresa y sustenta con el ahorro. Si un modelo nuestro cuesta más en combustible, no lo ocultes: reencuádralo con otro beneficio real " +
    "(garantía, equipamiento, precio, promoción). Si falta el kilometraje del cliente, dilo y pregúntalo. Nunca presentes la cifra como consumo oficial.";
  return out;
}
