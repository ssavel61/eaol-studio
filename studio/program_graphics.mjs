import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DIMENSIONS = {
  lower_third: { width: 1800, height: 140 },
  topic_bar: { width: 1320, height: 118 },
};

function loadFonts() {
  return [
    { file: "Inter-Regular.ttf", weight: 400 },
    { file: "Inter-Bold.ttf", weight: 700 },
    { file: "Inter-Black.ttf", weight: 900 },
  ].map(({ file, weight }) => {
    const path = join(ROOT, "fonts", file);
    if (!existsSync(path)) throw new Error(`missing program-graphics font: ${path}`);
    return { name: "Inter", data: readFileSync(path), weight, style: "normal" };
  });
}

const box = (style, children) => ({ type: "div", props: { style, children } });
const text = (style, children) => ({ type: "div", props: { style, children } });

function nameCard(name, alignment) {
  return box({
    width: "760px",
    height: "112px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: alignment,
    padding: "0 34px",
    color: "#ffffff",
    backgroundColor: "rgba(14,23,27,0.94)",
    border: "2px solid rgba(138,191,197,0.82)",
    borderRadius: "18px",
    boxShadow: "0 10px 26px rgba(0,0,0,0.30)",
  }, [
    text({ fontSize: 34, fontWeight: 900, letterSpacing: -0.4, lineHeight: 1 }, name),
    text({ color: "#8abfc5", fontSize: 18, fontWeight: 700, letterSpacing: 1.7, lineHeight: 1, marginTop: "10px" }, "CO-HOST"),
  ]);
}

export async function renderProgramGraphicOverlay({ type, outputPath, hostOneName, hostTwoName, title }) {
  if (!outputPath) throw new Error("program graphic output path is required");
  if (!DIMENSIONS[type]) throw new Error("program graphic type must be lower_third or topic_bar");
  const { width, height } = DIMENSIONS[type];
  const element = type === "lower_third"
    ? box({
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontFamily: "Inter",
        padding: "14px 0",
        backgroundColor: "rgba(0,0,0,0)",
      }, [
        nameCard(String(hostOneName || "Host 1").trim().slice(0, 80), "flex-start"),
        nameCard(String(hostTwoName || "Host 2").trim().slice(0, 80), "flex-end"),
      ])
    : box({
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Inter",
        padding: "10px",
        color: "#ffffff",
        backgroundColor: "rgba(14,23,27,0.95)",
        border: "2px solid rgba(138,191,197,0.86)",
        borderRadius: "22px",
        boxShadow: "0 10px 26px rgba(0,0,0,0.30)",
      }, [
        box({ display: "flex", width: "9px", height: "58px", marginRight: "24px", backgroundColor: "#f3e2ae", borderRadius: "5px" }, []),
        text({ fontSize: 36, fontWeight: 900, letterSpacing: -0.5, lineHeight: 1.05 }, String(title || "").trim().slice(0, 120)),
      ]);
  const svg = await satori(element, { width, height, fonts: loadFonts() });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error("program graphic rendered at an unexpected size");
  }
  writeFileSync(outputPath, png);
  return { path: outputPath, type, width, height, bytes: png.length };
}
