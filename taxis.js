// Segmento taxis: catálogo de vehículos homologados, búsqueda y análisis de la operación (cuota, seguro, energía).
// Se activa solo para empresas con tipo = 'taxis'. Los parámetros salen de parametros_costo (claves taxi_*).
import { resolver, norm } from "./fichas.js";
import { parametro as P, estimar, estadoPrecios, ETIQUETA } from "./costouso.js";

// ---------------------------------------------------------------------------
// Lectura del CSV oficial (separador ;, miles con punto, decimales con coma, precios con símbolo)
// ---------------------------------------------------------------------------
const num = (v) => {
  let s = String(v ?? "").replace(/[€$\s]/g, "");
  if (!s || /^(n\/a|-)$/i.test(s)) return null;
  s = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/\./g, "");
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const MARCAS = { "DONG FENG": "Dongfeng", DFSK: "DFSK", BYD: "BYD", GAC: "GAC", JAC: "JAC", KIA: "Kia", SKYWORTH: "Skyworth", JETOUR: "Jetour", OMODA: "Omoda", MG: "MG", CHANGAN: "Changan", CHEVROLET: "Chevrolet", NISSAN: "Nissan", HYUNDAI: "Hyundai", CHERY: "Chery" };
const FICHA = { "Seagull GS": "Seagull", "New Accent": "Accent", "GLORY 560 (7 pax)": "Glory 560", "ARRIZO 5 Sedan": "Arrizo 5", "Celtos SUV": "Seltos", "K3 Sedan": "K3" };
const titulo = (s) => (/^[A-Z0-9 ()]+$/.test(s) ? s.replace(/\w\S*/g, (w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).replace(/\bE5\b|\bEx30\b/gi, (w) => w.toUpperCase()) : s);

export function parsearCsvTaxis(texto) {
  const lineas = String(texto).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const cab = lineas.shift().split(";").map((c) => c.trim());
  return lineas.map((l) => {
    const c = l.split(";"); const r = {};
    cab.forEach((k, i) => (r[k] = (c[i] ?? "").trim()));
    return r;
  }).filter((r) => r.Marca && r.Modelo);
}

// Convierte una fila del CSV al registro de la tabla; corrige lo evidente y deja constancia en observaciones.
export function filaATabla(r, lote = "csv-2026") {
  const obs = []; let verificar = false;
  const marca = MARCAS[r.Marca.toUpperCase()] || r.Marca;
  const modeloOrig = r.Modelo.trim();
  let modelo = modeloOrig;
  if (/^celtos/i.test(modelo)) { modelo = "Seltos SUV"; obs.push('El listado dice "Celtos SUV"; se corrigió a Seltos.'); }
  modelo = titulo(modelo);
  const o = {
    marca, modelo, modelo_original: modelo === modeloOrig ? null : modeloOrig, modelo_ficha: FICHA[modeloOrig] || null,
    segmento: r.Segmento || null, motorizacion: r.Tipo_motorizacion || null, combustible: r.Combustible || null, carroceria: r.Carroceria || null,
    autonomia_nedc_km: num(r.Autonomia_NEDC_km), cilindrada_cc: num(r.Cilindrada_cc), precio_usd: num(r.Precio_USD),
    cajuela_l: num(r.Cajuela_L), rin_pulgadas: num(r.Rin_pulgadas), largo_mm: num(r.Largo_mm), ancho_mm: num(r.Ancho_mm), alto_mm: num(r.Altura_mm),
    wb_mm: num(r.Distancia_ejes_mm), potencia_hp: num(r.Potencia_HP), torque_nm: num(r.Torque_Nm), bateria_kwh: num(r.Bateria_kWh),
    mantenimiento_cada_km: num(r.Mantenimiento_cada_km),
    incluye_wallbox: /^si/i.test(r.Incluye_wallbox_instalacion) ? true : /^no/i.test(r.Incluye_wallbox_instalacion) ? false : null,
    incluye_cargador_portatil: /^n\/a$/i.test(r.Incluye_cargador_portatil) ? null : r.Incluye_cargador_portatil || null,
    garantia_anios: num(r.Garantia_anios), garantia_km: num(r.Garantia_km), garantia_texto: r.Garantia_texto_original || null,
    fuente: "Listado de vehículos homologados para taxis, Ecuador 2026", lote,
  };
  // Valores imposibles o invertidos
  if (o.ancho_mm && o.alto_mm && o.ancho_mm < o.alto_mm - 100 && /seltos|celtos/i.test(modeloOrig)) {
    [o.ancho_mm, o.alto_mm] = [o.alto_mm, o.ancho_mm]; obs.push("Ancho y alto estaban invertidos en el listado; se corrigieron."); verificar = true;
  }
  if (o.ancho_mm && o.ancho_mm > 1950 && o.carroceria === "Automovil") { obs.push(`Ancho ${o.ancho_mm} mm no es creíble para un automóvil; se dejó vacío.`); o.ancho_mm = null; verificar = true; }
  if (o.wb_mm && o.wb_mm < 2000) { obs.push(`Distancia entre ejes ${o.wb_mm} mm no es creíble; se dejó vacía.`); o.wb_mm = null; verificar = true; }
  if (o.potencia_hp && o.torque_nm && o.potencia_hp === o.torque_nm) { obs.push("Potencia y torque idénticos; probable error de digitación."); verificar = true; }
  if (!o.garantia_km && o.garantia_anios) obs.push("El listado no indica el kilometraje de la garantía.");
  o.observaciones = obs.join(" ") || null; o.verificar = verificar;
  return o;
}

export async function cargarTaxis(admin) {
  try {
    const { data, error } = await admin.from("homologacion_taxi").select("*").eq("vigente", true).order("id");
    return error ? [] : data || [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Cálculos
// ---------------------------------------------------------------------------
export const cuotaMensual = (monto, tasaAnualPct, meses) => {
  const r = tasaAnualPct / 100 / 12;
  return r === 0 ? monto / meses : (monto * r) / (1 - Math.pow(1 + r, -meses));
};
const redondea = (x, d = 0) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const esEV = (t) => /BEV|ELECTR/i.test(`${t.motorizacion} ${t.combustible}`);

// Mantenimiento mensual: 1) costo de servicio del modelo (si existe) x servicios; 2) USD/km de gasolina (o eléctrico = gasolina / ratio) como referencia.
function mantenimiento(t, kmMes, params) {
  const llantasKm = P(params, "taxi_llantas_usd_km");
  const llantas = llantasKm ? llantasKm * kmMes : 0;
  if (t.costo_servicio_usd && t.mantenimiento_cada_km) {
    return { mes: (kmMes / t.mantenimiento_cada_km) * t.costo_servicio_usd + llantas, fuente: `costo de servicio del modelo ($${t.costo_servicio_usd} cada ${t.mantenimiento_cada_km} km)${llantas ? " + llantas" : ""}` };
  }
  const base = P(params, "taxi_mant_usd_km_ice");
  if (!base) return null;
  const ratio = P(params, "taxi_ratio_mant_ice_ev") ?? 3;
  const km = esEV(t) ? base / ratio : base;
  return { mes: km * kmMes + llantas, fuente: `referencia $${redondea(km, 4)}/km (${esEV(t) ? `gasolina ÷ ${ratio}` : "gasolina/diésel"})${llantas ? " + llantas" : ""}` };
}

function energia(t, km, params) {
  const kwh = P(params, "kwh");
  if (esEV(t)) {
    if (!t.bateria_kwh || !t.autonomia_nedc_km) return { sin_estimado: "falta batería o autonomía" };
    const f = P(params, "taxi_factor_autonomia_real") ?? 0.8;
    const aut = t.autonomia_nedc_km * f;
    const kwh100 = ((t.bateria_kwh / aut) * 100) / 0.9;
    const usd100 = kwh ? kwh100 * kwh : 1.5;
    return { usd100, metodo: `batería ${t.bateria_kwh} kWh / (autonomía NEDC ${t.autonomia_nedc_km} km × ${f}) con 90% de eficiencia de carga${kwh ? "" : "; sin tarifa del kWh, referencia $1,5"}`, kwh100: redondea(kwh100, 1) };
  }
  const e = estimar({ propulsion: "Gasolina", cc: t.cilindrada_cc, segmento: "Auto", version: "", notas: "" }, params);
  return e.sin_estimado ? e : { usd100: e.usd100, metodo: e.metodo };
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------
export const TOOL_BUSCAR_TAXIS = {
  name: "buscar_taxis",
  description:
    "Busca en el listado oficial de vehículos HOMOLOGADOS para operar como taxi en Ecuador (eléctricos y a gasolina) con precio, autonomía, cajuela, garantía, mantenimiento y si incluye wallbox. " +
    "Úsala para cualquier pregunta sobre qué vehículo puede ser taxi, opciones por presupuesto, eléctricos vs gasolina o qué incluye cada uno. Un modelo que no esté en el listado NO está homologado: no lo ofrezcas como taxi.",
  input_schema: {
    type: "object",
    properties: {
      consulta: { type: "string", description: "Marca y/o modelo en texto libre, ej. 'Aion Y', 'Soluto'." },
      tipo: { type: "string", enum: ["electrico", "gasolina"], description: "Tipo de motorización." },
      carroceria: { type: "string", enum: ["Automovil", "SUV"] },
      precio_max: { type: "number", description: "Precio máximo en USD." },
      autonomia_min_km: { type: "integer", description: "Autonomía NEDC mínima (solo eléctricos)." },
      cajuela_min_l: { type: "integer" },
      garantia_min_anios: { type: "integer" },
      solo_con_wallbox: { type: "boolean", description: "true = solo los que incluyen instalación de wallbox." },
      solo_marcas_empresa: { type: "boolean", description: "true = solo marcas que representa la empresa." },
      ordenar: { type: "string", enum: ["precio", "autonomia", "garantia", "cajuela"], description: "Orden (precio ascendente; el resto descendente)." },
      limite: { type: "integer", description: "Máximo de resultados (1 a 28). Por defecto 8." },
    },
  },
};
export const TOOL_NEGOCIO_TAXI = {
  name: "analizar_negocio_taxi",
  description:
    "Analiza la operación de un taxi con 1 a 4 modelos homologados: cuota del crédito, seguro, energía por mes, costo por km y diferencia entre modelos (p. ej. eléctrico vs gasolina) a 1 y 5 años. " +
    "Usa por defecto los parámetros de la operación en Ecuador (200 km/día, 25 días al mes o 21 en Quito por pico y placa, entrada 25%, 60 meses, 14% anual, seguro 5% del PVP). " +
    "Úsala cuando el conductor o dueño pregunte cuánto cuesta operar, cuál le conviene, cuánto paga al mes o en cuánto recupera la diferencia de precio. No incluye mantenimiento, llantas, cupo/permiso ni ingresos: dilo siempre.",
  input_schema: {
    type: "object",
    properties: {
      modelos: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" }, description: "Ej. ['Aion UT', 'Soluto']." },
      ciudad: { type: "string", description: "Si es Quito se usan 21 días al mes por pico y placa." },
      km_dia: { type: "integer" }, dias_mes: { type: "integer" },
      entrada_pct: { type: "number" }, plazo_meses: { type: "integer" }, tasa_anual: { type: "number" }, seguro_pct: { type: "number" },
      precio_usd: { type: "number", description: "Solo si hay una promoción o precio negociado distinto al del listado (aplica al primer modelo)." },
    },
    required: ["modelos"],
  },
};
export const TOOLS_TAXIS = [TOOL_BUSCAR_TAXIS, TOOL_NEGOCIO_TAXI];
export const NOMBRES_TAXIS = new Set(TOOLS_TAXIS.map((t) => t.name));

const buscarTaxi = (taxis, q) => {
  const nq = norm(q);
  const pts = taxis.map((t) => {
    const txt = norm(`${t.marca} ${t.modelo}`);
    const toks = nq.split(" ").filter(Boolean);
    const hit = toks.filter((k) => txt.includes(k)).length;
    return [hit / (toks.length || 1), t];
  }).filter(([p]) => p >= 0.99);
  return pts.map(([, t]) => t);
};
const vistaTaxi = (t, propias, fichas) => {
  const o = {
    marca: t.marca, modelo: t.modelo, marca_de_la_empresa: propias.has(norm(t.marca)), carroceria: t.carroceria, motorizacion: t.motorizacion,
    precio_usd: t.precio_usd, autonomia_nedc_km: t.autonomia_nedc_km ?? undefined, bateria_kwh: t.bateria_kwh ?? undefined, cilindrada_cc: t.cilindrada_cc ?? undefined,
    potencia_hp: t.potencia_hp, torque_nm: t.torque_nm, cajuela_l: t.cajuela_l, garantia: t.garantia_texto || undefined,
    mantenimiento_cada_km: t.mantenimiento_cada_km, incluye_wallbox: t.incluye_wallbox ?? undefined, cargador_portatil: t.incluye_cargador_portatil ?? undefined,
    observaciones: t.observaciones || undefined, dato_por_verificar: t.verificar || undefined,
  };
  const f = fichas?.length ? resolver(fichas, `${t.marca} ${t.modelo_ficha || t.modelo}`)[0] : null;
  if (f) o.ficha_tecnica = { airbags: f.airbags ?? undefined, adas: f.adas || undefined, confianza: f.confianza };
  return o;
};
const REGLA = "Preséntalos primero si son de la empresa. Solo ofrece como taxi lo que aparece aquí (homologado). Usa solo estos datos; lo que no figure, no lo inventes.";

export function ejecutarTaxis(nombre, a, { taxis, fichas, marcasPropias, params }) {
  a = a || {};
  const propias = new Set((marcasPropias || []).map(norm));
  const prop = (t) => propias.has(norm(t.marca));

  if (nombre === TOOL_BUSCAR_TAXIS.name) {
    let l = taxis;
    if (a.consulta) l = buscarTaxi(l, a.consulta);
    if (a.tipo) l = l.filter((t) => (a.tipo === "electrico") === esEV(t));
    if (a.carroceria) l = l.filter((t) => norm(t.carroceria) === norm(a.carroceria));
    if (a.precio_max) l = l.filter((t) => t.precio_usd != null && t.precio_usd <= a.precio_max);
    if (a.autonomia_min_km) l = l.filter((t) => (t.autonomia_nedc_km ?? 0) >= a.autonomia_min_km);
    if (a.cajuela_min_l) l = l.filter((t) => (t.cajuela_l ?? 0) >= a.cajuela_min_l);
    if (a.garantia_min_anios) l = l.filter((t) => (t.garantia_anios ?? 0) >= a.garantia_min_anios);
    if (a.solo_con_wallbox) l = l.filter((t) => t.incluye_wallbox === true);
    if (a.solo_marcas_empresa) l = l.filter(prop);
    const ORD = { autonomia: (t) => t.autonomia_nedc_km ?? 0, garantia: (t) => t.garantia_anios ?? 0, cajuela: (t) => t.cajuela_l ?? 0 };
    if (a.ordenar === "precio") l = [...l].sort((x, y) => (x.precio_usd ?? 1e9) - (y.precio_usd ?? 1e9));
    else if (ORD[a.ordenar]) l = [...l].sort((x, y) => ORD[a.ordenar](y) - ORD[a.ordenar](x));
    else l = [...l].sort((x, y) => Number(prop(y)) - Number(prop(x)) || (x.precio_usd ?? 1e9) - (y.precio_usd ?? 1e9));
    const lim = Math.min(Math.max(a.limite || 8, 1), 28);
    if (!l.length) return { encontrados: 0, aviso: "Ningún vehículo homologado cumple esos criterios (o el modelo no está en el listado de homologados). No lo ofrezcas como taxi; sugiere relajar el filtro." };
    return { encontrados: l.length, mostrados: Math.min(lim, l.length), vehiculos: l.slice(0, lim).map((t) => vistaTaxi(t, propias, fichas)), regla: REGLA };
  }

  if (nombre === TOOL_NEGOCIO_TAXI.name) {
    const g = (k, d) => P(params, k) ?? d;
    const quito = /quito/i.test(a.ciudad || "");
    const kmDia = a.km_dia || g("taxi_km_dia", 200);
    const dias = a.dias_mes || (quito ? g("taxi_dias_mes_quito", 21) : g("taxi_dias_mes", 25));
    const entrada = a.entrada_pct ?? g("taxi_entrada_pct", 25);
    const plazo = a.plazo_meses || g("taxi_plazo_meses", 60);
    const tasa = a.tasa_anual ?? g("taxi_tasa_anual", 14);
    const seguroPct = a.seguro_pct ?? g("taxi_seguro_pct", 5);
    const kmMes = kmDia * dias;
    const elegidos = [], no_encontrados = [];
    for (const [i, q] of (a.modelos || []).slice(0, 4).entries()) {
      const r = buscarTaxi(taxis, q);
      if (!r.length) { no_encontrados.push(q); continue; }
      const t = { ...r[0] };
      if (i === 0 && a.precio_usd) t.precio_usd = a.precio_usd;
      if (!elegidos.includes(r[0])) elegidos.push(t);
    }
    if (!elegidos.length) return { error: "Ninguno de esos modelos está en el listado de homologados para taxi.", no_encontrados };
    // Referencia a gasolina cuando solo se pidieron eléctricos (la comparación que más pregunta el conductor)
    let referencia = null;
    if (elegidos.every(esEV) && elegidos.length < 4) {
      const ice = taxis.filter((t) => !esEV(t) && t.precio_usd && t.cilindrada_cc);
      referencia = [...ice].sort((x, y) => Number(prop(y)) - Number(prop(x)) || x.precio_usd - y.precio_usd)[0] || null;
      if (referencia) elegidos.push({ ...referencia, _referencia: true });
    }
    const filas = elegidos.map((t) => {
      const e = energia(t, kmMes, params);
      const precio = t.precio_usd;
      const monto = precio * (1 - entrada / 100);
      const cuota = cuotaMensual(monto, tasa, plazo);
      const seguro = (precio * seguroPct) / 100 / 12;
      const energiaMes = e.sin_estimado ? null : (e.usd100 * kmMes) / 100;
      const mant = mantenimiento(t, kmMes, params);
      const total = energiaMes == null ? null : cuota + seguro + energiaMes;
      const totalConMant = total == null || !mant ? null : total + mant.mes;
      return {
        modelo: `${t.marca} ${t.modelo}`, marca_de_la_empresa: prop(t), es_referencia_a_gasolina: !!t._referencia, tipo: esEV(t) ? "eléctrico" : "gasolina", precio_usd: precio,
        entrada_usd: redondea((precio * entrada) / 100), financiado_usd: redondea(monto), cuota_mensual: redondea(cuota), seguro_mensual: redondea(seguro),
        energia_mensual: redondea(energiaMes), total_mensual_sin_mantenimiento: redondea(total), costo_por_km: total == null ? null : redondea(total / kmMes, 3),
        mantenimiento_mensual: mant ? redondea(mant.mes) : null, metodo_mantenimiento: mant ? mant.fuente : "sin parámetro de mantenimiento cargado",
        total_mensual_con_mantenimiento: redondea(totalConMant), costo_por_km_con_mantenimiento: totalConMant == null ? null : redondea(totalConMant / kmMes, 3),
        energia_usd_100km: e.sin_estimado ? null : redondea(e.usd100, 2), metodo_energia: e.sin_estimado ? e.sin_estimado : e.metodo,
        servicios_mantenimiento_al_anio: t.mantenimiento_cada_km ? redondea((kmMes * 12) / t.mantenimiento_cada_km, 1) : null,
        incluye_wallbox: t.incluye_wallbox ?? undefined, garantia: t.garantia_texto || undefined,
        dato_por_verificar: t.verificar || undefined,
      };
    });
    const conTotal = filas.filter((f) => f.energia_mensual != null);
    const out = {
      supuestos: { km_dia: kmDia, dias_mes: dias, km_mes: kmMes, ciudad_pico_y_placa: quito, entrada_pct: entrada, plazo_meses: plazo, tasa_anual_pct: tasa, seguro_anual_pct_del_pvp: seguroPct },
      modelos: filas, no_encontrados,
      no_incluye: [...(filas.every((f) => f.mantenimiento_mensual != null) ? [] : ["mantenimiento (aún no está cargado el parámetro; solo se informan los servicios al año)"]), ...(P(params, "taxi_llantas_usd_km") ? [] : ["llantas"]), "cupo o permiso (varía por ciudad)", "ingresos de la operación", "matrícula y otros trámites"],
      aviso_energia: ETIQUETA + " En eléctricos se usa autonomía NEDC × " + g("taxi_factor_autonomia_real", 0.8) + " (supuesto por validar con datos reales).",
      regla: REGLA + " Si un eléctrico cuesta más que el de gasolina, muestra cuántos meses tarda en compensarse la diferencia con el ahorro mensual de energía y seguro. Es una estimación: no prometas ingresos.",
    };
    if (conTotal.length >= 2) {
      const base = referencia ? conTotal.find((f) => f.es_referencia_a_gasolina) : conTotal.reduce((a, b) => (a.total_mensual_sin_mantenimiento >= b.total_mensual_sin_mantenimiento ? a : b));
      out.comparacion = conTotal.filter((f) => f !== base).map((f) => {
        const ahorroMes = base.energia_mensual - f.energia_mensual;
        const difPrecio = f.precio_usd - base.precio_usd;
        return {
          modelo: f.modelo, contra: base.modelo, ahorro_energia_mensual: redondea(ahorroMes),
          diferencia_total_mensual: redondea(f.total_mensual_sin_mantenimiento - base.total_mensual_sin_mantenimiento),
          ...(f.total_mensual_con_mantenimiento != null && base.total_mensual_con_mantenimiento != null ? { diferencia_total_mensual_con_mantenimiento: redondea(f.total_mensual_con_mantenimiento - base.total_mensual_con_mantenimiento), ahorro_energia_y_mantenimiento_mensual: redondea(ahorroMes + (base.mantenimiento_mensual - f.mantenimiento_mensual)), ...(difPrecio > 0 && ahorroMes + (base.mantenimiento_mensual - f.mantenimiento_mensual) > 0 ? { meses_para_compensar_con_energia_y_mantenimiento: redondea(difPrecio / (ahorroMes + (base.mantenimiento_mensual - f.mantenimiento_mensual)), 0) } : {}) } : {}),
          diferencia_de_precio: redondea(difPrecio),
          meses_para_compensar_diferencia_de_precio_con_energia: difPrecio > 0 && ahorroMes > 0 ? redondea(difPrecio / ahorroMes, 0) : null,
          ahorro_energia_5_anios: redondea(ahorroMes * 60),
        };
      });
    }
    const ep = estadoPrecios(params);
    if (!ep.ok) out.aviso_precios = ep.aviso;
    return out;
  }
  return { error: "Herramienta desconocida" };
}

export function textoTaxis(taxis, marcasPropias = []) {
  if (!taxis.length) return "";
  const propias = new Set(marcasPropias.map(norm));
  const lst = taxis.map((t) => `${t.marca} ${t.modelo}${propias.has(norm(t.marca)) ? " (nuestra marca)" : ""} $${t.precio_usd}`).join("; ");
  return `\n## VEHÍCULOS HOMOLOGADOS PARA TAXI (${taxis.length})\nSolo estos modelos pueden operar como taxi: ${lst}.\nUsa buscar_taxis y analizar_negocio_taxi para detalles y análisis de operación.`;
}
