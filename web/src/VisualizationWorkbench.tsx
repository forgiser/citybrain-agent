import { MapPanel } from "./MapPanel";
import { MarkdownContent } from "./MarkdownContent";
import type { Artifact } from "./types";

export type VisualizationKind =
  | "map"
  | "markdown"
  | "html"
  | "csv"
  | "json"
  | "text"
  | "image";

export interface VisualizationTab {
  id: string;
  kind: VisualizationKind;
  title: string;
  sourcePath?: string;
  artifactId?: string;
  content?: string;
  contentUrl?: string;
  closable: boolean;
}

export const MAP_VISUALIZATION: VisualizationTab = {
  id: "map",
  kind: "map",
  title: "地图",
  closable: false,
};

export function VisualizationWorkbench({
  sessionId,
  artifacts,
  autoFit,
  baseMap,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onLayerAdded,
  onLayerRemoved,
}: {
  sessionId?: string;
  artifacts: Artifact[];
  autoFit: boolean;
  baseMap: "osm" | "blank";
  tabs: VisualizationTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onLayerAdded: (artifact: Artifact) => void;
  onLayerRemoved: (artifactId: string) => void;
}) {
  return (
    <main className="visualization-workbench">
      <div className="visualization-tabs" role="tablist" aria-label="可视化标签页">
        {tabs.map((tab) => (
          <div className={`visualization-tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
            <button type="button" role="tab" onClick={() => onActivate(tab.id)} title={tab.sourcePath ?? tab.title}>
              <span>{visualizationIcon(tab.kind)}</span>
              <strong>{tab.title}</strong>
            </button>
            {tab.closable && (
              <button type="button" className="close-tab" aria-label={`关闭 ${tab.title}`} onClick={() => onClose(tab.id)}>×</button>
            )}
          </div>
        ))}
      </div>
      <div className="visualization-stage">
        <div className={`visualization-view map-view ${activeTabId === "map" ? "active" : ""}`}>
          <MapPanel sessionId={sessionId} artifacts={artifacts} autoFit={autoFit} baseMap={baseMap} onLayerAdded={onLayerAdded} onLayerRemoved={onLayerRemoved} />
        </div>
        {tabs.filter((tab) => tab.kind !== "map").map((tab) => (
          <div className={`visualization-view ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
            <FileVisualization tab={tab} />
          </div>
        ))}
      </div>
    </main>
  );
}

function FileVisualization({ tab }: { tab: VisualizationTab }) {
  return (
    <section className={`file-visualization ${tab.kind}`}>
      <header>
        <div><small>{tab.kind.toUpperCase()}</small><h2>{tab.title}</h2></div>
        {tab.sourcePath && <span title={tab.sourcePath}>{tab.sourcePath}</span>}
      </header>
      <div className="file-visualization-content">
        {tab.kind === "markdown" && <article className="document-view"><MarkdownContent>{tab.content ?? ""}</MarkdownContent></article>}
        {tab.kind === "html" && <iframe title={tab.title} sandbox="" srcDoc={tab.content ?? ""} />}
        {tab.kind === "csv" && <CsvViewer content={tab.content ?? ""} />}
        {tab.kind === "json" && <pre className="code-view">{formatJson(tab.content ?? "")}</pre>}
        {tab.kind === "text" && <pre className="text-view">{tab.content}</pre>}
        {tab.kind === "image" && tab.contentUrl && <div className="image-view"><img src={tab.contentUrl} alt={tab.title} /></div>}
      </div>
    </section>
  );
}

function CsvViewer({ content }: { content: string }) {
  const rows = parseCsv(content).slice(0, 500);
  const [header = [], ...body] = rows;
  if (header.length === 0) return <div className="empty-visualization">CSV 文件为空</div>;
  return (
    <div className="table-view">
      <table>
        <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ""}</td>)}</tr>)}</tbody>
      </table>
      {rows.length >= 500 && <p>仅显示前 500 行。</p>}
    </div>
  );
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (char === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function visualizationIcon(kind: VisualizationKind): string {
  return {
    map: "◇",
    markdown: "M↓",
    html: "<>" ,
    csv: "▦",
    json: "{}",
    text: "≡",
    image: "▧",
  }[kind];
}
