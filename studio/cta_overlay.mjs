import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const WIDTH = 760;
const HEIGHT = 112;

function loadFonts() {
  return [
    { file: "Inter-Regular.ttf", weight: 400 },
    { file: "Inter-Bold.ttf", weight: 700 },
    { file: "Inter-Black.ttf", weight: 900 },
  ].map(({ file, weight }) => {
    const path = join(ROOT, "fonts", file);
    if (!existsSync(path)) throw new Error(`missing CTA font: ${path}`);
    return { name: "Inter", data: readFileSync(path), weight, style: "normal" };
  });
}

const box = (style, children) => ({ type: "div", props: { style, children } });
const text = (style, children) => ({ type: "div", props: { style, children } });

export async function renderCtaOverlay({
  websiteLabel = "Podcast",
  websiteUrlLabel = "example.com/podcast",
  secondaryLabel = null,
  actions = ["like", "comment", "subscribe"],
  outputPath,
}) {
  if (!outputPath) throw new Error("CTA overlay output path is required");
  const safeLabel = String(websiteLabel || "Podcast").trim().slice(0, 80) || "Podcast";
  const safeUrlLabel = String(websiteUrlLabel || "").trim().slice(0, 120);
  const safeSecondaryLabel = String(secondaryLabel ?? safeUrlLabel).trim().slice(0, 120);
  const normalizedActions = (actions || []).map((action) => String(action).trim().toLowerCase()).filter(Boolean);
  const primaryAction = normalizedActions.includes("subscribe") ? "SUBSCRIBE" : (normalizedActions[0] || "EXPLORE").toUpperCase();
  const element = box({
    width: WIDTH,
    height: HEIGHT,
    display: "flex",
    alignItems: "center",
    fontFamily: "Inter",
    padding: "10px",
    backgroundColor: "rgba(0,0,0,0)",
  }, [
    box({
      width: "100%",
      height: "92px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 18px 0 22px",
      backgroundColor: "rgba(14,23,27,0.94)",
      border: "2px solid rgba(138,191,197,0.82)",
      borderRadius: "46px",
      boxShadow: "0 10px 26px rgba(0,0,0,0.30)",
    }, [
      box({ display: "flex", alignItems: "center" }, [
        box({ display: "flex", width: "8px", height: "42px", marginRight: "16px", backgroundColor: "#8abfc5", borderRadius: "4px" }, []),
        box({ display: "flex", flexDirection: "column", justifyContent: "center" }, [
          text({ color: "#ffffff", fontSize: 28, fontWeight: 900, letterSpacing: -0.5, lineHeight: 1 }, safeLabel),
          ...(safeSecondaryLabel ? [text({
            color: "#8abfc5",
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: 0.2,
            lineHeight: 1,
            marginTop: "8px",
          }, safeSecondaryLabel)] : []),
        ]),
      ]),
      text({
        color: "#0e171b",
        fontSize: 20,
        fontWeight: 900,
        letterSpacing: 1.8,
        padding: "14px 22px",
        backgroundColor: "#f3e2ae",
        borderRadius: "28px",
      }, primaryAction),
    ]),
  ]);
  const svg = await satori(element, { width: WIDTH, height: HEIGHT, fonts: loadFonts() });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng();
  if (png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) {
    throw new Error("CTA overlay rendered at an unexpected size");
  }
  writeFileSync(outputPath, png);
  return {
    path: outputPath,
    width: WIDTH,
    height: HEIGHT,
    bytes: png.length,
    website_label: safeLabel,
    display_url: safeUrlLabel,
    secondary_label: safeSecondaryLabel,
  };
}
