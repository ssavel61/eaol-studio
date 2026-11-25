const params = new URLSearchParams(window.location.search);
const slug = params.get("episode") || "";
const fullReview = params.get("quality") === "full";
const status = document.querySelector("#status");
const video = document.querySelector("#proxy");
const backLink = document.querySelector("#back-to-studio");
const guideTitle = document.querySelector("#review-guide-title");
const timeline = document.querySelector("#review-timeline");

function formatTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1_000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  const prefix = hours ? `${hours}:${String(minutes).padStart(2, "0")}` : String(minutes);
  return `${prefix}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function timelineRow({ start_sec: startSec, end_sec: endSec, label, emphasis = false }) {
  const item = document.createElement("li");
  if (emphasis) item.className = "cta-moment";
  const range = document.createElement("strong");
  range.textContent = `${formatTime(startSec)}–${formatTime(endSec)}`;
  const description = document.createElement("span");
  description.textContent = label;
  const seek = document.createElement("button");
  seek.type = "button";
  seek.className = "seek-button";
  seek.textContent = "Jump to";
  seek.setAttribute("aria-label", `Jump to ${label} at ${formatTime(startSec)}`);
  seek.addEventListener("click", () => {
    video.currentTime = Math.max(0, Number(startSec || 0) - 1);
    video.play().catch(() => {});
  });
  item.append(range, description, seek);
  return item;
}

function renderTimeline(proxy) {
  const sections = proxy.timeline?.sections || [];
  const ctas = proxy.cta?.timeline || proxy.timeline?.ctas || [];
  const graphics = proxy.program_graphics?.timeline || proxy.timeline?.graphics || [];
  timeline.replaceChildren();
  const sectionLabels = {
    opening: "Approved show opening",
    program: "Complete side-by-side program",
    closing: "Approved show closing",
  };
  sections.forEach((section) => timeline.append(timelineRow({
    ...section,
    label: sectionLabels[section.type] || section.type,
  })));
  const ctaLabels = {
    newsletter: "Newsletter CTA shown",
    podcast_growth: "Podcast CTA shown",
    closing: "Closing CTA shown",
  };
  ctas.forEach((cue) => timeline.append(timelineRow({
    ...cue,
    label: ctaLabels[cue.cta_type] || "CTA shown",
    emphasis: true,
  })));
  graphics.forEach((cue) => timeline.append(timelineRow({
    ...cue,
    label: cue.type === "lower_third" ? `Lower-thirds: ${cue.label}` : `Topic bar: ${cue.label}`,
    emphasis: true,
  })));
  if (proxy.timeline?.closing_audio_lead) timeline.append(timelineRow({
    ...proxy.timeline.closing_audio_lead,
    label: "Closing music begins under final spoken lines",
    emphasis: true,
  }));
  guideTitle.textContent = `One continuous ${formatTime(proxy.output?.duration_sec)} package`;
}

function renderFullReview(render) {
  document.body.classList.add("full-review");
  document.title = "Studio · final 4K playback review";
  document.querySelector("h1").textContent = "Approve the finished 4K playback";
  document.querySelector(".lede").textContent = "Use the six Jump to buttons. Check sync, graphics, and the opening/closing in the finished file. Your edit and color choices are already approved; an uninterrupted full watch is not required.";
  const sections = render.timeline?.sections || [];
  const program = sections.find(section => section.type === "program");
  const closing = sections.find(section => section.type === "closing");
  if (!program || !closing) throw new Error("The final video's review timeline is unavailable.");
  const graphics = render.program_graphics?.timeline || [];
  const names = graphics.filter(cue => cue.type === "lower_third");
  const topic = graphics.find(cue => cue.type === "topic_bar");
  const middleNames = names[Math.floor(names.length / 2)];
  const lateCta = (render.cta?.timeline || []).filter(cue => cue.end_sec <= program.end_sec).at(-1);
  const moments = [
    { start_sec: Math.max(0, program.start_sec - 5), end_sec: program.start_sec + 12, label: "Opening transition" },
    { start_sec: program.start_sec + 15, end_sec: program.start_sec + 30, label: "Early lip sync and framing" },
    topic && { ...topic, label: "Topic bar readability" },
    middleNames && { ...middleNames, label: "Mid-episode names" },
    { start_sec: lateCta?.start_sec ?? Math.max(program.start_sec, program.end_sec - 35), end_sec: lateCta?.end_sec ?? program.end_sec - 10, label: "Late lip sync and CTA" },
    { start_sec: render.timeline?.closing_audio_lead?.start_sec ?? closing.start_sec, end_sec: render.output.duration_sec, label: "Closing music and ending" },
  ].filter(Boolean);
  timeline.replaceChildren(...moments.map(moment => timelineRow(moment)));
  guideTitle.textContent = `${moments.length} quick playback checks`;
  const acceptance = document.querySelector(".acceptance");
  acceptance.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "When these look and sound right";
  const instruction = document.createElement("p");
  instruction.textContent = "Record your decision in the Production workflow notes. If something is wrong, note the timestamp and what you see.";
  const scope = document.createElement("p");
  scope.textContent = "This is local playback approval. Uploading and publishing remain separate.";
  acceptance.append(heading, instruction, scope);
}

async function loadReview() {
  const response = await fetch(`/api/episodes/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error("Studio could not load this episode's review details.");
  const { episode } = await response.json();
  const proxy = fullReview ? episode?.episode_render : episode?.episode_proxy;
  if (!proxy || proxy.stale || proxy.status !== "complete") {
    throw new Error(fullReview ? "The current recipe does not have a finished full-resolution video yet." : "The current recipe does not have a finished low-resolution proxy yet.");
  }
  if (fullReview) renderFullReview(proxy);
  else renderTimeline(proxy);
  video.src = `/api/episodes/${encodeURIComponent(slug)}/${fullReview ? "episode-media" : "episode-proxy-media"}`;
  status.className = "status ready";
  status.textContent = fullReview
    ? `${proxy.output.width}×${proxy.output.height} · ${formatTime(proxy.output.duration_sec)} · actual final video`
    : "Complete package ready · use Jump to for the opening, program, CTA, graphic, and closing checks. Studio supports a complete watch or a passing metadata audit plus focused human review.";
}

if (!/^[a-z0-9_]+$/.test(slug)) {
  status.className = "status error";
  status.textContent = "This package-review link does not contain a valid episode.";
  video.hidden = true;
} else {
  backLink.href = `/?episode=${encodeURIComponent(slug)}#assembly-workspace`;
  loadReview().catch((error) => {
    status.className = "status error";
    status.textContent = error.message;
    guideTitle.textContent = "Exact rendered timeline unavailable";
    video.hidden = true;
  });
}
