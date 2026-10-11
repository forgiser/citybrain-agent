import { useEffect, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
} from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { api } from "./api";
import { getWebClientId } from "./clientId";
import type { Artifact, PendingMapLayer } from "./types";

setWorkerUrl(mapLibreWorkerUrl);

// map.loaded() becomes false again while sources, tiles, or animations are
// active. Commands only need the style to have initialized once.
const initializedMaps = new WeakSet<MapLibreMap>();

interface MapPanelProps {
  sessionId?: string;
  artifacts: Artifact[];
  pendingLayers: PendingMapLayer[];
  autoFit: boolean;
  baseMap: "osm" | "blank";
  onLayerAdded: (artifact: Artifact) => void;
  onLayerRemoved: (artifactId: string) => void;
}

interface MapSelection {
  layerId: string;
  featureId?: string | number;
  geometryType?: string;
  properties?: Record<string, unknown>;
}

interface MapCommandEnvelope {
  id: string;
  command: "set_view" | "fit_layer" | "add_layer" | "remove_layer" | "set_layer_visibility" | "update_layer" | "inspect_layer" | "visualize_layer";
  payload: Record<string, unknown>;
}

interface LayerVisualization {
  mode: "simple" | "categorical" | "graduated";
  field?: string;
  title: string;
  color: string;
  opacity: number;
  pointRadius: number;
  lineWidth: number;
  classification?: "quantile" | "equal_interval";
  legend: Array<{ label: string; color: string }>;
  categoryStops?: Array<{ value: string | number | boolean; color: string }>;
  numericStops?: Array<{ minimum: number; color: string }>;
}

interface MapCommandHandlers {
  onLayerAdded: (artifact: Artifact) => void;
  onLayerRemoved: (artifactId: string) => void;
  setLayerVisibility: (artifactId: string, visible: boolean) => void;
  setLayerVisualization: (artifactId: string, visualization: LayerVisualization) => void;
}

export function MapPanel({ sessionId, artifacts, pendingLayers, autoFit, baseMap, onLayerAdded, onLayerRemoved }: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [layerErrors, setLayerErrors] = useState<Map<string, string>>(new Map());
  const [layerVisualizations, setLayerVisualizations] = useState<Map<string, LayerVisualization>>(new Map());
  const [mapError, setMapError] = useState<string>();
  const [commandLoads, setCommandLoads] = useState<PendingMapLayer[]>([]);
  const artifactsRef = useRef(artifacts);
  const hiddenLayersRef = useRef(hiddenLayers);
  const selectionRef = useRef<MapSelection | undefined>(undefined);
  const clientIdRef = useRef(getWebClientId());

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const savedView = readSavedView(sessionId);
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: containerRef.current,
        center: savedView?.center ?? [105, 35],
        zoom: savedView?.zoom ?? 3,
        style: {
          version: 8,
          sources: baseMap === "osm" ? {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          } : {},
          layers: baseMap === "osm" ? [{ id: "osm", type: "raster", source: "osm" }] : [],
        },
      });
    } catch (error) {
      setMapError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    setMapError(undefined);
    map.addControl(new NavigationControl(), "top-right");
    map.addControl(new ScaleControl(), "bottom-left");
    const reportState = (): void => {
      if (!sessionId) return;
      void reportMapState(
        map,
        sessionId,
        clientIdRef.current,
        artifactsRef.current,
        hiddenLayersRef.current,
        selectionRef.current,
      );
    };
    map.on("error", (event) => {
      const message = event.error instanceof Error
        ? event.error.message
        : String(event.error);
      if (/worker|webgl|gpu/iu.test(message)) setMapError(message);
    });
    map.on("moveend", () => {
      if (!sessionId) return;
      const center = map.getCenter();
      localStorage.setItem(
        `geoagent-map-view:${sessionId}`,
        JSON.stringify({ center: [center.lng, center.lat], zoom: map.getZoom() }),
      );
      reportState();
    });
    map.on("style.load", () => {
      initializedMaps.add(map);
      reportState();
    });
    map.on("click", (event) => {
      const features = map.queryRenderedFeatures(event.point).filter((feature) =>
        feature.layer.id.startsWith("fill-") ||
        feature.layer.id.startsWith("line-") ||
        feature.layer.id.startsWith("point-"),
      );
      const feature = features[0];
      if (!feature) {
        selectionRef.current = undefined;
        reportState();
        return;
      }
      selectionRef.current = {
        layerId: feature.layer.id,
        ...(feature.id !== undefined ? { featureId: feature.id } : {}),
        ...(feature.geometry?.type ? { geometryType: feature.geometry.type } : {}),
        ...(feature.properties ? { properties: feature.properties } : {}),
      };
      const content = document.createElement("div");
      content.className = "feature-popup";
      const title = document.createElement("strong");
      title.textContent = "要素属性";
      const properties = document.createElement("pre");
      properties.textContent = JSON.stringify(feature.properties ?? {}, null, 2);
      content.append(title, properties);
      new Popup({ maxWidth: "360px" })
        .setLngLat(event.lngLat)
        .setDOMContent(content)
        .addTo(map);
      reportState();
    });
    const heartbeat = window.setInterval(reportState, 15_000);
    mapRef.current = map;
    return () => {
      window.clearInterval(heartbeat);
      if (sessionId) {
        void api(`/api/sessions/${sessionId}/map-state`, {
          method: "DELETE",
          body: JSON.stringify({ clientId: clientIdRef.current }),
        }).catch(() => undefined);
      }
      map.remove();
      mapRef.current = null;
    };
  }, [baseMap, sessionId]);

  useEffect(() => {
    // Preserve command-added layers while React is committing the parent
    // artifact/id state in separate updates. A layer that still has a live
    // MapLibre source is authoritative even if one intermediate render omits it.
    const map = mapRef.current;
    const nextArtifacts = [...artifacts];
    const nextIds = new Set(nextArtifacts.map((artifact) => artifact.id));
    for (const artifact of artifactsRef.current) {
      if (!nextIds.has(artifact.id) && map?.getSource(`source-${artifact.id}`)) {
        nextArtifacts.push(artifact);
      }
    }
    artifactsRef.current = nextArtifacts;
    hiddenLayersRef.current = hiddenLayers;
    if (map && sessionId) {
      void reportMapState(
        map,
        sessionId,
        clientIdRef.current,
        nextArtifacts,
        hiddenLayers,
        selectionRef.current,
      );
    }
  }, [artifacts, hiddenLayers, sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    const clientId = clientIdRef.current;
    const source = new EventSource(
      `/api/sessions/${sessionId}/map-commands?clientId=${encodeURIComponent(clientId)}`,
    );
    const handleCommand = (rawEvent: Event): void => {
      const event = rawEvent as MessageEvent<string>;
      void (async () => {
        let command: MapCommandEnvelope | undefined;
        let pendingId: string | undefined;
        try {
          command = JSON.parse(event.data) as MapCommandEnvelope;
          if (command.command === "add_layer" || command.command === "visualize_layer") {
            pendingId = `command:${command.id}`;
            const source = command.command === "add_layer" ? command.payload.path : command.payload.layer;
            const path = typeof source === "string" ? source : "地图图层";
            const name = path.split(/[\\/]/u).at(-1) || "地图图层";
            setCommandLoads((value) => [{
              id: pendingId!,
              name,
              message: command?.command === "visualize_layer"
                ? "Agent 正在生成并应用图层可视化…"
                : /\.(?:tif|tiff|vrt|img|asc)$/iu.test(name)
                ? "Agent 正在重投影并准备栅格影像…"
                : "Agent 正在准备地图图层…",
            }, ...value.filter((item) => item.id !== pendingId)]);
          }
          const map = mapRef.current;
          if (!map) throw new Error("The Web map is not initialized.");
          const result = await executeMapCommand(
            map,
            command,
            artifactsRef.current,
            sessionId,
            clientId,
            hiddenLayersRef.current,
            selectionRef.current,
            {
              onLayerAdded: (artifact) => {
                // Command chaining must not wait for React to commit the next
                // render. Keep the command-side registry current immediately
                // so add -> inspect/visualize can use the returned layer id.
                artifactsRef.current = [
                  artifact,
                  ...artifactsRef.current.filter((item) => item.id !== artifact.id),
                ];
                onLayerAdded(artifact);
              },
              onLayerRemoved: (artifactId) => {
                artifactsRef.current = artifactsRef.current.filter((item) => item.id !== artifactId);
                onLayerRemoved(artifactId);
              },
              setLayerVisibility: (artifactId, visible) => {
                setHiddenLayers((value) => {
                  const next = new Set(value);
                  if (visible) next.delete(artifactId); else next.add(artifactId);
                  hiddenLayersRef.current = next;
                  return next;
                });
              },
              setLayerVisualization: (artifactId, visualization) => {
                setLayerVisualizations((value) => new Map(value).set(artifactId, visualization));
              },
            },
          );
          await api(`/api/sessions/${sessionId}/map-command-results`, {
            method: "POST",
            body: JSON.stringify({ clientId, id: command.id, ok: true, result }),
          });
        } catch (error) {
          if (!command?.id) return;
          await api(`/api/sessions/${sessionId}/map-command-results`, {
            method: "POST",
            body: JSON.stringify({
              clientId,
              id: command.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }).catch(() => undefined);
        } finally {
          if (pendingId) {
            setCommandLoads((value) => value.filter((item) => item.id !== pendingId));
          }
        }
      })();
    };
    source.addEventListener("command", handleCommand);
    return () => {
      source.removeEventListener("command", handleCommand);
      source.close();
    };
  }, [onLayerAdded, onLayerRemoved, sessionId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    let cancelled = false;
    const load = (): void => {
      if (cancelled) return;
      const activeIds = new Set(artifacts.map((artifact) => artifact.id));
      for (const layer of map.getStyle().layers ?? []) {
        const artifactId = layer.id.match(/^(?:fill|line|point|raster)-(.+)$/u)?.[1];
        if (artifactId && !activeIds.has(artifactId) && map.getLayer(layer.id)) map.removeLayer(layer.id);
      }
      for (const sourceId of Object.keys(map.getStyle().sources ?? {})) {
        const artifactId = sourceId.startsWith("source-") ? sourceId.slice("source-".length) : undefined;
        if (artifactId && !activeIds.has(artifactId) && map.getSource(sourceId)) map.removeSource(sourceId);
      }
      for (const artifact of artifacts) {
        if (artifact.status !== "ready" || !isDisplayMapArtifact(artifact) || !artifact.map?.dataUrl) continue;
        const sourceId = `source-${artifact.id}`;
        if (map.getSource(sourceId)) continue;
        if (artifact.map.format === "raster-image") {
          void addRasterImageLayer(map, artifact, autoFit)
            .then(() => {
              if (cancelled || mapRef.current !== map) return;
              setLayerErrors((value) => {
                const next = new Map(value);
                next.delete(artifact.id);
                return next;
              });
              if (sessionId) {
                void reportMapState(
                  map,
                  sessionId,
                  clientIdRef.current,
                  artifactsRef.current,
                  hiddenLayersRef.current,
                  selectionRef.current,
                );
              }
            })
            .catch((error: unknown) => {
              if (cancelled) return;
              setLayerErrors((value) => new Map(value).set(
                artifact.id,
                error instanceof Error ? error.message : String(error),
              ));
            });
          continue;
        }
        void fetch(artifact.map.dataUrl)
          .then(async (response) => {
            if (!response.ok) throw new Error(`读取图层失败（HTTP ${response.status}）`);
            const value = await response.json() as unknown;
            if (!isGeoJson(value)) throw new Error("文件不是有效的 GeoJSON 数据");
            return value;
          })
          .then((geojson: GeoJSON.GeoJSON) => {
            if (cancelled || mapRef.current !== map) return;
            setLayerErrors((value) => {
              const next = new Map(value);
              next.delete(artifact.id);
              return next;
            });
            if (map.getSource(sourceId)) {
              (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
              if (sessionId) {
                void reportMapState(
                  map,
                  sessionId,
                  clientIdRef.current,
                  artifactsRef.current,
                  hiddenLayersRef.current,
                  selectionRef.current,
                );
              }
              return;
            }
            map.addSource(sourceId, { type: "geojson", data: geojson });
            map.addLayer({
              id: `fill-${artifact.id}`,
              type: "fill",
              source: sourceId,
              filter: ["==", ["geometry-type"], "Polygon"],
              paint: { "fill-color": "#22c55e", "fill-opacity": (artifact.layer?.opacity ?? 1) * 0.28, "fill-outline-color": "#86efac" },
            });
            map.addLayer({
              id: `line-${artifact.id}`,
              type: "line",
              source: sourceId,
              filter: ["==", ["geometry-type"], "LineString"],
              paint: { "line-color": "#38bdf8", "line-width": 3, "line-opacity": artifact.layer?.opacity ?? 1 },
            });
            map.addLayer({
              id: `point-${artifact.id}`,
              type: "circle",
              source: sourceId,
              filter: ["==", ["geometry-type"], "Point"],
              paint: { "circle-color": "#f59e0b", "circle-radius": 6, "circle-opacity": artifact.layer?.opacity ?? 1, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
            });
            if (autoFit) fitGeoJson(map, geojson);
            if (sessionId) {
              void reportMapState(
                map,
                sessionId,
                clientIdRef.current,
                artifactsRef.current,
                hiddenLayersRef.current,
                selectionRef.current,
              );
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setLayerErrors((value) => new Map(value).set(
              artifact.id,
              error instanceof Error ? error.message : String(error),
            ));
          });
      }
    };
    if (initializedMaps.has(map) || map.isStyleLoaded()) load();
    else map.once("style.load", load);
    return () => {
      cancelled = true;
      map.off("style.load", load);
    };
  }, [artifacts, autoFit, sessionId]);

  function toggleLayer(artifactId: string) {
    const map = mapRef.current;
    const hidden = hiddenLayers.has(artifactId);
    for (const prefix of ["fill", "line", "point", "raster"]) {
      const id = `${prefix}-${artifactId}`;
      if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", hidden ? "visible" : "none");
    }
    setHiddenLayers((value) => {
      const next = new Set(value);
      if (hidden) next.delete(artifactId); else next.add(artifactId);
      hiddenLayersRef.current = next;
      if (map && sessionId) {
        void reportMapState(
          map,
          sessionId,
          clientIdRef.current,
          artifactsRef.current,
          next,
          selectionRef.current,
        );
      }
      return next;
    });
    if (sessionId) {
      void api(`/api/sessions/${sessionId}/map/layers/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ visible: hidden }),
      }).catch(() => undefined);
    }
  }

  function setLayerOpacity(artifactId: string, opacity: number) {
    const map = mapRef.current;
    if (map?.getLayer(`fill-${artifactId}`)) map.setPaintProperty(`fill-${artifactId}`, "fill-opacity", opacity * 0.28);
    if (map?.getLayer(`line-${artifactId}`)) map.setPaintProperty(`line-${artifactId}`, "line-opacity", opacity);
    if (map?.getLayer(`point-${artifactId}`)) map.setPaintProperty(`point-${artifactId}`, "circle-opacity", opacity);
    if (map?.getLayer(`raster-${artifactId}`)) map.setPaintProperty(`raster-${artifactId}`, "raster-opacity", opacity);
    if (sessionId) {
      void api(`/api/sessions/${sessionId}/map/layers/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ opacity }),
      }).catch(() => undefined);
    }
  }

  async function removeLayer(artifactId: string) {
    const map = mapRef.current;
    if (map) removeMapLayer(map, artifactId);
    onLayerRemoved(artifactId);
    if (sessionId) {
      await api(`/api/sessions/${sessionId}/map/layers/${artifactId}`, { method: "DELETE" });
    }
  }

  async function zoomTo(artifact: Artifact) {
    const map = mapRef.current;
    if (!map || !artifact.map?.dataUrl) return;
    if (artifact.map.format === "raster-image") {
      fitRasterCoordinates(map, requireRasterCoordinates(artifact));
      return;
    }
    const geojson = await fetch(artifact.map.dataUrl).then((response) => response.json()) as GeoJSON.GeoJSON;
    fitGeoJson(map, geojson);
  }

  const loadingLayers = [...pendingLayers, ...commandLoads];

  return (
    <main className="map-panel">
      <div ref={containerRef} className="map-canvas" />
      {loadingLayers.length > 0 && <div className="map-loading-banner">
        <i />
        <div><strong>正在加载地图数据</strong><span>{loadingLayers[0]?.message}</span></div>
      </div>}
      {mapError && (
        <div className="map-error">
          <strong>地图暂时无法初始化</strong>
          <span>{mapError}</span>
          <small>Agent 问答和项目文件仍可继续使用。</small>
        </div>
      )}
      <div className="map-title">
        <span className="status-dot" />
        空间工作区
      </div>
      <div className="layer-card">
        <strong>图层</strong>
        {loadingLayers.map((item) => <div className="layer-loading" key={item.id}>
          <i />
          <div><strong>{item.name}</strong><small>{item.message}</small></div>
        </div>)}
        {artifacts.filter(isDisplayMapArtifact).length === 0 && loadingLayers.length === 0 ? (
          <p>地图不会自动加载文件。请在项目目录中点击“＋图”添加 GeoJSON、SHP、GPKG、KML 或 GML。</p>
        ) : artifacts.filter(isDisplayMapArtifact).map((item) => (
          <div className="layer-entry" key={item.id}>
            <div className="layer-row">
              <input type="checkbox" checked={!hiddenLayers.has(item.id)} onChange={() => toggleLayer(item.id)} />
              <span className="layer-swatch" style={{ background: layerVisualizations.get(item.id)?.legend[0]?.color }} />
              <span>{item.name}</span>
              <button title="缩放至图层" onClick={() => void zoomTo(item)}>⌖</button>
              <button title="移除图层" onClick={() => void removeLayer(item.id)}>×</button>
            </div>
            <input
              className="layer-opacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              defaultValue={item.layer?.opacity ?? 1}
              title="图层透明度"
              onChange={(event) => setLayerOpacity(item.id, Number(event.target.value))}
            />
            {layerVisualizations.get(item.id) && <div className="layer-legend">
              <strong>{layerVisualizations.get(item.id)!.title}</strong>
              {layerVisualizations.get(item.id)!.legend.map((entry) => <span key={`${entry.label}:${entry.color}`}>
                <i style={{ background: entry.color }} />{entry.label}
              </span>)}
            </div>}
            {layerErrors.get(item.id) && <small className="layer-error">{layerErrors.get(item.id)}</small>}
          </div>
        ))}
      </div>
    </main>
  );
}

async function reportMapState(
  map: MapLibreMap,
  sessionId: string,
  clientId: string,
  artifacts: Artifact[],
  hiddenLayers: Set<string>,
  selection: MapSelection | undefined,
): Promise<void> {
  const center = map.getCenter();
  const bounds = map.getBounds();
  await api(`/api/sessions/${sessionId}/map-state`, {
    method: "PUT",
    body: JSON.stringify({
      clientId,
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      layers: artifacts
        // Only publish layers that MapLibre has actually loaded. React/backend
        // records may exist while a source is still loading or after it failed.
        .filter((artifact) => artifact.map && map.getSource(`source-${artifact.id}`))
        .map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          visible: !hiddenLayers.has(artifact.id),
          format: artifact.map?.format,
          ...(artifact.layer?.style ? { visualization: artifact.layer.style } : {}),
        })),
      ...(selection ? { selection } : {}),
    }),
  }).catch(() => undefined);
}

async function executeMapCommand(
  map: MapLibreMap,
  envelope: MapCommandEnvelope,
  artifacts: Artifact[],
  sessionId: string,
  clientId: string,
  hiddenLayers: Set<string>,
  selection: MapSelection | undefined,
  handlers: MapCommandHandlers,
): Promise<Record<string, unknown>> {
  // Inspection reads prepared GeoJSON and does not depend on the renderer.
  if (envelope.command !== "inspect_layer") await waitForMapInitialization(map);
  const durationMs = readCommandNumber(envelope.payload.durationMs, 0);
  let reportedArtifacts = artifacts;
  let reportedHiddenLayers = hiddenLayers;
  let commandResult: Record<string, unknown> = {};
  if (envelope.command === "set_view") {
    const center = readCommandCoordinate(envelope.payload.center);
    await runMapMovement(map, durationMs, () => {
      map.easeTo({
        center,
        ...(typeof envelope.payload.zoom === "number" ? { zoom: envelope.payload.zoom } : {}),
        ...(typeof envelope.payload.bearing === "number" ? { bearing: envelope.payload.bearing } : {}),
        ...(typeof envelope.payload.pitch === "number" ? { pitch: envelope.payload.pitch } : {}),
        duration: durationMs,
      });
    });
  } else if (envelope.command === "fit_layer") {
    const layer = String(envelope.payload.layer ?? "").trim();
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact?.map?.dataUrl) throw new Error(`Map layer not found or not ready: ${layer}`);
    const rasterCoordinates = artifact.map.format === "raster-image"
      ? requireRasterCoordinates(artifact)
      : undefined;
    const geojson = rasterCoordinates ? undefined : await loadArtifactGeoJson(artifact);
    await runMapMovement(map, durationMs, () => {
      const fitOptions = {
        padding: readCommandNumber(envelope.payload.padding, 70),
        maxZoom: readCommandNumber(envelope.payload.maxZoom, 14),
        duration: durationMs,
      };
      if (rasterCoordinates) {
        fitRasterCoordinates(map, rasterCoordinates, fitOptions);
      } else {
        fitGeoJson(map, geojson!, fitOptions);
      }
    });
  } else if (envelope.command === "add_layer") {
    const path = readCommandString(envelope.payload.path, "path");
    const artifact = await api<Artifact>(`/api/sessions/${sessionId}/map/layers`, {
      method: "POST",
      body: JSON.stringify({
        absolutePath: path,
        ...(typeof envelope.payload.layerName === "string" && envelope.payload.layerName.trim()
          ? { layerName: envelope.payload.layerName.trim() }
          : {}),
      }),
    });
    if (artifact.status !== "ready" || !isDisplayMapArtifact(artifact) || !artifact.map?.dataUrl) {
      throw new Error(`The file could not be prepared as a display-ready map layer: ${path}`);
    }
    await addPreparedMapLayer(map, artifact, envelope.payload.fit !== false);
    handlers.onLayerAdded(artifact);
    reportedArtifacts = [artifact, ...artifacts.filter((item) => item.id !== artifact.id)];
  } else if (envelope.command === "remove_layer") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    removeMapLayer(map, artifact.id);
    handlers.onLayerRemoved(artifact.id);
    await api(`/api/sessions/${sessionId}/map/layers/${artifact.id}`, { method: "DELETE" });
    reportedArtifacts = artifacts.filter((item) => item.id !== artifact.id);
  } else if (envelope.command === "set_layer_visibility") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const visible = readCommandBoolean(envelope.payload.visible, "visible");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    setMapLayerVisibility(map, artifact.id, visible);
    handlers.setLayerVisibility(artifact.id, visible);
    await api(`/api/sessions/${sessionId}/map/layers/${artifact.id}`, {
      method: "PATCH",
      body: JSON.stringify({ visible }),
    });
    reportedHiddenLayers = new Set(hiddenLayers);
    if (visible) reportedHiddenLayers.delete(artifact.id);
    else reportedHiddenLayers.add(artifact.id);
  } else if (envelope.command === "update_layer") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const changes = readCommandRecord(envelope.payload.changes, "changes");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    const patch: Record<string, unknown> = {};
    if (changes.visible !== undefined) {
      const visible = readCommandBoolean(changes.visible, "changes.visible");
      setMapLayerVisibility(map, artifact.id, visible);
      handlers.setLayerVisibility(artifact.id, visible);
      reportedHiddenLayers = new Set(hiddenLayers);
      if (visible) reportedHiddenLayers.delete(artifact.id); else reportedHiddenLayers.add(artifact.id);
      patch.visible = visible;
    }
    if (changes.opacity !== undefined) {
      const opacity = readCommandNumberInRange(changes.opacity, 1, 0, 1, "changes.opacity");
      setMapLayerOpacity(map, artifact.id, opacity);
      if (artifact.layer) artifact.layer.opacity = opacity;
      patch.opacity = opacity;
    }
    if (Object.keys(patch).length === 0) throw new Error("changes must include visible or opacity.");
    await api(`/api/sessions/${sessionId}/map/layers/${artifact.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    commandResult = { updated: patch };
  } else if (envelope.command === "inspect_layer") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    if (artifact.map?.format === "raster-image") {
      return {
        id: artifact.id,
        name: artifact.name,
        kind: "raster",
        format: artifact.layer?.sourceFormat,
        crs: artifact.map.crs,
        coordinates: artifact.map.coordinates,
        message: "Raster attribute and band inspection is not yet available in the Web map inspector.",
      };
    }
    const geojson = await loadArtifactGeoJson(artifact);
    return inspectGeoJsonLayer(artifact, geojson, readCommandInteger(envelope.payload.maxUniqueValues, 12, 2, 50));
  } else if (envelope.command === "visualize_layer") {
    const layer = readCommandString(envelope.payload.layer, "layer");
    const artifact = artifacts.find((item) => item.id === layer || item.name === layer);
    if (!artifact) throw new Error(`Loaded map layer not found: ${layer}`);
    if (artifact.map?.format === "raster-image") {
      const mode = readCommandEnum(envelope.payload.mode, "mode", ["grayscale", "rgb", "color_relief", "hillshade"] as const);
      const updated = await api<Artifact>(`/api/sessions/${sessionId}/map/layers/${artifact.id}/visualize`, {
        method: "POST",
        body: JSON.stringify({ ...envelope.payload, mode }),
      });
      removeMapLayer(map, artifact.id);
      await addRasterImageLayer(map, updated, false);
      if (hiddenLayers.has(artifact.id)) setMapLayerVisibility(map, artifact.id, false);
      handlers.onLayerAdded(updated);
      reportedArtifacts = [updated, ...artifacts.filter((item) => item.id !== artifact.id)];
      commandResult = { visualization: updated.layer?.style, raster: true };
    } else {
      const geojson = await loadArtifactGeoJson(artifact);
      const visualization = buildLayerVisualization(geojson, envelope.payload);
      applyLayerVisualization(map, artifact.id, visualization);
      if (artifact.layer) artifact.layer.style = visualization as unknown as Record<string, unknown>;
      handlers.setLayerVisualization(artifact.id, visualization);
      await api(`/api/sessions/${sessionId}/map/layers/${artifact.id}`, {
        method: "PATCH",
        body: JSON.stringify({ style: visualization, opacity: visualization.opacity }),
      });
      commandResult = { visualization };
    }
  } else {
    throw new Error(`Unsupported map command: ${String(envelope.command)}`);
  }

  await reportMapState(map, sessionId, clientId, reportedArtifacts, reportedHiddenLayers, selection);
  return {
    ...commandResult,
    ...currentMapView(map),
    layers: reportedArtifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      visible: !reportedHiddenLayers.has(artifact.id),
      format: artifact.map?.format,
    })),
  };
}

async function loadArtifactGeoJson(artifact: Artifact): Promise<GeoJSON.GeoJSON> {
  if (!artifact.map?.dataUrl) throw new Error(`Layer data is unavailable: ${artifact.name}`);
  const response = await fetch(artifact.map.dataUrl);
  if (!response.ok) throw new Error(`Unable to load layer data: ${response.status}`);
  const value = await response.json() as unknown;
  if (!isGeoJson(value)) throw new Error(`Layer is not valid GeoJSON: ${artifact.name}`);
  return value;
}

function inspectGeoJsonLayer(
  artifact: Artifact,
  geojson: GeoJSON.GeoJSON,
  maxUniqueValues: number,
): Record<string, unknown> {
  const features = collectFeatures(geojson);
  const geometryCounts = new Map<string, number>();
  const fields = new Map<string, {
    count: number;
    nullCount: number;
    types: Set<string>;
    unique: Map<string, string | number | boolean>;
    uniqueOverflow: boolean;
    minimum?: number;
    maximum?: number;
  }>();
  for (const feature of features) {
    const geometryType = feature.geometry?.type ?? "null";
    geometryCounts.set(geometryType, (geometryCounts.get(geometryType) ?? 0) + 1);
    for (const [name, rawValue] of Object.entries(feature.properties ?? {})) {
      const state = fields.get(name) ?? {
        count: 0,
        nullCount: 0,
        types: new Set<string>(),
        unique: new Map<string, string | number | boolean>(),
        uniqueOverflow: false,
      };
      state.count += 1;
      if (rawValue === null || rawValue === undefined) {
        state.nullCount += 1;
        state.types.add("null");
      } else {
        const type = typeof rawValue;
        state.types.add(type);
        if (type === "number" && Number.isFinite(rawValue)) {
          const number = rawValue as number;
          state.minimum = state.minimum === undefined ? number : Math.min(state.minimum, number);
          state.maximum = state.maximum === undefined ? number : Math.max(state.maximum, number);
        }
        if (type === "string" || type === "number" || type === "boolean") {
          const primitive = rawValue as string | number | boolean;
          const key = `${type}:${String(primitive)}`;
          if (state.unique.size < maxUniqueValues) state.unique.set(key, primitive);
          else if (!state.unique.has(key)) state.uniqueOverflow = true;
        }
      }
      fields.set(name, state);
    }
  }
  return {
    layer: { id: artifact.id, name: artifact.name },
    featureCount: features.length,
    geometryTypes: Object.fromEntries(geometryCounts),
    fields: [...fields.entries()].slice(0, 100).map(([name, state]) => ({
      name,
      types: [...state.types],
      populatedCount: state.count - state.nullCount,
      nullCount: features.length - (state.count - state.nullCount),
      ...(state.minimum !== undefined ? { minimum: state.minimum, maximum: state.maximum } : {}),
      uniqueValues: [...state.unique.values()].map((value) => typeof value === "string" ? value.slice(0, 160) : value),
      uniqueValuesTruncated: state.uniqueOverflow,
    })),
    fieldsTruncated: fields.size > 100,
  };
}

function buildLayerVisualization(
  geojson: GeoJSON.GeoJSON,
  payload: Record<string, unknown>,
): LayerVisualization {
  const mode = readCommandEnum(payload.mode, "mode", ["simple", "categorical", "graduated"] as const);
  const field = mode === "simple" ? undefined : readCommandString(payload.field, "field");
  const opacity = readCommandNumberInRange(payload.opacity, 0.78, 0, 1, "opacity");
  const pointRadius = readCommandNumberInRange(payload.pointRadius, 6, 1, 30, "pointRadius");
  const lineWidth = readCommandNumberInRange(payload.lineWidth, 3, 0.5, 20, "lineWidth");
  const classes = readCommandInteger(payload.classes, 5, 2, 9);
  const color = readCommandColor(payload.color, "#2563eb");
  const palette = readCommandPalette(payload.palette, mode === "graduated" ? GRADUATED_PALETTE : CATEGORICAL_PALETTE);
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim().slice(0, 100)
    : field ?? "图层样式";
  if (mode === "simple") {
    return { mode, title, color, opacity, pointRadius, lineWidth, legend: [{ label: artifactValueLabel(title), color }] };
  }

  const features = collectFeatures(geojson);
  const values = features
    .map((feature) => feature.properties?.[field!])
    .filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value));
  if (values.length === 0) throw new Error(`Field has no visualizable values: ${field}`);

  if (mode === "categorical") {
    const counts = new Map<string, { value: string | number | boolean; count: number }>();
    for (const value of values) {
      const key = `${typeof value}:${String(value)}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { value, count: 1 });
    }
    const selected = [...counts.values()].sort((left, right) => right.count - left.count).slice(0, classes);
    const legend = selected.map((entry, index) => ({
      label: `${artifactValueLabel(entry.value)} (${entry.count})`,
      color: palette[index % palette.length]!,
    }));
    if (counts.size > selected.length) legend.push({ label: `其他 (${counts.size - selected.length} 类)`, color });
    return {
      mode,
      field,
      title,
      color,
      opacity,
      pointRadius,
      lineWidth,
      legend,
      categoryStops: selected.map((entry, index) => ({ value: String(entry.value), color: palette[index % palette.length]! })),
    };
  }

  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (numeric.length === 0) throw new Error(`Graduated visualization requires a numeric field: ${field}`);
  const classification = readCommandEnum(payload.classification, "classification", ["quantile", "equal_interval"] as const, "quantile");
  const actualClasses = Math.min(classes, Math.max(1, new Set(numeric).size));
  const breaks = createNumericBreaks(numeric, actualClasses, classification);
  const legend = breaks.map((range, index) => ({
    label: `${formatLegendNumber(range.minimum)} – ${formatLegendNumber(range.maximum)}`,
    color: paletteColor(palette, index, breaks.length),
  }));
  return {
    mode,
    field,
    title,
    color,
    opacity,
    pointRadius,
    lineWidth,
    classification,
    legend,
    numericStops: breaks.map((range, index) => ({ minimum: range.minimum, color: paletteColor(palette, index, breaks.length) })),
  };
}

function applyLayerVisualization(map: MapLibreMap, artifactId: string, visualization: LayerVisualization): void {
  const colorExpression = createColorExpression(visualization);
  const fillId = `fill-${artifactId}`;
  const lineId = `line-${artifactId}`;
  const pointId = `point-${artifactId}`;
  if (map.getLayer(fillId)) {
    map.setPaintProperty(fillId, "fill-color", colorExpression);
    map.setPaintProperty(fillId, "fill-opacity", visualization.opacity * 0.55);
    map.setPaintProperty(fillId, "fill-outline-color", colorExpression);
  }
  if (map.getLayer(lineId)) {
    map.setPaintProperty(lineId, "line-color", colorExpression);
    map.setPaintProperty(lineId, "line-opacity", visualization.opacity);
    map.setPaintProperty(lineId, "line-width", visualization.lineWidth);
  }
  if (map.getLayer(pointId)) {
    map.setPaintProperty(pointId, "circle-color", colorExpression);
    map.setPaintProperty(pointId, "circle-opacity", visualization.opacity);
    map.setPaintProperty(pointId, "circle-radius", visualization.pointRadius);
  }
}

function createColorExpression(visualization: LayerVisualization): string | ExpressionSpecification {
  if (visualization.mode === "simple" || !visualization.field) return visualization.color;
  if (visualization.mode === "categorical") {
    const expression: unknown[] = ["match", ["to-string", ["get", visualization.field]]];
    for (const entry of visualization.categoryStops ?? []) expression.push(entry.value, entry.color);
    expression.push(visualization.color);
    return expression as ExpressionSpecification;
  }
  const stops = visualization.numericStops ?? [];
  const expression: unknown[] = ["step", ["to-number", ["get", visualization.field]], stops[0]?.color ?? visualization.color];
  for (const entry of stops.slice(1)) expression.push(entry.minimum, entry.color);
  return expression as ExpressionSpecification;
}

function collectFeatures(geojson: GeoJSON.GeoJSON): GeoJSON.Feature[] {
  if (geojson.type === "FeatureCollection") return geojson.features;
  if (geojson.type === "Feature") return [geojson];
  return [{ type: "Feature", properties: {}, geometry: geojson as GeoJSON.Geometry }];
}

function createNumericBreaks(
  sorted: number[],
  classes: number,
  classification: "quantile" | "equal_interval",
): Array<{ minimum: number; maximum: number }> {
  const minimum = sorted[0]!;
  const maximum = sorted.at(-1)!;
  if (classes <= 1 || minimum === maximum) return [{ minimum, maximum }];
  const thresholds: number[] = [minimum];
  for (let index = 1; index < classes; index += 1) {
    const value = classification === "equal_interval"
      ? minimum + ((maximum - minimum) * index) / classes
      : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * index) / classes))]!;
    if (value > thresholds.at(-1)!) thresholds.push(value);
  }
  return thresholds.map((start, index) => ({
    minimum: start,
    maximum: index + 1 < thresholds.length ? thresholds[index + 1]! : maximum,
  }));
}

const CATEGORICAL_PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#9333ea"];
const GRADUATED_PALETTE = ["#eff6ff", "#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a", "#172554"];

function readCommandPalette(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) throw new Error("palette must contain 2 to 12 colors.");
  return value.map((color) => readCommandColor(color));
}

function readCommandColor(value: unknown, fallback?: string): string {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) throw new Error("Colors must use six-digit CSS hex syntax.");
  return value;
}

function readCommandEnum<const T extends readonly string[]>(value: unknown, name: string, values: T, fallback?: T[number]): T[number] {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  return value as T[number];
}

function readCommandInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = readCommandNumberInRange(value, fallback, minimum, maximum, "integer value");
  if (!Number.isInteger(number)) throw new Error("Expected an integer value.");
  return number;
}

function readCommandNumberInRange(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const number = value === undefined ? fallback : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function artifactValueLabel(value: unknown): string {
  return String(value).slice(0, 80);
}

function formatLegendNumber(value: number): string {
  return Number(value.toPrecision(6)).toString();
}

function paletteColor(palette: string[], index: number, total: number): string {
  if (total <= 1) return palette.at(-1)!;
  return palette[Math.round((index * (palette.length - 1)) / (total - 1))]!;
}

async function addPreparedMapLayer(map: MapLibreMap, artifact: Artifact, fit: boolean): Promise<void> {
  if (artifact.map?.format === "raster-image") {
    await addRasterImageLayer(map, artifact, fit);
    return;
  }
  await addGeoJsonLayer(map, artifact, fit);
}

async function addRasterImageLayer(map: MapLibreMap, artifact: Artifact, fit: boolean): Promise<void> {
  if (!artifact.map?.dataUrl) throw new Error(`Layer data is unavailable: ${artifact.name}`);
  const coordinates = requireRasterCoordinates(artifact);
  const sourceId = `source-${artifact.id}`;
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "image",
      url: artifact.map.dataUrl,
      coordinates,
    });
    map.addLayer({
      id: `raster-${artifact.id}`,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": artifact.layer?.opacity ?? 1 },
    });
  }
  if (fit) fitRasterCoordinates(map, coordinates);
}

async function addGeoJsonLayer(map: MapLibreMap, artifact: Artifact, fit: boolean): Promise<void> {
  if (!artifact.map?.dataUrl) throw new Error(`Layer data is unavailable: ${artifact.name}`);
  const response = await fetch(artifact.map.dataUrl);
  if (!response.ok) throw new Error(`Unable to load layer data: ${response.status}`);
  const value = await response.json() as unknown;
  if (!isGeoJson(value)) throw new Error(`File is not valid GeoJSON: ${artifact.name}`);
  const sourceId = `source-${artifact.id}`;
  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(value);
  } else {
    map.addSource(sourceId, { type: "geojson", data: value });
    map.addLayer({
      id: `fill-${artifact.id}`,
      type: "fill",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#22c55e", "fill-opacity": (artifact.layer?.opacity ?? 1) * 0.28, "fill-outline-color": "#86efac" },
    });
    map.addLayer({
      id: `line-${artifact.id}`,
      type: "line",
      source: sourceId,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#38bdf8", "line-width": 3, "line-opacity": artifact.layer?.opacity ?? 1 },
    });
    map.addLayer({
      id: `point-${artifact.id}`,
      type: "circle",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-color": "#f59e0b", "circle-radius": 6, "circle-opacity": artifact.layer?.opacity ?? 1, "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
    });
  }
  if (fit) fitGeoJson(map, value);
}

function removeMapLayer(map: MapLibreMap, artifactId: string): void {
  for (const prefix of ["fill", "line", "point", "raster"]) {
    const id = `${prefix}-${artifactId}`;
    if (map.getLayer(id)) map.removeLayer(id);
  }
  const sourceId = `source-${artifactId}`;
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

function setMapLayerVisibility(map: MapLibreMap, artifactId: string, visible: boolean): void {
  for (const prefix of ["fill", "line", "point", "raster"]) {
    const id = `${prefix}-${artifactId}`;
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }
}

function setMapLayerOpacity(map: MapLibreMap, artifactId: string, opacity: number): void {
  if (map.getLayer(`fill-${artifactId}`)) map.setPaintProperty(`fill-${artifactId}`, "fill-opacity", opacity * 0.55);
  if (map.getLayer(`line-${artifactId}`)) map.setPaintProperty(`line-${artifactId}`, "line-opacity", opacity);
  if (map.getLayer(`point-${artifactId}`)) map.setPaintProperty(`point-${artifactId}`, "circle-opacity", opacity);
  if (map.getLayer(`raster-${artifactId}`)) map.setPaintProperty(`raster-${artifactId}`, "raster-opacity", opacity);
}

function isDisplayMapArtifact(artifact: Artifact): boolean {
  return artifact.map?.format === "geojson" || artifact.map?.format === "raster-image";
}

function requireRasterCoordinates(
  artifact: Artifact,
): [[number, number], [number, number], [number, number], [number, number]] {
  const coordinates = artifact.map?.coordinates;
  if (!coordinates || coordinates.length !== 4 || coordinates.some((coordinate) =>
    coordinate.length !== 2 || coordinate.some((value) => !Number.isFinite(value))
  )) {
    throw new Error(`Raster display coordinates are unavailable: ${artifact.name}`);
  }
  return coordinates;
}

function fitRasterCoordinates(
  map: MapLibreMap,
  coordinates: [[number, number], [number, number], [number, number], [number, number]],
  options: { padding?: number; maxZoom?: number; duration?: number } = {},
): void {
  const bounds = coordinates.reduce(
    (current, coordinate) => current.extend(coordinate),
    new LngLatBounds(coordinates[0], coordinates[0]),
  );
  map.fitBounds(bounds, {
    padding: options.padding ?? 70,
    maxZoom: options.maxZoom ?? 14,
    duration: options.duration ?? 800,
  });
}

function waitForMapInitialization(map: MapLibreMap): Promise<void> {
  if (initializedMaps.has(map) || map.isStyleLoaded()) {
    initializedMaps.add(map);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      map.off("style.load", onStyleLoad);
      reject(new Error("The Web map style did not initialize in time."));
    }, 10_000);
    const onStyleLoad = (): void => {
      window.clearTimeout(timeout);
      initializedMaps.add(map);
      resolve();
    };
    map.once("style.load", onStyleLoad);
  });
}

function runMapMovement(
  map: MapLibreMap,
  durationMs: number,
  start: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      map.off("moveend", finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, Math.max(durationMs + 2_000, 2_000));
    map.once("moveend", finish);
    try {
      start();
      if (durationMs === 0) window.setTimeout(finish, 0);
    } catch (error) {
      settled = true;
      window.clearTimeout(timeout);
      map.off("moveend", finish);
      reject(error);
    }
  });
}

function currentMapView(map: MapLibreMap): Record<string, unknown> {
  const center = map.getCenter();
  const bounds = map.getBounds();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
  };
}

function readCommandCoordinate(value: unknown): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    throw new Error("Invalid map center received from the server.");
  }
  return [value[0], value[1]];
}

function readCommandNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readCommandString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function readCommandBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function readCommandRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function fitGeoJson(
  map: MapLibreMap,
  geojson: GeoJSON.GeoJSON,
  options: { padding?: number; maxZoom?: number; duration?: number } = {},
): void {
  const coordinates: number[][] = [];
  collectCoordinates(geojson, coordinates);
  if (coordinates.length === 0) throw new Error("GeoJSON contains no coordinates to fit.");
  const bounds = coordinates.reduce(
    (current, coordinate) => current.extend(coordinate as [number, number]),
    new LngLatBounds(coordinates[0] as [number, number], coordinates[0] as [number, number]),
  );
  map.fitBounds(bounds, {
    padding: options.padding ?? 70,
    maxZoom: options.maxZoom ?? 14,
    duration: options.duration ?? 800,
  });
}

function collectCoordinates(value: unknown, output: number[][]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      output.push(value as number[]);
      return;
    }
    for (const item of value) collectCoordinates(item, output);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.coordinates) collectCoordinates(record.coordinates, output);
    if (record.geometry) collectCoordinates(record.geometry, output);
    if (record.features) collectCoordinates(record.features, output);
    if (record.geometries) collectCoordinates(record.geometries, output);
  }
}

function isGeoJson(value: unknown): value is GeoJSON.GeoJSON {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && [
    "FeatureCollection", "Feature", "GeometryCollection", "Point", "MultiPoint",
    "LineString", "MultiLineString", "Polygon", "MultiPolygon",
  ].includes(type);
}

function readSavedView(sessionId: string | undefined): {
  center: [number, number];
  zoom: number;
} | undefined {
  if (!sessionId) return undefined;
  try {
    const value = JSON.parse(localStorage.getItem(`geoagent-map-view:${sessionId}`) ?? "null") as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { center?: unknown }).center) &&
      (value as { center: unknown[] }).center.length === 2 &&
      (value as { center: unknown[] }).center.every((item) => typeof item === "number") &&
      typeof (value as { zoom?: unknown }).zoom === "number"
    ) {
      return value as { center: [number, number]; zoom: number };
    }
  } catch {
    // Ignore a malformed browser preference and use the default extent.
  }
  return undefined;
}
