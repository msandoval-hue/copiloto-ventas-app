import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Carga el cerebro del agente: copiloto.md es obligatorio; los demás archivos
// de prompts/ son opcionales (si falta uno, la app arranca igual).
function leer(ruta, obligatorio = false) {
  try {
    return readFileSync(ruta, "utf8");
  } catch (e) {
    if (obligatorio) throw e;
    console.warn("Aviso: no se encontró " + ruta);
    return "";
  }
}
const SYSTEM = [
  leer("./prompts/copiloto.md", true),
  leer("./prompts/expertos.md"),
  leer("./prompts/mercado.md"),
  leer("./prompts/triggers.md"),
  leer("./prompts/practicas.md"),
]
  .filter(Boolean)
  .join("\n\n");
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const PIN = process.env.APP_PIN || "";

app.get("/health", (_req, res) => res.send("ok"));

app.post("/api/chat", async (req, res) => {
  // Protección simple: la app es pública y cada llamada cuesta
  if (PIN && req.headers["x-pin"] !== PIN) {
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  try {
    const messages = (req.body.messages || [])
      .slice(-20)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 4000),
      }));
    if (!messages.length) return res.status(400).json({ error: "Sin mensajes" });

    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    });
    const reply = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error del agente, intenta de nuevo" });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Copiloto activo"));
