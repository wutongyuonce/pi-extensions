import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import Chart from "chart.js/auto";
import { uiStreamResultPatchNotificationSchema } from "../../../../ui-stream-types.ts";

const app = new App({ name: "interactive-visualizer", version: "0.1.0" });
const root = document.getElementById("app")!;

let chartInstance: Chart | null = null;

interface ChartSpec {
  type: "bar" | "line" | "pie" | "doughnut";
  title?: string;
  labels: string[];
  datasets: Array<{ label: string; data: number[]; color?: string }>;
}

function renderChart(spec: ChartSpec) {
  root.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = spec.title || "Chart";
  root.appendChild(header);

  const canvas = document.createElement("canvas");
  canvas.style.maxHeight = "400px";
  root.appendChild(canvas);

  chartInstance?.destroy();
  chartInstance = new Chart(canvas, {
    type: spec.type,
    data: {
      labels: spec.labels,
      datasets: spec.datasets.map((ds) => ({
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.color || undefined,
        borderColor: ds.color || undefined,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
    },
  });

  appendMessageForm();
}

function renderSvg(svg: string) {
  root.innerHTML = "";
  const container = document.createElement("div");
  container.className = "svg-container";
  container.innerHTML = svg;
  root.appendChild(container);

  // Wire up clickable choice nodes
  container.addEventListener("click", async (e) => {
    const target = (e.target as Element).closest("[data-choice]");
    if (!target) return;
    const choice = target.getAttribute("data-choice");
    if (!choice) return;
    const label = target.textContent?.trim() || choice;
    await app.sendMessage({ role: "user", content: [{ type: "text", text: `Chose: ${label}` }] }).catch(() => {});
  });

  appendMessageForm();
}

function appendMessageForm() {
  const form = document.createElement("form");
  form.className = "message-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Send a message to the agent...";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Send";
  form.append(input, button);
  root.appendChild(form);

  const status = document.createElement("div");
  status.className = "status";
  root.appendChild(status);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    status.textContent = "Sending...";
    try {
      await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      status.textContent = "Sent!";
      setTimeout(() => { status.textContent = ""; }, 2000);
    } catch (err) {
      status.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
    }
  });
}

function extractContent(data: Record<string, unknown>) {
  const sc = data.structuredContent as Record<string, unknown> | undefined;
  if (sc?.svg) return { type: "svg" as const, svg: sc.svg as string };
  if (sc?.chart) return { type: "chart" as const, chart: sc.chart as ChartSpec };
  return undefined;
}

function renderContent(content: ReturnType<typeof extractContent>) {
  if (!content) return;
  if (content.type === "svg") renderSvg(content.svg);
  else renderChart(content.chart);
}

app.setNotificationHandler(uiStreamResultPatchNotificationSchema, (notification) => {
  renderContent(extractContent(notification.params));
});

app.ontoolresult = (result) => {
  renderContent(extractContent(result as Record<string, unknown>));
};

app.ontoolinput = async ({ arguments: args }) => {
  if (!args) return;
  try {
    if (args.type && args.labels && args.datasets) {
      const labels = Array.isArray(args.labels)
        ? (args.labels as string[])
        : ((args.labels as string) || "").split(",").map((s) => s.trim());
      const datasets = Array.isArray(args.datasets)
        ? (args.datasets as ChartSpec["datasets"])
        : JSON.parse((args.datasets as string) || "[]");
      renderChart({
        type: (args.type as ChartSpec["type"]) || "bar",
        title: (args.title as string) || "Chart",
        labels,
        datasets,
      });
    }
  } catch (err) {
    root.textContent = `Error: ${err instanceof Error ? err.message : err}`;
  }
};

void app.connect(new PostMessageTransport(window.parent, window.parent)).catch((err) => {
  root.textContent = `Connection failed: ${err instanceof Error ? err.message : err}`;
});
